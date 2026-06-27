# ltspice_pcb_viewer

Umbrella project for visualizing and cross-exploring electronics designs
(LTspice / KiCad schematics and PCBs). The project is composed of independent
**modules** under [`modules/`](modules/) that will be integrated into a single
application later.

## Modules

| Module | Description |
| --- | --- |
| [`kicad_schematic_viewer`](modules/kicad_schematic_viewer/) | Framework-agnostic `<kicad-schematic>` web component that parses `.kicad_sch`, computes the netlist in-browser, and renders an interactive SVG with net/component highlighting. |

_More modules to come; they will be integrated into the umbrella app._

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
    kicad_schematic_viewer/   # KiCad schematic net/component viewer
  README.md
```
