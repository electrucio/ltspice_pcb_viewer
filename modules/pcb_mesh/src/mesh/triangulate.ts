/**
 * Triangulation of copper regions + optional uniform refinement.
 *
 * Triangulation is ear clipping (`earcut`) per polygon-with-holes. Ear clipping is
 * exact on area (it partitions the polygon) but gives no angle guarantee — slivers
 * happen; `quality.minAngleDeg` reports them honestly. Refinement is uniform 1→4
 * midpoint subdivision with shared-midpoint dedup, so it stays conforming (no hanging
 * nodes) and preserves area exactly. A quality (Delaunay/Ruppert) mesher is the
 * planned upgrade, not this file's job.
 */

import earcut from "earcut";
import type { CopperRegion, MeshQuality, MultiPolygon, RegionMesh } from "../types.js";
import { multiPolygonArea } from "../types.js";
import { triangulateQuality } from "./delaunay.js";
import { triangulateRuppert } from "./ruppert.js";

export interface RawMesh {
  vertices: number[]; // interleaved x,y
  triangles: number[];
}

/** Ear-clip every polygon of a multipolygon into one shared vertex/index buffer. */
export function triangulateMultiPolygon(mp: MultiPolygon): RawMesh {
  const vertices: number[] = [];
  const triangles: number[] = [];
  for (const poly of mp) {
    const flat: number[] = [];
    const holeIndices: number[] = [];
    for (let r = 0; r < poly.length; r++) {
      if (r > 0) holeIndices.push(flat.length / 2);
      for (const [x, y] of poly[r]!) flat.push(x, y);
    }
    const offset = vertices.length / 2;
    const tris = earcut(flat, holeIndices.length ? holeIndices : undefined);
    vertices.push(...flat);
    for (const i of tris) triangles.push(offset + i);
  }
  return { vertices, triangles };
}

function triangleArea(vs: number[], a: number, b: number, c: number): number {
  const ax = vs[2 * a]!, ay = vs[2 * a + 1]!;
  const bx = vs[2 * b]!, by = vs[2 * b + 1]!;
  const cx = vs[2 * c]!, cy = vs[2 * c + 1]!;
  return Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
}

/** Drop exactly-degenerate (zero-area) triangles earcut may emit on collinear input. */
export function dropDegenerate(mesh: RawMesh): RawMesh {
  const triangles: number[] = [];
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    const [a, b, c] = [mesh.triangles[t]!, mesh.triangles[t + 1]!, mesh.triangles[t + 2]!];
    if (triangleArea(mesh.vertices, a, b, c) > 0) triangles.push(a, b, c);
  }
  return { vertices: mesh.vertices, triangles };
}

export function maxEdge(mesh: RawMesh): number {
  const vs = mesh.vertices;
  let max = 0;
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = mesh.triangles[t + e]!, b = mesh.triangles[t + ((e + 1) % 3)]!;
      const d = Math.hypot(vs[2 * a]! - vs[2 * b]!, vs[2 * a + 1]! - vs[2 * b + 1]!);
      if (d > max) max = d;
    }
  }
  return max;
}

const MAX_TRIANGLES = 2_000_000; // refinement safety valve per region

/**
 * Adaptive conforming refinement (Rivara-style marked-edge bisection): only triangles
 * with an edge longer than `targetEdge` are split, by the midpoint of their longest
 * edge; a closure pass marks neighbours' longest edges too, so shared midpoints stay
 * conforming (no hanging nodes). Triangle count scales with copper area / target²
 * (graded mesh), unlike uniform 1→4 subdivision which multiplies the WHOLE region by
 * 4 per pass to tame its single longest edge. Bisection is area-exact.
 */
export function refineToEdgeLength(mesh: RawMesh, targetEdge: number): RawMesh {
  if (!Number.isFinite(targetEdge) || targetEdge <= 0) return mesh;
  const vertices = mesh.vertices.slice();
  let tris = mesh.triangles.slice();
  const target2 = targetEdge * targetEdge;
  const KEY = (a: number, b: number) => (a < b ? a * 0x4000000 + b : b * 0x4000000 + a);
  const len2 = (a: number, b: number) => {
    const dx = vertices[2 * a]! - vertices[2 * b]!, dy = vertices[2 * a + 1]! - vertices[2 * b + 1]!;
    return dx * dx + dy * dy;
  };
  /** longest edge of (a,b,c) as [u, v, length²] */
  const longest = (a: number, b: number, c: number): [number, number, number] => {
    const ab = len2(a, b), bc = len2(b, c), ca = len2(c, a);
    if (ab >= bc && ab >= ca) return [a, b, ab];
    if (bc >= ca) return [b, c, bc];
    return [c, a, ca];
  };

  for (let pass = 0; pass < 64 && tris.length / 3 < MAX_TRIANGLES; pass++) {
    // 1) mark the longest edge of every oversize triangle
    const marked = new Set<number>();
    for (let t = 0; t < tris.length; t += 3) {
      const [u, v, l2] = longest(tris[t]!, tris[t + 1]!, tris[t + 2]!);
      if (l2 > target2) marked.add(KEY(u, v));
    }
    if (!marked.size) break;
    // 2) conformity closure: a triangle with ANY marked edge must have its longest marked
    for (let changed = true; changed; ) {
      changed = false;
      for (let t = 0; t < tris.length; t += 3) {
        const a = tris[t]!, b = tris[t + 1]!, c = tris[t + 2]!;
        if (marked.has(KEY(a, b)) || marked.has(KEY(b, c)) || marked.has(KEY(c, a))) {
          const [u, v] = longest(a, b, c);
          const k = KEY(u, v);
          if (!marked.has(k)) { marked.add(k); changed = true; }
        }
      }
    }
    // 3) split: bisect by the longest marked edge; children inherit at most one
    //    original (possibly marked) edge each, so recursion depth ≤ 3
    const midpoints = new Map<number, number>();
    const mid = (a: number, b: number): number => {
      const key = KEY(a, b);
      let m = midpoints.get(key);
      if (m === undefined) {
        m = vertices.length / 2;
        vertices.push((vertices[2 * a]! + vertices[2 * b]!) / 2, (vertices[2 * a + 1]! + vertices[2 * b + 1]!) / 2);
        midpoints.set(key, m);
      }
      return m;
    };
    const out: number[] = [];
    const split = (a: number, b: number, c: number): void => {
      // rotate so the longest marked edge is (a,b); new-midpoint edges are never marked
      let best = -1, ra = a, rb = b, rc = c;
      const consider = (u: number, v: number, w: number) => {
        if (marked.has(KEY(u, v))) { const l = len2(u, v); if (l > best) { best = l; ra = u; rb = v; rc = w; } }
      };
      consider(a, b, c); consider(b, c, a); consider(c, a, b);
      if (best < 0) { out.push(a, b, c); return; }
      const m = mid(ra, rb);
      split(ra, m, rc);
      split(m, rb, rc);
    };
    for (let t = 0; t < tris.length; t += 3) split(tris[t]!, tris[t + 1]!, tris[t + 2]!);
    tris = out;
  }
  return { vertices, triangles: tris };
}

export function measureQuality(mesh: RawMesh): MeshQuality {
  const vs = mesh.vertices;
  let minAngle = Infinity, maxE = 0, worstAspect = 0, sliverCount = 0;
  const angleHistogramDeg = [0, 0, 0, 0, 0, 0]; // 10° bins by per-triangle min angle
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    const i = [mesh.triangles[t]!, mesh.triangles[t + 1]!, mesh.triangles[t + 2]!];
    let triMin = Infinity, triMaxEdge = 0;
    for (let k = 0; k < 3; k++) {
      const p = i[k]!, q = i[(k + 1) % 3]!, r = i[(k + 2) % 3]!;
      const ux = vs[2 * q]! - vs[2 * p]!, uy = vs[2 * q + 1]! - vs[2 * p + 1]!;
      const wx = vs[2 * r]! - vs[2 * p]!, wy = vs[2 * r + 1]! - vs[2 * p + 1]!;
      const dot = ux * wx + uy * wy;
      const lu = Math.hypot(ux, uy);
      const den = lu * Math.hypot(wx, wy);
      if (den > 0) triMin = Math.min(triMin, Math.acos(Math.max(-1, Math.min(1, dot / den))));
      if (lu > triMaxEdge) triMaxEdge = lu;
    }
    const area = triangleArea(vs, i[0]!, i[1]!, i[2]!);
    const triMinDeg = Number.isFinite(triMin) ? (triMin * 180) / Math.PI : 0;
    angleHistogramDeg[Math.min(5, Math.floor(triMinDeg / 10))]!++;
    if (triMinDeg < 20) sliverCount++;
    const aspect = area > 0 ? (triMaxEdge * triMaxEdge) / (2 * area) : Infinity;
    if (aspect > worstAspect) worstAspect = aspect;
    if (triMaxEdge > maxE) maxE = triMaxEdge;
    if (triMin < minAngle) minAngle = triMin;
  }
  return {
    triangleCount: mesh.triangles.length / 3,
    vertexCount: mesh.vertices.length / 2,
    minAngleDeg: Number.isFinite(minAngle) ? (minAngle * 180) / Math.PI : 0,
    maxEdgeLength: maxE,
    angleHistogramDeg,
    sliverCount,
    worstAspect,
  };
}

export function meshArea(mesh: RawMesh): number {
  let s = 0;
  for (let t = 0; t < mesh.triangles.length; t += 3)
    s += triangleArea(mesh.vertices, mesh.triangles[t]!, mesh.triangles[t + 1]!, mesh.triangles[t + 2]!);
  return s;
}

/** Triangulate (and optionally refine) one copper region into its final RegionMesh. */
export function meshRegion(region: CopperRegion, targetEdge: number, refinement: "ruppert" | "delaunay" | "bisect" = "delaunay"): RegionMesh {
  let base: RawMesh;
  if (refinement === "ruppert") {
    // quality-guaranteed CDT (WASM); bounds angle + area, so no straggler bisection —
    // it would only damage the angle guarantee
    base = triangulateRuppert(region.polygons, targetEdge);
  } else if (Number.isFinite(targetEdge) && targetEdge > 0 && refinement === "delaunay") {
    // generate homogeneous triangles directly; bisect the few boundary stragglers
    base = triangulateQuality(region.polygons, targetEdge);
  } else {
    base = triangulateMultiPolygon(region.polygons);
  }
  const clean = dropDegenerate(base);
  const raw = refinement === "ruppert" ? clean : refineToEdgeLength(clean, targetEdge);
  return {
    layer: region.layer,
    net: region.net,
    islands: region.polygons.length,
    holes: region.polygons.reduce((s, poly) => s + poly.length - 1, 0),
    degenerateTriangles: (base.triangles.length - clean.triangles.length) / 3,
    vertices: Float64Array.from(raw.vertices),
    triangles: Uint32Array.from(raw.triangles),
    outlineArea: multiPolygonArea(region.polygons),
    meshArea: meshArea(raw),
    quality: measureQuality(raw),
  };
}
