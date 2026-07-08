/**
 * Shared geometry/mesh contracts for pcb_mesh. Everything is in **board millimetres,
 * Y down** — the same frame as the `kicad_pcb_viewer` board model, converted nowhere.
 *
 * Polygon representation is GeoJSON-style (and structurally identical to what the
 * `polygon-clipping` dependency uses):
 *   Vec2 = [x, y]; Ring = Vec2[] (NOT closed — first point is not repeated at the end);
 *   Polygon = Ring[] with ring 0 the outer boundary and the rest holes;
 *   MultiPolygon = Polygon[].
 */

export type Vec2 = [number, number];
export type Ring = Vec2[];
export type Polygon = Ring[];
export type MultiPolygon = Polygon[];

/** One net's copper on one layer: the boolean union of all its primitives, minus drills. */
export interface CopperRegion {
  layer: string;
  net: string; // "" = unconnected copper (e.g. isolated pads)
  polygons: MultiPolygon;
  /** signed-area sum over all rings (holes subtract), mm² */
  area: number;
}

export interface MeshQuality {
  triangleCount: number;
  vertexCount: number;
  /** smallest interior angle over all triangles, degrees (earcut can produce slivers) */
  minAngleDeg: number;
  /** longest edge over all triangles, mm */
  maxEdgeLength: number;
  /** triangles binned by their min angle: [0–10°, 10–20°, …, 50–60°] */
  angleHistogramDeg: number[];
  /** triangles with min angle < 20° (the FEM-hostile ones) */
  sliverCount: number;
  /** worst longestEdge²/(2·area) over all triangles; equilateral ≈ 1.15 */
  worstAspect: number;
}

/** What extraction/meshing had to clean up or drop — counted, never silent. */
export interface SanitationReport {
  /** tracks with |start−end| ≈ 0 (meshed as circles) */
  zeroLengthTracks: number;
  /** trapezoid/custom pads drawn as their bounding rect */
  padShapeFallbacks: number;
  /** boolean-union output rings with < 3 vertices (dropped) */
  degenerateRings: number;
  /** (layer, net) pairs whose copper vanished entirely (e.g. NPTH pads) */
  emptyRegions: number;
  /** exactly-zero-area triangles dropped after ear clipping */
  degenerateTriangles: number;
  /** outline vertices removed by Douglas–Peucker simplification (`simplifyTolerance`) */
  simplifiedVertices: number;
  /** footprint copper graphics whose net could not be inferred from the pads */
  orphanCopperGraphics: number;
  /** boolean ops that needed the jitter fallback (polygon-clipping robustness) */
  booleanFallbacks: number;
  /** primitives dropped because no boolean fallback succeeded — copper may be missing */
  droppedPrimitives: number;
}

/** Triangulated copper region — the unit solvers will consume. */
export interface RegionMesh {
  layer: string;
  net: string;
  /** disjoint copper islands in this region — >1 on a routed net deserves a look */
  islands: number;
  /** hole rings (drills, clearance voids) across all islands */
  holes: number;
  /** zero-area triangles dropped for this region */
  degenerateTriangles: number;
  /** interleaved x0,y0,x1,y1,… (mm, board coords, Y down) */
  vertices: Float64Array;
  /** vertex indices, 3 per triangle, CCW in the Y-down frame not guaranteed — use area sign */
  triangles: Uint32Array;
  /** area of the source polygon union (shoelace), mm² */
  outlineArea: number;
  /** sum of triangle areas, mm² — must match outlineArea (conservation invariant) */
  meshArea: number;
  quality: MeshQuality;
}

export interface BoardMesh {
  /** copper layers actually meshed, in input order */
  layers: string[];
  regions: RegionMesh[];
  report: SanitationReport;
}

export interface MeshOptions {
  /** copper layers to mesh; default: every *.Cu layer with content */
  layers?: string[];
  /** restrict to these net names; default: all nets (including "" unconnected copper) */
  nets?: string[];
  /**
   * max chord (sagitta) error when tessellating arcs/circles, mm; default 0.005.
   * Segment counts adapt to each primitive's radius, making area accuracy a tunable
   * guarantee instead of a per-radius accident.
   */
  chordTolerance?: number;
  /** lower bound on segments per full circle regardless of radius; default 12 */
  arcSegments?: number;
  /**
   * max boundary deviation (mm) when simplifying the union outlines (Douglas–Peucker)
   * before meshing; collapses KiCad's dense zone-fill vertices so they don't seed
   * needless refinement. 0 disables. Default 0.01 (2× chordTolerance — below any
   * clearance that matters; the Monte Carlo verifier reports the true drift).
   */
  simplifyTolerance?: number;
  /** include zone `filled_polygon`s; default true */
  includeZones?: boolean;
  /** subtract pad/via drill holes from the copper; default true */
  subtractDrills?: boolean;
  /**
   * target triangle edge length in mm. When set, regions are meshed to (near-)uniform
   * triangles of this size. Default: no refinement (ear-clip of the outline only).
   */
  maxEdgeLength?: number;
  /**
   * how to reach `maxEdgeLength`:
   *  - "ruppert": quality-GUARANTEED — Rust/WASM constrained Delaunay + Ruppert
   *    refinement (spade): min angle ≥ 25° target wherever the input geometry allows,
   *    max-area constraint from `maxEdgeLength`. Also valid without `maxEdgeLength`
   *    (angle-only cleanup at natural density). Requires `await initRuppert()` first.
   *  - "delaunay" (default): generate the fine mesh directly — boundary resampled at h,
   *    hexagonal interior points, constrained Delaunay (cdt2d). Homogeneous but no
   *    angle guarantee at boundaries.
   *  - "bisect": adaptively bisect the ear-clip mesh's longest edges. Cheaper for tiny
   *    targets on small regions, but inherits ear-clip sliver shapes.
   */
  refinement?: "ruppert" | "delaunay" | "bisect";
}

export interface ResolvedMeshOptions {
  layers: string[] | null;
  nets: string[] | null;
  chordTolerance: number;
  arcSegments: number;
  simplifyTolerance: number;
  includeZones: boolean;
  subtractDrills: boolean;
  maxEdgeLength: number;
  refinement: "ruppert" | "delaunay" | "bisect";
}

export function resolveOptions(o: MeshOptions | undefined): ResolvedMeshOptions {
  return {
    layers: o?.layers ?? null,
    nets: o?.nets ?? null,
    chordTolerance: o?.chordTolerance ?? 0.005,
    arcSegments: Math.max(4, Math.round(o?.arcSegments ?? 12)),
    simplifyTolerance: o?.simplifyTolerance ?? 0.01,
    includeZones: o?.includeZones ?? true,
    subtractDrills: o?.subtractDrills ?? true,
    maxEdgeLength: o?.maxEdgeLength ?? Infinity,
    refinement: o?.refinement ?? "delaunay",
  };
}

export function emptySanitationReport(): SanitationReport {
  return {
    zeroLengthTracks: 0,
    padShapeFallbacks: 0,
    degenerateRings: 0,
    emptyRegions: 0,
    degenerateTriangles: 0,
    simplifiedVertices: 0,
    orphanCopperGraphics: 0,
    booleanFallbacks: 0,
    droppedPrimitives: 0,
  };
}

/** Shoelace signed area of one ring (positive = CCW in a Y-up frame). */
export function ringArea(ring: Ring): number {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[(i + 1) % n]!;
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

/** Unsigned area of a polygon-with-holes / multipolygon (holes subtract). */
export function multiPolygonArea(mp: MultiPolygon): number {
  let total = 0;
  for (const poly of mp) {
    for (let r = 0; r < poly.length; r++) {
      const a = Math.abs(ringArea(poly[r]!));
      total += r === 0 ? a : -a;
    }
  }
  return total;
}

/** Drop a repeated closing point (GeoJSON-closed rings → our open convention). */
export function openRing(ring: Ring): Ring {
  if (ring.length > 1) {
    const [fx, fy] = ring[0]!;
    const [lx, ly] = ring[ring.length - 1]!;
    if (fx === lx && fy === ly) return ring.slice(0, -1);
  }
  return ring;
}
