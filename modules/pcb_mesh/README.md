# pcb_mesh

Copper-geometry extraction + triangular meshing for KiCad PCBs — the first building
block of a 2.5D parasitic-extraction engine (the "M2 seed": geometry kernel feeding the
future DC-resistance / RLGC solvers).

Given a `.kicad_pcb`, it produces per-**layer**, per-**net** copper regions — the
boolean union of track stadiums, pad shapes, via rings and zone fills, with every drill
hole subtracted — and triangulates each region into an FEM-ready mesh.

```ts
import { buildBoardMeshFromString } from "pcb_mesh";

const mesh = buildBoardMeshFromString(kicadPcbText, { maxEdgeLength: 0.5 });
for (const r of mesh.regions) {
  // r.layer, r.net, r.vertices (Float64Array x,y…), r.triangles (Uint32Array),
  // r.outlineArea, r.meshArea, r.quality { triangleCount, minAngleDeg, maxEdgeLength }
}
```

All coordinates are **board millimetres, Y down** — the same frame as
`kicad_pcb_viewer`, whose parser this module reuses by relative source import
(`../kicad_pcb_viewer/src/parser/pcb.js`).

## Pipeline

1. **Polygonize** (`src/outline/primitives.ts`) — track segment → stadium (round-cap
   capsule); pad → circle/oval/rect/roundrect (trapezoid/custom fall back to rect);
   via → outer ring circle; drills → circles/ovals. Pad orientation reuses the viewer's
   empirically-locked rotation convention (`rotate()`, `ROT_SIGN = -1`).
2. **Union** (`src/outline/copper.ts`) — per (layer, net), Martinez–Rueda boolean union
   via [`polygon-clipping`]; then subtract **all** drills on the layer (a hole is a
   physical hole — this also makes NPTH pads vanish since pad size == drill size).
   Zone `filled_polygon`s are trusted as poured by KiCad.
3. **Triangulate** (`src/mesh/triangulate.ts` + `delaunay.ts` + `ruppert.ts`) —
   without `maxEdgeLength`: ear clipping ([`earcut`]) of the outline only (render
   mesh). With a target, three strategies (`refinement` option):
   - **`"ruppert"` (recommended for solving)** — quality-**guaranteed**: Rust/WASM
     [`geometry_core`](../geometry_core) (spade CDT + Ruppert refinement), min angle
     25° target / ≥ 20° accepted wherever input geometry allows, max-area constraint
     from the target edge, size graded from local feature size automatically. Also
     works with no target (angle-only cleanup). Needs `await initRuppert()` and a
     built `geometry_core/pkg`.
   - **`"delaunay"` (default, pure JS)** — generated homogeneous mesh: boundary
     resampled at ≤ h, hexagonal interior points, constrained Delaunay ([`cdt2d`]).
     Well-shaped interiors but **no angle guarantee at boundaries**.
   - **`"bisect"`** — Rivara-style adaptive longest-edge bisection of the ear-clip
     mesh (conforming, area-exact). Cheap, but inherits ear-clip sliver shapes.

   Between union and meshing, the outlines are **Douglas–Peucker simplified**
   (`simplifyTolerance`, default 0.01 mm deviation bound, counted in the sanitation
   report): KiCad's dense zone-fill vertices would otherwise seed needless local
   refinement. Measured area drift on the poweramp pour: −0.008 %.

   Poweramp board, B.Cu (85×100 mm, big ground pour), `maxEdgeLength: 1`:
   uniform 1→4 subdivision (removed) ~10 M triangles · delaunay 38 k / **31 %**
   slivers / 2.1 s · **ruppert 54 k / 0 slivers / min ∠ 25° / 0.3 s** (212 k without
   outline simplification — the knob that tamed it).

## Correctness invariants (tested)

- **Area conservation**: mesh area == shoelace outline area (rel < 1e-6 on the real
  board; ~1e-13 observed) — the single sharpest check on the whole pipeline.
- Analytic areas: stadium `L·W + πr²`, annulus `π(R²−r²)`, roundrect
  `w·h − (4−π)rr²`, rotation invariance, union of overlapping tracks doesn't
  double-count.
- Mesh validity: index bounds, Euler characteristic `V − E + F = 2` after refinement
  (conforming, deduped midpoints), refinement preserves area exactly, hole faces
  correctly removed on the Delaunay path, graded/homogeneous triangle-count bounds.
- End-to-end on the poweramp fixture (47 footprints / 180 tracks / 18 vias / zones):
  every net with tracks gets a region, drills strictly reduce copper, both layers mesh.

## Honest limitations (v1)

- **Unrefined meshes (no `maxEdgeLength`) are ear-clip meshes**: no angle guarantee,
  slivers on big zone outlines (min angle ≈ 0°, reported via `quality.minAngleDeg`).
  Fine for areas/visualization; use the Delaunay refinement for anything FEM-shaped.
- **`cdt2d` dominates fine-target runtimes** (~1 s per 10 k points, superlinear on the
  10 k-vertex ground-pour boundary): whole-board B.Cu at 0.5 mm ≈ 8 s, at 0.25 mm ≈
  45 s. Per-net meshing stays fast. Known upgrade paths: `delaunator` + `constrainautor`
  (orders of magnitude faster CDT), or the planned Rust/WASM geometry core.
- Boundary-adjacent triangles on the Delaunay path can be thinner than interior ones
  (min angle down to ~19°) — full Ruppert refinement would lift that floor.
- Arc tracks arrive already straightened by the parser; trapezoid/custom pads are
  boxed; no arc-track stadium yet.
- No stackup awareness (thickness/ε_r) — this module is 2D per-layer geometry only.

## Verification endpoint: `analyzeRegion(pcb, layer, net)`

Per-region report for UI/CI: composition (tracks/pads/vias/zones, Σ track length,
connected pad refs), per-layer island & hole counts, perimeter, mesh quality — and the
region's area computed **four independent ways**: boolean-union shoelace, Σ triangles,
Σ closed-form primitives (overlap-blind upper bound), and a seeded **Monte Carlo
estimate sampled against the analytic primitives** (shares no code with
polygon-clipping/earcut/cdt2d, so it catches bugs in any of them) with a reported ±σ.

Related plumbing:
- `chordTolerance` option — arc tessellation by sagitta bound (per-radius segment
  counts), so area accuracy is a guarantee, not a per-radius accident.
- `MeshQuality` now machine-checkable: angle histogram, sliver count (<20°), worst
  aspect ratio — CI can enforce "min angle ≥ X, zero degenerates, drift < 1e-9".
- `SanitationReport` on every build: zero-length tracks, pad-shape fallbacks,
  degenerate rings, vanished regions (NPTH), dropped zero-area triangles — counted,
  never silent.
- `boardMeshToJSON` / `boardMeshFromJSON` — versioned, diffable mesh fixtures for
  contract tests (same-input builds are byte-identical per environment).

## Demo

`npm run dev` → renders every triangle of a chosen layer over the board outline,
per-net colors, click to isolate a net, refinement selector, live stats
(region/triangle counts, copper area, mesh-vs-outline area drift, build time).
Upload any `.kicad_pcb` to inspect your own board.

## Test / build

`npm install`, `npm test` (29 vitest tests), `npm run typecheck`, `npm run build`.

[`polygon-clipping`]: https://github.com/mfogel/polygon-clipping
[`earcut`]: https://github.com/mapbox/earcut
