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
  // anchor is the just-mapped pair; net A<->NA and GND<->0 are mapped nets
  const base = (over: Partial<ChainParams> = {}): ChainParams => ({
    anchorLt: comp("R1", "1k", ["A", "GND"], 0, 0),
    anchorKi: comp("RX", "1k", ["NA", "0"], 0, 0),
    ltComps: [comp("R1", "1k", ["A", "GND"]), comp("R2", "4k7", ["A", "B"], 10, 0), comp("C5", "100n", ["A", "GND"], 0, 10)],
    kiComps: [comp("RX", "1k", ["NA", "0"]), comp("R9", "4k7", ["NA", "NB"], 10, 0), comp("C8", "100n", ["NA", "0"], 0, 10)],
    isMappedLt: (r) => r === "R1",
    isMappedKi: (r) => r === "RX",
    netCounterpartLt: (n) => (n === "A" ? "NA" : n === "GND" ? "0" : undefined),
    componentCounterpartLt: (r) => (r === "R1" ? "RX" : undefined),
    ...over,
  });

  it("suggests a same-type neighbor by topology+value, ignoring ref names", () => {
    const s = chooseChainSuggestion(base());
    expect(s).not.toBeNull();
    // R2(lt) is a resistor matching R9(ki) by value 4k7; C5 matches C8 by value 100n
    expect([["R2", "R9"], ["C5", "C8"]]).toContainEqual([s!.ltRef, s!.kiRef]);
  });

  it("does not cross component types", () => {
    const s = chooseChainSuggestion(base({
      ltComps: [comp("R1", "1k", ["A"]), comp("C9", "100n", ["A"])],
      kiComps: [comp("RX", "1k", ["NA"]), comp("R7", "100n", ["NA"])],
    }));
    expect(s).toBeNull();
  });

  it("skips already-mapped candidates", () => {
    const s = chooseChainSuggestion(base({ isMappedLt: (r) => r === "R1" || r === "R2", isMappedKi: (r) => r === "RX" || r === "R9" }));
    expect(s!.ltRef).toBe("C5"); // R2 excluded, C5 remains
  });

  it("requires a signal beyond type (shared net / value / mapped neighbor)", () => {
    const s = chooseChainSuggestion(base({
      anchorLt: comp("Z1", "x", ["A"], 0, 0), anchorKi: comp("Z1", "x", ["NA"], 0, 0),
      ltComps: [comp("Z1", "x", ["A"]), comp("R7", "999", ["A"])],
      kiComps: [comp("Z1", "x", ["NA"]), comp("R8", "111", ["NA"])], // adjacent, but diff value, no mapped nets/neighbors
      isMappedLt: () => false, isMappedKi: () => false,
      netCounterpartLt: () => undefined,
      componentCounterpartLt: () => undefined,
    }));
    expect(s).toBeNull();
  });

  it("prefers the candidate connected to a shared mapped component neighbor", () => {
    // Anchor R1<->RX. D1 and D2 are diodes connected to anchor net A; neither matches by value.
    // D1 also connects (via net M) to mapped transistor Q1<->QK; D2 connects to nothing else mapped.
    // The kicad diode connected to QK (D7) should win over the unrelated one (D8).
    const s = chooseChainSuggestion({
      anchorLt: comp("R1", "1k", ["A"], 0, 0),
      anchorKi: comp("RX", "1k", ["NA"], 0, 0),
      ltComps: [
        comp("R1", "1k", ["A"]), comp("Q1", "npn", ["M", "X"]),
        comp("D1", "d1", ["A", "M"], 5, 0), comp("D2", "d2", ["A", "Y"], 6, 0),
      ],
      kiComps: [
        comp("RX", "1k", ["NA"]), comp("QK", "BD", ["NM", "NX"]),
        comp("D7", "dk", ["NA", "NM"], 5, 0), comp("D8", "dz", ["NA", "NY"], 6, 0),
      ],
      isMappedLt: (r) => r === "R1" || r === "Q1",
      isMappedKi: (r) => r === "RX" || r === "QK",
      netCounterpartLt: (n) => (n === "A" ? "NA" : undefined), // net M not mapped
      componentCounterpartLt: (r) => (r === "R1" ? "RX" : r === "Q1" ? "QK" : undefined),
    });
    expect(s).toMatchObject({ ltRef: "D1", kiRef: "D7" });
  });
});
