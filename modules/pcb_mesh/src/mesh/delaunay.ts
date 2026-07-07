/**
 * Quality meshing: near-homogeneous triangles of target size `h`, generated directly —
 * NOT by refining the ear-clip mesh.
 *
 * Per polygon-with-holes: (1) resample every boundary edge to segments ≤ h (points lie
 * exactly on the original edges, so the covered region — and its area — is unchanged);
 * (2) drop a hexagonal grid of interior points at spacing `h`, keeping only points
 * comfortably inside (≥ ~h/2 from the boundary, tested by trimmed scanline intervals at
 * y and y ± h/2); (3) constrained Delaunay triangulation (`cdt2d`, robust predicates)
 * with the boundary segments as constraints, exterior (and hole) faces removed.
 *
 * Triangle count ≈ 2·area/h² — the information-theoretic floor for uniform size — and
 * interior triangles are near-equilateral (hex grid + Delaunay). Compare: bisecting the
 * ear-clip mesh reaches the same edge bound with 10–30× more, badly-shaped triangles.
 */

import cdt2d from "cdt2d";
import type { MultiPolygon, Polygon } from "../types.js";
import type { RawMesh } from "./triangulate.js";

/** Even-odd scanline: sorted x-intersections of all rings with the line y = const. */
function crossings(poly: Polygon, y: number): number[] {
  const xs: number[] = [];
  for (const ring of poly) {
    for (let i = 0, n = ring.length; i < n; i++) {
      const [ax, ay] = ring[i]!, [bx, by] = ring[(i + 1) % n]!;
      if (ay > y !== by > y) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
    }
  }
  return xs.sort((a, b) => a - b);
}

/** Is x inside the even-odd intervals, with every interval trimmed by `margin`? */
function insideTrimmed(xs: number[], x: number, margin: number): boolean {
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (x >= xs[i]! + margin && x <= xs[i + 1]! - margin) return true;
  }
  return false;
}

export function triangulateQuality(mp: MultiPolygon, targetEdge: number): RawMesh {
  // Work at 0.9× the target: a hex lattice at spacing exactly `targetEdge` produces
  // edges of length exactly targetEdge, and float noise then pushes half of them just
  // over the bound — the straggler-bisect pass after this would shred the lattice.
  const h = 0.9 * targetEdge;
  const vertices: number[] = [];
  const triangles: number[] = [];

  for (const poly of mp) {
    const pts: number[][] = [];
    const edges: number[][] = [];

    // 1) boundary: resample each ring edge to ≤ h, constraint edges between neighbours
    for (const ring of poly) {
      const start = pts.length;
      for (let i = 0, n = ring.length; i < n; i++) {
        const [ax, ay] = ring[i]!, [bx, by] = ring[(i + 1) % n]!;
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / h));
        for (let s = 0; s < steps; s++) {
          const t = s / steps;
          pts.push([ax + t * (bx - ax), ay + t * (by - ay)]);
        }
      }
      for (let i = start; i < pts.length; i++) edges.push([i, i + 1 === pts.length ? start : i + 1]);
    }

    // 2) interior hexagonal grid, kept only well inside the boundary
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of poly[0]! as unknown as Array<[number, number]>) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    // 0.35·h: close enough to the boundary that boundary↔grid edges stay ≤ h (so the
    // straggler-bisect pass after this stays a no-op almost everywhere), far enough
    // that the thinnest boundary triangle keeps a workable min angle (~19°)
    const margin = 0.35 * h;
    const dy = h * 0.8660254037844386; // hex row spacing h·√3/2
    let row = 0;
    for (let y = minY + dy; y < maxY - margin / 2; y += dy, row++) {
      const mids = crossings(poly, y);
      if (!mids.length) continue;
      const above = crossings(poly, y + margin);
      const below = crossings(poly, y - margin);
      const x0 = minX + (row % 2 ? h / 2 : 0);
      for (let x = x0 + h; x < maxX; x += h) {
        if (insideTrimmed(mids, x, margin) && insideTrimmed(above, x, margin) && insideTrimmed(below, x, margin)) {
          pts.push([x, y]);
        }
      }
    }

    // 3) constrained Delaunay; exterior faces (outside the outer ring or inside holes,
    //    by even-odd against the constraint loops) removed by cdt2d
    const tris = cdt2d(pts, edges, { delaunay: true, exterior: false });
    const offset = vertices.length / 2;
    for (const p of pts) vertices.push(p[0]!, p[1]!);
    for (const t of tris) triangles.push(offset + t[0], offset + t[1], offset + t[2]);
  }

  return { vertices, triangles };
}
