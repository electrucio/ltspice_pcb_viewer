import { describe, it, expect } from "vitest";
import { chooseChainSuggestion, parseValue, componentType, type ChainComp, type ChainParams } from "../src/suggest/chain.js";

describe("value parsing", () => {
  it("parses engineering notation incl. R/k-as-decimal", () => {
    expect(parseValue("10k")).toBe(10000);
    expect(parseValue("4k7")).toBeCloseTo(4700);
    expect(parseValue("3u3")).toBeCloseTo(3.3e-6);
    expect(parseValue("100n")).toBeCloseTo(100e-9);
    expect(parseValue("0.5")).toBe(0.5);
    expect(parseValue("2k2")).toBeCloseTo(2200);
    expect(parseValue("BD139")).toBeNull();
  });
  it("extracts component type from a ref", () => {
    expect(componentType("R12")).toBe("R");
    expect(componentType("Q3")).toBe("Q");
    expect(componentType("C10")).toBe("C");
  });
});

// Tiny synthetic topology: anchor R1 connects to net A; R2 (same ref+value) and C5 hang off A.
function comp(ref: string, value: string, nets: string[], x = 0, y = 0): ChainComp {
  return { ref, value, nets, pos: { x, y } };
}

describe("chooseChainSuggestion", () => {
  const base = (over: Partial<ChainParams> = {}): ChainParams => ({
    anchorLt: comp("R1", "1k", ["A", "GND"], 0, 0),
    anchorKi: comp("R1", "1k", ["NA", "0"], 0, 0),
    ltComps: [comp("R1", "1k", ["A", "GND"]), comp("R2", "4k7", ["A", "B"], 10, 0), comp("C5", "100n", ["A", "GND"], 0, 10)],
    kiComps: [comp("R1", "1k", ["NA", "0"]), comp("R2", "4k7", ["NA", "NB"], 10, 0), comp("C5", "100n", ["NA", "0"], 0, 10)],
    isMappedLt: () => false,
    isMappedKi: () => false,
    netCounterpartLt: (n) => (n === "A" ? "NA" : n === "GND" ? "0" : undefined),
    ...over,
  });

  it("suggests a same-type, same-ref neighbor of the anchor", () => {
    const s = chooseChainSuggestion(base());
    expect(s).not.toBeNull();
    // R2 and C5 both qualify; R2 wins (sameRef + value), but the highest score should be a real pair
    expect(["R2", "C5"]).toContain(s!.ltRef);
    expect(s!.ltRef).toBe(s!.kiRef);
  });

  it("does not cross component types", () => {
    const s = chooseChainSuggestion(base({
      // only a C on lt and an R on ki as neighbors -> no same-type pair
      ltComps: [comp("R1", "1k", ["A"]), comp("C9", "100n", ["A"])],
      kiComps: [comp("R1", "1k", ["NA"]), comp("R9", "100n", ["NA"])],
    }));
    expect(s).toBeNull();
  });

  it("skips already-mapped candidates", () => {
    const s = chooseChainSuggestion(base({ isMappedLt: (r) => r === "R2", isMappedKi: (r) => r === "R2" }));
    expect(s!.ltRef).toBe("C5"); // R2 excluded, C5 remains
  });

  it("requires a signal beyond type (shared net / ref / value)", () => {
    const s = chooseChainSuggestion(base({
      ltComps: [comp("R1", "1k", ["A"]), comp("R7", "999", ["A"])],
      kiComps: [comp("R1", "1k", ["NA"]), comp("R8", "111", ["NX"])], // diff ref, diff value, no shared mapped net
      netCounterpartLt: () => undefined,
    }));
    expect(s).toBeNull();
  });
});
