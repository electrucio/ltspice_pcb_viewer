import { describe, it, expect } from "vitest";
import { formatEng } from "../src/sim/summary.js";

describe("formatEng", () => {
  it("uses engineering prefixes without dropping significant zeros", () => {
    expect(formatEng(0.038, "A")).toBe("38 mA");
    expect(formatEng(0.14, "A")).toBe("140 mA"); // regression: was "14 mA"
    expect(formatEng(0.2, "A")).toBe("200 mA"); // regression: was "2 mA"
    expect(formatEng(3.3, "V")).toBe("3.3 V");
    expect(formatEng(15, "V")).toBe("15 V");
    expect(formatEng(1000, "Hz")).toBe("1 kHz");
    expect(formatEng(-0.0005, "A")).toBe("-500 µA");
  });
  it("treats sub-pico magnitudes as zero and handles non-finite", () => {
    expect(formatEng(-3.5e-17, "V")).toBe("0 V");
    expect(formatEng(0, "V")).toBe("0 V");
    expect(formatEng(NaN, "V")).toBe("–");
    expect(formatEng(null, "V")).toBe("–");
  });
});
