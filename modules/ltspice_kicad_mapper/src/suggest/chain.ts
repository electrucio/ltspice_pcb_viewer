/**
 * Suggestion engine for the mapper — two-level similarity, topology-aware, no reference
 * designators and no geometry.
 *
 * COMPONENTS
 *   simple(lt, ki)   one-to-one:
 *                      1.0  if lt and ki are a confirmed mapping;
 *                      0    if different type (R/C/D/L/Q);
 *                      0.4 + 0.6·valueSimilarity   otherwise.
 *   contextual(lt,ki) = simple(lt,ki)·(0.4 + 0.6·neighbourContext)  + netConsistency
 *                     neighbourContext = average, over lt's connected components, of the
 *                     best simple() to any of ki's connected components (confirmed
 *                     neighbours count 1.0). netConsistency rewards sitting on confirmed
 *                     net counterparts and strongly penalises contradicting them; unmapped
 *                     nets are neutral.
 *
 * NETS (no simple level — net names/labels are not trusted)
 *   netContextual(lt, ki) = how well the components on lt match the components on ki,
 *                           scored by simple() (so confirmed components dominate).
 *
 * A match is only proposed when it clears a threshold. The "best match" for an item is
 * the highest-scoring item on the other side.
 */

export interface SuggestComp {
  ref: string;
  value: string;
  nets: string[];
}

export interface SuggestNet {
  name: string;
  comps: string[]; // real component refs connected to this net
}

export interface SuggestInput {
  ltComps: SuggestComp[];
  kiComps: SuggestComp[];
  ltNets: SuggestNet[];
  kiNets: SuggestNet[];
  compCounterpartLt: (ref: string) => string | undefined; // confirmed lt comp -> ki comp
  compCounterpartKi: (ref: string) => string | undefined; // confirmed ki comp -> lt comp
  netCounterpartLt: (name: string) => string | undefined;
  netCounterpartKi: (name: string) => string | undefined;
  compMappedLt: (ref: string) => boolean;
  compMappedKi: (ref: string) => boolean;
  netMappedLt: (name: string) => boolean;
  netMappedKi: (name: string) => boolean;
}

export type Side = "lt" | "ki";

export const COMPONENT_THRESHOLD = 0.5;
export const NET_THRESHOLD = 0.5;
/**
 * Cross-check ratio. After finding the top-1 candidate B for the clicked A, we re-match B
 * back against A's schematic; if B's best there scores far higher than B↔A (i.e. A is well
 * below this fraction of it), B's real partner is elsewhere, so we suggest nothing.
 */
export const MUTUAL_RATIO = 0.8;
const EASY = new Set(["R", "C", "D", "L", "Q"]);
const MULT: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, meg: 1e6, g: 1e9 };

export function componentType(ref: string): string {
  const m = ref.match(/^[A-Za-z]+/);
  return m ? m[0].toUpperCase() : "";
}

export function parseValue(raw: string): number | null {
  if (!raw) return null;
  const t = raw.trim().toLowerCase().replace(/µ/g, "u").replace(/ohms?|ω/g, "").trim();
  let m = t.match(/^(\d*\.?\d+)(meg|[pnumkg])(\d+)$/);
  if (m) return parseFloat(`${m[1]}.${m[3]}`) * MULT[m[2]]!;
  m = t.match(/^(\d*\.?\d+)\s*(meg|[pnumkg])$/);
  if (m) return parseFloat(m[1]!) * MULT[m[2]]!;
  m = t.match(/^(\d*\.?\d+)$/);
  if (m) return parseFloat(m[1]!);
  return null;
}

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

interface Index {
  ltComp: Map<string, SuggestComp>;
  kiComp: Map<string, SuggestComp>;
  ltNbr: Map<string, SuggestComp[]>;
  kiNbr: Map<string, SuggestComp[]>;
  ltNet: Map<string, SuggestNet>;
  kiNet: Map<string, SuggestNet>;
}

function adjacency(comps: SuggestComp[]): Map<string, SuggestComp[]> {
  const byNet = new Map<string, SuggestComp[]>();
  for (const c of comps) for (const n of c.nets) (byNet.get(n) ?? byNet.set(n, []).get(n)!).push(c);
  const byRef = new Map(comps.map((c) => [c.ref, c]));
  const sets = new Map<string, Set<string>>(comps.map((c) => [c.ref, new Set<string>()]));
  for (const list of byNet.values()) for (const a of list) for (const b of list) if (a.ref !== b.ref) sets.get(a.ref)!.add(b.ref);
  const out = new Map<string, SuggestComp[]>();
  for (const c of comps) out.set(c.ref, [...sets.get(c.ref)!].map((r) => byRef.get(r)!));
  return out;
}

function makeIndex(input: SuggestInput): Index {
  return {
    ltComp: new Map(input.ltComps.map((c) => [c.ref, c])),
    kiComp: new Map(input.kiComps.map((c) => [c.ref, c])),
    ltNbr: adjacency(input.ltComps),
    kiNbr: adjacency(input.kiComps),
    ltNet: new Map(input.ltNets.map((n) => [n.name, n])),
    kiNet: new Map(input.kiNets.map((n) => [n.name, n])),
  };
}

/** simple similarity, always oriented (lt component vs ki component). */
export function simpleSimilarity(lt: SuggestComp, ki: SuggestComp, input: SuggestInput): number {
  if (input.compCounterpartLt(lt.ref) === ki.ref) return 1;
  if (componentType(lt.ref) !== componentType(ki.ref)) return 0;
  return 0.4 + 0.6 * valueSimilarity(lt.value, ki.value);
}

function neighbourContext(ltNbrs: SuggestComp[], kiNbrs: SuggestComp[], input: SuggestInput): number {
  if (ltNbrs.length === 0) return 0;
  let sum = 0;
  for (const na of ltNbrs) {
    let best = 0;
    for (const nb of kiNbrs) {
      const v = simpleSimilarity(na, nb, input);
      if (v > best) best = v;
    }
    sum += best;
  }
  return sum / ltNbrs.length;
}

/** Confirmed nets are authoritative: reward agreement, strongly penalise contradiction. */
function netConsistency(lt: SuggestComp, ki: SuggestComp, input: SuggestInput): number {
  let agree = 0, disagree = 0;
  for (const n of lt.nets) {
    const cp = input.netCounterpartLt(n);
    if (cp == null) continue;
    if (ki.nets.includes(cp)) agree++; else disagree++;
  }
  for (const n of ki.nets) {
    const cp = input.netCounterpartKi(n);
    if (cp == null) continue;
    if (lt.nets.includes(cp)) agree++; else disagree++;
  }
  return 0.4 * agree - 5 * disagree;
}

export function contextualComponentScore(lt: SuggestComp, ki: SuggestComp, input: SuggestInput, idx = makeIndex(input)): number {
  const s = simpleSimilarity(lt, ki, input);
  if (s <= 0) return -Infinity; // different type
  const nb = neighbourContext(idx.ltNbr.get(lt.ref) ?? [], idx.kiNbr.get(ki.ref) ?? [], input);
  return s * (0.4 + 0.6 * nb) + netConsistency(lt, ki, input);
}

export interface CompMatch {
  ref: string;
  score: number;
}

/** Highest-contextual component on the other side for `ref` (above threshold), or null. */
export function bestComponentMatch(input: SuggestInput, side: Side, ref: string): CompMatch | null {
  const idx = makeIndex(input);
  let best: CompMatch | null = null;
  if (side === "lt") {
    const a = idx.ltComp.get(ref);
    if (!a) return null;
    for (const b of input.kiComps) {
      if (!EASY.has(componentType(b.ref)) || input.compMappedKi(b.ref)) continue;
      const sc = contextualComponentScore(a, b, input, idx);
      if (sc >= COMPONENT_THRESHOLD && (!best || sc > best.score)) best = { ref: b.ref, score: sc };
    }
  } else {
    const b = idx.kiComp.get(ref);
    if (!b) return null;
    for (const a of input.ltComps) {
      if (!EASY.has(componentType(a.ref)) || input.compMappedLt(a.ref)) continue;
      const sc = contextualComponentScore(a, b, input, idx);
      if (sc >= COMPONENT_THRESHOLD && (!best || sc > best.score)) best = { ref: a.ref, score: sc };
    }
  }
  return best;
}

/**
 * Best counterpart for `ref` that survives a back-check: the top-1 candidate B must not
 * have a much better partner back in `ref`'s own schematic (mutual nearest neighbour with
 * a ratio test). Otherwise B's real partner is elsewhere → return null (don't suggest).
 */
export function mutualComponentMatch(input: SuggestInput, side: Side, ref: string): CompMatch | null {
  const fwd = bestComponentMatch(input, side, ref);
  if (!fwd) return null;
  const back = bestComponentMatch(input, side === "lt" ? "ki" : "lt", fwd.ref);
  if (!back || back.ref === ref) return fwd; // mutual best
  return fwd.score >= back.score * MUTUAL_RATIO ? fwd : null;
}

export interface PairMatch {
  ltRef: string;
  kiRef: string;
  score: number;
}

/**
 * Best next component pair to autosuggest in the chain. Candidates are preferentially
 * near the already-mapped region (a connected component or one on a mapped net), for UX,
 * but the best match is searched across all components.
 */
export function chooseNextComponentPair(input: SuggestInput): PairMatch | null {
  const idx = makeIndex(input);
  const unmappedLt = input.ltComps.filter((c) => EASY.has(componentType(c.ref)) && !input.compMappedLt(c.ref));
  const onFrontier = (c: SuggestComp) =>
    (idx.ltNbr.get(c.ref) ?? []).some((n) => input.compMappedLt(n.ref)) || c.nets.some((n) => input.netMappedLt(n));
  const frontier = unmappedLt.filter(onFrontier);
  const candidates = frontier.length ? frontier : unmappedLt;

  // each candidate's best counterpart must pass the back-check; pick the strongest overall
  let best: PairMatch | null = null;
  for (const a of candidates) {
    const match = mutualComponentMatch(input, "lt", a.ref);
    if (match && (!best || match.score > best.score)) best = { ltRef: a.ref, kiRef: match.ref, score: match.score };
  }
  return best;
}

/**
 * Net contextual similarity, driven ONLY by confirmed component mappings — net names and
 * raw type/value overlap are not trusted. A confirmed component on one net must have its
 * counterpart on the other (agree); if it's elsewhere, that's a contradiction (disagree).
 * Returns 0 when there is no confirmed anchor at all, so nets aren't matched on a guess.
 *   score = agree / (agree + 2·disagree)   ∈ (0, 1]
 */
export function netContextualScore(ltNet: SuggestNet, kiNet: SuggestNet, input: SuggestInput): number {
  let agree = 0, disagree = 0;
  for (const r of ltNet.comps) {
    if (!input.compMappedLt(r)) continue;
    const cp = input.compCounterpartLt(r);
    if (cp && kiNet.comps.includes(cp)) agree++; else disagree++;
  }
  for (const r of kiNet.comps) {
    if (!input.compMappedKi(r)) continue;
    const cp = input.compCounterpartKi(r);
    if (cp && ltNet.comps.includes(cp)) agree++; else disagree++;
  }
  if (agree === 0) return 0;
  return agree / (agree + 2 * disagree);
}

export interface NetMatch {
  name: string;
  score: number;
}

/** Highest-contextual net on the other side for `name` (above threshold), or null. */
export function bestNetMatch(input: SuggestInput, side: Side, name: string): NetMatch | null {
  const idx = makeIndex(input);
  let best: NetMatch | null = null;
  if (side === "lt") {
    const a = idx.ltNet.get(name);
    if (!a) return null;
    for (const b of input.kiNets) {
      if (input.netMappedKi(b.name)) continue;
      const sc = netContextualScore(a, b, input);
      if (sc >= NET_THRESHOLD && (!best || sc > best.score)) best = { name: b.name, score: sc };
    }
  } else {
    const b = idx.kiNet.get(name);
    if (!b) return null;
    for (const a of input.ltNets) {
      if (input.netMappedLt(a.name)) continue;
      const sc = netContextualScore(a, b, input);
      if (sc >= NET_THRESHOLD && (!best || sc > best.score)) best = { name: a.name, score: sc };
    }
  }
  return best;
}

/** Net match with the same back-check as mutualComponentMatch. */
export function mutualNetMatch(input: SuggestInput, side: Side, name: string): NetMatch | null {
  const fwd = bestNetMatch(input, side, name);
  if (!fwd) return null;
  const back = bestNetMatch(input, side === "lt" ? "ki" : "lt", fwd.name);
  if (!back || back.name === name) return fwd;
  return fwd.score >= back.score * MUTUAL_RATIO ? fwd : null;
}

export interface NetPairMatch {
  ltNet: string;
  kiNet: string;
  score: number;
}

/** Best next net pair to autosuggest in the chain (preferring nets near mapped parts). */
export function chooseNextNetPair(input: SuggestInput): NetPairMatch | null {
  const unmapped = input.ltNets.filter((n) => !input.netMappedLt(n.name));
  const frontier = unmapped.filter((n) => n.comps.some((r) => input.compMappedLt(r)));
  const candidates = frontier.length ? frontier : unmapped;
  let best: NetPairMatch | null = null;
  for (const a of candidates) {
    const match = mutualNetMatch(input, "lt", a.name);
    if (match && (!best || match.score > best.score)) best = { ltNet: a.name, kiNet: match.name, score: match.score };
  }
  return best;
}
