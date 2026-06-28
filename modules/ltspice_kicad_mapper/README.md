# ltspice_kicad_mapper

A web component that shows an **LTspice** schematic and a **KiCad** schematic side by
side and lets you build (and export) a **1:1 mapping** between their **nets** and their
**components**. Third module of the `ltspice_pcb_viewer` umbrella project; it embeds the
two sibling viewer modules.

```html
<ltspice-kicad-mapper id="m" theme="dark"></ltspice-kicad-mapper>
<script type="module">
  import "ltspice_kicad_mapper"; // auto-registers <ltspice-kicad-mapper>
  const m = document.getElementById("m");
  m.registerLtspiceSymbol("lin_pot", asyText); // custom .asy, before loading
  await m.loadLtspiceUrl("amp.asc");
  await m.loadKicadUrl("board.kicad_sch");
</script>
```

## Why

The same circuit carries different auto-generated names in each tool (LTspice
`PRE_SPEAKER` is KiCad `Net-(C8-Pad2)`). This tool produces a durable, re-loadable
correspondence between the two domains.

## Interaction

Mapping is **deliberate** — clicking only selects, so a stray click never maps:

- **Hover** over a net/part to preview it (distinct violet cue) before selecting.
- Click a net/part on one side → **pending** selection (amber). If a likely match
  exists on the other side it is **auto-selected** (blue) so you can map immediately —
  but nothing maps until you confirm.
- Press **M** (or the **Map** button) to map the selected pair (both turn green). Pick a
  different item on the other side first if the suggestion is wrong. `Esc` clears, `U` unmaps.
- Selecting a net highlights **only that net** (its wires/pins), not the bodies of the
  components it connects to.
- Selecting a fresh item resets cleanly (clicking a new item never re-lights a
  previously-mapped pair); clicking **empty space** unselects **both** sides.
- Click an already-mapped item → both sides highlight green (cross-probe).
- **Unmap** breaks the active pair; **Clear** drops the selection.
- Every mapped net/part is **always drawn slightly thicker** (marked) on both sides, so
  what's done stays visible while you work.
- The per-side **Nets/Components** lists show mapped status (`→ counterpart`) + counts.
- **Export mapping** downloads JSON; **Import mapping** restores it (stale ids pruned).

### Chain of suggestions

After you map a **component** pair, the mapper walks outward and **pre-selects the next
likely component pair** (auto-selected on both sides) — so you can map a whole connected
cluster by pressing **M** repeatedly. Candidates are components *adjacent to the anchor*
(sharing a net) on each side, scored by:

- same type (R/C/D/L/Q) — a hard gate; other parts (pots, sources, connectors) are left
  to manual mapping;
- shared already-mapped nets (topology) — strongest signal;
- shared already-mapped **component** neighbors — if a candidate connects to a mapped
  component, the other-side candidate that connects to its mapped counterpart scores
  higher (this compounds as the chain grows);
- same value (engineering-aware: `4k7` == `4.7k`);
- **proximity** to the anchor — the nearest directly-connected neighbor is preferred, so
  the chain crawls locally instead of jumping around; direction is a final tie-breaker.

Reference designators are **not** used — they frequently differ between the two tools.

Both schematics **auto-zoom** to the anchor + suggestion, so the suggested parts are easy
to find. If the suggestion is wrong, click the correct counterpart before pressing M.

### Inference (runs after every map / import)

- If a mapped **component** has exactly one unmapped net on each side, those two nets
  are mapped automatically.
- If **all** of a component's nets are mapped and exactly one component on the other
  side has the matching net set, the two components are mapped automatically.
- If **all** components connected to a net are mapped and exactly one net on the other
  side connects to the matching set of components, the two nets are mapped automatically.

All cascade to a fixpoint and run on **every** confirmed mapping — manual *and* chained —
so mapping a handful of components pulls in most of their nets (and vice versa).

## Architecture

```
src/
  mapping/format.ts     MappingFile JSON schema + serialize/deserialize/validate
  mapping/store.ts      MappingStore: two 1:1 bimaps (nets, components), suggest, import/export
  interaction/pairing.ts pure pairing state machine (pending -> map), unit-tested
  component/mapper.ts   <ltspice-kicad-mapper>: embeds both viewers, sidebars, toolbar
  component/style.ts    shadow-DOM stylesheet
  index.ts              entry: registers element + exports headless mapping primitives
```

It depends on the two sibling viewers, imported by relative path
(`../../<viewer>/src/index.js`) for element registration; Vite bundles them. Highlight
**color is recolored per state** by setting the viewers' `--ksv-highlight` /
`--ksv-select` CSS variables — so the two viewer modules need no changes.

### Public API
- Attributes: `ltspice-src`, `kicad-src`, `theme`.
- Methods: `loadLtspiceUrl`, `loadKicadUrl`, `registerLtspiceSymbol`, `loadMapping`,
  `exportMapping(): MappingFile`, `getStore()`.
- Event: `mappingchange` (detail = `{nets, components}` counts).

### Mapping file
```jsonc
{ "version": 1,
  "ltspiceSource": "AudioAmpCompl-40W.asc", "kicadSource": "poweramp.kicad_sch",
  "nets":       [ { "ltspice": "FEEDBACK", "kicad": "Net-(C4-Pad2)" }, { "ltspice": "0", "kicad": "0" } ],
  "components": [ { "ltspice": "R1", "kicad": "R1" } ] }
```

## Develop

```bash
npm install
npm run dev     # demo: AudioAmpCompl-40W.asc <-> poweramp.kicad_sch
npm test        # store + format + pairing unit tests
npm run build   # bundle in dist/
```

## Limitations (v1)
1:1 only (unmap to remap); suggestions match identical names/refs only (most nets are
mapped manually because the tools' auto-names differ). The viewers run in light,
high-contrast mode.

> The "faint mark of all mapped items" relies on a small `markNets`/`markComponents`/
> `clearMarks` API added to both viewer modules (a set-highlight independent of the
> single selection, styled by the `--ksv-mark` CSS variable).
