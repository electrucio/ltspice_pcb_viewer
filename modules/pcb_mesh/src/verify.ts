/**
 * Region analysis + cross-verified areas — the "every number ships with a check" layer.
 *
 * `analyzeRegion(pcb, layer, net)` reports what a selected copper region is made of and
 * computes its area FOUR independent ways:
 *
 *  1. `outline`      — shoelace over the boolean-union polygons (polygon-clipping path)
 *  2. `mesh`         — sum of triangle areas (earcut/CDT + refinement path)
 *  3. `primitiveSum` — closed-form primitive areas (stadium L·W+πr², annulus, roundrect
 *                      w·h−(4−π)r², …), overlap-blind → an upper bound on the
 *                      drill-free union
 *  4. `monteCarlo`   — point sampling against the ANALYTIC primitives (distance to
 *                      segment, exact circle/roundrect tests). This path shares no code
 *                      with tessellation, polygon-clipping, earcut or cdt2d, so it can
 *                      catch a bug in any of them. Seeded (reproducible) with a
 *                      reported standard error.
 *
 * Expected relationships (the demo surfaces them as checks):
 *   mesh == outline (rel ~1e-12);  unionNoDrills ≤ primitiveSum (equality iff no
 *   overlaps);  monteCarlo == true analytic area, i.e. ≥ outline by roughly the arc
 *   tessellation deficit (bounded by ~2·chordTolerance/r) ± its own σ.
 */

import type { BBox, BoardGraphic, Pad, Pcb, Track, Via, ZoneFill } from "../../kicad_pcb_viewer/src/parser/pcb.js";
import { rotate } from "../../kicad_pcb_viewer/src/geometry/transform.js";
import type { MeshOptions, MeshQuality, MultiPolygon } from "./types.js";
import { multiPolygonArea, resolveOptions } from "./types.js";
import { copperOrderOf, extractCopperRegions, padOnLayer, viaSpansLayer } from "./outline/copper.js";
import { meshRegion } from "./mesh/triangulate.js";

export interface MonteCarloArea {
  value: number; // mm²
  stdError: number; // mm², 1σ of the estimator
  samples: number;
  hits: number;
}

export interface AreaReport {
  /** shoelace of the boolean union, drills subtracted (what the mesh is built from) */
  outline: number;
  /** Σ triangle areas of the mesh */
  mesh: number;
  /** |mesh − outline| / outline — must be ~1e-12; anything else is a pipeline bug */
  meshVsOutlineRel: number;
  /** shoelace of the boolean union WITHOUT drill subtraction (for the primitive bound) */
  unionNoDrills: number;
  /** Σ closed-form primitive areas (no drills, overlap-blind) — always ≥ unionNoDrills */
  primitiveSum: number;
  /** primitiveSum − unionNoDrills: copper counted twice by overlapping primitives */
  overlapArea: number;
  /** independent analytic-sampling estimate of the drilled copper area */
  monteCarlo: MonteCarloArea;
  /** (monteCarlo − outline) in σ units (signed; expect small positive: arc deficit) */
  mcVsOutlineSigmas: number;
}

export interface RegionReport {
  layer: string;
  net: string;
  counts: {
    tracks: number;
    pads: number;
    vias: number;
    zoneFills: number;
    /** net-assigned copper graphics (gr_poly & co. on copper layers) */
    copperGraphics: number;
    /** disjoint copper islands — >1 on a routed net is worth a look */
    islands: number;
    holes: number;
  };
  /** Σ track centerline lengths on this (layer, net), mm */
  trackLength: number;
  trackWidth: { min: number; max: number } | null;
  /** connected pads as "REF.pad" (unique, sorted) */
  padRefs: string[];
  /** Σ ring perimeters of the union polygons, mm */
  perimeter: number;
  bbox: BBox;
  meshQuality: MeshQuality;
  areas: AreaReport;
}

export interface AnalyzeOptions extends MeshOptions {
  /** Monte Carlo sample count (default 200_000) */
  mcSamples?: number;
  /** RNG seed for reproducible sampling (default 1) */
  seed?: number;
}

// ---- analytic point-in-primitive tests (independent of all tessellation) ----

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

type PointTest = (x: number, y: number) => boolean;

function trackTest(t: Track): PointTest {
  const r = t.width / 2;
  return (x, y) => distToSegment(x, y, t.start.x, t.start.y, t.end.x, t.end.y) <= r;
}

function viaTest(v: Via): PointTest {
  const r = v.size / 2;
  return (x, y) => Math.hypot(x - v.pos.x, y - v.pos.y) <= r;
}

/** stadium test in local axis-aligned coords: capsule of total extents w×h */
function inStadiumLocal(x: number, y: number, w: number, h: number): boolean {
  if (w >= h) {
    const half = (w - h) / 2;
    return distToSegment(x, y, -half, 0, half, 0) <= h / 2;
  }
  const half = (h - w) / 2;
  return distToSegment(x, y, 0, -half, 0, half) <= w / 2;
}

function inRoundRectLocal(x: number, y: number, w: number, h: number, r: number): boolean {
  const ax = Math.abs(x), ay = Math.abs(y);
  if (ax > w / 2 || ay > h / 2) return false;
  const dx = ax - (w / 2 - r), dy = ay - (h / 2 - r);
  if (dx <= 0 || dy <= 0) return true;
  return dx * dx + dy * dy <= r * r;
}

/** board point → pad-local frame (inverse of the placement used by padOutline) */
function padLocal(p: Pad, x: number, y: number): { x: number; y: number } {
  return rotate({ x: x - p.pos.x, y: y - p.pos.y }, -p.angle);
}

function padTest(p: Pad): PointTest {
  const { w, h } = p.size;
  switch (p.shape) {
    case "circle": {
      const r = w / 2;
      return (x, y) => Math.hypot(x - p.pos.x, y - p.pos.y) <= r;
    }
    case "oval":
      return (x, y) => {
        const l = padLocal(p, x, y);
        return inStadiumLocal(l.x, l.y, w, h);
      };
    case "roundrect": {
      const r = Math.min(p.rratio * Math.min(w, h), w / 2, h / 2);
      return (x, y) => {
        const l = padLocal(p, x, y);
        return inRoundRectLocal(l.x, l.y, w, h, r);
      };
    }
    default: // rect + the rect fallbacks (trapezoid/custom) — must match padOutline
      return (x, y) => {
        const l = padLocal(p, x, y);
        return Math.abs(l.x) <= w / 2 && Math.abs(l.y) <= h / 2;
      };
  }
}

function padDrillTest(p: Pad): PointTest | null {
  if (!p.thruHole || !p.drill) return null;
  const { w, h } = p.drill;
  if (w <= 0 && h <= 0) return null;
  if (Math.abs(w - h) < 1e-9) {
    const r = w / 2;
    return (x, y) => Math.hypot(x - p.pos.x, y - p.pos.y) <= r;
  }
  return (x, y) => {
    const l = padLocal(p, x, y);
    return inStadiumLocal(l.x, l.y, w, h);
  };
}

function zoneTest(z: ZoneFill): PointTest {
  const pts = z.pts;
  return (x, y) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i]!, b = pts[j]!;
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };
}

// ---- closed-form primitive areas -------------------------------------------

function trackArea(t: Track): number {
  const L = Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y);
  return L * t.width + Math.PI * (t.width / 2) ** 2;
}

function padArea(p: Pad): number {
  const { w, h } = p.size;
  switch (p.shape) {
    case "circle":
      return Math.PI * (w / 2) ** 2;
    case "oval": {
      const d = Math.min(w, h);
      return Math.abs(w - h) * d + Math.PI * (d / 2) ** 2;
    }
    case "roundrect": {
      const r = Math.min(p.rratio * Math.min(w, h), w / 2, h / 2);
      return w * h - (4 - Math.PI) * r * r;
    }
    default:
      return w * h;
  }
}

function zoneArea(z: ZoneFill): number {
  let s = 0;
  for (let i = 0, n = z.pts.length; i < n; i++) {
    const a = z.pts[i]!, b = z.pts[(i + 1) % n]!;
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s / 2);
}

// net-assigned copper graphics: analytic point tests + closed-form areas
// (fill shape ∪ per-edge stroke stadiums — mirrors src/outline/copper.ts)

function graphicPointTests(g: BoardGraphic): PointTest[] {
  const tests: PointTest[] = [];
  const stroke = (ax: number, ay: number, bx: number, by: number, w: number) => {
    if (w > 0) tests.push((x, y) => distToSegment(x, y, ax, ay, bx, by) <= w / 2);
  };
  if (g.kind === "poly") {
    if (g.fill) {
      const pts = g.pts;
      tests.push((x, y) => {
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const a = pts[i]!, b = pts[j]!;
          if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
        }
        return inside;
      });
    }
    for (let i = 0; i < g.pts.length; i++) {
      const a = g.pts[i]!, b = g.pts[(i + 1) % g.pts.length]!;
      stroke(a.x, a.y, b.x, b.y, g.width);
    }
  } else if (g.kind === "rect") {
    const x1 = Math.min(g.a.x, g.b.x), x2 = Math.max(g.a.x, g.b.x);
    const y1 = Math.min(g.a.y, g.b.y), y2 = Math.max(g.a.y, g.b.y);
    if (g.fill) tests.push((x, y) => x >= x1 && x <= x2 && y >= y1 && y <= y2);
    stroke(x1, y1, x2, y1, g.width); stroke(x2, y1, x2, y2, g.width);
    stroke(x2, y2, x1, y2, g.width); stroke(x1, y2, x1, y1, g.width);
  } else if (g.kind === "circle") {
    const r = g.radius + g.width / 2;
    tests.push((x, y) => Math.hypot(x - g.center.x, y - g.center.y) <= r);
  } else if (g.kind === "line") {
    stroke(g.a.x, g.a.y, g.b.x, g.b.y, g.width);
  } else if (g.kind === "arc") {
    stroke(g.start.x, g.start.y, g.end.x, g.end.y, g.width); // straightened, like arc tracks
  }
  return tests;
}

function graphicArea(g: BoardGraphic): number {
  const stadium = (len: number, w: number) => len * w + Math.PI * (w / 2) ** 2;
  if (g.kind === "poly") {
    let s = 0, per = 0;
    for (let i = 0, n = g.pts.length; i < n; i++) {
      const a = g.pts[i]!, b = g.pts[(i + 1) % n]!;
      s += a.x * b.y - b.x * a.y;
      per += stadium(Math.hypot(b.x - a.x, b.y - a.y), g.width);
    }
    return (g.fill ? Math.abs(s / 2) : 0) + per;
  }
  if (g.kind === "rect") {
    const w = Math.abs(g.b.x - g.a.x), h = Math.abs(g.b.y - g.a.y);
    return (g.fill ? w * h : 0) + 2 * (stadium(w, g.width) + stadium(h, g.width));
  }
  if (g.kind === "circle") return Math.PI * (g.radius + g.width / 2) ** 2;
  if (g.kind === "line") return stadium(Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y), g.width);
  if (g.kind === "arc") return stadium(Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y), g.width);
  return 0;
}

// ---- helpers ----------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function polygonsBBox(mp: MultiPolygon): BBox {
  const b: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const poly of mp)
    for (const [x, y] of poly[0]!) {
      if (x < b.minX) b.minX = x;
      if (y < b.minY) b.minY = y;
      if (x > b.maxX) b.maxX = x;
      if (y > b.maxY) b.maxY = y;
    }
  return b;
}

function perimeterOf(mp: MultiPolygon): number {
  let s = 0;
  for (const poly of mp)
    for (const ring of poly)
      for (let i = 0, n = ring.length; i < n; i++) {
        const a = ring[i]!, b = ring[(i + 1) % n]!;
        s += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
  return s;
}

// ---- the endpoint -----------------------------------------------------------

/**
 * Analyze one (layer, net) copper region. Returns null if that pair has no copper.
 * Mesh options (chordTolerance, maxEdgeLength, …) apply to the outline/mesh estimates;
 * the Monte Carlo estimate is tessellation-free by construction.
 */
export function analyzeRegion(pcb: Pcb, layer: string, net: string, options?: AnalyzeOptions): RegionReport | null {
  const o = resolveOptions(options);
  const scoped: AnalyzeOptions = { ...options, layers: [layer], nets: [net] };

  const [region] = extractCopperRegions(pcb, scoped);
  if (!region) return null;
  const [regionNoDrills] = extractCopperRegions(pcb, { ...scoped, subtractDrills: false });
  const mesh = meshRegion(region, o.maxEdgeLength, o.refinement);

  // primitives of this (layer, net)
  const tracks = pcb.tracks.filter((t) => t.layer === layer && t.net === net);
  const copperOrder = copperOrderOf(pcb);
  const vias = pcb.vias.filter((v) => viaSpansLayer(v, layer, copperOrder) && v.net === net);
  const pads: Pad[] = [];
  for (const f of pcb.footprints) for (const p of f.pads) if (padOnLayer(p, layer) && p.net === net) pads.push(p);
  const zones = o.includeZones ? pcb.zones.filter((z) => z.layer === layer && z.net === net) : [];
  const graphics = pcb.graphics.filter((g) => g.layer === layer && g.net === net);

  const primitiveSum =
    tracks.reduce((s, t) => s + trackArea(t), 0) +
    vias.reduce((s, v) => s + Math.PI * (v.size / 2) ** 2, 0) +
    pads.reduce((s, p) => s + padArea(p), 0) +
    zones.reduce((s, z) => s + zoneArea(z), 0) +
    graphics.reduce((s, g) => s + graphicArea(g), 0);

  // Monte Carlo over the analytic primitives (drills subtracted analytically too)
  const copperTests: PointTest[] = [
    ...tracks.map(trackTest),
    ...vias.map(viaTest),
    ...pads.map(padTest),
    ...zones.map(zoneTest),
    ...graphics.flatMap(graphicPointTests),
  ];
  const drillTests: PointTest[] = [];
  if (o.subtractDrills) {
    for (const v of pcb.vias)
      if (viaSpansLayer(v, layer, copperOrder)) {
        const r = v.drill / 2;
        drillTests.push((x, y) => Math.hypot(x - v.pos.x, y - v.pos.y) <= r);
      }
    for (const f of pcb.footprints)
      for (const p of f.pads) {
        const d = padDrillTest(p);
        if (d) drillTests.push(d);
      }
  }
  const bbox = polygonsBBox(region.polygons);
  const margin = 0.01 * Math.hypot(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) + 1e-6;
  const x0 = bbox.minX - margin, y0 = bbox.minY - margin;
  const W = bbox.maxX - bbox.minX + 2 * margin, H = bbox.maxY - bbox.minY + 2 * margin;
  const samples = Math.max(1000, Math.round(options?.mcSamples ?? 200_000));
  const rand = mulberry32(options?.seed ?? 1);
  let hits = 0;
  for (let i = 0; i < samples; i++) {
    const x = x0 + rand() * W, y = y0 + rand() * H;
    let inside = false;
    for (const test of copperTests) if (test(x, y)) { inside = true; break; }
    if (!inside) continue;
    for (const test of drillTests) if (test(x, y)) { inside = false; break; }
    if (inside) hits++;
  }
  const boxArea = W * H;
  const p = hits / samples;
  const mc: MonteCarloArea = {
    value: boxArea * p,
    stdError: boxArea * Math.sqrt(Math.max(p * (1 - p), 1e-12) / samples),
    samples,
    hits,
  };

  const unionNoDrills = regionNoDrills ? regionNoDrills.area : 0;
  const widths = tracks.map((t) => t.width);
  const padRefs = [...new Set(pads.map((p) => `${p.ref}.${p.number}`))].sort();

  return {
    layer,
    net,
    counts: {
      tracks: tracks.length,
      pads: pads.length,
      vias: vias.length,
      zoneFills: zones.length,
      copperGraphics: graphics.length,
      islands: mesh.islands,
      holes: mesh.holes,
    },
    trackLength: tracks.reduce((s, t) => s + Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y), 0),
    trackWidth: widths.length ? { min: Math.min(...widths), max: Math.max(...widths) } : null,
    padRefs,
    perimeter: perimeterOf(region.polygons),
    bbox,
    meshQuality: mesh.quality,
    areas: {
      outline: multiPolygonArea(region.polygons),
      mesh: mesh.meshArea,
      meshVsOutlineRel: Math.abs(mesh.meshArea - region.area) / region.area,
      unionNoDrills,
      primitiveSum,
      overlapArea: primitiveSum - unionNoDrills,
      monteCarlo: mc,
      mcVsOutlineSigmas: mc.stdError > 0 ? (mc.value - region.area) / mc.stdError : 0,
    },
  };
}
