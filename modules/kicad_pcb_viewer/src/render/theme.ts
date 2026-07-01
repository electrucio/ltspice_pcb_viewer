/**
 * Theme for the PCB viewer. Single combined view of all layers; colours are themable
 * via `--pcb-*` custom properties, and selection highlighting reuses `--ksv-highlight`
 * (so the umbrella app can cross-probe by overriding it, like the schematic viewers).
 */
export const STYLESHEET = `
:host {
  --pcb-bg: #1b1f22;          /* outside the board */
  --pcb-board: #2c3a33;       /* substrate */
  --pcb-fcu: #d08a3e;         /* front copper */
  --pcb-bcu: #2f6fb0;         /* back copper */
  --pcb-pad: #c9962b;         /* pads / vias copper */
  --pcb-hole: #14181a;        /* drilled holes */
  --pcb-silk: #e9ecef;
  --pcb-edge: #d9cf52;        /* board outline */
  --pcb-zone-opacity: 0.35;
  --ksv-highlight: #ff3b3b;   /* selected net/part */
  --ksv-dim-opacity: 0.25;
  display: block; position: relative; width: 100%; height: 100%;
  overflow: hidden; background: var(--pcb-bg);
  font-family: ui-sans-serif, system-ui, sans-serif;
}
.pcb-root { width: 100%; height: 100%; }
svg { width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; transform-origin: 0 0; }
svg.pcb-panning { cursor: grabbing; }

.pcb-board { fill: var(--pcb-board); stroke: none; }
.pcb-track { fill: none; stroke-linecap: round; pointer-events: none; }
.pcb-track.layer-F_Cu { stroke: var(--pcb-fcu); }
.pcb-track.layer-B_Cu { stroke: var(--pcb-bcu); }
.pcb-track-hit { fill: none; stroke: transparent; stroke-linecap: round; pointer-events: stroke; }
.pcb-zone { stroke: none; opacity: var(--pcb-zone-opacity); pointer-events: fill; }
.pcb-zone.layer-F_Cu { fill: var(--pcb-fcu); }
.pcb-zone.layer-B_Cu { fill: var(--pcb-bcu); }
.pcb-pad-copper { fill: var(--pcb-pad); stroke: none; }
.pcb-hole { fill: var(--pcb-hole); stroke: none; pointer-events: none; }
.pcb-pad { pointer-events: fill; }
.pcb-via-copper { fill: var(--pcb-pad); }
.pcb-via { pointer-events: fill; }
.pcb-silk { stroke: var(--pcb-silk); fill: none; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
.pcb-silk.filled { fill: var(--pcb-silk); }
.pcb-edge { stroke: var(--pcb-edge); fill: none; stroke-linecap: round; pointer-events: none; }
.pcb-ref { fill: var(--pcb-silk); pointer-events: none; }

.pcb-track-hit:hover, .pcb-pad:hover, .pcb-via:hover, .pcb-zone:hover { cursor: pointer; }

/* selection: dim everything, light the chosen net/part */
.pcb-root.has-selection .pcb-track,
.pcb-root.has-selection .pcb-zone,
.pcb-root.has-selection .pcb-pad-copper,
.pcb-root.has-selection .pcb-via-copper,
.pcb-root.has-selection .pcb-ref,
.pcb-root.has-selection .pcb-silk { opacity: var(--ksv-dim-opacity); transition: opacity .08s; }

.pcb-track.ksv-on { opacity: 1 !important; stroke: var(--ksv-highlight); }
.pcb-zone.ksv-on { opacity: calc(var(--pcb-zone-opacity) + 0.25) !important; fill: var(--ksv-highlight); }
.pcb-pad-copper.ksv-on, .pcb-via-copper.ksv-on { opacity: 1 !important; fill: var(--ksv-highlight); }
.pcb-ref.ksv-on { opacity: 1 !important; fill: var(--ksv-highlight); }
/* a selected component: outline its courtyard/silk too */
.pcb-footprint.ksv-on .pcb-silk { opacity: 1 !important; stroke: var(--ksv-highlight); }
`;
