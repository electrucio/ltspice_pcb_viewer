/**
 * Build a compact SimSummary from an LTspice transient `.raw` (+ optional `.op.raw`),
 * using the LTspice schematic context (net names, components + connected nets, directives).
 * One streaming pass over the transient computes time-weighted V/I/Vdrop/P stats and a
 * windowed DFT (THD) per net; the bulk waveform is never retained.
 */

import { readHeader, streamPoints, readSinglePoint, readVar, type RawFile, type RawHeader } from "./raw.js";
import { MAINS_F0, MAINS_N, HARM_N, type SimSummary, type NetSim, type CompSim, type Stat } from "../../../ltspice_kicad_mapper/src/sim/summary.js";

export interface LtComp { ref: string; value: string; nets: string[] }
export interface LtCtx {
  nets: { name: string }[];
  comps: LtComp[];
  directives: string[];
  /** Optional `viewerNet → LTspice node` alias (from the SPICE netlist) so anonymous nets
   *  like `Net-(C14.1)` resolve to the `.raw`'s `V(n008)`. Built by `buildNetNodeAlias`. */
  netAlias?: Map<string, string>;
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

const compType = (ref: string): string => (ref.match(/^[A-Za-z]+/)?.[0] ?? "").toUpperCase().charAt(0);

/** Resolve the THD fundamental + harmonic count from `.param`/`.four` directives. */
export function resolveFundamental(directives: string[]): { f0: number | null; nHarm: number } {
  const params = new Map<string, number>();
  for (const d of directives) {
    if (/^\.param\b/i.test(d)) {
      for (const m of d.matchAll(/(\w+)\s*=\s*([-+0-9.eE]+)/g)) {
        const v = parseFloat(m[2]!);
        if (isFinite(v)) params.set(m[1]!.toLowerCase(), v);
      }
    }
  }
  let f0: number | null = null;
  let nHarm = 9;
  for (const d of directives) {
    const m = d.match(/^\.four\s+(\S+)\s+(\d+)?/i);
    if (!m) continue;
    const tok = m[1]!.replace(/[{}]/g, "");
    const f = parseFloat(tok);
    f0 = isFinite(f) ? f : params.get(tok.toLowerCase()) ?? null;
    if (m[2]) nHarm = Math.min(parseInt(m[2], 10), 30);
    if (f0) break;
  }
  // Fallback when there's no `.four` directive: use a conventional test-tone param so the
  // harmonic spectrum / THD still resolve (the amp's `.asc` sets `.param in_freq=1000`).
  if (f0 == null) f0 = params.get("in_freq") ?? params.get("freq") ?? params.get("f0") ?? params.get("fin") ?? null;
  return { f0, nHarm };
}

export interface BuildOpts {
  onProgress?: (frac: number) => void;
  pointsPerChunk?: number;
  /** THD + signal-harmonic fundamental (Hz). `undefined` → auto-resolve from directives;
   *  `null` → skip THD/harmonics entirely; a number → use it. */
  thdF0?: number | null;
  /** Ripple/mains-hum base frequency (Hz). `undefined` → default (MAINS_F0); `null` → skip
   *  the ripple spectrum; a number → use it. */
  mainsF0?: number | null;
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

  const auto = resolveFundamental(ctx.directives);
  const f0 = opts.thdF0 === null ? null : (opts.thdF0 ?? auto.f0); // null → THD/harmonics off
  const nHarm = auto.nHarm;
  const mainsBase = opts.mainsF0 === null ? null : (opts.mainsF0 ?? MAINS_F0); // null → ripple off
  const needed = new Set<number>();
  const vi = (name: string): number | undefined => idx.get(name.toLowerCase());

  // --- nets ---
  // Signal-harmonic DFT bins go up to HARM_N (≥ nHarm) so the displayed spectrum reaches the
  // 10th even when `.four` (or its default) asks for fewer; THD still uses 2..nHarm. The mains
  // bins (re/im at m·MAINS_F0) are independent of f₀ and accumulated for every net.
  const NH = Math.max(nHarm, HARM_N);
  interface NetAcc { name: string; vi: number; acc: Acc; re: Float64Array; im: Float64Array; reM: Float64Array; imM: Float64Array }
  const netAccs: NetAcc[] = [];
  for (const n of ctx.nets) {
    const v = vi("v(" + node(n.name) + ")");
    if (v == null) continue;
    needed.add(v);
    netAccs.push({
      name: n.name, vi: v, acc: new Acc(),
      re: new Float64Array(NH + 1), im: new Float64Array(NH + 1),
      reM: new Float64Array(MAINS_N + 1), imM: new Float64Array(MAINS_N + 1),
    });
  }

  // --- components ---
  interface CompAcc {
    ref: string; type: string;
    iVi?: number; i?: Acc;
    aVi?: number | null; bVi?: number | null; aNet?: string; bNet?: string; vdrop?: Acc; pSum?: number; // 2-terminal
    cVi?: number; bcVi?: number; eVi?: number; ic?: Acc; ib?: Acc; ie?: Acc; // transistor
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
  const w = f0 ? 2 * Math.PI * f0 : 0;
  const wM = mainsBase ? 2 * Math.PI * mainsBase : 0;
  let prevT = 0, firstT = NaN, lastT = 0, started = false;
  const cosK = new Float64Array(NH + 1), sinK = new Float64Array(NH + 1);
  const cosM = new Float64Array(MAINS_N + 1), sinM = new Float64Array(MAINS_N + 1);

  await streamPoints(transient, hdr, (t, dv, base) => {
    for (const i of neededList) vals[i] = readVar(hdr, dv, base, i);
    const dt = started ? t - prevT : 0;
    if (!started) { firstT = t; started = true; }
    prevT = t; lastT = t;

    for (const na of netAccs) na.acc.add(vals[na.vi]!, dt);
    if (dt > 0) {
      // Precompute trig once per point (reused across all nets); signal bins only if f₀ known.
      if (w) for (let k = 1; k <= NH; k++) { const a = w * k * t; cosK[k] = Math.cos(a); sinK[k] = Math.sin(a); }
      if (wM) for (let m = 1; m <= MAINS_N; m++) { const a = wM * m * t; cosM[m] = Math.cos(a); sinM[m] = Math.sin(a); }
      for (const na of netAccs) {
        const x = vals[na.vi]! * dt;
        if (w) for (let k = 1; k <= NH; k++) { na.re[k]! += x * cosK[k]!; na.im[k]! += x * sinK[k]!; }
        if (wM) for (let m = 1; m <= MAINS_N; m++) { na.reM[m]! += x * cosM[m]!; na.imM[m]! += x * sinM[m]!; }
      }
    }
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
    }
  }, opts.onProgress, opts.pointsPerChunk);

  const T = lastT - firstT;

  // --- finalize ---
  const nets: Record<string, NetSim> = {};
  for (const na of netAccs) {
    const ns: NetSim = { v: na.acc.stat(T), dc: opV(na.name) };
    if (wM && T > 0) {
      const mains: number[] = [];
      for (let m = 1; m <= MAINS_N; m++) mains.push((2 / T) * Math.hypot(na.reM[m]!, na.imM[m]!));
      ns.mains = mains;
    }
    if (w && T > 0) {
      const amp = (k: number): number => (2 / T) * Math.hypot(na.re[k]!, na.im[k]!);
      const harm: number[] = []; // displayed spectrum (first HARM_N)
      for (let k = 1; k <= HARM_N; k++) harm.push(amp(k));
      const a1 = amp(1);
      // THD uses the full requested harmonic count (nHarm, may exceed HARM_N) straight from
      // the DFT bins — never index past the truncated display array.
      let sumSq = 0;
      for (let k = 2; k <= nHarm; k++) sumSq += amp(k) ** 2;
      if (a1 > 1e-12) {
        const thd = Math.sqrt(sumSq) / a1;
        ns.a1 = a1; ns.thdPct = thd * 100; ns.thdDb = 20 * Math.log10(Math.max(thd, 1e-12));
      }
      ns.harm = harm;
    }
    nets[na.name] = ns;
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
    comps[ca.ref] = cs;
  }

  return { f0, window: T, nPoints: hdr.nPoints, source, directives: ctx.directives, mainsF0: mainsBase ?? undefined, nets, comps };
}

function opCurrent(opMap: Map<string, number> | null, key: string): number | undefined {
  const v = opMap?.get(key.toLowerCase());
  return v == null ? undefined : v;
}
