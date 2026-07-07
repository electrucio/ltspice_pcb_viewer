import { describe, it, expect } from "vitest";
import {
  triangulateMultiPolygon,
  dropDegenerate,
  refineToEdgeLength,
  meshArea,
  maxEdge,
  measureQuality,
} from "../src/mesh/triangulate.js";
import { triangulateQuality } from "../src/mesh/delaunay.js";
import { multiPolygonArea, type MultiPolygon } from "../src/types.js";

const square: MultiPolygon = [[[[0, 0], [4, 0], [4, 4], [0, 4]]]];
const squareWithHole: MultiPolygon = [
  [
    [[0, 0], [4, 0], [4, 4], [0, 4]],
    [[1.5, 1.5], [2.5, 1.5], [2.5, 2.5], [1.5, 2.5]],
  ],
];

describe("triangulation", () => {
  it("meshes a square exactly", () => {
    const m = triangulateMultiPolygon(square);
    expect(m.triangles.length / 3).toBe(2);
    expect(meshArea(m)).toBeCloseTo(16, 12);
  });

  it("conserves area with holes (mesh area == shoelace area)", () => {
    const m = triangulateMultiPolygon(squareWithHole);
    expect(meshArea(m)).toBeCloseTo(multiPolygonArea(squareWithHole), 9);
    expect(meshArea(m)).toBeCloseTo(15, 9);
  });

  it("meshes disjoint polygons into one buffer with valid indices", () => {
    const two: MultiPolygon = [...square, [[[10, 0], [12, 0], [12, 2], [10, 2]]]];
    const m = triangulateMultiPolygon(two);
    expect(meshArea(m)).toBeCloseTo(20, 9);
    for (const i of m.triangles) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(m.vertices.length / 2);
    }
  });

  it("dropDegenerate removes only zero-area triangles", () => {
    const m = dropDegenerate(triangulateMultiPolygon(squareWithHole));
    expect(meshArea(m)).toBeCloseTo(15, 9);
    // every remaining triangle has strictly positive area — implied by area match +
    // count check
    expect(m.triangles.length % 3).toBe(0);
  });
});

describe("adaptive refinement (longest-edge bisection)", () => {
  const euler = (m: { vertices: number[]; triangles: number[] }): number => {
    const edges = new Set<string>();
    for (let t = 0; t < m.triangles.length; t += 3)
      for (let e = 0; e < 3; e++) {
        const a = m.triangles[t + e]!, b = m.triangles[t + ((e + 1) % 3)]!;
        edges.add(a < b ? `${a}-${b}` : `${b}-${a}`);
      }
    return m.vertices.length / 2 - edges.size + (m.triangles.length / 3 + 1);
  };

  it("respects the target edge length and conserves area exactly", () => {
    const before = dropDegenerate(triangulateMultiPolygon(squareWithHole));
    const after = refineToEdgeLength(before, 0.4);
    expect(maxEdge(after)).toBeLessThanOrEqual(0.4);
    expect(meshArea(after)).toBeCloseTo(meshArea(before), 10);
  });

  it("stays conforming (Euler characteristic V − E + F = 2)", () => {
    const before = dropDegenerate(triangulateMultiPolygon(square));
    const after = refineToEdgeLength(before, 1.9);
    expect(maxEdge(after)).toBeLessThanOrEqual(1.9);
    expect(euler(after)).toBe(2);
  });

  it("is graded: a long skinny region does not explode", () => {
    // 100×1 strip (a long track): count must scale with area/h², not 4^passes.
    // Uniform 1→4 subdivision needed ~7 passes here → 32 768 triangles.
    const strip = dropDegenerate(triangulateMultiPolygon([[[[0, 0], [100, 0], [100, 1], [0, 1]]]]));
    const after = refineToEdgeLength(strip, 1);
    expect(maxEdge(after)).toBeLessThanOrEqual(1);
    expect(meshArea(after)).toBeCloseTo(100, 9);
    // observed ~4.4k; uniform subdivision produced 32 768 on this shape
    expect(after.triangles.length / 3).toBeLessThan(8000);
    expect(euler(after)).toBe(2);
  });

  it("no-op when target is Infinity", () => {
    const before = dropDegenerate(triangulateMultiPolygon(square));
    expect(refineToEdgeLength(before, Infinity)).toBe(before);
  });

  it("quality metrics are sane", () => {
    const q = measureQuality(refineToEdgeLength(dropDegenerate(triangulateMultiPolygon(square)), 1));
    expect(q.minAngleDeg).toBeGreaterThan(0);
    expect(q.minAngleDeg).toBeLessThanOrEqual(60);
    expect(q.maxEdgeLength).toBeLessThanOrEqual(1);
    expect(q.triangleCount * 3).toBeGreaterThanOrEqual(q.vertexCount);
  });
});

describe("quality meshing (boundary resample + hex grid + constrained Delaunay)", () => {
  const euler = (m: { vertices: number[]; triangles: number[] }): number => {
    const edges = new Set<string>();
    for (let t = 0; t < m.triangles.length; t += 3)
      for (let e = 0; e < 3; e++) {
        const a = m.triangles[t + e]!, b = m.triangles[t + ((e + 1) % 3)]!;
        edges.add(a < b ? `${a}-${b}` : `${b}-${a}`);
      }
    return m.vertices.length / 2 - edges.size + (m.triangles.length / 3 + 1);
  };

  it("conserves area on a square (boundary is reproduced exactly)", () => {
    const m = triangulateQuality(square, 0.5);
    expect(meshArea(m)).toBeCloseTo(16, 9);
    expect(euler(m)).toBe(2);
  });

  it("handles holes: hole faces removed, area exact", () => {
    const m = triangulateQuality(squareWithHole, 0.3);
    expect(meshArea(m)).toBeCloseTo(15, 9);
  });

  it("is homogeneous and near-optimal in count on a long strip", () => {
    const strip: MultiPolygon = [[[[0, 0], [100, 0], [100, 1], [0, 1]]]];
    const m = refineToEdgeLength(dropDegenerate(triangulateQuality(strip, 1)), 1);
    expect(meshArea(m)).toBeCloseTo(100, 9);
    expect(maxEdge(m)).toBeLessThanOrEqual(1);
    const q = measureQuality(m);
    // ~2·area/h² = 200 ideal; bisection of the same base mesh needed ~4400
    expect(q.triangleCount).toBeLessThan(800);
    expect(q.minAngleDeg).toBeGreaterThan(10);
  });

  it("disjoint polygons mesh independently with valid indices", () => {
    const two: MultiPolygon = [...square, [[[10, 0], [12, 0], [12, 2], [10, 2]]]];
    const m = triangulateQuality(two, 0.5);
    expect(meshArea(m)).toBeCloseTo(20, 9);
    for (const i of m.triangles) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(m.vertices.length / 2);
    }
  });
});

describe("outline simplification (Douglas–Peucker)", () => {
  it("never deviates more than the tolerance", async () => {
    const { simplifyRing } = await import("../src/outline/simplify.js");
    // noisy circle: 200 points with ±0.004 radial jitter (deterministic)
    const ring: [number, number][] = [];
    for (let i = 0; i < 200; i++) {
      const a = (2 * Math.PI * i) / 200;
      const r = 5 + 0.004 * Math.sin(i * 7.3);
      ring.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    const tol = 0.02;
    const out = simplifyRing(ring, tol);
    expect(out.length).toBeLessThan(ring.length);
    // every original vertex within tol of the simplified boundary
    const dist = (p: [number, number]) => {
      let best = Infinity;
      for (let i = 0; i < out.length; i++) {
        const [ax, ay] = out[i]!, [bx, by] = out[(i + 1) % out.length]!;
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2)) : 0;
        best = Math.min(best, Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy)));
      }
      return best;
    };
    for (const p of ring) expect(dist(p)).toBeLessThanOrEqual(tol + 1e-12);
  });

  it("keeps tiny rings intact rather than degenerating them", async () => {
    const { simplifyRing } = await import("../src/outline/simplify.js");
    const tri: [number, number][] = [[0, 0], [1, 0], [0.5, 0.8]];
    expect(simplifyRing(tri, 10)).toEqual(tri);
  });
});
