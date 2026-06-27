/**
 * "Chain of suggestions" — after an anchor component pair is mapped, propose the next
 * likely component pair by walking the netlist outward from the anchor.
 *
 * Candidates on each side are components *adjacent to the anchor* (sharing a net with
 * it). A candidate pair is scored by:
 *   - same component type (R/C/D/L/Q) — a hard gate;
 *   - number of shared already-mapped nets (topological agreement) — strongest;
 *   - same reference designator (e.g. R4 ↔ R4);
 *   - same value (engineering-notation aware: 4k7 == 4.7k, 3u3 == 3.3µ);
 *   - similar geometric direction from the anchor (weak tie-breaker).
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

  let best: ChainSuggestion | null = null;
  for (const n of ltN) {
    for (const mc of kiN) {
      if (componentType(n.ref) !== componentType(mc.ref)) continue; // type gate
      const sharedMapped = n.nets.filter((net) => {
        const cp = p.netCounterpartLt(net);
        return cp != null && mc.nets.includes(cp);
      }).length;
      const sameRef = n.ref.toLowerCase() === mc.ref.toLowerCase();
      const valueMatch = valuesMatch(n.value, mc.value);
      if (!(sharedMapped > 0 || sameRef || valueMatch)) continue; // need a real signal beyond type
      const d1 = unit(n.pos.x - p.anchorLt.pos.x, n.pos.y - p.anchorLt.pos.y);
      const d2 = unit(mc.pos.x - p.anchorKi.pos.x, mc.pos.y - p.anchorKi.pos.y);
      const dir = d1 && d2 ? Math.max(0, d1.x * d2.x + d1.y * d2.y) : 0;
      const score = 3 * sharedMapped + (sameRef ? 4 : 0) + (valueMatch ? 3 : 0) + dir;
      if (!best || score > best.score) best = { ltRef: n.ref, kiRef: mc.ref, score };
    }
  }
  return best;
}
