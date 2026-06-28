import { describe, it, expect } from "vitest";
import {
  bestComponentMatch, bestNetMatch, chooseNextComponentPair,
  parseValue, componentType, valueSimilarity,
  type SuggestInput, type SuggestComp, type SuggestNet,
} from "../src/suggest/chain.js";

describe("value parsing & similarity", () => {
  it("parses engineering notation incl. R/k-as-decimal", () => {
    expect(parseValue("10k")).toBe(10000);
    expect(parseValue("4k7")).toBeCloseTo(4700);
    expect(parseValue("3u3")).toBeCloseTo(3.3e-6);
    expect(parseValue("BD139")).toBeNull();
  });
  it("extracts component type", () => {
    expect(componentType("R12")).toBe("R");
    expect(componentType("Q3")).toBe("Q");
  });
  it("value similarity by ratio / string equality", () => {
    expect(valueSimilarity("10k", "10k")).toBe(1);
    expect(valueSimilarity("10k", "4k7")).toBeCloseTo(0.47, 1);
    expect(valueSimilarity("BD139", "2SD896")).toBe(0);
  });
});

const C = (ref: string, value: string, nets: string[]): SuggestComp => ({ ref, value, nets });

function input(over: Partial<SuggestInput> = {}): SuggestInput {
  const ltComps = over.ltComps ?? [];
  const kiComps = over.kiComps ?? [];
  const netsOf = (comps: SuggestComp[]): SuggestNet[] => {
    const m = new Map<string, string[]>();
    for (const c of comps) for (const n of c.nets) (m.get(n) ?? m.set(n, []).get(n)!).push(c.ref);
    return [...m].map(([name, cs]) => ({ name, comps: cs }));
  };
  return {
    ltComps, kiComps,
    ltNets: over.ltNets ?? netsOf(ltComps),
    kiNets: over.kiNets ?? netsOf(kiComps),
    compCounterpartLt: over.compCounterpartLt ?? (() => undefined),
    netCounterpartLt: over.netCounterpartLt ?? (() => undefined),
    netCounterpartKi: over.netCounterpartKi ?? (() => undefined),
    compMappedLt: over.compMappedLt ?? (() => false),
    compMappedKi: over.compMappedKi ?? (() => false),
    netMappedLt: over.netMappedLt ?? (() => false),
    netMappedKi: over.netMappedKi ?? (() => false),
  };
}

describe("bestComponentMatch (click → best contextual counterpart)", () => {
  it("matches by type+value+context, ignoring reference designators", () => {
    const inp = input({
      ltComps: [C("Q1", "npn", ["N1"]), C("R5", "1k", ["N1", "N2"])],
      kiComps: [C("QK", "BD139", ["M1"]), C("R99", "1k", ["M1", "M2"])],
      compCounterpartLt: (r) => (r === "Q1" ? "QK" : undefined),
      compMappedLt: (r) => r === "Q1",
      compMappedKi: (r) => r === "QK",
    });
    expect(bestComponentMatch(inp, "lt", "R5")?.ref).toBe("R99");
  });

  it("returns null when nothing clears the threshold (ambiguous, no context)", () => {
    // a lone transistor with no value match and no mapped context -> below threshold
    const inp = input({
      ltComps: [C("Q1", "npn", [])],
      kiComps: [C("Q9", "BD139", [])],
    });
    expect(bestComponentMatch(inp, "lt", "Q1")).toBeNull();
  });

  it("prefers the contextually-consistent candidate (confirmed neighbour)", () => {
    const inp = input({
      ltComps: [C("Q1", "npn", ["N1"]), C("R1", "1k", ["N1", "N2"])],
      kiComps: [C("Q5", "BD139", ["M1"]), C("R9", "1k", ["M1", "M2"]), C("R8", "1k", ["X8", "X9"])],
      compCounterpartLt: (r) => (r === "Q1" ? "Q5" : undefined),
      compMappedLt: (r) => r === "Q1",
      compMappedKi: (r) => r === "Q5",
    });
    expect(bestComponentMatch(inp, "lt", "R1")?.ref).toBe("R9");
  });

  it("penalises a candidate that contradicts a confirmed net mapping", () => {
    const inp = input({
      ltComps: [C("Q1", "npn", ["S"]), C("R1", "1k", ["S", "X"])],
      kiComps: [C("Q5", "BD139", ["NS", "NB"]), C("R9", "1k", ["NS", "M"]), C("R8", "1k", ["NB", "NZ"])],
      compCounterpartLt: (r) => (r === "Q1" ? "Q5" : undefined),
      compMappedLt: (r) => r === "Q1",
      compMappedKi: (r) => r === "Q5",
      netCounterpartLt: (n) => (n === "S" ? "NS" : undefined),
      netCounterpartKi: (n) => (n === "NS" ? "S" : undefined),
      netMappedLt: (n) => n === "S",
      netMappedKi: (n) => n === "NS",
    });
    expect(bestComponentMatch(inp, "lt", "R1")?.ref).toBe("R9"); // R8 (off net NS) penalised
  });
});

describe("chooseNextComponentPair (chain)", () => {
  it("suggests an unmapped pair near the mapped region", () => {
    const inp = input({
      ltComps: [C("Q1", "npn", ["N1"]), C("R1", "1k", ["N1", "N2"])],
      kiComps: [C("Q5", "BD139", ["M1"]), C("R9", "1k", ["M1", "M2"])],
      compCounterpartLt: (r) => (r === "Q1" ? "Q5" : undefined),
      compMappedLt: (r) => r === "Q1",
      compMappedKi: (r) => r === "Q5",
    });
    expect(chooseNextComponentPair(inp)).toMatchObject({ ltRef: "R1", kiRef: "R9" });
  });
});

describe("bestNetMatch (click net → best contextual net, no simple level)", () => {
  it("matches nets by their connected components", () => {
    // confirmed comps R1<->R9 and C1<->C9. Net NETA(lt) connects R1+C1; the ki net with R9+C9 wins.
    const inp = input({
      ltComps: [C("R1", "1k", ["A", "G"]), C("C1", "100n", ["A", "G"])],
      kiComps: [C("R9", "1k", ["NA", "NG"]), C("C9", "100n", ["NA", "NG"]), C("Rx", "1k", ["ZZ"])],
      compCounterpartLt: (r) => (r === "R1" ? "R9" : r === "C1" ? "C9" : undefined),
      compMappedLt: (r) => r === "R1" || r === "C1",
      compMappedKi: (r) => r === "R9" || r === "C9",
    });
    expect(bestNetMatch(inp, "lt", "A")?.name).toBe("NA");
  });
});
