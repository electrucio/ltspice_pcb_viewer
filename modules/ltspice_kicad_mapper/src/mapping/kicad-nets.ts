/**
 * KiCad schematic ↔ KiCad PCB net-name reconciliation.
 *
 * The LTspice↔KiCad mapping is keyed on the **schematic** net names, but a `.kicad_pcb`
 * names the same nets slightly differently: labeled / power nets carry a sheet-path
 * prefix (schematic `POW` → PCB `/POW`), while auto-generated names (`Net-(C10-Pad1)`)
 * and component refs are identical. To drive PCB highlighting from a schematic-keyed
 * mapping we build a small alias both ways.
 *
 * Matching, in order of confidence:
 *   1. exact name equality;
 *   2. path-normalized equality (strip a leading `/` and any sheet-path segments, so
 *      `/sheet/POW` and `POW` collapse to `POW`);
 *   3. structural fallback — an unmatched schematic net and an unmatched PCB net that
 *      connect to the *same set of component refs*, when that pairing is unambiguous.
 */

export interface KicadNetAlias {
  /** schematic net name -> PCB net name */
  schToPcb: Map<string, string>;
  /** PCB net name -> schematic net name */
  pcbToSch: Map<string, string>;
}

/** schematic-ref ↔ PCB-ref correspondence (both directions). */
export interface KicadRefAlias {
  schToPcb: Map<string, string>;
  pcbToSch: Map<string, string>;
}

/**
 * Match KiCad schematic components to PCB footprints by their **stable schematic symbol
 * UUID** — the footprint's `path` ends in the symbol's UUID, which does not change when
 * the reference designator is renamed (e.g. schematic `Q3` ↔ board `Q3*`). Components
 * without a UUID match are simply absent from the alias (callers fall back to identity).
 */
export function reconcileKicadComponents(
  schComps: { ref: string; uuid?: string }[],
  pcbComps: { ref: string; symbolUuid?: string }[],
): KicadRefAlias {
  const schByUuid = new Map<string, string>();
  for (const c of schComps) if (c.uuid) schByUuid.set(c.uuid, c.ref);
  const schToPcb = new Map<string, string>();
  const pcbToSch = new Map<string, string>();
  for (const c of pcbComps) {
    const schRef = c.symbolUuid ? schByUuid.get(c.symbolUuid) : undefined;
    if (schRef !== undefined) { schToPcb.set(schRef, c.ref); pcbToSch.set(c.ref, schRef); }
  }
  return { schToPcb, pcbToSch };
}

export interface SchNet {
  name: string;
  /** real component refs on this net (no power-symbol pseudo-refs) */
  refs: string[];
}

/** Strip a leading slash and sheet-path segments: `/sheet/POW` -> `POW`, `/POW` -> `POW`. */
export function normalizeNetName(name: string): string {
  const noLead = name.replace(/^\/+/, "");
  const seg = noLead.split("/");
  return seg[seg.length - 1] || noLead;
}

function refSetKey(refs: string[]): string {
  return [...new Set(refs)].sort().join("");
}

/**
 * Build the schematic↔PCB net alias.
 * @param schNets   schematic nets with their connected component refs
 * @param pcbNets   all PCB net names
 * @param pcbNetRefs PCB net name -> connected component refs
 */
export function reconcileKicadNets(
  schNets: SchNet[],
  pcbNets: string[],
  pcbNetRefs: Map<string, string[]>,
): KicadNetAlias {
  const schToPcb = new Map<string, string>();
  const pcbToSch = new Map<string, string>();
  const usedPcb = new Set<string>();

  const link = (sch: string, pcb: string): void => {
    schToPcb.set(sch, pcb);
    pcbToSch.set(pcb, sch);
    usedPcb.add(pcb);
  };

  const pcbSet = new Set(pcbNets);
  const remainingSch: SchNet[] = [];

  // 1. exact
  for (const n of schNets) {
    if (pcbSet.has(n.name) && !usedPcb.has(n.name)) link(n.name, n.name);
    else remainingSch.push(n);
  }

  // 2. path-normalized — index unused PCB nets by their normalized form
  const byNorm = new Map<string, string[]>();
  for (const p of pcbNets) {
    if (usedPcb.has(p)) continue;
    const k = normalizeNetName(p);
    (byNorm.get(k) ?? byNorm.set(k, []).get(k)!).push(p);
  }
  const stillSch: SchNet[] = [];
  for (const n of remainingSch) {
    const cands = (byNorm.get(normalizeNetName(n.name)) ?? []).filter((p) => !usedPcb.has(p));
    if (cands.length === 1) link(n.name, cands[0]!);
    else stillSch.push(n);
  }

  // 3. structural fallback — unique equal ref-set among unused PCB nets
  const pcbByRefSet = new Map<string, string[]>();
  for (const p of pcbNets) {
    if (usedPcb.has(p)) continue;
    const refs = pcbNetRefs.get(p) ?? [];
    if (!refs.length) continue;
    const k = refSetKey(refs);
    (pcbByRefSet.get(k) ?? pcbByRefSet.set(k, []).get(k)!).push(p);
  }
  for (const n of stillSch) {
    if (!n.refs.length) continue;
    const cands = (pcbByRefSet.get(refSetKey(n.refs)) ?? []).filter((p) => !usedPcb.has(p));
    if (cands.length === 1) link(n.name, cands[0]!);
  }

  return { schToPcb, pcbToSch };
}
