# kicad_pcb_viewer

A framework-agnostic **web component** that renders a KiCad PCB (`.kicad_pcb`) as a
**single combined view of all layers** (not split top/bottom like InteractiveHtmlBom),
with layer toggles, net/component highlighting, mirror, and pan/zoom. Part of the
`ltspice_pcb_viewer` umbrella project; designed for later cross-probe integration.

```html
<kicad-pcb src="board.kicad_pcb"></kicad-pcb>
<script type="module">
  import "kicad_pcb_viewer"; // auto-registers <kicad-pcb>
</script>
```

## What it does

- Parses `.kicad_pcb` (S-expression, reusing the schematic viewer's `sexpr` parser) into
  a render-ready model: board edges, copper tracks, vias, zone fills, and footprints with
  pads + silkscreen + reference labels. Nets are referenced by name (KiCad 9/10).
- Renders one SVG in board mm (Y down): bottom copper, top copper, pads (with drill
  holes), vias, silkscreen, board outline, references — each in a `data-layer` group.
- Every clickable element carries `data-net` / `data-ref`; highlight reuses the
  `--ksv-highlight` variable so the umbrella app can cross-probe like the schematic viewers.

## API

- Attributes: `src`.
- Methods: `loadFromUrl`, `loadFromString`, `getLayers()`, `setLayer(layer, visible)`,
  `setMirror(on)`, `toggleMirror()`, `setRotation(deg)`, `getRotation()`, `rotate90()`,
  `fit()`, `highlightNet(name)`, `highlightComponent(ref)`, `clearHighlights()`,
  `getNets()`, `getComponents()`.
- Events: `ready`, `netselect`, `componentselect`, `nethover`.

Layer ids (toggleable): `B.Cu`, `F.Cu`, `pads`, `vias`, `B.SilkS`, `F.SilkS`,
`Edge.Cuts`, `refs`.

## Develop

```bash
npm install
npm run dev     # demo: poweramp.kicad_pcb (layer checkboxes, net/part lists, mirror)
npm test        # parser tests (counts + pad-on-track coincidence)
npm run build   # library bundle in dist/
```

## Export the demo as a static page

`npm run build:demo` bundles the demo into a **single self-contained**
`dist-demo/index.html` (JS, CSS, and the default `poweramp.kicad_pcb` all inlined —
no runtime `fetch`). It uses a relative `base`, so it works at any URL or subpath:

```bash
# bake YOUR board into the page (defaults to the bundled poweramp board):
BOARD=/path/to/your.kicad_pcb npm run build:demo

# then publish the one file anywhere static, e.g. a GitHub Pages repo:
cp dist-demo/index.html /path/to/<user>.github.io/pcb.html
# it even opens straight from file://
```

The in-page file picker still works on the static page (it reads the chosen
`.kicad_pcb` locally in the browser — nothing is uploaded), so one published
page can also view other boards on the fly.

## Notes / limitations (v1)
- The footprint/pad rotation sign (`ROT_SIGN`) is locked empirically (pads coincide with
  their nets' track endpoints). All poweramp footprints are front-side & through-hole;
  back-side footprint flipping isn't exercised yet (the parser places by orientation only).
- Pad shapes: circle / oval / roundrect / rect (trapezoid/custom fall back to rect).
- Mirror is a horizontal flip of the whole view (text included), i.e. "view from back".
- No copper-pour hatching, soldermask, or 3D; zones render as their filled polygons.
