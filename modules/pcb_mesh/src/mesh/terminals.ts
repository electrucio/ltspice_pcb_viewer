/**
 * Terminal-aware solver meshes (the M4 prerequisite).
 *
 * A pad terminal is an equipotential (the component lead/solder shorts it), so the
 * FEM must NOT solve inside it: each terminal pad becomes a HOLE in the copper
 * region, and the hole's boundary ring — which the CDT conforms to exactly, Steiner
 * points included — is the terminal where Dirichlet BCs apply. Same mechanism for
 * vias (as internal inter-layer terminals).
 *
 * Robustness: terminal rings are the pad outlines INSET by `terminalInset`
 * (default 0.02 mm ≥ 2× the outline-simplification tolerance), so they are strictly
 * inside real copper and cannot cross the region boundary. Drill rings swallowed by a
 * terminal ring are dropped (the terminal hole covers them). Overlapping same-net pad
 * terminals are merged into one terminal (they are electrically one node). Anything
 * that still can't be placed safely is skipped AND reported, never silently.
 */

import pc from "polygon-clipping";
import type { Pcb } from "../../../kicad_pcb_viewer/src/parser/pcb.js";
import type { MeshOptions, MultiPolygon, Polygon, RegionMesh, Ring, Vec2 } from "../types.js";
import { resolveOptions } from "../types.js";
import { copperOrderOf, extractCopperRegions, padOnLayer, viaSpansLayer } from "../outline/copper.js";
import { circleOutline, padArcRadius, padOutline, segmentsForRadius } from "../outline/primitives.js";
import { meshRegion } from "./triangulate.js";

export interface Terminal {
  /** "Q3.2" for pads (merged: "Q3.2+R1.1"), "via@x,y" for vias */
  id: string;
  kind: "pad" | "via";
  /** pad refs covered ("REF.pad"), empty for vias */
  refs: string[];
  /**
   * constituent terminal ids (pads AND vias). Cross-layer identity must use these,
   * never `id`: a via-in-pad merges into "PAD+via@x,y" on the pad's layer while the
   * same via is plain "via@x,y" everywhere else.
   */
  members: string[];
  /** indices into the RegionMesh vertex buffer that lie on the terminal ring(s) */
  vertexIndices: number[];
}

export interface TerminalMesh {
  mesh: RegionMesh;
  terminals: Terminal[];
  /** terminal ids that could not be safely constrained (reported, not silent) */
  skipped: string[];
}

export interface TerminalMeshOptions extends MeshOptions {
  /** inset of terminal rings from the pad outline, mm (default 0.02) */
  terminalInset?: number;
  /** also create (internal) terminals for vias of the net — default true */
  viaTerminals?: boolean;
}

// ---- small geometry helpers -------------------------------------------------

function centroid(ring: Ring): Vec2 {
  let x = 0, y = 0;
  for (const [px, py] of ring) { x += px; y += py; }
  return [x / ring.length, y / ring.length];
}

/**
 * Uniform inward offset of a CONVEX ring: every edge moves `inset` along its inward
 * normal; new vertices are the intersections of adjacent offset edges. (A radial
 * shrink toward the centroid is NOT uniform — a 0.2 mm-wide pad would inset its short
 * axis by only ~4 µm, leaving micro-channels that explode the quality mesher.)
 */
function insetRing(ring: Ring, inset: number): Ring | null {
  const n = ring.length;
  if (n < 3) return null;
  const [cx, cy] = centroid(ring);
  // offset line per edge: point p + inward normal·inset, direction d
  const lines: Array<{ px: number; py: number; dx: number; dy: number }> = [];
  for (let i = 0; i < n; i++) {
    const [ax, ay] = ring[i]!, [bx, by] = ring[(i + 1) % n]!;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-12) continue; // skip degenerate edges
    let nx = -dy / len, ny = dx / len;
    // orient the normal toward the interior (centroid side)
    if (nx * (cx - ax) + ny * (cy - ay) < 0) { nx = -nx; ny = -ny; }
    lines.push({ px: ax + nx * inset, py: ay + ny * inset, dx, dy });
  }
  if (lines.length < 3) return null;
  const out: Ring = [];
  for (let i = 0; i < lines.length; i++) {
    const a = lines[(i + lines.length - 1) % lines.length]!, b = lines[i]!;
    const det = a.dx * b.dy - a.dy * b.dx;
    if (Math.abs(det) < 1e-12) continue; // collinear neighbours — vertex is redundant
    const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / det;
    out.push([a.px + t * a.dx, a.py + t * a.dy]);
  }
  if (out.length < 3) return null;
  // reject collapsed insets (pad thinner than 2·inset): vertices must stay inside
  for (const [x, y] of out) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[i]!, [bx, by] = ring[j]!;
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
    }
    if (!inside) return null;
  }
  return out;
}

function pointInRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i]!, [bx, by] = ring[j]!;
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

function ringsBBoxOverlap(a: Ring, b: Ring): boolean {
  let aMinX = Infinity, aMinY = Infinity, aMaxX = -Infinity, aMaxY = -Infinity;
  for (const [x, y] of a) { aMinX = Math.min(aMinX, x); aMinY = Math.min(aMinY, y); aMaxX = Math.max(aMaxX, x); aMaxY = Math.max(aMaxY, y); }
  let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
  for (const [x, y] of b) { bMinX = Math.min(bMinX, x); bMinY = Math.min(bMinY, y); bMaxX = Math.max(bMaxX, x); bMaxY = Math.max(bMaxY, y); }
  return aMinX <= bMaxX && bMinX <= aMaxX && aMinY <= bMaxY && bMinY <= aMaxY;
}

function segsIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
  const d = (a: Vec2, b: Vec2, c: Vec2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0));
}

function ringsCross(a: Ring, b: Ring): boolean {
  if (!ringsBBoxOverlap(a, b)) return false;
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++)
      if (segsIntersect(a[i]!, a[(i + 1) % a.length]!, b[j]!, b[(j + 1) % b.length]!)) return true;
  return false;
}

function distToRing(x: number, y: number, ring: Ring): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i]!, [bx, by] = ring[j]!;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
}

// ---- terminal construction ---------------------------------------------------

interface TerminalSpec {
  id: string;
  kind: "pad" | "via";
  refs: string[];
  members: string[];
  rings: Ring[];
}

/** Merge overlapping specs (electrically one node) via polygon union. */
function mergeOverlapping(specs: TerminalSpec[]): TerminalSpec[] {
  const out: TerminalSpec[] = [];
  for (const spec of specs) {
    // overlap = edges cross OR one ring contains the other (checked both ways —
    // a via-in-pad ring sits strictly inside the pad ring with no edge crossing)
    const hit = out.find((o) => o.rings.some((r) => spec.rings.some((s) =>
      ringsCross(r, s) ||
      (ringsBBoxOverlap(r, s) && (pointInRing(s[0]![0], s[0]![1], r) || pointInRing(r[0]![0], r[0]![1], s))),
    )));
    if (!hit) { out.push({ ...spec, rings: [...spec.rings], refs: [...spec.refs], members: [...spec.members] }); continue; }
    const union = pc.union(
      hit.rings.map((r) => [r]) as Parameters<typeof pc.union>[0],
      ...(spec.rings.map((r) => [r]) as Array<Parameters<typeof pc.union>[0]>),
    );
    hit.rings = union.map((poly) => poly[0] as Ring); // outer rings only — terminals have no holes
    hit.id = `${hit.id}+${spec.id}`;
    hit.refs.push(...spec.refs);
    hit.members.push(...spec.members);
  }
  return out;
}

/**
 * Build the solver mesh for one (layer, net): copper region with terminal pads (and
 * optionally vias) as tagged, mesh-conforming holes.
 */
export function buildTerminalMesh(pcb: Pcb, layer: string, net: string, options?: TerminalMeshOptions): TerminalMesh | null {
  const o = resolveOptions(options);
  const inset = options?.terminalInset ?? Math.max(0.02, 2 * o.simplifyTolerance);
  const segs = (r: number) => Math.max(o.arcSegments, segmentsForRadius(r, o.chordTolerance));

  const [region] = extractCopperRegions(pcb, { ...options, layers: [layer], nets: [net] });
  if (!region) return null;

  // terminal specs from pads (+ vias)
  const specs: TerminalSpec[] = [];
  for (const f of pcb.footprints)
    for (const p of f.pads) {
      if (!padOnLayer(p, layer) || p.net !== net) continue;
      const ring = insetRing(padOutline(p, segs(padArcRadius(p))), inset);
      const id = `${p.ref}.${p.number}`;
      if (ring) specs.push({ id, kind: "pad", refs: [id], members: [id], rings: [ring] });
    }
  if (options?.viaTerminals ?? true) {
    const copperOrder = copperOrderOf(pcb);
    for (const v of pcb.vias) {
      if (v.net !== net || !viaSpansLayer(v, layer, copperOrder)) continue;
      // annulus MIDLINE circle, not an inset of the outer ring: a via is usually wider
      // than the traces it joins, so its outer ring sticks out of the copper boundary
      // (an inset ring would cross it and get skipped). The midline is guaranteed
      // strictly inside the annulus copper.
      const rMid = (v.drill / 2 + v.size / 2) / 2;
      if (rMid <= v.drill / 2) continue; // degenerate barrel
      const ring = circleOutline(v.pos.x, v.pos.y, rMid, segs(rMid));
      const id = `via@${v.pos.x},${v.pos.y}`;
      specs.push({ id, kind: "via", refs: [], members: [id], rings: [ring] });
    }
  }

  const merged = mergeOverlapping(specs);
  const skipped: string[] = [];

  // place each terminal ring as a hole in its island
  const polygons: MultiPolygon = region.polygons.map((poly) => poly.map((r) => r.slice()) as Polygon);
  const placed: Array<{ spec: TerminalSpec; rings: Ring[] }> = [];
  for (const spec of merged) {
    const rings: Ring[] = [];
    let ok = true;
    for (const ring of spec.rings) {
      const [sx, sy] = ring[0]!;
      const poly = polygons.find((p) => pointInRing(sx, sy, p[0]!));
      if (!poly) { ok = false; break; } // terminal outside this net's copper (shouldn't happen)
      // must not cross the island outline or surviving holes; swallow contained holes
      if (ringsCross(ring, poly[0]!)) { ok = false; break; }
      for (let h = poly.length - 1; h >= 1; h--) {
        const hole = poly[h]!;
        if (ringsCross(ring, hole)) { ok = false; break; }
        if (pointInRing(hole[0]![0], hole[0]![1], ring)) poly.splice(h, 1); // drill inside terminal
        else if (pointInRing(sx, sy, hole)) { ok = false; break; } // terminal inside a void
      }
      if (!ok) break;
      poly.push(ring);
      rings.push(ring);
    }
    if (ok && rings.length) placed.push({ spec, rings });
    else skipped.push(spec.id);
  }

  const mesh = meshRegion({ ...region, polygons }, o.maxEdgeLength, o.refinement);

  // terminal vertex sets: mesh vertices on the terminal rings (Steiner points incl.)
  const TOL = 1e-4; // mm
  const terminals: Terminal[] = placed.map(({ spec, rings }) => {
    const vertexIndices: number[] = [];
    for (let i = 0; i < mesh.vertices.length / 2; i++) {
      const x = mesh.vertices[2 * i]!, y = mesh.vertices[2 * i + 1]!;
      if (rings.some((r) => distToRing(x, y, r) <= TOL)) vertexIndices.push(i);
    }
    return { id: spec.id, kind: spec.kind, refs: spec.refs, members: spec.members, vertexIndices };
  });

  return { mesh, terminals: terminals.filter((t) => t.vertexIndices.length > 0), skipped };
}
