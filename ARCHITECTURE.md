# ltspice_pcb_viewer — architecture & context

Context dump for future work. The repo is an **umbrella project** holding independent,
self-contained frontend **modules** under [`modules/`](modules/) that will eventually be
integrated into one app. Everything is TypeScript + Vite (library mode) + Vitest, no
runtime deps; each module ships a framework-agnostic **web component** plus a headless
core, and has its own `demo/` (run with `npm run dev`), `test/`, and `README.md`.

Reference designs used throughout live in a **sibling repo**, not here:
`../electrucio_updates/guitar_amplifier/` — `ltspice/AudioAmpCompl-40W.asc` (LTspice,
UTF-16) and `kicad/poweramp/poweramp.kicad_sch` (KiCad 10). `poweramp_net_mapping.md`
there is the **ground-truth net oracle** used to validate the net engines (and the two
viewers cross-validate against each other on the shared power-amp block).

## Modules

### `modules/kicad_schematic_viewer` — `<kicad-schematic>`
Parses `.kicad_sch` (S-expression) and **computes the netlist in-browser** (KiCad stores
geometry only). Pipeline: `parser/sexpr.ts` → `parser/schematic.ts` (typed model:
lib symbols w/ pins+graphics, instances, wires, junctions, labels) →
`geometry/transform.ts` (instance rotation/mirror + library-Y-up→schematic-Y-down;
the exact variant was **empirically locked** by maximizing pin↔wire-endpoint coincidence)
→ `netlist/connectivity.ts` (union-find over quantized coords: wire endpoints, junction-
gated T/crossings, label & power-symbol naming) → `render/svg.ts` (SVG tagged with
`data-net`/`data-ref`) → `interaction/controller.ts` (pan/zoom, hit-test, highlight).
Validated by 5 vitest tests against `poweramp_net_mapping.md`.

### `modules/ltspice_schematic_viewer` — `<ltspice-schematic>`
Same shape for LTspice `.asc`. Extra challenges handled: **UTF-16 decode** (`parser/asc.ts`),
and **symbol geometry is external** to the `.asc` — an embedded built-in `.asy` library
(`symbols/builtin.ts`, ported from the project's `asc_viewer.html`) plus a runtime
`registerSymbol(name, asyText)` for custom symbols (the demo registers the pot `.asy`s).
LTspice orientation (`R0/R90/…`, `Mn` mirror) in `geometry/transform.ts`; net engine in
`netlist/connectivity.ts` (T-junctions auto-connect where an endpoint lies on a wire;
FLAGs name nets; `0` = ground). 6 vitest tests; cross-validates with the KiCad engine.

### `modules/ltspice_kicad_mapper` — `<ltspice-kicad-mapper>`  (the integration)
Embeds the viewers side by side (imported by relative path from `../../<viewer>/src`)
and builds a **1:1 net/component mapping** between them. Recolors the viewers' highlights
via their `--ksv-highlight`/`--ksv-select` CSS variables — the viewers needed almost no
changes for this. Key files: `mapping/store.ts` (two 1:1 bimaps + JSON import/export),
`mapping/format.ts`, `interaction/pairing.ts` (deliberate selection state machine),
`suggest/chain.ts` (the suggestion engine), `component/mapper.ts` (the element).

The KiCad pane carries **both** a `<kicad-schematic>` and a `<kicad-pcb>` (a
`[Schematic | PCB]` toggle picks which is visible; both stay mounted so highlights
survive toggling). KiCad highlights **fan out to both** views, translated through two
aliases in `mapping/kicad-nets.ts`:
- **Components** (`reconcileKicadComponents`) match by the **stable schematic symbol
  UUID** — the footprint's `(path …)` ends in the schematic symbol's `(uuid …)`, which
  survives reference-designator renames (e.g. schematic `Q3` ↔ board `Q3*`). The
  `<kicad-schematic>` exposes `ComponentInfo.uuid`; `<kicad-pcb>` exposes
  `PcbComponentInfo.symbolUuid`.
- **Nets** (`reconcileKicadNets`) — net names differ (PCB prefixes labeled/power nets
  with a sheet path, e.g. `POW` ↔ `/POW`; auto-names like `Net-(C6-Pad1)` vs
  `Net-(Q3-C)` don't match at all). Matched exact → path-normalized → structurally by
  equal connected-**ref-set**, where PCB ref-sets are first translated into
  schematic-ref space via the UUID component alias so they compare like-for-like.

The mapper exposes `loadKicadPcb*`, `setKicadView`, and `getSources()` (raw text of all
loaded designs + registered symbols) for the app's static export. The read-only export
viewer rebuilds the same two aliases from the embedded designs.

### `modules/kicad_pcb_viewer` — `<kicad-pcb>`
Renders a KiCad `.kicad_pcb` (S-expression; reuses `parser/sexpr.ts`) as a **single
combined view of all layers** — not split top/bottom like InteractiveHtmlBom.
`parser/pcb.ts` → model (board edges, tracks, vias, zone fills, footprints w/ pads +
silk + ref); nets by name (KiCad 9/10). `geometry/transform.ts` places footprint pads
(orientation; `ROT_SIGN` locked empirically by pad↔track coincidence; all poweramp
footprints are front-side THT). `render/svg.ts` draws into `data-layer` groups (B.Cu,
F.Cu, pads, vias, F/B.SilkS, Edge.Cuts, refs), tagging `data-net`/`data-ref`.
`interaction/controller.ts` = pan/zoom + horizontal **mirror** (transform on a content
group) + per-layer visibility + net/component highlight (`--ksv-highlight`). 3 parser
tests. Data source is the original `poweramp.kicad_pcb` (not the ibom export).

### `modules/app` — the integrated application
Full-screen shell (`index.html` + `src/main.ts`) embedding `<ltspice-kicad-mapper>`:
LTspice left, switchable KiCad schematic/PCB right, map + synchronized cross-probe,
upload any `.asc`/`.kicad_sch`/`.kicad_pcb`. The app runs in **modern browsers only**.

Its headline feature is **Download read-only HTML**: a separate, pre-compiled
**read-only viewer** (`viewer/viewer.ts` + `cross-probe.ts` + `lists.ts` read-only
nets/components sidebars + `compat.ts`) is built by
`vite.viewer.config.ts` into one self-contained, **iOS-Safari-12-targeted** HTML
*template* (`src/generated/viewer.html`, git-ignored) with a `__LK_DATA__` placeholder
inside a `<script type="application/json">` block. On Download, `main.ts` replaces that
placeholder with a JSON payload (`getSources()` + `exportMapping()`; `<` escaped to
`<` so a stray `</script>` can't break out) and saves a Blob — ibom-style, no
`fetch`. Old-Safari strategy: esbuild `build.target:"safari12"` downlevels syntax
(`?.`,`??`); `compat.ts` shims the method-level gaps (`replaceChildren`, `flatMap`);
SVG rendering + native Web Components mean no canvas/Path2D or web-components polyfill.
The payload reserves a `simulation` field for future LTspice sim results.

## Shared conventions (across both viewers)

- **`ksv-*` CSS classes** and a **themable stylesheet** (`render/theme.ts`) with
  `--ksv-*` custom properties; light + dark. The mapper drives highlight color through
  these variables.
- **`interaction/controller.ts` is duplicated** in both viewers (copy, not shared
  package yet) — edits usually need applying to both. It owns pan/zoom (viewBox),
  DOM hit-testing via fat invisible `*-hit` companions, `highlightNet/Component`,
  `markNets/markComponents/clearMarks` (a set-highlight independent of selection),
  hover (`ksv-hover`), and `zoomToComponents` / `zoomToNet` (use `fitWithContext`, which
  keeps ~45% of the schematic in view so there's context).
- Viewer element API: `loadFromUrl/loadFromString`, `getNets()`, `getComponents()`
  (incl. `nets[]` and `pos`), `highlightNet/Component`, `clearHighlights`,
  `mark*`/`clearMarks`, `zoomToNet/zoomToComponents`; events `ready`, `netselect`,
  `componentselect`, `nethover`, `componenthover`.

## Mapper behaviour (current)

- **Deliberate mapping:** clicking only *selects* (one per side); press **M** (or Map
  button) to commit. `Esc` clears, `U` unmaps. Clicking empty space clears both sides.
- **Suggestion engine** (`suggest/chain.ts`), no reference designators, no geometry:
  - `simpleSimilarity(lt,ki)` = 1 if confirmed, 0 if different type (R/C/D/L/Q), else
    `0.4 + 0.6·valueSimilarity` (engineering-aware: `4k7`==`4.7k`).
  - `contextualComponentScore` = `simple·(0.4+0.6·neighbourContext) + netConsistency`
    (confirmed neighbours count 1.0; confirmed-net agreement rewards, contradiction
    penalises hard).
  - Nets: `netContextualScore` = component-overlap via `simpleSimilarity`
    (confirmed components dominate); **no simple level** (net labels untrusted).
  - Thresholds `COMPONENT_THRESHOLD`/`NET_THRESHOLD` (0.5); **mutual back-check**
    (`MUTUAL_RATIO` 0.8) drops a suggestion whose top-1 clearly belongs to someone else.
  - Clicking an unmapped item auto-selects its best contextual counterpart; after a map,
    the **chain** pre-selects the next likely pair *of the same kind* and zooms to it.
- **Inference** after every map/import (fixpoint): mapped-component→leftover net,
  all-nets-mapped→component, all-components-mapped→net.
- **Highlighting:** while something is selected, only the **active pair** is highlighted;
  when idle, all mapped items are faintly **marked** (so a full mapping doesn't look like
  "everything is highlighted" on click). Selected/suggested components show a bold box;
  nets show a thicker stroke + translucent halo.
- **Mapping file:** JSON `{version, ltspiceSource, kicadSource, nets[], components[]}`;
  import prunes entries whose ids are absent in the loaded schematics.

## Dev / verify workflow

- Per module: `npm install`, `npm run dev` (serves `demo/`), `npm test`, `npm run build`.
- Cross-module: the mapper imports sibling **source** directly; no workspace tooling yet
  (a future option). Root `.gitignore` covers `node_modules/`/`dist/` at any depth.
- Browser verification is done with the **chrome-devtools MCP** against the demos
  (load, screenshot, simulate clicks / `keydown` for M, assert DOM classes/counts).
- Net engines are validated against `poweramp_net_mapping.md`; the mapper's suggestion
  engine is unit-tested in `test/chain.test.ts`.

## Known gaps / future ideas
- Hierarchical KiCad sheets, global/hierarchical labels, buses, Newstroke font fidelity
  are out of scope in the viewers.
- The `controller.ts` copies (and `theme.ts`) could be extracted into a shared package
  once integration starts (the PCB viewer has its own `PcbController` variant too).
- Next integration: a schematic↔PCB cross-probe (reuse the mapper pattern; the PCB
  viewer already exposes `data-net`/`data-ref` + `highlightNet`/`highlightComponent`).
- PCB viewer v1 gaps: back-side footprint flip, copper-pour hatching, soldermask/3D.
