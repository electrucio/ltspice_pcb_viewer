/**
 * Bridge auto-named LTspice nets to the node names used in the `.raw`.
 *
 * An `.asc` only *names* nets where you drop a flag/label; everything else is anonymous.
 * Each tool then invents its own name for an anonymous node — LTspice's netlister calls it
 * `N001`/`N002`/… (and the `.raw` stores `V(n001)`), while our schematic viewer invents a
 * KiCad-style `Net-(C14.1)`. The two names never match, so name-based sim lookup misses
 * every anonymous net.
 *
 * The LTspice SPICE **netlist** (`.net`) closes the gap: it lists each component with the
 * LTspice node names it connects to. We match each viewer net to the netlist node that
 * touches the *same set of component refs* (the structural trick `reconcileKicadNets` uses)
 * and return a `viewerNet → ltNode` alias, so `buildSimSummary` can find `V(n008)` for
 * `Net-(C14.1)`.
 */

/** Decode a `.net` file, which LTspice writes as UTF-16 (like the `.asc`); fall back to UTF-8. */
export function decodeNetlist(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf);
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(buf);
  if (b.length >= 2 && b[1] === 0) return new TextDecoder("utf-16le").decode(buf); // UTF-16LE, no BOM
  return new TextDecoder("utf-8").decode(buf);
}

/**
 * Parse device lines into `ref → ordered tokens after the ref`. Comment/directive/
 * continuation lines (`* . + ;`) are skipped. Subckt instances are emitted with an `X`
 * prefix (`XRV2`) whereas the schematic reference is `RV2`, so we strip a leading `X`.
 */
export function parseNetlistRefs(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const c = line[0]!;
    if (c === "." || c === "*" || c === "+" || c === ";") continue;
    const toks = line.split(/\s+/);
    let ref = toks[0]!;
    if ((ref[0] === "X" || ref[0] === "x") && ref.length > 1) ref = ref.slice(1);
    out.set(ref, toks.slice(1));
  }
  return out;
}

function bump<K>(map: Map<K, Set<string>>, key: K, value: string): void {
  let s = map.get(key);
  if (!s) map.set(key, (s = new Set()));
  s.add(value);
}

const sig = (s: Set<string>): string => [...s].sort().join("|");

/**
 * Build a `viewerNet → ltNode` alias by matching nets that touch an identical set of
 * component refs. A net is only aliased when its ref-set is unique on **both** sides
 * (exactly one node and one viewer net share it) and the names actually differ — so it
 * resolves anonymous nets without ever overriding a correctly-labeled one. Unmatched nets
 * simply fall back to name-based lookup (current behaviour).
 *
 * Nodes are delimited from each netlist line using the viewer's pin count for that ref,
 * which keeps the comparison in viewer-ref space and gracefully ignores extras like a
 * BJT's 4th (substrate) node. Ground (`0`) is excluded — it touches nearly everything.
 */
export function buildNetNodeAlias(
  refTokens: Map<string, string[]>,
  comps: { ref: string; nets: string[] }[],
): Map<string, string> {
  const compByRef = new Map(comps.map((c) => [c.ref, c]));

  const nodeRefs = new Map<string, Set<string>>();
  for (const [ref, toks] of refTokens) {
    const comp = compByRef.get(ref);
    if (!comp) continue;
    for (const node of toks.slice(0, comp.nets.length)) {
      if (node === "0" || node.toUpperCase() === "GND") continue;
      bump(nodeRefs, node, ref);
    }
  }

  const netRefs = new Map<string, Set<string>>();
  for (const c of comps) {
    for (const net of new Set(c.nets)) {
      if (net === "0") continue;
      bump(netRefs, net, c.ref);
    }
  }

  const nodeBySig = new Map<string, string[]>();
  for (const [node, refs] of nodeRefs) (nodeBySig.get(sig(refs)) ?? nodeBySig.set(sig(refs), []).get(sig(refs))!).push(node);
  const netBySig = new Map<string, string[]>();
  for (const [net, refs] of netRefs) (netBySig.get(sig(refs)) ?? netBySig.set(sig(refs), []).get(sig(refs))!).push(net);

  const alias = new Map<string, string>();
  for (const [net, refs] of netRefs) {
    const s = sig(refs);
    const nodes = nodeBySig.get(s);
    const peers = netBySig.get(s);
    if (nodes?.length === 1 && peers?.length === 1 && nodes[0] !== net) alias.set(net, nodes[0]!);
  }
  return alias;
}
