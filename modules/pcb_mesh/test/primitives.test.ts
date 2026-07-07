import { describe, it, expect } from "vitest";
import { circleOutline, padOutline, stadiumOutline } from "../src/outline/primitives.js";
import { ringArea } from "../src/types.js";
import { makePad } from "./helpers.js";

const area = (ring: [number, number][]) => Math.abs(ringArea(ring));

describe("primitive outlines (areas vs closed forms)", () => {
  it("circle: inscribed-polygon area converges to πr² from below", () => {
    const r = 1.5;
    const exact = Math.PI * r * r;
    const a64 = area(circleOutline(0, 0, r, 64));
    expect(a64).toBeLessThan(exact);
    expect(a64).toBeCloseTo(exact, 1);
    // deficit shrinks ~1/n²
    const a16 = area(circleOutline(0, 0, r, 16));
    expect((exact - a64) / (exact - a16)).toBeLessThan(0.08);
  });

  it("track stadium: L·W + πr²", () => {
    const L = 10, W = 1, r = W / 2;
    const exact = L * W + Math.PI * r * r;
    const a = area(stadiumOutline({ x: 0, y: 0 }, { x: L, y: 0 }, W, 64));
    expect(Math.abs(a - exact) / exact).toBeLessThan(0.002);
  });

  it("zero-length track degrades to a circle", () => {
    const a = area(stadiumOutline({ x: 3, y: 3 }, { x: 3, y: 3 }, 2, 64));
    expect(Math.abs(a - Math.PI) / Math.PI).toBeLessThan(0.005);
  });

  it("stadium is direction-invariant", () => {
    const a1 = area(stadiumOutline({ x: 0, y: 0 }, { x: 3, y: 4 }, 0.8, 32));
    const a2 = area(stadiumOutline({ x: 3, y: 4 }, { x: 0, y: 0 }, 0.8, 32));
    expect(a1).toBeCloseTo(a2, 12);
  });

  it("rect pad rotated 45° keeps exact area and known extents", () => {
    const p = makePad({ shape: "rect", size: { w: 2, h: 1 }, angle: 45, pos: { x: 10, y: 20 } });
    const ring = padOutline(p, 32);
    expect(area(ring)).toBeCloseTo(2 * 1, 12);
    // rotated rect diagonal extent: (w+h)/√2 total width
    const xs = ring.map((v) => v[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo((2 + 1) / Math.SQRT2, 9);
  });

  it("oval pad = stadium: w·h version", () => {
    const p = makePad({ shape: "oval", size: { w: 3, h: 1 } });
    const exact = (3 - 1) * 1 + Math.PI * 0.25;
    expect(Math.abs(area(padOutline(p, 64)) - exact) / exact).toBeLessThan(0.002);
  });

  it("roundrect pad: w·h − (4−π)·rr²", () => {
    const p = makePad({ shape: "roundrect", size: { w: 2, h: 1 }, rratio: 0.25 });
    const rr = 0.25 * 1; // rratio·min(w,h)
    const exact = 2 * 1 - (4 - Math.PI) * rr * rr;
    expect(Math.abs(area(padOutline(p, 64)) - exact) / exact).toBeLessThan(0.002);
  });

  it("pad rotation matches the viewer's ROT_SIGN convention", () => {
    // a wide rect pad rotated +90° must become tall
    const p = makePad({ shape: "rect", size: { w: 4, h: 1 }, angle: 90 });
    const ring = padOutline(p, 8);
    const xs = ring.map((v) => v[0]), ys = ring.map((v) => v[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(1, 9);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(4, 9);
  });
});
