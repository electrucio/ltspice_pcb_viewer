/**
 * Copper region extraction: gather every copper primitive of a (layer, net) pair,
 * boolean-union them into clean polygons-with-holes, and subtract drill holes.
 *
 * Drills are physical holes through the whole board, so every drill on a layer is
 * subtracted from every net's copper on that layer (this also makes NPTH pads —
 * pad size == drill size — vanish for free).
 *
 * Arc tessellation is driven by `chordTolerance` (sagitta bound, per-radius segment
 * counts via `segmentsForRadius`), with `arcSegments` as a floor — so area accuracy is
 * a tunable guarantee, not a per-radius accident.
 *
 * Everything cleaned up or dropped is counted in a SanitationReport — never silent.
 *
 * Booleans use `polygon-clipping` (Martinez–Rueda). Its ring convention is
 * GeoJSON-closed; results are normalized back to our open-ring convention.
 */

import pc from "polygon-clipping";
import type { Pcb, Pad } from "../../../kicad_pcb_viewer/src/parser/pcb.js";
import type { MultiPolygon, Polygon, Ring, SanitationReport } from "../types.js";
import { emptySanitationReport, multiPolygonArea, openRing, resolveOptions, type CopperRegion, type MeshOptions } from "../types.js";
import { circleOutline, padArcRadius, padDrillOutline, padOutline, segmentsForRadius, stadiumOutline, trackOutline, viaDrillOutline, viaOutline } from "./primitives.js";
import { simplifyMultiPolygon } from "./simplify.js";

type PcGeom = Parameters<typeof pc.union>[0];

/** Snap to a 1 nm grid: float-noise coordinates (tessellated arcs, rotated pads) are
 *  the classic trigger for Martinez–Rueda "unable to complete output ring" failures,
 *  and 1e-6 mm is far below any tolerance in this pipeline. */
const snap = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * polygon-clipping occasionally fails on near-degenerate constellations even after
 * snapping. Recover instead of dying: union incrementally, and jitter (then drop) the
 * specific primitive that breaks — counted in the report, never silent.
 */
function robustUnion(polys: Polygon[], report: SanitationReport): ReturnType<typeof pc.union> {
  try {
    return pc.union(polys[0] as PcGeom, ...(polys.slice(1) as PcGeom[]));
  } catch {
    let acc = pc.union(polys[0] as PcGeom);
    for (let i = 1; i < polys.length; i++) {
      try {
        acc = pc.union(acc as PcGeom, polys[i] as PcGeom);
      } catch {
        try {
          const jittered = polys[i]!.map((ring) => ring.map(([x, y]) => [x + 1.7e-6, y + 2.3e-6] as [number, number]));
          acc = pc.union(acc as PcGeom, jittered as unknown as PcGeom);
          report.booleanFallbacks++;
        } catch {
          report.droppedPrimitives++;
        }
      }
    }
    return acc;
  }
}

function robustDifference(acc: ReturnType<typeof pc.union>, drills: Polygon[], report: SanitationReport): ReturnType<typeof pc.union> {
  try {
    return pc.difference(acc as PcGeom, drills as unknown as PcGeom);
  } catch {
    for (const d of drills) {
      try {
        acc = pc.difference(acc as PcGeom, [d] as unknown as PcGeom);
      } catch {
        try {
          const jittered = d.map((ring) => ring.map(([x, y]) => [x + 1.7e-6, y + 2.3e-6] as [number, number]));
          acc = pc.difference(acc as PcGeom, [jittered] as unknown as PcGeom);
          report.booleanFallbacks++;
        } catch {
          report.droppedPrimitives++;
        }
      }
    }
    return acc;
  }
}

export interface ExtractResult {
  regions: CopperRegion[];
  report: SanitationReport;
}

/** Does a pad put copper on `layer`? (`*.Cu` = every copper layer.) */
export function padOnLayer(p: Pad, layer: string): boolean {
  return p.layers.some((l) => l === layer || l === "*.Cu");
}

/** Copper layers with content, in KiCad stacking order (F.Cu first, B.Cu last). */
export function copperLayers(pcb: Pcb): string[] {
  const seen = new Set<string>();
  for (const t of pcb.tracks) if (t.layer.endsWith(".Cu")) seen.add(t.layer);
  for (const z of pcb.zones) if (z.layer.endsWith(".Cu")) seen.add(z.layer);
  for (const f of pcb.footprints)
    for (const p of f.pads)
      for (const l of p.layers) if (l.endsWith(".Cu") && !l.startsWith("*")) seen.add(l);
  const order = (l: string) => (l === "F.Cu" ? 0 : l === "B.Cu" ? 2 : 1);
  return [...seen].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
}

/**
 * All copper regions of the board (or of the layers/nets selected in `options`),
 * one entry per (layer, net) that actually has copper, plus a sanitation report.
 */
export function extractCopper(pcb: Pcb, options?: MeshOptions): ExtractResult {
  const o = resolveOptions(options);
  const layers = o.layers ?? copperLayers(pcb);
  const netFilter = o.nets ? new Set(o.nets) : null;
  const regions: CopperRegion[] = [];
  const report = emptySanitationReport();
  const segs = (radius: number) => Math.max(o.arcSegments, segmentsForRadius(radius, o.chordTolerance));

  const normalize = (mp: ReturnType<typeof pc.union>): MultiPolygon =>
    mp.map((poly) =>
      poly
        .map((ring) => openRing(ring as Ring))
        .filter((r) => {
          if (r.length >= 3) return true;
          report.degenerateRings++;
          return false;
        }),
    ).filter((poly) => poly.length > 0 && poly[0]!.length >= 3);

  for (const layer of layers) {
    // 1) collect primitive outlines per net
    const byNet = new Map<string, Polygon[]>();
    const add = (net: string, ring: Ring) => {
      if (netFilter && !netFilter.has(net)) return;
      if (ring.length < 3) return;
      let list = byNet.get(net);
      if (!list) byNet.set(net, (list = []));
      list.push([ring.map(([x, y]) => [snap(x), snap(y)] as [number, number])]);
    };

    for (const t of pcb.tracks)
      if (t.layer === layer) {
        if (Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y) < 1e-9) report.zeroLengthTracks++;
        add(t.net, trackOutline(t, segs(t.width / 2)));
      }
    for (const v of pcb.vias)
      if (v.layers.length === 0 || v.layers.includes(layer)) add(v.net, viaOutline(v, segs(v.size / 2)));
    for (const f of pcb.footprints)
      for (const p of f.pads)
        if (padOnLayer(p, layer)) {
          if (p.shape === "trapezoid" || p.shape === "custom") report.padShapeFallbacks++;
          add(p.net, padOutline(p, segs(padArcRadius(p))));
        }
    if (o.includeZones)
      for (const z of pcb.zones)
        if (z.layer === layer) add(z.net, z.pts.map((p) => [p.x, p.y] as [number, number]));
    // net-assigned copper graphics (KiCad 9/10 gr_poly/rect/circle/line on copper):
    // real copper — fill plus the stroke outline (drawn as stadiums along each edge,
    // which is what actually makes contact with neighbouring copper)
    for (const g of pcb.graphics) {
      if (g.layer !== layer || g.net === undefined) continue;
      const stroke = (a: { x: number; y: number }, b: { x: number; y: number }, width: number) => {
        if (width > 0) add(g.net!, stadiumOutline(a, b, width, segs(width / 2)));
      };
      if (g.kind === "poly") {
        const ring = g.pts.map((p) => [p.x, p.y] as [number, number]);
        if (g.fill) add(g.net, ring);
        for (let i = 0; i < g.pts.length; i++) stroke(g.pts[i]!, g.pts[(i + 1) % g.pts.length]!, g.width);
      } else if (g.kind === "rect") {
        const c1 = g.a, c2 = { x: g.b.x, y: g.a.y }, c3 = g.b, c4 = { x: g.a.x, y: g.b.y };
        if (g.fill) add(g.net, [[c1.x, c1.y], [c2.x, c2.y], [c3.x, c3.y], [c4.x, c4.y]]);
        for (const [a, b] of [[c1, c2], [c2, c3], [c3, c4], [c4, c1]] as const) stroke(a, b, g.width);
      } else if (g.kind === "circle") {
        add(g.net, circleOutline(g.center.x, g.center.y, g.radius + g.width / 2, segs(g.radius + g.width / 2)));
      } else if (g.kind === "line") {
        stroke(g.a, g.b, g.width);
      }
      // arcs: parser keeps 3-point arcs; straightened like arc tracks (known gap)
      else if (g.kind === "arc") stroke(g.start, g.end, g.width);
    }

    // 2) all drills on this layer (net-independent: a hole is a hole)
    const drills: Polygon[] = [];
    const snapRing = (r: Ring): Ring => r.map(([x, y]) => [snap(x), snap(y)] as [number, number]);
    if (o.subtractDrills) {
      for (const v of pcb.vias)
        if (v.layers.length === 0 || v.layers.includes(layer)) drills.push([snapRing(viaDrillOutline(v, segs(v.drill / 2)))]);
      for (const f of pcb.footprints)
        for (const p of f.pads) {
          if (!p.thruHole) continue;
          const d = padDrillOutline(p, segs(Math.min(p.drill?.w ?? 0, p.drill?.h ?? 0) / 2));
          if (d) drills.push([snapRing(d)]);
        }
    }

    // 3) union per net, minus drills (robust: snap + incremental fallback)
    for (const [net, polys] of byNet) {
      let merged = robustUnion(polys, report);
      if (drills.length) merged = robustDifference(merged, drills, report);
      let polygons = normalize(merged);
      if (o.simplifyTolerance > 0 && polygons.length) {
        const s = simplifyMultiPolygon(polygons, o.simplifyTolerance);
        report.simplifiedVertices += s.removedVertices;
        polygons = s.polygons;
      }
      if (!polygons.length) {
        report.emptyRegions++;
        continue;
      }
      regions.push({ layer, net, polygons, area: multiPolygonArea(polygons) });
    }
  }
  return { regions, report };
}

/** Regions only — see `extractCopper` for the variant with the sanitation report. */
export function extractCopperRegions(pcb: Pcb, options?: MeshOptions): CopperRegion[] {
  return extractCopper(pcb, options).regions;
}
