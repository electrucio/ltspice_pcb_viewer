/**
 * Douglas–Peucker outline simplification with a hard deviation bound: no point of the
 * original ring ends up farther than `tol` from the simplified boundary. Used to
 * collapse KiCad's very dense zone-fill outlines (sub-0.1 mm arc segments) before
 * meshing — every tiny constraint segment would otherwise seed a local feature that
 * Ruppert refinement resolves at that scale.
 *
 * Applied AFTER the boolean union, so all downstream area accounting (outlineArea,
 * meshArea, the mesh==outline invariant) is consistent with the simplified geometry;
 * the Monte Carlo verifier samples the analytic primitives instead and therefore
 * reports the true area drift introduced by simplification.
 */

import type { MultiPolygon, Ring } from "../types.js";

function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

/** DP on a closed ring: anchors at vertex 0 and the vertex farthest from it. */
export function simplifyRing(ring: Ring, tol: number): Ring {
  const n = ring.length;
  if (n <= 4 || !(tol > 0)) return ring;
  const [x0, y0] = ring[0]!;
  let far = 1, best = -1;
  for (let i = 1; i < n; i++) {
    const dx = ring[i]![0] - x0, dy = ring[i]![1] - y0;
    const d = dx * dx + dy * dy;
    if (d > best) { best = d; far = i; }
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const tol2 = tol * tol;
  // chains (0 → far) and (far → n≡0), endpoints kept, interior decided recursively
  const stack: Array<[number, number]> = [[0, far], [far, n]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const [ax, ay] = ring[a]!;
    const [bx, by] = ring[b % n]!;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist2(ring[i]![0], ring[i]![1], ax, ay, bx, by);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol2) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out: Ring = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(ring[i]!);
  return out.length >= 3 ? out : ring;
}

export function simplifyMultiPolygon(mp: MultiPolygon, tol: number): { polygons: MultiPolygon; removedVertices: number } {
  let removed = 0;
  const polygons: MultiPolygon = [];
  for (const poly of mp) {
    const rings: Ring[] = [];
    for (const ring of poly) {
      const s = simplifyRing(ring, tol);
      removed += ring.length - s.length;
      if (s.length >= 3) rings.push(s);
    }
    if (rings.length && rings[0]!.length >= 3) polygons.push(rings);
  }
  return { polygons, removedVertices: removed };
}
