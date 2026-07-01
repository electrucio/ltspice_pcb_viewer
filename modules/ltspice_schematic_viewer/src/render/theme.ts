/**
 * Theming for the LTspice viewer. Class names match the shared interaction
 * controller (ksv-*). LTspice coordinates span thousands of units, so all strokes
 * use `vector-effect: non-scaling-stroke` and pixel widths to stay crisp at any zoom.
 */
export const STYLESHEET = `
:host {
  --ksv-bg: #0e1116;
  --ksv-wire: #4aa3ff;
  --ksv-junction: #4aa3ff;
  --ksv-symbol: #c9d1d9;
  --ksv-pin: #c9d1d9;
  --ksv-ref: #58c0a8;
  --ksv-value: #d7a85b;
  --ksv-label: #4aa3ff;
  --ksv-ground: #8b949e;
  --ksv-comment: #6e7681;
  --ksv-directive: #58c0a8;
  --ksv-highlight: #ff8c00;
  --ksv-select: #ff3b3b;
  --ksv-mark: #39d353;
  --ksv-hover: #c08bff;
  --ksv-dim-opacity: 0.22;
  display: block; position: relative; width: 100%; height: 100%;
  overflow: hidden; background: var(--ksv-bg);
  font-family: ui-sans-serif, system-ui, sans-serif;
}
:host([theme="light"]) {
  --ksv-bg: #ffffff;
  --ksv-wire: #0a55c8;
  --ksv-junction: #0a55c8;
  --ksv-symbol: #1b2733;
  --ksv-pin: #1b2733;
  --ksv-ref: #0b7a5e;
  --ksv-value: #9a6212;
  --ksv-label: #0a55c8;
  --ksv-ground: #555;
  --ksv-comment: #6e7681;
  --ksv-directive: #0b7a5e;
  --ksv-mark: #1a9e4b;
  --ksv-hover: #8957e5;
}
.ksv-root { width: 100%; height: 100%; }
svg { width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; transform-origin: 0 0; }
svg.ksv-panning { cursor: grabbing; }

.ksv-wire { stroke: var(--ksv-wire); stroke-width: 1.9px; fill: none; stroke-linecap: round; vector-effect: non-scaling-stroke; pointer-events: none; }
.ksv-junction { fill: var(--ksv-junction); stroke: none; }
.ksv-pin { stroke: var(--ksv-pin); stroke-width: 1.7px; fill: none; vector-effect: non-scaling-stroke; pointer-events: none; }
.ksv-graphic { stroke: var(--ksv-symbol); fill: none; stroke-width: 1.7px; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; pointer-events: none; }
.ksv-ground { stroke: var(--ksv-ground); stroke-width: 1.4px; fill: none; vector-effect: non-scaling-stroke; pointer-events: none; }
text { fill: var(--ksv-symbol); }
.ksv-ref { fill: var(--ksv-ref); }
.ksv-value { fill: var(--ksv-value); }
.ksv-label-text { fill: var(--ksv-label); }
.ksv-comment { fill: var(--ksv-comment); }
.ksv-directive { fill: var(--ksv-directive); }

/* invisible fat hit targets so thin wires/pins and symbol bodies are clickable */
.ksv-wire-hit, .ksv-pin-hit { stroke: transparent; fill: none; stroke-width: 12px; stroke-linecap: round; vector-effect: non-scaling-stroke; pointer-events: stroke; }
.ksv-comp-hit { fill: transparent; stroke: none; pointer-events: fill; }
.ksv-wire-hit:hover, .ksv-pin-hit:hover, .ksv-comp-hit:hover, .ksv-junction:hover, .ksv-label:hover { cursor: pointer; }

/* dimming when a selection is active */
.ksv-root.has-selection .ksv-wire,
.ksv-root.has-selection .ksv-pin,
.ksv-root.has-selection .ksv-junction,
.ksv-root.has-selection .ksv-component,
.ksv-root.has-selection .ksv-label { opacity: var(--ksv-dim-opacity); transition: opacity .08s; }
/* mapped (marked) items stay more visible than other dimmed items during a selection */
.ksv-root.has-selection .ksv-mark { opacity: 0.6; }

.ksv-wire.ksv-on, .ksv-pin.ksv-on, .ksv-junction.ksv-on { opacity: 1 !important; stroke: var(--ksv-highlight); }
.ksv-wire.ksv-on, .ksv-pin.ksv-on { stroke-width: 4px; }
.ksv-junction.ksv-on { fill: var(--ksv-highlight); }
/* fat translucent halo so a selected net really pops */
.ksv-wire-hit.ksv-on, .ksv-pin-hit.ksv-on { stroke: var(--ksv-highlight); opacity: 0.30; }
.ksv-component.ksv-on { opacity: 1 !important; }
/* host of a selected net: keep the component visible (pin shows) without recoloring it */
.ksv-component.ksv-on-host { opacity: 1 !important; }
.ksv-component.ksv-on .ksv-graphic { stroke: var(--ksv-select); stroke-width: 2.8px; }
/* prominent box around a selected/suggested component so it's easy to spot */
.ksv-component.ksv-on .ksv-comp-hit { fill: var(--ksv-highlight); fill-opacity: 0.16; stroke: var(--ksv-highlight); stroke-width: 2.5px; vector-effect: non-scaling-stroke; }
.ksv-label.ksv-on { opacity: 1 !important; }
.ksv-label.ksv-on .ksv-label-text { fill: var(--ksv-highlight); }

.ksv-wire.ksv-sel, .ksv-pin.ksv-sel { stroke: var(--ksv-select); }

/* marks: persistent highlight of mapped items */
.ksv-wire.ksv-mark, .ksv-pin.ksv-mark { stroke: var(--ksv-mark); stroke-width: 3.4px; }
.ksv-wire-hit.ksv-mark, .ksv-pin-hit.ksv-mark { stroke: var(--ksv-mark); opacity: 0.18; }
.ksv-junction.ksv-mark { fill: var(--ksv-mark); }
.ksv-component.ksv-mark .ksv-graphic { stroke: var(--ksv-mark); }
.ksv-label.ksv-mark .ksv-label-text { fill: var(--ksv-mark); }

/* hover: distinct cue while pointing at a net/part (independent of selection/marks) */
.ksv-wire.ksv-hover, .ksv-pin.ksv-hover { stroke: var(--ksv-hover); stroke-width: 3px; opacity: 1 !important; }
.ksv-junction.ksv-hover { fill: var(--ksv-hover); opacity: 1 !important; }
.ksv-component.ksv-hover { opacity: 1 !important; }
.ksv-component.ksv-hover .ksv-graphic { stroke: var(--ksv-hover); }
.ksv-label.ksv-hover .ksv-label-text { fill: var(--ksv-hover); }
`;
