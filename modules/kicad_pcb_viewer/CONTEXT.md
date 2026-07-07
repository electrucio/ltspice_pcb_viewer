# kicad_pcb_viewer — module context

Deep-dive context for `modules/kicad_pcb_viewer` (`<kicad-pcb>`). Complements the
one-paragraph summary in the repo-root [ARCHITECTURE.md](../../ARCHITECTURE.md).
Written as the reference for building analysis features (meshing, parasitic
extraction) on top of this module's parser and board model.

## What it is

A framework-agnostic web component that parses a KiCad `.kicad_pcb` file (S-expression,
KiCad 9/10 format) and renders it as a **single combined SVG view of all layers**
(not a top/bottom split like InteractiveHtmlBom), with pan/zoom, horizontal mirror,
rotation, per-layer visibility toggles, and net/component highlighting.

TypeScript + Vite (library mode) + Vitest, **zero runtime dependencies**. Ships both the
custom element and a headless core (parser + renderer usable without the element; the
parser is additionally usable in Node — no DOM needed).

## Pipeline / file map

```
.kicad_pcb text
  → src/parser/sexpr.ts      generic S-expression tokenizer/reader (shared design with
                             the schematic viewer): SNode {name, values, children},
                             helpers child()/children()/childStr()
  → src/parser/pcb.ts        typed, flat, render-ready board model (see below)
  → src/geometry/transform.ts footprint-local → board coords (rotate/translate);
                             ROT_SIGN = -1, locked EMPIRICALLY by maximizing
                             pad↔track-endpoint coincidence (scripts/diagnose-transform.ts)
  → src/render/svg.ts        SVG grouped by data-layer, elements tagged data-net/data-ref;
                             arcPath() renders 3-point arcs (start/mid/end)
  → src/interaction/controller.ts  PcbController: viewBox pan/zoom, mirror/rotation on a
                             content group, layer toggles, hit-test via fat invisible
                             *-hit companions, highlight/hover, click events
  → src/component/kicad-pcb.ts  <kicad-pcb> element tying it together (shadow DOM +
                             themable stylesheet from render/theme.ts, --ksv-* vars)
```

## The board model (`parser/pcb.ts` — the contract analysis code builds on)

`parsePcb(text): Pcb`. All coordinates are **board millimetres, Y pointing down**
(same convention as SVG). Footprint-local pad/graphic coordinates are already
transformed into board coords at parse time — consumers never deal with footprint
placement math.

```ts
Pcb {
  footprints: Footprint[]  // ref, symbolUuid (stable schematic-symbol UUID from the
                           // footprint `path` — survives ref renames), value, pos,
                           // angle, layer (F.Cu|B.Cu), pads[], graphics[] (silk/fab),
                           // refPos/refLayer
  tracks: Track[]          // start, end, width, layer, net  (routed `segment`s; `arc`
                           // tracks are COLLAPSED to straight start→end — see gaps)
  vias:   Via[]            // pos, size (outer copper Ø), drill, layers, net
  zones:  ZoneFill[]       // one entry per `filled_polygon`: layer, net, pts[]
                           // (the filled outline as stored by KiCad, already poured)
  graphics: BoardGraphic[] // gr_line/rect/circle/arc/poly on any layer; the board
                           // outline is the subset on layer "Edge.Cuts"
  nets: string[]           // sorted unique net NAMES (referenced by name everywhere;
                           // KiCad 9/10 puts the name in each (net …) — no net table)
  layers: string[]         // layer names seen on tracks/graphics
  bbox                     // from Edge.Cuts if present, else tracks+pads
}

Pad { ref, number, shape (circle|oval|rect|roundrect|trapezoid|custom), thruHole,
      pos (board coords), size {w,h}, angle (board-frame, deg), rratio, drill? {w,h},
      layers[] (e.g. ["*.Cu","*.Mask"] or ["F.Cu"]), net }
```

Notes for consumers:
- **Units:** mm everywhere, converted nowhere — the file is already mm.
- **Net identity is the name string.** Everything carrying copper (pad/track/via/zone)
  has `.net` (`""` = unconnected, e.g. mounting holes / np_thru_hole pads).
- **Pad geometry** is parametric (shape + size + angle + rratio), not polygonized;
  `render/svg.ts` has the polygonization logic for drawing (`padElement`), but it is
  render-oriented (SVG shapes), not reusable as geometry.
- **Zone fills are trusted as poured by KiCad** (the file stores `filled_polygon`s);
  the viewer does not re-pour zones, does not process thermal spokes, and treats each
  filled polygon independently.
- `angle` on pads is the **absolute board-frame angle exactly as stored in the file** —
  KiCad serializes pad rotation with the footprint rotation already included, even
  though pad *positions* are footprint-relative. (Adding `fangle` again was a real bug:
  poweramp Q7's 90°-placed footprint got 180° pads, drawing its ovals tall instead of
  wide. Fixed; pinned by a parser test.) Rotation sign is `ROT_SIGN = -1`
  (empirical — do not "fix" it without re-running the pad↔track coincidence
  diagnostic).
- `key(p)` in `geometry/transform.ts` quantizes coords to 1e-3 mm for robust point
  matching (used by tests and the mapper's structural net matching).

## Element API (`<kicad-pcb>`, class `KicadPcbElement`)

- Loading: `loadFromString(text)`, `src=` attribute / `loadFromUrl`.
- Query: `getNets(): string[]`, `getComponents(): PcbComponentInfo[]`
  (`{ref, value, symbolUuid, nets[], pos}`), `getLayers()`.
- View: `setLayer(layer, visible)`, `setMirror/toggleMirror`, `setRotation(0|90|180|270)`,
  `fit()`.
- Highlight: `highlightNet(name)`, `highlightComponent(ref)`, `clearHighlights()`
  (colors via `--ksv-highlight`/`--ksv-select` CSS variables — how the mapper recolors).
- Events: `ready`, `netselect`, `componentselect`, `nethover`.

## Rendering specifics worth knowing

- SVG groups per `data-layer` id: `B.Cu`, `F.Cu`, `pads`, `vias`, `F/B.SilkS`,
  `Edge.Cuts`, `refs`; toggling = `display:none` on the group.
- Every interactive element has a fat invisible `*-hit` companion for forgiving
  hit-testing (don't count DOM nodes and expect them to equal geometry counts).
- `arcPath(start, mid, end)` derives center/radius/sweep from the three points
  (collinear → straight line). This is the only arc math in the module.

## Tests & fixtures

- `test/fixtures/poweramp.kicad_pcb` — the real 47-footprint / 180-track / 18-via /
  2-copper-layer guitar-amp board (source of truth also used by the demo; original
  lives in the sibling `electrucio_updates` repo). 8 zones, 2 `filled_polygon`s.
- `test/pcb.test.ts` — structural counts; **pad↔track endpoint coincidence >80%**
  (validates ROT_SIGN + transforms end-to-end); layer/outline presence.
- `test/svg.test.ts`, `test/wheel.test.ts` — renderer & zoom math.
- Cross-module: the mapper (`modules/ltspice_kicad_mapper`) reconciles this viewer's
  nets/components against the schematic viewer via `symbolUuid` and structural ref-sets
  — an independent consistency check on this parser.

## Known gaps (v1)

- Arc tracks are collapsed to straight segments (fine for highlight; **wrong for
  geometry/length-sensitive analysis** — first thing to fix when meshing needs them).
- Back-side footprints are not mirrored (all poweramp footprints are front THT).
- No soldermask/paste rendering, no copper-pour hatching, no teardrops.
- `custom` pad shapes are drawn as their bounding primitive.
- No stackup parsing: layer *names* only — no thickness/ε_r/loss-tangent (needed later
  for parasitic extraction; the `(setup (stackup …))` section is present in KiCad files
  and simply ignored today).
- Nets are taken from the file's annotations; there is no independent connectivity
  derivation (unlike the schematic viewers, which must compute netlists).

## How sibling modules consume it

By **relative source import** (no workspace tooling):
`import { parsePcb } from "../../kicad_pcb_viewer/src/parser/pcb.js"` — the pattern
established by `ltspice_kicad_mapper`. The parser is DOM-free and safe in Node/Vitest.
