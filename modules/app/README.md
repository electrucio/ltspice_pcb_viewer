# app — LTspice ↔ KiCad mapper & cross-probe

The integrated application that ties the other modules together:

- **Left:** an LTspice schematic. **Right:** a KiCad project, switchable between its
  **schematic** and its **PCB** (a `[Schematic | PCB]` toggle).
- **Map** nets and components between LTspice and KiCad, with **synchronized
  highlighting**: click a net/component in any pane and its mapped counterpart lights up
  in the others — including the PCB (KiCad schematic and PCB share refs; net names are
  reconciled, e.g. schematic `POW` ↔ PCB `/POW`).
- **Simulation summaries**: upload an LTspice transient `.raw` (+ optional `.op.raw`);
  the app summarizes each net (V min/avg/rms/max/pp, DC bias) and component (current,
  voltage drop, power; transistor Ic/Ib/Ie + β) and **discards the bulk waveform**. Hover
  any net/component (either side) to see its metrics in a tooltip; the `ƒ directives` button
  lists the SPICE directives, and the summary rides along in the exported HTML.
  Optionally **Load .log** — the `.raw` stores float32, so harmonics/THD/ripple can't be
  recomputed to LTspice's precision; instead the `.log`'s **exact** `.four` (harmonics +
  THD, signal *and* 50 Hz ripple) and `.meas` results are parsed and shown verbatim in a
  **"from LTspice .log"** section of the tooltip (`sim/logfile.ts`).
  Optionally **Load .net** (the LTspice SPICE netlist) too: unlabeled nets get
  viewer-invented names (`Net-(C14.1)`) that don't match the `.raw`'s internal node names
  (`V(n008)`), so they'd otherwise show no data; the netlist bridges them by matching each
  net to the node touching the same component set (`sim/netlist.ts`) — this also lets the
  `.log`'s node data attach to anonymous nets.
- **Upload** any `.asc`, `.kicad_sch`, and `.kicad_pcb` (toolbar Load buttons).
- **Download read-only HTML**: bakes the current designs + mapping into **one
  self-contained file** that is **read-only** (cross-probe by clicking the schematics/PCB
  or the **nets/components lists**, plus the schematic/PCB toggle and PCB **Mirror** /
  **Rotate** (90°/180°/270°) controls — no editing) and **compatible with old iOS
  Safari (12.x)**.

The app itself targets modern browsers; only the downloaded file carries the old-Safari
constraint.

## Run

```bash
npm install
npm run dev     # builds the export template, then serves the app (modern browsers)
npm run build   # dist-app/ (modern static build)
```

`npm run dev`/`build` first run `npm run build:viewer`, which compiles the read-only
viewer (`viewer/`) into a single Safari-12-targeted HTML *template*
(`src/generated/viewer.html`, git-ignored). The app imports that template with `?raw`
and, on **Download**, replaces its `__LK_DATA__` placeholder with a JSON payload of the
current designs + mapping (ibom-style data-in-a-`<script>`-block; no `fetch`).

## How the pieces fit

```
index.html + src/main.ts            app shell: toolbar (Download) + <ltspice-kicad-mapper>
  └─ <ltspice-kicad-mapper>          embeds <ltspice-schematic>, <kicad-schematic>,
                                     <kicad-pcb>; owns mapping + synchronized highlight
viewer/  (read-only export)         viewer.html + viewer.ts + cross-probe.ts
                                     + lists.ts (read-only sidebars) + compat.ts
  └─ compiled by vite.viewer.config.ts (target: safari12) → src/generated/viewer.html
```

### Old-Safari compatibility (export only)

- `vite.viewer.config.ts` sets esbuild `build.target: "safari12"` → modern **syntax**
  (`?.`, `??`, …) is downleveled automatically.
- `viewer/compat.ts` shims the two **method**-level gaps the viewer components use that
  esbuild does not polyfill: `Element.prototype.replaceChildren` (Safari 14+) and
  `Array.prototype.flatMap`.
- Rendering is **SVG** (no canvas `Path2D`); Web Components / Shadow DOM are native in
  iOS Safari 10.1+; no web-components polyfill is needed for the iOS 12 target.

## Deploying the app (GitHub Pages)

The app is a pure client-side SPA (no backend; static asset `fetch()` calls are
page-relative), so it can be served as-is from GitHub Pages. It's published to
`electrucio.github.io/ltspice-kicad-mapper/` by `.github/workflows/deploy-app.yml`,
which builds `modules/app` with `VITE_BASE=/ltspice-kicad-mapper/` (see `vite.config.ts`
— the built `index.html` otherwise references assets from the site **root**, which
would collide with the other content already at `electrucio.github.io`'s root) and
pushes `dist-app/` into that subfolder of the `electrucio/electrucio.github.io` repo.

One-time setup (must be done by a human on github.com — not automatable from here):

1. **Push this repo to GitHub** (it currently only exists locally): create a repo (e.g.
   under the `electrucio` account) and `git remote add origin <url> && git push -u origin main`.
2. **Create a deploy token**: a classic PAT with `repo` scope, or a fine-grained PAT
   scoped to `electrucio/electrucio.github.io` with **Contents: read and write** —
   created on the account that has push access to that repo.
3. **Add it as a secret** named `PAGES_DEPLOY_TOKEN` in this repo's
   **Settings → Secrets and variables → Actions**.
4. Push to `main` (touching `modules/app/**` or a sibling viewer module) — the workflow
   builds and deploys automatically. Use the **Run workflow** button (workflow_dispatch)
   for a manual first run.

To change the target subfolder or repo, edit `DEPLOY_SUBPATH` / the `repository:` field
in `.github/workflows/deploy-app.yml`.

## Future

The export payload reserves a `simulation` field (currently `null`) for upcoming
LTspice simulation results linked to specific nets/components.
