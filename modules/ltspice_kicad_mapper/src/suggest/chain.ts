/**
 * "Chain of suggestions" — after an anchor component pair is mapped, propose the next
 * likely component pair using a two-level similarity model (no reference designators,
 * no geometry):
 *
 *   simple(a, b)      one component vs one component:
 *                       1.0  if a and b are already a confirmed mapping;
 *                       0    if different type (R/C/D/L/Q);
 *                       0.4 + 0.6·valueSimilarity   otherwise (same type).
 *
 *   contextual(a, b)  simple(a, b) modulated by how well a's connected components match
 *                     b's connected components — each neighbour pair scored by simple()
 *                     (so confirmed neighbours contribute 1.0). A candidate sitting next
 *                     to already-mapped components that line up scores high.
 *
 * On top of that, confirmed NET mappings are authoritative: if a candidate sits on a
 * mapped net, its partner must sit on that net's counterpart — agreement rewards, any
 * disagreement is a strong penalty (effectively disqualifying).
 *
 * For the chain we restrict the *candidate* side to the anchor's connected components
 * (locality / UX), but search ALL components on the other side for its best match.
 * Only R/C/D/L/Q are suggested; other parts are mapped manually.
 *
 * Pure and DOM-free so it can be unit-tested.
 */

export interface ChainComp {
  ref: string;
  value: string;
  nets: string[];
}

export interface ChainParams {
  anchorLt: ChainComp;
  ltComps: ChainComp[];
  kiComps: ChainComp[];
  isMappedLt: (ref: string) => boolean;
  isMappedKi: (ref: string) => boolean;
  /** ltspice component ref -> mapped kicad component ref (or undefined) */
  componentCounterpartLt: (ref: string) => string | undefined;
  /** ltspice net name -> mapped kicad net name (or undefined) */
  netCounterpartLt: (net: string) => string | undefined;
  /** kicad net name -> mapped ltspice net name (or undefined) */
  netCounterpartKi: (net: string) => string | undefined;
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

/** 0..1 similarity of two values: numeric ratio, or string equality for non-numeric. */
export function valueSimilarity(a: string, b: string): number {
  const pa = parseValue(a), pb = parseValue(b);
  if (pa != null && pb != null) {
    const hi = Math.max(Math.abs(pa), Math.abs(pb));
    const lo = Math.min(Math.abs(pa), Math.abs(pb));
    return hi === 0 ? 1 : lo / hi;
  }
  if (a && b && a.trim().toLowerCase() === b.trim().toLowerCase()) return 1;
  return 0;
}

type Confirmed = (ltRef: string, kiRef: string) => boolean;

/** simple(a,b): a is ltspice, b is kicad. */
export function simpleSimilarity(lt: ChainComp, ki: ChainComp, confirmed: Confirmed): number {
  if (confirmed(lt.ref, ki.ref)) return 1;
  if (componentType(lt.ref) !== componentType(ki.ref)) return 0;
  return 0.4 + 0.6 * valueSimilarity(lt.value, ki.value);
}

function neighbors(comp: ChainComp, all: ChainComp[]): ChainComp[] {
  return all.filter((c) => c.ref !== comp.ref && c.nets.some((n) => comp.nets.includes(n)));
}

export function chooseChainSuggestion(p: ChainParams): ChainSuggestion | null {
  const confirmed: Confirmed = (l, k) => p.componentCounterpartLt(l) === k;

  // adjacency precomputed once per side
  const ltNbr = new Map<string, ChainComp[]>();
  for (const c of p.ltComps) ltNbr.set(c.ref, neighbors(c, p.ltComps));
  const kiNbr = new Map<string, ChainComp[]>();
  for (const c of p.kiComps) kiNbr.set(c.ref, neighbors(c, p.kiComps));

  // candidates: the anchor's connected components (locality/UX), unmapped, easy types
  const candidates = (ltNbr.get(p.anchorLt.ref) ?? []).filter(
    (c) => EASY_TYPES.has(componentType(c.ref)) && !p.isMappedLt(c.ref),
  );
  // search the whole other side for the best contextual match
  const pool = p.kiComps.filter((c) => EASY_TYPES.has(componentType(c.ref)) && !p.isMappedKi(c.ref));

  const contextual = (a: ChainComp, b: ChainComp): number => {
    const s = simpleSimilarity(a, b, confirmed);
    if (s <= 0) return 0;
    const nbA = ltNbr.get(a.ref) ?? [];
    const nbB = kiNbr.get(b.ref) ?? [];
    if (nbA.length === 0) return s * 0.4;
    let sum = 0;
    for (const na of nbA) {
      let bestN = 0;
      for (const nb of nbB) {
        const v = simpleSimilarity(na, nb, confirmed);
        if (v > bestN) bestN = v;
      }
      sum += bestN;
    }
    return s * (0.4 + 0.6 * (sum / nbA.length));
  };

  // Confirmed net mappings are authoritative: if a sits on a mapped net, b must sit on
  // that net's counterpart (and vice versa). Agreement rewards; any disagreement is a
  // strong penalty (a real match agrees on every mapped net it touches).
  const netConsistency = (a: ChainComp, b: ChainComp): number => {
    let agree = 0, disagree = 0;
    for (const n of a.nets) {
      const cp = p.netCounterpartLt(n);
      if (cp == null) continue;
      if (b.nets.includes(cp)) agree++; else disagree++;
    }
    for (const n of b.nets) {
      const cp = p.netCounterpartKi(n);
      if (cp == null) continue;
      if (a.nets.includes(cp)) agree++; else disagree++;
    }
    return 0.4 * agree - 5 * disagree;
  };

  let best: ChainSuggestion | null = null;
  for (const a of candidates) {
    for (const b of pool) {
      const ctx = contextual(a, b);
      if (ctx <= 0) continue; // different type
      const score = ctx + netConsistency(a, b);
      if (score > 0 && (!best || score > best.score)) best = { ltRef: a.ref, kiRef: b.ref, score };
    }
  }
  return best;
}
