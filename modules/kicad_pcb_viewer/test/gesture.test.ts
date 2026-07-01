import { describe, it, expect } from "vitest";
import { computeGestureViewBox, wheelZoomFactor, type ViewBox } from "../src/interaction/controller.js";

const rect = { width: 200, height: 100 };

/** Map a content-space point to rect-relative screen pixels under a given viewBox. */
function screenOf(vb: ViewBox, r: typeof rect, p: { x: number; y: number }) {
  return { x: ((p.x - vb.x) / vb.w) * r.width, y: ((p.y - vb.y) / vb.h) * r.height };
}
/** Map a rect-relative screen point to content space under a given viewBox. */
function contentOf(vb: ViewBox, r: typeof rect, p: { x: number; y: number }) {
  return { x: vb.x + (p.x / r.width) * vb.w, y: vb.y + (p.y / r.height) * vb.h };
}

describe("computeGestureViewBox", () => {
  it("a pure pan (scale=1) matches the incremental per-frame pan formula in one shot", () => {
    const vb0: ViewBox = { x: 0, y: 0, w: 100, h: 80 };
    const p0 = { x: 50, y: 20 }, p1 = { x: 70, y: 35 }; // total delta: dx=20, dy=15
    const vb1 = computeGestureViewBox(vb0, rect, p0, p1, 1);
    // hand-derived from vb.x -= (dx/rect.width)*vb.w; vb.y -= (dy/rect.height)*vb.h
    expect(vb1.x).toBeCloseTo(-10, 9);
    expect(vb1.y).toBeCloseTo(-12, 9);
    expect(vb1.w).toBe(100);
    expect(vb1.h).toBe(80);
  });

  it("splitting the same pan into two incremental steps sums to the identical one-shot result", () => {
    // Because w/h are unaffected by a pure pan, repeated incremental application is linear —
    // this reproduces the OLD per-touchmove-frame code path (many small steps) and confirms
    // committing once at gesture-end (the new behavior) converges on the exact same state.
    let vb: ViewBox = { x: 0, y: 0, w: 100, h: 80 };
    const step = (dx: number, dy: number) => { vb = { ...vb, x: vb.x - (dx / rect.width) * vb.w, y: vb.y - (dy / rect.height) * vb.h }; };
    step(10, 5);
    step(10, 10);
    const oneShot = computeGestureViewBox({ x: 0, y: 0, w: 100, h: 80 }, rect, { x: 0, y: 0 }, { x: 20, y: 15 }, 1);
    expect(vb.x).toBeCloseTo(oneShot.x, 9);
    expect(vb.y).toBeCloseTo(oneShot.y, 9);
  });

  it("a pinch (scale≠1) keeps the content point under the gesture's start position tracking the current position", () => {
    const vb0: ViewBox = { x: 10, y: 5, w: 200, h: 150 };
    const p0 = { x: 100, y: 80 }, p1 = { x: 130, y: 60 }, scale = 1.6;
    const anchorContent = contentOf(vb0, rect, p0);
    const vb1 = computeGestureViewBox(vb0, rect, p0, p1, scale);
    expect(vb1.w).toBeCloseTo(vb0.w / scale, 9);
    expect(vb1.h).toBeCloseTo(vb0.h / scale, 9);
    // the point that was at p0 (pre-gesture) must now render at p1 under the committed vb1 —
    // this is the "fingers stay on the content they grabbed" invariant the formula is built for.
    const anchorScreenNow = screenOf(vb1, rect, anchorContent);
    expect(anchorScreenNow.x).toBeCloseTo(p1.x, 9);
    expect(anchorScreenNow.y).toBeCloseTo(p1.y, 9);
  });

  it("a no-movement gesture (tap: p0===p1, scale=1) leaves the viewBox unchanged", () => {
    const vb0: ViewBox = { x: 3, y: -7, w: 55, h: 40 };
    const p = { x: 42, y: 17 };
    const vb1 = computeGestureViewBox(vb0, rect, p, p, 1);
    expect(vb1.x).toBeCloseTo(vb0.x, 9);
    expect(vb1.y).toBeCloseTo(vb0.y, 9);
    expect(vb1.w).toBe(vb0.w);
    expect(vb1.h).toBe(vb0.h);
  });
});

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
