# ltspice_schematic_viewer

A framework-agnostic **web component** to visualize, explore, and highlight **nets
and components** from LTspice schematics (`.asc`). Sibling of `kicad_schematic_viewer`
in the `ltspice_pcb_viewer` umbrella project.

```html
<ltspice-schematic src="amp.asc" theme="dark"></ltspice-schematic>
<script type="module">
  import "ltspice_schematic_viewer"; // auto-registers <ltspice-schematic>
</script>
```

## Key ideas

- **`.asc` stores geometry only — no netlist.** Nets are computed in-browser by a
  union-find over wire endpoints, pins, and flags (T-junctions connect; bare
  crossings don't; same-named flags merge; flag `0` is ground).
- **Symbol geometry is external.** LTspice ships symbol shapes in `.asy` files that
  aren't in the `.asc`. The module embeds a built-in library (res, cap, ind, diode,
  npn, pnp, mos, jfet, sources, …); custom symbols are added at runtime via
  `registerSymbol(name, asyText)`.
- **UTF-16.** LTspice writes `.asc`/`.asy` as UTF-16 (often LE, no BOM); the loader
  sniffs and decodes automatically.

## Architecture

```
src/
  parser/asc.ts          .asc parser + UTF-16 decode
  parser/asy.ts          .asy symbol parser (lines/rects/circles/arcs + pins)
  symbols/builtin.ts     embedded built-in symbol library + SymbolLibrary lookup
  geometry/transform.ts  LTspice R0/R90/.. and Mn mirror orientation
  netlist/connectivity.ts union-find net engine + symbol placement (the core)
  render/svg.ts          model -> SVG (arcs sampled as polylines, flags, text)
  render/theme.ts        themable CSS (non-scaling strokes for large coords)
  interaction/controller.ts  shared pan/zoom/hit-test/highlight (same as KiCad module)
  component/ltspice-schematic.ts  the <ltspice-schematic> element + API
```

## API

- **Attributes:** `src`, `theme` (`light`|`dark`), `interactive`.
- **Methods:** `loadFromUrl`, `loadFromString` (text or raw bytes), `registerSymbol`,
  `highlightNet`, `highlightComponent`, `clearHighlights`, `fit`, `zoomToNet`,
  `getNets`, `getComponents`.
- **Events:** `ready`, `nethover`, `netselect`, `componenthover`, `componentselect`.

## Develop

```bash
npm install
npm run dev     # demo: AudioAmpCompl-40W.asc explorer
npm test        # net engine, cross-validated against the KiCad poweramp net mapping
npm run build   # library bundle in dist/
```

## Validation

The net engine is unit-tested against `AudioAmpCompl-40W.asc` and **cross-validated
with the KiCad viewer**: the power-amp block produces the same connectivity in both
(e.g. LTspice `PRE_SPEAKER` == KiCad `OUT`, `FEEDBACK`, `BOOTSTRAP`, `VCC`).

## Limitations (v1)

- Built-in symbol set covers common primitives; exotic/third-party symbols need
  `registerSymbol`. Missing symbols render as a dashed `?` placeholder.
- Text uses a web sans-serif (not LTspice's exact font); `.subckt`/hierarchy and
  bus notation are not yet modeled.
