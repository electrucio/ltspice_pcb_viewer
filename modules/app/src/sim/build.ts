/**
 * Build a compact SimSummary from an LTspice transient `.raw` (+ optional `.op.raw`),
 * using the LTspice schematic context (net names, components + connected nets).
 * One streaming pass over the transient computes time-weighted V/I/Vdrop/P stats per net
 * and component; the bulk waveform is never retained. Harmonics/THD/ripple are NOT computed
 * here (float32 `.raw` can't match LTspice's precision) — those come from the `.log`
 * (see `logfile.ts`) and are merged onto this summary.
 */

import { readHeader, streamPoints, readSinglePoint, readVar, type RawFile, type RawHeader } from "./raw.js";
import type { SimSummary, NetSim, CompSim, Stat } from "../../../ltspice_kicad_mapper/src/sim/summary.js";

export interface LtComp { ref: string; value: string; nets: string[] }
export interface LtCtx {
  nets: { name: string }[];
  comps: LtComp[];
  directives: string[];
  /** Optional `viewerNet → LTspice node` alias (from the SPICE netlist) so anonymous nets
   *  like `Net-(C14.1)` resolve to the `.raw`'s `V(n008)`. Built by `buildNetNodeAlias`. */
  netAlias?: Map<string, string>;
  /** Optional per-ref SPICE-order node list (from the same parsed netlist, e.g.
   *  `parseNetlistRefs(...).get(ref)`), used to identify transistor terminals (collector,
   *  base, emitter) robustly. The `.asy` symbol's PIN order is *supposed* to equal SPICE
   *  order, and does for the built-in symbols, but a custom/third-party symbol isn't
   *  guaranteed to — the netlist is LTspice's own resolved order and can't be wrong. When a
   *  ref has no entry here (no `.net` loaded, or the ref is missing from it), transistor
   *  power falls back to the viewer's `LtComp.nets` order (best-effort). */
  qNodes?: Map<string, string[]>;
}

class Acc {
  min = Infinity; max = -Infinity; sum = 0; sq = 0;
  add(x: number, dt: number): void {
    if (x < this.min) this.min = x;
    if (x > this.max) this.max = x;
    this.sum += x * dt;
    this.sq += x * x * dt;
  }
  stat(T: number): Stat {
    const avg = T > 0 ? this.sum / T : this.min;
    const rms = T > 0 ? Math.sqrt(Math.max(0, this.sq / T)) : Math.abs(this.min);
    return { min: this.min, max: this.max, avg, rms, pp: this.max - this.min };
  }
}

export const compType = (ref: string): string => (ref.match(/^[A-Za-z]+/)?.[0] ?? "").toUpperCase().charAt(0);

export interface BuildOpts {
  onProgress?: (frac: number) => void;
  pointsPerChunk?: number;
}

export async function buildSimSummary(
  transient: RawFile,
  op: RawFile | null,
  ctx: LtCtx,
  source: string,
  opts: BuildOpts = {},
): Promise<SimSummary> {
  const hdr: RawHeader = await readHeader(transient);
  const idx = new Map<string, number>(); // lowercased var name -> index
  for (const v of hdr.vars) idx.set(v.name.toLowerCase(), v.index);

  // Resolve a viewer net name to the LTspice node name the `.raw`/`.op` actually uses
  // (identity unless the SPICE-netlist alias maps an anonymous net like Net-(C14.1)→N008).
  const node = (net: string): string => ctx.netAlias?.get(net) ?? net;

  const opMap = op ? await readSinglePoint(op) : null;
  const opV = (net: string): number | null => {
    if (net === "0") return 0;
    const v = opMap?.get("v(" + node(net).toLowerCase() + ")");
    return v == null ? null : v;
  };

  const needed = new Set<number>();
  const vi = (name: string): number | undefined => idx.get(name.toLowerCase());

  // --- nets ---
  interface NetAcc { name: string; vi: number; acc: Acc }
  const netAccs: NetAcc[] = [];
  for (const n of ctx.nets) {
    const v = vi("v(" + node(n.name) + ")");
    if (v == null) continue;
    needed.add(v);
    netAccs.push({ name: n.name, vi: v, acc: new Acc() });
  }

  // --- components ---
  // Resolve a net to a `.raw` voltage var: null = unresolvable, { vi: null } = grounded (0V).
  const vref = (n: string | undefined): { vi: number | null } | null => {
    if (n == null) return null;
    if (n === "0") return { vi: null };
    const v = vi("v(" + node(n) + ")");
    return v == null ? null : { vi: v };
  };
  interface CompAcc {
    ref: string; type: string;
    iVi?: number; i?: Acc;
    aVi?: number | null; bVi?: number | null; aNet?: string; bNet?: string; vdrop?: Acc; pSum?: number; // 2-terminal
    cVi?: number; bcVi?: number; eVi?: number; ic?: Acc; ib?: Acc; ie?: Acc; // transistor currents
    // transistor power Pdiss = Vce·Ic (+ Vbe·Ib when Ib is also known): terminal voltage var
    // indices (null = grounded) + net names (for the DC/.op figure) + the accumulated ∫P·dt.
    qPow?: { cVi: number | null; eVi: number | null; bVi: number | null; hasIb: boolean; sum: number; collNet: string; emitNet: string; baseNet?: string };
  }
  const compAccs: CompAcc[] = [];
  for (const c of ctx.comps) {
    const t = compType(c.ref);
    const ca: CompAcc = { ref: c.ref, type: t };
    if (t === "Q") {
      const ic = vi("ic(" + c.ref + ")"), ib = vi("ib(" + c.ref + ")"), ie = vi("ie(" + c.ref + ")");
      if (ic != null) { ca.cVi = ic; ca.ic = new Acc(); needed.add(ic); }
      if (ib != null) { ca.bcVi = ib; ca.ib = new Acc(); needed.add(ib); }
      if (ie != null) { ca.eVi = ie; ca.ie = new Acc(); needed.add(ie); }

      // Dissipated power, identifying collector/base/emitter from the SPICE netlist's node
      // order when available (robust — independent of how the symbol happens to be drawn),
      // else falling back to the viewer's pin order (correct for standard C/B/E symbols,
      // best-effort for anything else).
      const [collNet, baseNet, emitNet] = ctx.qNodes?.get(c.ref) ?? c.nets;
      const vc = vref(collNet), ve = vref(emitNet);
      if (ic != null && vc && ve) {
        const vb = ib != null ? vref(baseNet) : null;
        ca.qPow = { cVi: vc.vi, eVi: ve.vi, bVi: vb ? vb.vi : null, hasIb: !!vb, sum: 0, collNet: collNet!, emitNet: emitNet!, baseNet: vb ? baseNet : undefined };
        if (vc.vi != null) needed.add(vc.vi);
        if (ve.vi != null) needed.add(ve.vi);
        if (vb && vb.vi != null) needed.add(vb.vi);
      }
    } else {
      const iv = vi("i(" + c.ref + ")");
      if (iv != null) { ca.iVi = iv; ca.i = new Acc(); needed.add(iv); }
      // voltage drop across a 2-terminal part
      const realNets = [...new Set(c.nets)];
      if (realNets.length === 2) {
        const a = realNets[0] === "0" ? null : vi("v(" + node(realNets[0]!) + ")");
        const b = realNets[1] === "0" ? null : vi("v(" + node(realNets[1]!) + ")");
        const aOk = realNets[0] === "0" || a != null;
        const bOk = realNets[1] === "0" || b != null;
        if (aOk && bOk) {
          ca.aVi = a ?? null; ca.bVi = b ?? null; ca.aNet = realNets[0]; ca.bNet = realNets[1];
          ca.vdrop = new Acc(); ca.pSum = 0;
          if (a != null) needed.add(a);
          if (b != null) needed.add(b);
        }
      }
    }
    if (ca.i || ca.ic || ca.ib || ca.ie) compAccs.push(ca);
  }

  // --- streaming pass ---
  const vals = new Float64Array(hdr.nVars);
  const neededList = [...needed];
  let prevT = 0, firstT = NaN, lastT = 0, started = false;

  await streamPoints(transient, hdr, (t, dv, base) => {
    for (const i of neededList) vals[i] = readVar(hdr, dv, base, i);
    const dt = started ? t - prevT : 0;
    if (!started) { firstT = t; started = true; }
    prevT = t; lastT = t;

    for (const na of netAccs) na.acc.add(vals[na.vi]!, dt);
    for (const ca of compAccs) {
      if (ca.i) ca.i.add(vals[ca.iVi!]!, dt);
      if (ca.vdrop) {
        const va = ca.aVi == null ? 0 : vals[ca.aVi]!;
        const vb = ca.bVi == null ? 0 : vals[ca.bVi]!;
        const vd = va - vb;
        ca.vdrop.add(vd, dt);
        if (ca.i) ca.pSum! += vd * vals[ca.iVi!]! * dt;
      }
      if (ca.ic) ca.ic.add(vals[ca.cVi!]!, dt);
      if (ca.ib) ca.ib.add(vals[ca.bcVi!]!, dt);
      if (ca.ie) ca.ie.add(vals[ca.eVi!]!, dt);
      if (ca.qPow) {
        const vc = ca.qPow.cVi == null ? 0 : vals[ca.qPow.cVi]!;
        const ve = ca.qPow.eVi == null ? 0 : vals[ca.qPow.eVi]!;
        let p = (vc - ve) * vals[ca.cVi!]!; // Vce · Ic
        if (ca.qPow.hasIb) {
          const vb = ca.qPow.bVi == null ? 0 : vals[ca.qPow.bVi]!;
          p += (vb - ve) * vals[ca.bcVi!]!; // + Vbe · Ib
        }
        ca.qPow.sum += p * dt;
      }
    }
  }, opts.onProgress, opts.pointsPerChunk);

  const T = lastT - firstT;

  // --- finalize ---
  const nets: Record<string, NetSim> = {};
  for (const na of netAccs) {
    nets[na.name] = { v: na.acc.stat(T), dc: opV(na.name) };
  }

  const comps: Record<string, CompSim> = {};
  for (const ca of compAccs) {
    const cs: CompSim = { type: ca.type };
    if (ca.i) { cs.i = ca.i.stat(T); cs.dcI = opCurrent(opMap, "i(" + ca.ref + ")"); }
    if (ca.vdrop) {
      cs.vdrop = ca.vdrop.stat(T);
      cs.pAvg = T > 0 ? ca.pSum! / T : 0;
      const da = opV(ca.aNet!), db = opV(ca.bNet!);
      if (da != null && db != null) {
        cs.dcVdrop = da - db;
        if (cs.dcI != null) cs.dcP = cs.dcVdrop * cs.dcI;
      }
    }
    if (ca.ic) { cs.ic = ca.ic.stat(T); cs.dcIc = opCurrent(opMap, "ic(" + ca.ref + ")"); }
    if (ca.ib) { cs.ib = ca.ib.stat(T); cs.dcIb = opCurrent(opMap, "ib(" + ca.ref + ")"); }
    if (ca.ie) { cs.ie = ca.ie.stat(T); cs.dcIe = opCurrent(opMap, "ie(" + ca.ref + ")"); }
    if (cs.dcIc != null && cs.dcIb) cs.betaDc = cs.dcIc / cs.dcIb;
    if (ca.qPow) {
      cs.pAvg = T > 0 ? ca.qPow.sum / T : 0;
      const dVc = opV(ca.qPow.collNet), dVe = opV(ca.qPow.emitNet);
      if (dVc != null && dVe != null && cs.dcIc != null) {
        let dP = (dVc - dVe) * cs.dcIc;
        if (ca.qPow.hasIb && ca.qPow.baseNet != null && cs.dcIb != null) {
          const dVb = opV(ca.qPow.baseNet);
          if (dVb != null) dP += (dVb - dVe) * cs.dcIb;
        }
        cs.dcP = dP;
      }
    }
    comps[ca.ref] = cs;
  }

  return { window: T, nPoints: hdr.nPoints, source, directives: ctx.directives, nets, comps };
}

function opCurrent(opMap: Map<string, number> | null, key: string): number | undefined {
  const v = opMap?.get(key.toLowerCase());
  return v == null ? undefined : v;
}
