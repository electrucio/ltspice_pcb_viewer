import { describe, it, expect } from "vitest";
import { chooseChainSuggestion, parseValue, componentType, valueSimilarity, type ChainComp, type ChainParams } from "../src/suggest/chain.js";

describe("value parsing & similarity", () => {
  it("parses engineering notation incl. R/k-as-decimal", () => {
    expect(parseValue("10k")).toBe(10000);
    expect(parseValue("4k7")).toBeCloseTo(4700);
    expect(parseValue("3u3")).toBeCloseTo(3.3e-6);
    expect(parseValue("100n")).toBeCloseTo(100e-9);
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

describe("chooseChainSuggestion (two-level: simple + contextual)", () => {
  it("matches by type+value+context, ignoring reference designators", () => {
    // anchor Q1<->QK. R-something hangs off the anchor on each side with value 1k.
    const s = chooseChainSuggestion({
      anchorLt: comp("Q1", "npn", ["N1"]),
      ltComps: [comp("Q1", "npn", ["N1"]), comp("R5", "1k", ["N1", "N2"])],
      kiComps: [comp("QK", "BD139", ["M1"]), comp("R99", "1k", ["M1", "M2"])],
      isMappedLt: (r) => r === "Q1",
      isMappedKi: (r) => r === "QK",
      componentCounterpartLt: (r) => (r === "Q1" ? "QK" : undefined),
    });
    expect(s).toMatchObject({ ltRef: "R5", kiRef: "R99" }); // refs differ, still matched
  });

  it("prefers the candidate whose context lines up (confirmed neighbour)", () => {
    // R1 hangs off the anchor Q1. Two identical 1k kicad resistors: Ra is connected to the
    // confirmed anchor counterpart QK; Rb is isolated. Context must pick Ra.
    const s = chooseChainSuggestion({
      anchorLt: comp("Q1", "npn", ["N1"]),
      ltComps: [comp("Q1", "npn", ["N1"]), comp("R1", "1k", ["N1", "N2"])],
      kiComps: [
        comp("Q5", "BD139", ["M1"]),
        comp("R9", "1k", ["M1", "M2"]), // shares net M1 with Q5 (the confirmed anchor)
        comp("R8", "1k", ["M8", "M9"]), // isolated from the mapped cluster
      ],
      isMappedLt: (r) => r === "Q1",
      isMappedKi: (r) => r === "Q5",
      componentCounterpartLt: (r) => (r === "Q1" ? "Q5" : undefined),
    });
    expect(s!.ltRef).toBe("R1");
    expect(s!.kiRef).toBe("R9");
  });

  it("does not suggest across component types", () => {
    const s = chooseChainSuggestion({
      anchorLt: comp("Q1", "npn", ["N1"]),
      ltComps: [comp("Q1", "npn", ["N1"]), comp("C9", "100n", ["N1"])],
      kiComps: [comp("QK", "BD139", ["M1"]), comp("R7", "100n", ["M1"])], // C vs R
      isMappedLt: (r) => r === "Q1",
      isMappedKi: (r) => r === "QK",
      componentCounterpartLt: (r) => (r === "Q1" ? "QK" : undefined),
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
    });
    expect(s).toMatchObject({ ltRef: "R2", kiRef: "R8" }); // R1/R9 excluded
  });
});
