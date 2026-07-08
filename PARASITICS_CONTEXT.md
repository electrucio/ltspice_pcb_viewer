# PCB Parasitic Extraction — project context (state as of 2026-07-07)

Working context for the parasitic-extraction effort inside the `ltspice_pcb_viewer`
monorepo. Successor to the original planning doc ("Web-Based 2.5D PCB Parasitic
Extraction Engine"); this records what is actually **built, measured and tested**, the
decisions taken where reality diverged from the plan, and what comes next. Treat as
authoritative over the original plan where they disagree.

## 1. Where we are on the original roadmap

Original module plan: M0 analytic → M1 parser → M2 geometry → … → M8 orchestrator.
Current status:

- **M1 (KiCad parsing)** — pre-existed as `modules/kicad_pcb_viewer` (viewer +
  parser). Documented in `modules/kicad_pcb_viewer/CONTEXT.md`. One real bug found and
  fixed during this work: **pad angles are stored ABSOLUTE in `.kicad_pcb`** (footprint
  rotation already included) while pad positions are footprint-relative; the parser
  was adding the footprint angle again, drawing rotated footprints' oval/rect pads 90°
  off (poweramp Q7). Pinned by a regression test.
- **M2 (geometry / meshing)** — **this is what's now built**, split across two new
  modules (details below): `modules/pcb_mesh` (TS pipeline) and
  `modules/geometry_core` (Rust→WASM quality mesher). Copper extraction, boolean
  union, drill subtraction, outline simplification, three triangulation strategies,
  quality metrics, verification endpoint, serialization.
- **M0 (analytic oracle)** — `modules/analytic_models`, built **just-in-time in
  solver order**. Current slice: DC resistance (IACS ρ/α + temperature model,
  ρL/(W·t), counting-squares with Jaeger's 0.56 sq per 90° corner, plated via-barrel
  annulus R). 14 tests. Cross-check resource: **`~/git/pcb-toolkit`** (sibling clone —
  a reverse-engineered Saturn PCB Toolkit v8.44 in Rust, validated against Saturn's
  help-PDF vectors; run its CLI with `--json` to mint fixtures). It also covers the
  future M5–M7 oracle formulas (decompiled Hammerstad–Jensen, via coaxial model,
  spiral inductors), largely replacing the need to chase the original papers.
  circuitcalculator.com confirmed as a second formula-family reference (same R(T)
  model, but referenced at 25 °C where Saturn/IACS use 20 °C — our API takes T
  explicitly). Remaining M0 slices land with their solvers: Hammerstad–Jensen/Wheeler
  (M5), fringing C (M6), Grover/via-L/Bessel (M7).
- **M4 (DC-resistance FEM)** — `modules/solver_rdc`, working. Terminal support
  landed in `pcb_mesh` first (`buildTerminalMesh`): pads/vias become mesh-conforming
  equipotential HOLES (inset ~20 µm so simplification can't make them cross the
  boundary; swallowed drills handled; overlapping same-net pads merged; failures
  reported, never silent) whose ring vertices are the tagged terminal sets — no
  kernel change needed (holes are just odd-winding rings). Solver: linear-triangle
  sheet-conductance FEM per layer, cross-layer supernodes for THT pads/vias (barrel R
  shorted in v1 — lumped upgrade noted), Dirichlet pair solve, Jacobi-CG with
  reported residual + current-conservation check. 8 acceptance tests vs the M0
  oracle: straight strip ρL/(Wt) <0.5%, **L-bend re-derives Jaeger's 0.56-square
  corner**, reciprocity, temperature scaling, refinement stability, and on the
  poweramp a pad pair disconnected on B.Cu alone solving finite through THT/via
  stitching. Measured: /POW1 R2.1↔R9.1 = 3.80 mΩ (≈ counting-squares 3.7 mΩ).
- **UI (demo)** — click-to-pick pad terminals (green from / red to markers), FEM R
  with residual+conservation, **current-density overlay** (the solved field, yellow→
  red by |J|; solver returns per-layer potentials via `returnField`), and the **M0
  instant estimate** beside it (`solver_rdc/estimate.ts`: Dijkstra over the net's
  track graph, via barrels from analytic_models; honest limits — single path, no
  pours/graphics/corner corrections; null when no track path exists). Terminal-ring
  inset is a true uniform edge offset (a radial shrink under-inset thin pads by 5×
  and spawned µm channels that exploded the mesher — fixed, strip now matches
  ρL/(Wt) to 2e-5).
- **Stackup parsing (P2.1) — DONE**: `Pcb.stackup` from `(setup (stackup …))`;
  solver + M0 estimate resolve thickness per layer (option → stackup → 35 µm) and
  via-barrel length from board thickness. Real impact: jetson inner layers are
  18 µm (½ oz) — net 859 J18.D21↔R100.2 is 1.92 Ω, not the 1.055 Ω the 1 oz
  assumption gave (path runs mostly on In5/In7).
- **Lumped via barrels (P2.2) — DONE**: `lumpedVias` (default true) replaces the
  via cross-layer shorts with barrel conductances chained between the via's
  per-layer nodes (analytic R_barrel; segment length = stackup dielectric span,
  1.6 mm/gaps fallback). THT pads stay shorted (soldered lead). Series
  composition is exact (test: ΔR == R_barrel to 1e-9). `SolveResult.viaCurrents`
  reports per-barrel current (A at 1 V; ×R = share of total), demo shows the top
  3. Real boards: jetson net 859 1.921→1.930 Ω; openair +3V3 60.46→61.01 mΩ.
- **Richardson error bars (P2.3) — DONE**: `solveWithErrorEstimate` solves at h
  and h/2, reports the fine R with the CONSERVATIVE bound |R(h)−R(h/2)| (not the
  /3 asymptotic — Ruppert meshes aren't exactly h-parameterized), `converged`
  = relError ≤ 5%. Tests: bar brackets analytic truth on strip AND L-bend, bar
  shrinks with h. Demo shows "R = 3.807 mΩ ± 0.32%" (poweramp, 242 ms both
  passes at h=0.8) and flags UNCONVERGED.
- **Power display (P2.4) — DONE**: demo solve panel takes a current, shows
  P = I²R + peak areal power, and the overlay has a J²·Rs power-density mode
  (per-layer Rs from the stackup). Linear problem → I changes rescale without
  re-solving.
- **Verification bench (P2.5)**: `SolveResult.terminalPotentials` exposes every
  terminal's solved V (four-point readouts). **van der Pauw CI test**
  (test/vdp.test.ts): exp(−πR₁/Rs)+exp(−πR₂/Rs)=1 holds to <2% on a square
  (corner R also matches Rs·ln2/π) AND on an asymmetric blob — a parameter-free,
  shape-independent oracle no closed-form fixture can replace. **KiPIDA
  cross-run is manual** (it's a KiCad-9 IPC plugin; needs the GUI): install per
  its README, run IR-drop on poweramp /POW1 R2.1→R9.1 (expect ~3.8 mΩ ± few %,
  its grid solver differs by design) — record results here when run.
  **KiCad-Parasitics (Steffen-W) cross-run — DONE, headless**: driven via
  KiCad 10's bundled pcbnew python (driver in scratchpad; their clone at
  ~/git/KiCad-Parasitics locally patched with `from __future__ import
  annotations` — it targets py3.10+, KiCad ships 3.9; numpy +
  typing_extensions pip'd --user into KiCad's python). poweramp /POW1
  R2.1↔R9.1: their shortest-path R = 4.608 mΩ over 11.52 mm vs our M0
  4.729 mΩ over the IDENTICAL 11.52 mm path — Δ2.6% is exactly their
  ρ=1.68e-8 vs our IACS 1.724e-8; geometric agreement exact. (Their ngspice
  full-network DC sim aborts in the bundled libngspice — "timestep too
  small" — so the network-level number wasn't obtainable headless.) Our FEM
  3.807 mΩ sits below both shortest-path numbers, as it must (parallel
  copper).
- **M3, M5–M8** — not started. Next: M5 RLGC (papers in ~/git/papers),
  app-level integration, plane-net fast preview.

## 2. Module: `modules/pcb_mesh` (TypeScript)

Headless library (no web component), repo conventions (Vite lib, Vitest), consumes the
viewer's parser by relative source import. **All coordinates: board mm, Y down.**

### Pipeline

```
parsePcb → per (layer, net):
  polygonize primitives      src/outline/primitives.ts
    tracks → stadiums; pads → circle/oval/rect/roundrect (trapezoid/custom boxed);
    vias → rings; drills → circles/oval stadiums.
    Arc tessellation by CHORD TOLERANCE (sagitta ≤ chordTolerance, default 5 µm),
    per-radius segment counts — area error is a tunable guarantee.
    Pad orientation reuses the viewer's empirically locked rotate()/ROT_SIGN=-1.
  boolean union − all drills  src/outline/copper.ts   (polygon-clipping, Martinez–Rueda)
    Drills are net-independent holes → NPTH pads vanish for free.
  Douglas–Peucker simplify    src/outline/simplify.ts (default 0.01 mm deviation bound)
    KiCad zone-fill outlines carry thousands of sub-0.1 mm vertices; unsimplified they
    seed massive needless refinement (see numbers). Hard deviation bound, removed
    vertices counted, measured area drift on the poweramp pour −0.008 %.
  triangulate                 src/mesh/*.ts — three strategies (MeshOptions.refinement)
```

### Triangulation strategies (`refinement`)

| strategy | engine | guarantee | use |
|---|---|---|---|
| `"ruppert"` | Rust/WASM `geometry_core` (spade CDT + Ruppert `refine()`) | **min ∠ 25° target / ≥ 20° accepted** + max-area from target edge; graded from local feature size | solver meshes — the real one |
| `"delaunay"` (default, pure JS) | boundary resample + hex interior points + `cdt2d` | homogeneous interiors, **no boundary angle guarantee** | fallback when WASM pkg absent; cross-check |
| `"bisect"` | Rivara longest-edge bisection of the ear-clip mesh | conforming, area-exact, inherits slivers | cheap cross-check |
| (no `maxEdgeLength`) | `earcut` | none — render mesh only | viewer/level-0 |

`"ruppert"` needs `await initRuppert()` once (WASM load; node tests pass bytes,
browser fetches). Deliberate: no straggler bisection after Ruppert — it would break
the angle guarantee; the contract is area+angle, not a hard max-edge.

### Measured (poweramp board, B.Cu incl. the big ground pour, 1 mm target)

| variant | triangles | slivers <20° | min ∠ | time |
|---|---|---|---|---|
| uniform 1→4 subdivision (removed) | ~10 M | — | — | unusable |
| bisect | 381 k | many | ~0° | 1.5 s |
| delaunay (cdt2d) | 38 k | **31 %** | ~0° | 2.1 s |
| ruppert, unsimplified outlines | 212 k | 6 | 19.8° | 0.23 s |
| ruppert, floor `min_area` (no simplify) | 57 k | **2793** | 0° | 54 ms |
| **ruppert + 0.01 mm simplify (defaults)** | **54 k** | **0** | **25.0°** | **0.3 s total** |

Lesson recorded in code comments: the `min_area` refinement floor (kept as opt-in in
the crate) only trades triangles for slivers once outlines are simplified —
simplification is the correct knob.

### Verification layer (the "every number ships with a check" principle)

`analyzeRegion(pcb, layer, net)` (`src/verify.ts`) → per-region report used by the
demo's selection panel and available to CI: composition (tracks/pads/vias/zones,
Σ track length, widths, connected pad refs), per-layer islands & holes, perimeter,
mesh quality, and the area computed **four independent ways**:

1. shoelace of the boolean union (drills subtracted),
2. Σ triangle areas — must equal (1) to ~1e-12 (hard invariant, tested),
3. Σ closed-form primitive areas (overlap-blind upper bound on the drill-free union),
4. **seeded Monte Carlo sampled against the ANALYTIC primitives** (exact
   point-in-stadium/circle/roundrect tests; shares zero code with
   polygon-clipping/earcut/cdt2d/spade) with reported ±σ — the tessellation-free
   oracle that would catch a bug in any of the geometry engines, including
   over-aggressive simplification.

Also: `MeshQuality` is machine-checkable (min angle, 10° histogram, sliver count,
worst aspect); every build carries a `SanitationReport` (zero-length tracks, pad-shape
fallbacks, degenerate rings, vanished NPTH regions, dropped zero-area triangles,
simplified vertices) — counted, never silent; `boardMeshToJSON/FromJSON` versioned
fixtures (same-input builds byte-identical per environment — cross-engine trig
differences preclude cross-platform byte identity until the kernel owns everything).

**Islands caveat:** island counts are per-layer; a net split on one layer usually
joins through vias elsewhere. True disconnected-copper detection needs cross-layer
connectivity (future). The demo words this carefully.

### Tests (56 vitest + 13 viewer + 4 cargo, all green)

Analytic-area oracles (stadium L·W+πr², annulus, roundrect w·h−(4−π)r², rotation
invariance, overlap non-double-count), mesh validity (index bounds, Euler
V−E+F=2, area conservation at 1e-9…1e-13), chord-tolerance sagitta bound, DP deviation
bound property test, Ruppert angle bound incl. holes, sanitation counts, MC-vs-closed-
form within 4σ, determinism, JSON roundtrip, end-to-end poweramp invariants.

### Demo (`npm run dev` — note: dev script needs `--config vite.config.ts`, see gotchas)

All triangles of a layer rendered over the board outline, per-net colors,
click-to-isolate with the cross-checked info panel (4 areas + ✓/✗ flags + quality),
multi-island highlight toggle, refinement/edge-length selectors, live stats incl.
sliver count and sanitation summary. Board upload works for any `.kicad_pcb`.

## 3. Module: `modules/geometry_core` (Rust → WASM)

The project's numerics beachhead (the plan's "M2 in Rust", now real). `spade` CDT +
Ruppert/Chew `refine()`; holes/outer faces excluded by odd-winding
(`exclude_outer_faces` — verified against spade's source, handles holes natively);
Steiner points only on constraint edges → area exactly preserved.
`refine_region(coords, ring_lens, min_angle_deg, max_area, min_area, max_additional_vertices)`.

Gotcha fixed inside: spade's default Steiner budget is 10×|input vertices| — far too
small for area-driven refinement; the crate derives a budget from Σ|ring shoelace| /
max_area. Build: `wasm-pack build --release --target web` (pkg/ untracked; pcb_mesh
demo falls back to cdt2d when missing). Toolchain via `brew install rustup wasm-pack`
(+ `wasm32-unknown-unknown` target); rustup is keg-only →
`PATH="/opt/homebrew/opt/rustup/bin:$PATH"`.

## 4. Decisions & deviations from the original plan

- **TS-first, Rust where it pays**: the boolean/union layer stayed TS
  (`polygon-clipping`) — the plan's warning against hand-rolling booleans held; the
  quality mesher went straight to Rust/spade rather than hand-rolling Ruppert in TS
  (encroachment handling = "dangerous kernel" class). cdt2d path retained as the
  dual-implementation cross-check.
- **"Endpoint" = module API** (`buildBoardMesh`, `analyzeRegion`), not HTTP — the app
  is fully browser-side.
- **No `mesh_for(solver, …)` API**: solvers will declare mesh *requirements* via the
  options bag; the mesher stays solver-agnostic (only the future orchestrator knows
  solvers exist).
- Verified-API rule extended to libraries: spade's refine API was read from its
  vendored source before use, not recalled.

## 5. Known gaps / next steps (ordered; first two gate M4)

1. **Pad edges as tagged interior constraints** — M4 applies terminal BCs on pad
   edges, but a pad embedded in a zone/track VANISHES from the union boundary. Pad
   outlines must be inserted as interior constraint edges in the CDT and tagged
   (pad/terminal id); other boundary edges get provenance (outline/via/zone) by
   geometric re-association. Hardest thing to retrofit — do before M4.
2. **`refinement_level` hierarchy** — parameterized level ladder for
   convergence-order tests and the Richardson error bars (levels need a known ratio,
   not nestedness).
3. Cross-layer connectivity (stitch via vias) → true disconnected-copper detection.
4. Arc tracks are straightened by the parser (fine for highlight, wrong for length-
   sensitive analysis); trapezoid/custom pads boxed. Stackup is parsed
   (`Pcb.stackup`, `copperThicknessMm`, `boardThicknessMm`) and drives solver
   sheet conductance per layer; ε_r/tanδ await M5.
5. M4 itself: linear FEM on the meshes (sheet conductivity σ·t, pad terminals as BCs,
   via barrels as lumped R) — the mesh side is ready for it.
6. Per-(layer,net) mesh caching for interactivity on 10× bigger boards (trivial,
   deferred until it hurts).

## 6. Environment gotchas (cost real time — don't rediscover)

- `vite demo` resolves the config from the `demo/` dir → a `vite.config.ts` in the
  module root is silently ignored (its `fs.allow` never applied; things "work" only
  for files in the module graph). Fix: `vite demo --config vite.config.ts` (done for
  pcb_mesh; the other modules' demos still carry the latent quirk).
- Don't import a wasm-pack `.wasm` via `?url` dynamic import in vite dev — serve it
  through `fs.allow` + default `initWasm()` fetch, or pass bytes in node.
- KiCad file facts verified on real files this session: pad angle absolutism (above);
  zone `filled_polygon`s are trusted as poured; net identity is the name string;
  **KiCad 9/10 graphic shapes on copper can carry `(net "…")` and are then real,
  connected copper** (a `gr_poly` patched Net-(Q4-E) on this board — parser reads the
  net, extraction/MC-verifier include fill + stroke stadiums); zones with `(keepout …)`
  and no `filled_polygon` are rule areas, not missing fills;
  **a via's `(layers A B)` is a SPAN** — through-vias list only F/B but connect every
  inner layer between (fixed net-288-style false disconnections on 4-layer boards);
  **the `(layers …)` table's numeric ids are legacy-stable, NOT ordered** (B.Cu is
  always 2, inners 4, 6…) — the physical copper stack is the table's TEXTUAL order
  (`Pcb.copperStack`); `fp_poly` on copper (microwave footprints) is real copper with
  no net — inferred from the footprint's unique pad net; `gr_text` on copper is real
  copper we render but cannot mesh yet (counted as `copperTextIgnored`);
  via TERMINALS use the annulus midline circle (r = (drill+size)/4), never an inset
  of the outer ring (vias are wider than their traces);
  **KiCad has TWO net-reference dialects** — name-style (`(net "GND")` on every
  element; poweramp fixture) and number-style (root table `(net 4 "+3V3")`, elements
  say `(net 4)`, but zones ALSO carry `(net_name "+3V3")`; jetson, openair-max). The
  parser canonicalizes every reference to the NAME via the root table (only id+name
  rows count — single-value root decls are the name dialect's own net list). Without
  this the same net splits in two — openair-max +3V3 had tracks under "4" and its
  1549 mm² In1.Cu plane under "+3V3" → "not connected" C13.2↔R8.2 (now 60.5 mΩ) and
  double-extracted, "empty-looking" B.Cu;
  **pour cutouts nest copper islands**: a pad/via whose copper sits inside a zone
  VOID is a separate polygon nested inside the big island's hole, so several outers
  can contain a terminal point — placement must pick the INNERMOST containing island
  (first-match landed "inside a void" and skipped multichannel_mixer's C11.1 & three
  sibling GND pads + their vias; now J9.R↔C11.1 = 2.23 mΩ);
  **via-in-pad is common on dense boards** (jetson: through via stacked at the center
  of an SMD pad, J18.D21) — the via merges into the pad's terminal on that layer, so
  cross-layer supernode stitching must union by terminal **member ids**
  (`Terminal.members`), never by the merged display id ("PAD+via@x,y" ≠ "via@x,y";
  matching display ids reported net-859 J18.D21↔R100.2 "not connected"; now solves
  1.055 Ω through all 10 layers).

## 7. Where things live

```
ARCHITECTURE.md                       repo-wide map (updated)
PARASITICS_CONTEXT.md                 this file
modules/kicad_pcb_viewer/CONTEXT.md   parser/board-model contract deep-dive
modules/analytic_models/README.md     M0 oracle: slices, sources, verification
~/git/pcb-toolkit                     sibling clone: Saturn reimplementation (fixture mint)
~/git/KiPIDA                          sibling clone: KiCad DC-PI plugin (AGPL — ideas/cross-check only)
~/git/atlc                            atlc 4.6.1 source (M5 numerical oracle; SF .tar.gz is corrupt, use .tar.bz2)
~/git/kicad                           sparse clone: pcb_calculator/transline (HJ formulas) + demos (4–12 layer boards)
~/git/FastCap2 FasterCap FastHenry2   ediloren mirrors (M6/M7 golden-reference solvers)
~/git/papers                          Hammerstad–Jensen 1980 + Wheeler 1977 PDFs (user-provided —
                                      M0/M5 transcription sources secured) + wcalc/Qucs docs
modules/pcb_mesh/README.md            pipeline, strategies, invariants, numbers
modules/geometry_core/README.md       kernel API, build, measurements
modules/pcb_mesh/scripts/             profile-mesh.ts, bench-ruppert*.ts (dev tools)
```
