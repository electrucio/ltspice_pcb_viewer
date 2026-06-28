/**
 * "Chain of suggestions" — after an anchor component pair is mapped, propose the next
 * likely component pair by walking the netlist outward from the anchor.
 *
 * Candidates on each side are components *adjacent to the anchor* (sharing a net with
 * it). A candidate pair is scored by:
 *   - same component type (R/C/D/L/Q) — a hard gate;
 *   - number of shared already-mapped nets (topological agreement) — strongest;
 *   - shared already-mapped *component* neighbors: a candidate connecting to a mapped
 *     component scores higher when its other-side partner connects to that component's
 *     mapped counterpart (reference designators are NOT used — they change between tools);
 *   - same value (engineering-notation aware: 4k7 == 4.7k, 3u3 == 3.3µ);
 *   - proximity / direction from the anchor (tie-breakers, keep the chain local).
 *
 * Only "easy" passive/discrete types are suggested; everything else is left to manual
 * mapping. Pure and DOM-free so it can be unit-tested.
 */

export interface ChainComp {
  ref: string;
  value: string;
  nets: string[];
  pos: { x: number; y: number };
}

export interface ChainParams {
  anchorLt: ChainComp;
  anchorKi: ChainComp;
  ltComps: ChainComp[];
  kiComps: ChainComp[];
  isMappedLt: (ref: string) => boolean;
  isMappedKi: (ref: string) => boolean;
  /** ltspice net name -> mapped kicad net name (or undefined) */
  netCounterpartLt: (net: string) => string | undefined;
  /** ltspice component ref -> mapped kicad component ref (or undefined) */
  componentCounterpartLt: (ref: string) => string | undefined;
}

export interface ChainSuggestion {
  ltRef: string;
  kiRef: string;
  score: number;
}

const EASY_TYPES = new Set(["R", "C", "D", "L", "Q"]);
const MULT: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, meg: 1e6, g: 1e9 };

/** Leading alphabetic part of a reference designator, upper-cased (R4 -> "R"). */
export function componentType(ref: string): string {
  const m = ref.match(/^[A-Za-z]+/);
  return m ? m[0].toUpperCase() : "";
}

/** Parse an engineering value to a number, or null if non-numeric (e.g. "BD139"). */
export function parseValue(raw: string): number | null {
  if (!raw) return null;
  const t = raw.trim().toLowerCase().replace(/µ/g, "u").replace(/ohms?|ω/g, "").trim();
  let m = t.match(/^(\d*\.?\d+)(meg|[pnumkg])(\d+)$/); // 4k7, 3u3
  if (m) return parseFloat(`${m[1]}.${m[3]}`) * MULT[m[2]]!;
  m = t.match(/^(\d*\.?\d+)\s*(meg|[pnumkg])$/); // 10k, 100n
  if (m) return parseFloat(m[1]!) * MULT[m[2]]!;
  m = t.match(/^(\d*\.?\d+)$/); // 220, 0.5
  if (m) return parseFloat(m[1]!);
  return null;
}

function valuesMatch(a: string, b: string): boolean {
  const va = parseValue(a), vb = parseValue(b);
  if (va != null && vb != null) return Math.abs(va - vb) <= 1e-12 + 0.01 * Math.max(Math.abs(va), Math.abs(vb));
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function unit(dx: number, dy: number): { x: number; y: number } | null {
  const len = Math.hypot(dx, dy);
  return len < 1e-6 ? null : { x: dx / len, y: dy / len };
}

function sharesNet(a: ChainComp, b: ChainComp): boolean {
  return a.nets.some((n) => b.nets.includes(n));
}

export function chooseChainSuggestion(p: ChainParams): ChainSuggestion | null {
  const ltN = p.ltComps.filter(
    (c) => c.ref !== p.anchorLt.ref && EASY_TYPES.has(componentType(c.ref)) && !p.isMappedLt(c.ref) && sharesNet(c, p.anchorLt),
  );
  const kiN = p.kiComps.filter(
    (c) => c.ref !== p.anchorKi.ref && EASY_TYPES.has(componentType(c.ref)) && !p.isMappedKi(c.ref) && sharesNet(c, p.anchorKi),
  );

  // normalize distances per side so we can prefer the nearest connected neighbor
  const dist = (a: ChainComp, b: ChainComp) => Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
  const maxLt = Math.max(1e-6, ...ltN.map((c) => dist(c, p.anchorLt)));
  const maxKi = Math.max(1e-6, ...kiN.map((c) => dist(c, p.anchorKi)));

  let best: ChainSuggestion | null = null;
  for (const n of ltN) {
    // kicad counterparts of the already-mapped components that N connects to (on the lt side)
    const expectedKiNeighbors = new Set(
      p.ltComps
        .filter((c) => c.ref !== n.ref && p.isMappedLt(c.ref) && sharesNet(c, n))
        .map((c) => p.componentCounterpartLt(c.ref))
        .filter((r): r is string => !!r),
    );
    for (const mc of kiN) {
      if (componentType(n.ref) !== componentType(mc.ref)) continue; // type gate
      const sharedMapped = n.nets.filter((net) => {
        const cp = p.netCounterpartLt(net);
        return cp != null && mc.nets.includes(cp);
      }).length;
      // does mc connect to the same already-mapped components (by mapping) that n connects to?
      const sharedMappedNeighbors = p.kiComps.filter(
        (c) => c.ref !== mc.ref && expectedKiNeighbors.has(c.ref) && sharesNet(c, mc),
      ).length;
      const valueMatch = valuesMatch(n.value, mc.value);
      if (!(sharedMapped > 0 || valueMatch || sharedMappedNeighbors > 0)) continue; // need a real signal beyond type
      const d1 = unit(n.pos.x - p.anchorLt.pos.x, n.pos.y - p.anchorLt.pos.y);
      const d2 = unit(mc.pos.x - p.anchorKi.pos.x, mc.pos.y - p.anchorKi.pos.y);
      const dir = d1 && d2 ? Math.max(0, d1.x * d2.x + d1.y * d2.y) : 0;
      // prefer the nearest neighbor on each side, so the chain stays local & easy to find
      const proximity = (1 - dist(n, p.anchorLt) / maxLt) * 0.5 + (1 - dist(mc, p.anchorKi) / maxKi) * 0.5;
      const score = 3 * sharedMapped + 2 * sharedMappedNeighbors + (valueMatch ? 3 : 0) + 0.5 * dir + proximity;
      if (!best || score > best.score) best = { ltRef: n.ref, kiRef: mc.ref, score };
    }
  }
  return best;
}
