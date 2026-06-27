/**
 * Theming via CSS custom properties. The component injects this stylesheet into
 * its shadow root; host apps can override any `--ksv-*` variable from outside.
 */
export const STYLESHEET = `
:host {
  --ksv-bg: #ffffff;
  --ksv-wire: #008484;
  --ksv-junction: #008484;
  --ksv-symbol: #840000;
  --ksv-pin: #840000;
  --ksv-ref: #008484;
  --ksv-value: #840000;
  --ksv-label: #840000;
  --ksv-text: #000000;
  --ksv-highlight: #ff8c00;
  --ksv-select: #ff2d2d;
  --ksv-mark: #1a9e4b;
  --ksv-dim-opacity: 0.22;
  display: block;
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--ksv-bg);
  font-family: ui-sans-serif, system-ui, sans-serif;
}
:host([theme="dark"]) {
  --ksv-bg: #131516;
  --ksv-wire: #43c9c9;
  --ksv-junction: #43c9c9;
  --ksv-symbol: #ff6e6e;
  --ksv-pin: #ff6e6e;
  --ksv-ref: #43c9c9;
  --ksv-value: #ff9e9e;
  --ksv-label: #ff9e9e;
  --ksv-text: #e8e8e8;
  --ksv-highlight: #ffb300;
  --ksv-select: #ff5252;
  --ksv-mark: #39d353;
}
.ksv-root { width: 100%; height: 100%; }
svg { width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; }
svg.ksv-panning { cursor: grabbing; }

.ksv-wire { stroke: var(--ksv-wire); stroke-width: 0.22; fill: none; stroke-linecap: round; pointer-events: none; }
.ksv-junction { fill: var(--ksv-junction); stroke: none; }
.ksv-pin { stroke: var(--ksv-pin); stroke-width: 0.22; fill: none; stroke-linecap: round; pointer-events: none; }
.ksv-graphic { stroke: var(--ksv-symbol); fill: none; stroke-linejoin: round; pointer-events: none; }

/* invisible fat hit targets so thin wires/pins and symbol bodies are clickable */
.ksv-wire-hit, .ksv-pin-hit { stroke: transparent; fill: none; stroke-width: 1.4; stroke-linecap: round; pointer-events: stroke; }
.ksv-comp-hit { fill: transparent; stroke: none; pointer-events: fill; }
.ksv-wire-hit:hover, .ksv-pin-hit:hover, .ksv-comp-hit:hover, .ksv-junction:hover, .ksv-label:hover { cursor: pointer; }
.ksv-graphic.fill-outline { fill: var(--ksv-symbol); }
.ksv-graphic.fill-bg { fill: var(--ksv-bg); }
.ksv-ref { fill: var(--ksv-ref); }
.ksv-value { fill: var(--ksv-value); }
.ksv-label-text { fill: var(--ksv-label); }
.ksv-label-tag { fill: none; stroke: var(--ksv-label); stroke-width: 0.12; }

/* interaction states (toggled by the controller) */
.ksv-root.has-selection .ksv-wire,
.ksv-root.has-selection .ksv-pin,
.ksv-root.has-selection .ksv-junction,
.ksv-root.has-selection .ksv-component,
.ksv-root.has-selection .ksv-label { opacity: var(--ksv-dim-opacity); transition: opacity .08s; }

.ksv-wire.ksv-on, .ksv-pin.ksv-on, .ksv-junction.ksv-on { opacity: 1 !important; stroke: var(--ksv-highlight); }
.ksv-junction.ksv-on { fill: var(--ksv-highlight); }
.ksv-component.ksv-on { opacity: 1 !important; }
.ksv-component.ksv-on .ksv-graphic { stroke: var(--ksv-select); }
.ksv-component.ksv-on .ksv-graphic.fill-outline { fill: var(--ksv-select); }
.ksv-label.ksv-on { opacity: 1 !important; }

.ksv-wire.ksv-sel, .ksv-pin.ksv-sel, .ksv-junction.ksv-sel { stroke: var(--ksv-select); stroke-width: 0.3; }
.ksv-junction.ksv-sel { fill: var(--ksv-select); }

/* marks: faint persistent highlight of mapped items (shown when idle) */
.ksv-wire.ksv-mark, .ksv-pin.ksv-mark { stroke: var(--ksv-mark); stroke-width: 0.32; }
.ksv-junction.ksv-mark { fill: var(--ksv-mark); }
.ksv-component.ksv-mark .ksv-graphic { stroke: var(--ksv-mark); }
.ksv-component.ksv-mark .ksv-graphic.fill-outline { fill: var(--ksv-mark); }
.ksv-label.ksv-mark .ksv-label-text { fill: var(--ksv-mark); }
`;
