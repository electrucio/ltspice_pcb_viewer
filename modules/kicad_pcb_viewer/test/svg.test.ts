import { describe, it, expect } from "vitest";
import { arcPath } from "../src/render/svg.js";

// Parse "M ax ay A r r 0 large sweep cx cy" into its pieces.
function parseArc(d: string) {
  const m = d.match(/^M (\S+) (\S+) A (\S+) \S+ 0 (\d) (\d) (\S+) (\S+)$/);
  if (!m) return null;
  return {
    start: [+m[1]!, +m[2]!], r: +m[3]!, large: +m[4]!, sweep: +m[5]!, end: [+m[6]!, +m[7]!],
  };
}

const S = 1 / Math.SQRT2; // 0.707…

describe("arcPath", () => {
  it("minor arc S=(1,0)→E=(0,1) through the down-right mid → large 0, sweep 1", () => {
    const a = parseArc(arcPath({ x: 1, y: 0 }, { x: S, y: S }, { x: 0, y: 1 }))!;
    expect(a).not.toBeNull();
    expect(a.r).toBeCloseTo(1, 6);
    expect([a.large, a.sweep]).toEqual([0, 1]);
    expect(a.start).toEqual([1, 0]);
    expect(a.end).toEqual([0, 1]);
  });

  it("major arc (same endpoints, mid on the far side) → large 1, sweep 0", () => {
    const a = parseArc(arcPath({ x: 1, y: 0 }, { x: -S, y: -S }, { x: 0, y: 1 }))!;
    expect([a.large, a.sweep]).toEqual([1, 0]);
    expect(a.r).toBeCloseTo(1, 6);
  });

  it("reversing start/end flips the sweep but not the large-arc flag", () => {
    const fwd = parseArc(arcPath({ x: 1, y: 0 }, { x: S, y: S }, { x: 0, y: 1 }))!;
    const rev = parseArc(arcPath({ x: 0, y: 1 }, { x: S, y: S }, { x: 1, y: 0 }))!;
    expect(rev.large).toBe(fwd.large); // both minor
    expect(rev.sweep).toBe(1 - fwd.sweep); // opposite traversal
  });

  it("a >180° arc reports large=1 (regression: large-arc-flag was hardcoded 0)", () => {
    // three points on the unit circle spanning 270°: 0°, 135°, 270°
    const p = (deg: number) => ({ x: Math.cos((deg * Math.PI) / 180), y: Math.sin((deg * Math.PI) / 180) });
    const a = parseArc(arcPath(p(0), p(135), p(270)))!;
    expect(a.large).toBe(1);
  });

  it("collinear points degrade to a straight line", () => {
    expect(arcPath({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 })).toBe("M 0 0 L 2 2");
  });
});
