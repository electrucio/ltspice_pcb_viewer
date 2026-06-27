# ltspice_pcb_viewer

Umbrella project for visualizing and cross-exploring electronics designs
(LTspice / KiCad schematics and PCBs). The project is composed of independent
**modules** under [`modules/`](modules/) that will be integrated into a single
application later.

## Modules

| Module | Description |
| --- | --- |
| [`kicad_schematic_viewer`](modules/kicad_schematic_viewer/) | Framework-agnostic `<kicad-schematic>` web component that parses `.kicad_sch`, computes the netlist in-browser, and renders an interactive SVG with net/component highlighting. |
| [`ltspice_schematic_viewer`](modules/ltspice_schematic_viewer/) | Framework-agnostic `<ltspice-schematic>` web component that parses `.asc` (with an embedded `.asy` symbol library), computes the netlist in-browser, and renders an interactive SVG with net/component highlighting. |
| [`ltspice_kicad_mapper`](modules/ltspice_kicad_mapper/) | `<ltspice-kicad-mapper>` web component that embeds both viewers side by side and builds a 1:1 net/component mapping between an LTspice and a KiCad schematic, with JSON import/export. The first cross-module integration. |

_More modules to come; they will be integrated into the umbrella app._

The two schematic viewers share the same interaction model and `ksv-*` theming
conventions; their net engines are cross-validated against each other on the shared
guitar-amplifier power-amp design.

## Working on a module

Each module is self-contained (its own `package.json`, build, tests, and demo):

```bash
cd modules/kicad_schematic_viewer
npm install
npm run dev     # interactive demo
npm test        # unit tests
npm run build   # library bundle in dist/
```

## Layout

```
ltspice_pcb_viewer/
  modules/
    kicad_schematic_viewer/     # KiCad schematic net/component viewer
    ltspice_schematic_viewer/   # LTspice schematic net/component viewer
    ltspice_kicad_mapper/       # side-by-side net/component mapper (embeds both viewers)
  README.md
```
