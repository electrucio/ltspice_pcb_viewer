# kicad-schematic-viewer

A framework-agnostic **web component** to visualize, explore, and highlight **nets
and components** from KiCad schematics (`.kicad_sch`), designed to be embedded in
other frontend apps.

```html
<kicad-schematic src="poweramp.kicad_sch" theme="dark"></kicad-schematic>
<script type="module">
  import "kicad-schematic-viewer"; // auto-registers <kicad-schematic>
</script>
```

## Why this exists / the key idea

A `.kicad_sch` file stores **geometry only — no netlist**. KiCad *derives* nets from
wire/pin/junction geometry plus label and power-symbol naming, every time it runs ERC
or exports. This module reimplements that derivation in the browser, so it needs no
KiCad install and no pre-export step. Net membership is computed by a union-find over
quantized coordinates that mirrors KiCad's connection rules:

1. each wire segment connects its endpoints;
2. a **junction** connects every wire passing through it (a mid-span T or a crossing
   connects *only* with a junction dot);
3. pins / labels / power-symbol pins on the same point share the node;
4. local/global labels merge by text; power symbols merge by value.

> Connectivity is reproduced exactly (validated against a ground-truth oracle). The
> auto-generated *name* of an anonymous net (`Net-(REF-PIN)`) follows KiCad's
> convention but its exact string is not guaranteed to match KiCad's internal pick —
> what matters is which pins share a net.

## Architecture

```
src/
  parser/sexpr.ts        S-expression tokenizer/parser -> generic tree
  parser/schematic.ts    typed model: lib symbols (pins+graphics), instances, wires…
  geometry/transform.ts  instance rotation/mirror + Y-flip -> world coords
  netlist/connectivity.ts union-find net engine  (the core)
  render/svg.ts          model+netlist -> SVG, every node tagged data-net/data-ref
  render/theme.ts        themable CSS custom properties (light/dark)
  interaction/controller.ts pan/zoom, DOM hit-testing, highlight
  component/kicad-schematic.ts  <kicad-schematic> custom element + API
  index.ts               entry: auto-registers element + exports headless core
```

## API

**Attributes:** `src`, `theme` (`light`|`dark`), `interactive` (`false` to disable).

**Methods:** `loadFromUrl(url)`, `loadFromString(text)`, `highlightNet(name)`,
`highlightComponent(ref)`, `clearHighlights()`, `fit()`, `zoomToNet(name)`,
`getNets(): NetInfo[]`, `getComponents(): ComponentInfo[]`.

**Events** (`CustomEvent`, bubbling/composed): `ready`, `nethover`, `netselect`,
`componenthover`, `componentselect` — `detail` carries the net/component info.

**Headless** (no DOM): `import { parseSchematic, buildNetlist } from "kicad-schematic-viewer"`.

## Develop

```bash
npm install
npm run dev      # demo at /demo (poweramp explorer with net/component sidebar)
npm test         # net engine validated against poweramp_net_mapping.md oracle
npm run build    # ESM bundle + d.ts in dist/
```

## Scope & limitations (v1)

- Single flat sheet. The model is structured for hierarchical sheets / global labels /
  buses / no-connects, which are not yet wired into the net engine.
- Text uses a web sans-serif rather than KiCad's Newstroke vector font.
- Power-symbol detection uses the `(power …)` marker; the net name is the instance value.
