import { describe, it, expect } from "vitest";
import { wheelZoomFactor } from "../src/interaction/controller.js";

describe("wheelZoomFactor", () => {
  it("is proportional to deltaY magnitude, not a fixed step", () => {
    const small = wheelZoomFactor(5);
    const large = wheelZoomFactor(50);
    expect(small).toBeGreaterThan(1);
    expect(large).toBeGreaterThan(small); // a bigger delta zooms more than a small one
    expect(small - 1).toBeLessThan(0.02); // a light trackpad nudge is a gentle step, not ~10%
  });

  it("zooms out for positive deltaY and in for negative deltaY (sign convention preserved)", () => {
    expect(wheelZoomFactor(50)).toBeGreaterThan(1);
    expect(wheelZoomFactor(-50)).toBeLessThan(1);
    expect(wheelZoomFactor(0)).toBeCloseTo(1, 9);
  });

  it("clamps extreme deltaY spikes instead of producing an unbounded jump", () => {
    expect(wheelZoomFactor(100000)).toBeCloseTo(wheelZoomFactor(100), 9);
    expect(wheelZoomFactor(-100000)).toBeCloseTo(wheelZoomFactor(-100), 9);
  });

  it("a full wheel notch (±100) is close to the old fixed 1.1 step", () => {
    expect(wheelZoomFactor(100)).toBeCloseTo(1.1, 1);
  });
});
