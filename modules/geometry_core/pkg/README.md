# geometry_core

Rust → WASM geometry kernel for the PCB parasitic-extraction engine (the "M2 in Rust"
of the project plan). First capability: **quality-guaranteed meshing** of copper
regions — constrained Delaunay triangulation with Ruppert/Chew-style refinement via
[`spade`](https://docs.rs/spade)'s `refine()`:

- minimum-angle bound (target 25°, accept ≥ 20°) wherever the input geometry allows —
  constraint edges meeting at small angles (near-tangent arc intersections in a
  boolean union) force a few unavoidable local slivers, which the TS side counts;
- maximum-area constraint derived from the target edge length (`(√3/4)·h²`);
- holes and outer faces excluded by odd-winding classification
  (`exclude_outer_faces`);
- Steiner points on constraint edges only → **area is exactly preserved** (the TS
  test suite asserts mesh area == outline area to 1e-9 on the real board).

Ruppert grades triangle size from the local feature size automatically: fine at
necks/clearances/dense pour boundaries, coarse in open pour interiors.

Measured on the poweramp board, B.Cu, 1 mm target (vs the TS cdt2d path):
**209k triangles, 6 slivers (0.003%), 660 ms** — against 38k triangles with **31%**
slivers in 2.1 s. Faster *and* guaranteed.

## API

`refine_region(coords, ring_lens, min_angle_deg, max_area, max_additional_vertices)`
→ `{ vertices: Float64Array, triangles: Uint32Array, complete: bool }` — one or more
polygons-with-holes, rings flattened. `max_additional_vertices = 0` derives a budget
from the area constraint (spade's own default of 10×|V| is far too small).

## Build & test

```sh
cargo test                                   # native tests (area, angle bound, holes)
wasm-pack build --release --target web      # → pkg/ (consumed by modules/pcb_mesh)
```

Requires `rustup` (stable), the `wasm32-unknown-unknown` target and `wasm-pack`
(`brew install rustup wasm-pack`). `pkg/` is untracked — build it once before using
`pcb_mesh`'s `refinement: "ruppert"` or its demo (which falls back to cdt2d when the
pkg is missing).

Consumed from TS as `pcb_mesh/src/mesh/ruppert.ts`: `await initRuppert()` once, then
`buildBoardMesh(pcb, { maxEdgeLength: 1, refinement: "ruppert" })`.
