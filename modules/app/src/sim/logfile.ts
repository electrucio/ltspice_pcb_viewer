/**
 * Parse LTspice's `.log` file and attach its **exact** results to a `SimSummary`.
 *
 * The transient `.raw` stores voltages as float32, so recomputing harmonics/THD/ripple from
 * it is imprecise. LTspice, however, writes the exact `.four` (Fourier + THD) and `.meas`
 * results into the `.log`. We parse those and show them verbatim — they are LTspice's own
 * numbers, keyed on LTspice node/ref names and merged onto the viewer's nets/components.
 */

import type { SimSummary, FourBlock, FourHarmonic, LogMeas, NetLog, CompLog } from "../../../ltspice_kicad_mapper/src/sim/summary.js";

/** A `.meas` result plus the node/ref its expression references (for attachment). */
interface ParsedMeas { name: string; value: number; unit?: string; node?: string; ref?: string }
export interface ParsedLog {
  four: { node: string; mains: boolean; block: FourBlock }[];
  meas: ParsedMeas[];
}

/** Decode a `.log` (LTspice writes UTF-16; fall back to UTF-8). */
export function decodeLog(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf);
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(buf);
  if (b.length >= 2 && b[1] === 0) return new TextDecoder("utf-16le").decode(buf); // UTF-16LE, no BOM
  return new TextDecoder("utf-8").decode(buf);
}

/**
 * Parse the `.four` Fourier blocks and `.meas` results from a `.log`.
 * A `.four` block is classified as **mains** (ripple) when its fundamental is ≤120 Hz.
 * `.meas` node/ref are derived from a `v(...)`/`i(...)` in the measured expression.
 */
export function parseLog(text: string): ParsedLog {
  const lines = text.split(/\r?\n/);
  const four: ParsedLog["four"] = [];
  let nPeriods: number | undefined;

  for (let i = 0; i < lines.length; i++) {
    const np = lines[i]!.match(/N-Period\s*=\s*(\d+)/i);
    if (np) nPeriods = parseInt(np[1]!, 10);
    const fm = lines[i]!.match(/Fourier components of\s+V\(([^)]+)\)/i);
    if (!fm) continue;
    const node = fm[1]!.trim();
    const harmonics: FourHarmonic[] = [];
    let thdPct: number | undefined;
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (/Fourier components of/i.test(lines[j]!)) break;
      const t = lines[j]!.match(/Total Harmonic Distortion:\s*([0-9.eE+-]+)\s*%/i);
      if (t) { thdPct = parseFloat(t[1]!); break; }
      const rm = lines[j]!.match(/^\s*(\d+)\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)/);
      if (rm) harmonics.push({ n: parseInt(rm[1]!, 10), freq: parseFloat(rm[2]!), amp: parseFloat(rm[3]!), norm: parseFloat(rm[4]!) });
    }
    if (harmonics.length) {
      const f0 = harmonics[0]!.freq;
      four.push({ node, mains: f0 <= 120, block: { f0, nPeriods, thdPct, harmonics } });
    }
    i = j - 1;
  }

  // .meas results: `name: EXPR=value [FROM a TO b]`. Dedupe by name (last wins).
  const measByName = new Map<string, ParsedMeas>();
  for (const l of lines) {
    const m = l.match(/^\s*([A-Za-z_]\w*)\s*:\s*(.*?)=\s*([-+0-9.eE]+)/);
    if (!m) continue;
    const value = parseFloat(m[3]!);
    if (!isFinite(value)) continue;
    const expr = m[2]!;
    const vm = expr.match(/\bv\(([^)]+)\)/i);
    const im = expr.match(/\bi\w*\(([^)]+)\)/i); // I(), Ic(), Ib(), Ix()…
    measByName.set(m[1]!, {
      name: m[1]!, value,
      unit: vm ? "V" : im ? "A" : "",
      node: vm ? vm[1]!.trim() : undefined,
      ref: im ? im[1]!.trim() : undefined,
    });
  }
  return { four, meas: [...measByName.values()] };
}

/**
 * Merge parsed `.log` results into a `SimSummary` (whose nets are keyed by **viewer** net
 * name). LTspice node names are matched case-insensitively; anonymous viewer nets resolve to
 * their LTspice node via the netlist alias (`viewerNet → ltNode`). Meas that reference no
 * net/component (PARAM expressions) go to `logGlobals`. Returns attach counts.
 */
export function mergeLog(
  summary: SimSummary,
  log: ParsedLog,
  netAlias?: Map<string, string>,
  logSource?: string,
): { four: number; meas: number } {
  // LTspice node (lowercased) → viewer net name
  const nodeToNet = new Map<string, string>();
  for (const name of Object.keys(summary.nets)) {
    nodeToNet.set((netAlias?.get(name) ?? name).toLowerCase(), name);
  }
  const refUpper = new Map<string, string>();
  for (const ref of Object.keys(summary.comps)) refUpper.set(ref.toUpperCase(), ref);

  const netLog = (net: string): NetLog => (summary.nets[net]!.log ??= {});
  const compLog = (ref: string): CompLog => (summary.comps[ref]!.log ??= {});

  let nFour = 0, nMeas = 0;
  for (const f of log.four) {
    const net = nodeToNet.get(f.node.toLowerCase());
    if (!net) continue;
    const lg = netLog(net);
    if (f.mains) lg.mains = f.block; else lg.four = f.block;
    nFour++;
  }

  const globals: LogMeas[] = [];
  for (const m of log.meas) {
    const lm: LogMeas = { name: m.name, value: m.value, unit: m.unit };
    const net = m.node ? nodeToNet.get(m.node.toLowerCase()) : undefined;
    if (net) { (netLog(net).meas ??= []).push(lm); nMeas++; continue; }
    const ref = m.ref ? refUpper.get(m.ref.toUpperCase()) : undefined;
    if (ref) { (compLog(ref).meas ??= []).push(lm); nMeas++; continue; }
    globals.push(lm);
  }
  summary.logGlobals = globals.length ? globals : undefined;
  summary.logSource = logSource;
  return { four: nFour, meas: nMeas };
}
