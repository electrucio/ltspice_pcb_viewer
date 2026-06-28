import { describe, it, expect } from "vitest";
import { chooseChainSuggestion, parseValue, componentType, valueSimilarity, type ChainComp, type ChainParams } from "../src/suggest/chain.js";

describe("value parsing & similarity", () => {
  it("parses engineering notation incl. R/k-as-decimal", () => {
    expect(parseValue("10k")).toBe(10000);
    expect(parseValue("4k7")).toBeCloseTo(4700);
    expect(parseValue("3u3")).toBeCloseTo(3.3e-6);
    expect(parseValue("BD139")).toBeNull();
  });
  it("extracts component type from a ref", () => {
    expect(componentType("R12")).toBe("R");
    expect(componentType("Q3")).toBe("Q");
  });
  it("scores value similarity by ratio / string equality", () => {
    expect(valueSimilarity("10k", "10k")).toBe(1);
    expect(valueSimilarity("10k", "4k7")).toBeCloseTo(0.47, 1);
    expect(valueSimilarity("BD139", "BD139")).toBe(1);
    expect(valueSimilarity("BD139", "2SD896")).toBe(0);
  });
});

function comp(ref: string, value: string, nets: string[]): ChainComp {
  return { ref, value, nets };
}

const noNetMap = { netCounterpartLt: () => undefined, netCounterpartKi: () => undefined } as const;

describe("chooseChainSuggestion (two-level: simple + contextual)", () => {
  it("matches by type+value+context, ignoring reference designators", () => {
    const s = chooseChainSuggestion({
      anchorLt: comp("Q1", "npn", ["N1"]),
      ltComps: [comp("Q1", "npn", ["N1"]), comp("R5", "1k", ["N1", "N2"])],
      kiComps: [comp("QK", "BD139", ["M1"]), comp("R99", "1k", ["M1", "M2"])],
      isMappedLt: (r) => r === "Q1",
      isMappedKi: (r) => r === "QK",
      componentCounterpartLt: (r) => (r === "Q1" ? "QK" : undefined),
      ...noNetMap,
    });
    expect(s).toMatchObject({ ltRef: "R5", kiRef: "R99" });
  });

  it("prefers the candidate whose context lines up (confirmed neighbour)", () => {
    const s = chooseChainSuggestion({
      anchorLt: comp("Q1", "npn", ["N1"]),
      ltComps: [comp("Q1", "npn", ["N1"]), comp("R1", "1k", ["N1", "N2"])],
      kiComps: [comp("Q5", "BD139", ["M1"]), comp("R9", "1k", ["M1", "M2"]), comp("R8", "1k", ["M8", "M9"])],
      isMappedLt: (r) => r === "Q1",
      isMappedKi: (r) => r === "Q5",
      componentCounterpartLt: (r) => (r === "Q1" ? "Q5" : undefined),
      ...noNetMap,
    });
    expect(s!.ltRef).toBe("R1");
    expect(s!.kiRef).toBe("R9");
  });

  it("does not suggest across component types", () => {
    const s = chooseChainSuggestion({
      anchorLt: comp("Q1", "npn", ["N1"]),
      ltComps: [comp("Q1", "npn", ["N1"]), comp("C9", "100n", ["N1"])],
      kiComps: [comp("QK", "BD139", ["M1"]), comp("R7", "100n", ["M1"])],
      isMappedLt: (r) => r === "Q1",
      isMappedKi: (r) => r === "QK",
      componentCounterpartLt: (r) => (r === "Q1" ? "QK" : undefined),
      ...noNetMap,
    });
    expect(s).toBeNull();
  });

  it("skips already-mapped candidates", () => {
    const s = chooseChainSuggestion({
      anchorLt: comp("Q1", "npn", ["N1"]),
      ltComps: [comp("Q1", "npn", ["N1"]), comp("R1", "1k", ["N1"]), comp("R2", "4k7", ["N1"])],
      kiComps: [comp("Q5", "BD139", ["M1"]), comp("R9", "1k", ["M1"]), comp("R8", "4k7", ["M1"])],
      isMappedLt: (r) => r === "Q1" || r === "R1",
      isMappedKi: (r) => r === "Q5" || r === "R9",
      componentCounterpartLt: (r) => (r === "Q1" ? "Q5" : r === "R1" ? "R9" : undefined),
      ...noNetMap,
    });
    expect(s).toMatchObject({ ltRef: "R2", kiRef: "R8" });
  });

  it("penalizes a candidate that is NOT on a confirmed-mapped net (and rewards the one that is)", () => {
    // anchor Q1<->Q5; net S(lt) <-> NS(ki) confirmed. Candidate R1 sits on S.
    // R9 sits on NS (agrees) ; R8 sits on NB instead (disagrees) -> R9 must win.
    const s = chooseChainSuggestion({
      anchorLt: comp("Q1", "npn", ["S"]),
      ltComps: [comp("Q1", "npn", ["S"]), comp("R1", "1k", ["S", "X"])],
      kiComps: [comp("Q5", "BD139", ["NS", "NB"]), comp("R9", "1k", ["NS", "M"]), comp("R8", "1k", ["NB", "NZ"])],
      isMappedLt: (r) => r === "Q1",
      isMappedKi: (r) => r === "Q5",
      componentCounterpartLt: (r) => (r === "Q1" ? "Q5" : undefined),
      netCounterpartLt: (n) => (n === "S" ? "NS" : undefined),
      netCounterpartKi: (n) => (n === "NS" ? "S" : undefined),
    });
    expect(s).toMatchObject({ ltRef: "R1", kiRef: "R9" });
  });
});
