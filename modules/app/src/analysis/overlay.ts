/**
 * Annotations painted into the PCB viewer's overlay group (board mm coordinates):
 * the current-density / power-density heatmap of a solve, and clickable pad markers
 * for from/to picking. Port of the pcb_mesh demo's renderFlow/renderPadMarkers,
 * kept separate so the demo stays standalone.
 *
 * The overlay group is recreated empty on every viewer render — the drawer listens
 * for the viewer's `ready` event and calls these again.
 */

import type { LayerField } from "../../../solver_rdc/src/solve.js";

const SVGNS = "http://www.w3.org/2000/svg";

export interface PadMarker {
  id: string; // "R2.1"
  x: number;
  y: number;
}

export type OverlayMode = "J" | "P";

/** Yellow→red heat triangles; scale = 98th percentile of the chosen quantity. */
export function drawFieldOverlay(
  group: SVGGElement,
  field: LayerField[],
  mode: OverlayMode,
  /** Ω/sq per layer name — needed for the power mode (J²·Rs) */
  rsOfLayer: (layer: string) => number,
): void {
  group.querySelector("#an-flow")?.remove();
  const g = document.createElementNS(SVGNS, "g");
  g.id = "an-flow";
  g.setAttribute("pointer-events", "none");
  const valOf = (j: number, rs: number): number => (mode === "P" ? j * j * rs : j);
  const vals: number[] = [];
  for (const f of field) {
    const rs = rsOfLayer(f.layer);
    for (const j of f.currentDensity) if (j > 0) vals.push(valOf(j, rs));
  }
  vals.sort((a, b) => a - b);
  const vMax = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.98))] || 1;
  for (const f of field) {
    const rs = rsOfLayer(f.layer);
    for (let t = 0; t < f.triangles.length; t += 3) {
      const rel = Math.min(1, valOf(f.currentDensity[t / 3]!, rs) / vMax);
      if (rel < 0.03) continue;
      const [a, b, c] = [f.triangles[t]! * 2, f.triangles[t + 1]! * 2, f.triangles[t + 2]! * 2];
      const p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", `M${f.vertices[a]} ${f.vertices[a + 1]}L${f.vertices[b]} ${f.vertices[b + 1]}L${f.vertices[c]} ${f.vertices[c + 1]}Z`);
      p.setAttribute("fill", `hsl(${60 - 60 * rel} 100% 55%)`);
      p.setAttribute("fill-opacity", String(0.15 + 0.75 * rel));
      g.appendChild(p);
    }
  }
  group.appendChild(g);
  // keep markers on top of the heatmap
  const markers = group.querySelector("#an-pads");
  if (markers) group.appendChild(markers);
}

export function clearFieldOverlay(group: SVGGElement): void {
  group.querySelector("#an-flow")?.remove();
}

/** Clickable rings on the selected net's pads; from = green, to = red. */
export function drawPadMarkers(
  group: SVGGElement,
  pads: PadMarker[],
  selected: () => { from: string; to: string },
  onPick: (id: string) => void,
): void {
  group.querySelector("#an-pads")?.remove();
  if (!pads.length) return;
  const g = document.createElementNS(SVGNS, "g");
  g.id = "an-pads";
  for (const p of pads) {
    const c = document.createElementNS(SVGNS, "circle");
    c.setAttribute("cx", String(p.x));
    c.setAttribute("cy", String(p.y));
    c.setAttribute("r", "1.1");
    c.setAttribute("fill", "none");
    c.dataset.pad = p.id;
    c.style.cursor = "pointer";
    c.addEventListener("click", (ev) => {
      ev.stopPropagation();
      onPick(p.id);
    });
    const label = document.createElementNS(SVGNS, "text");
    label.textContent = p.id;
    label.setAttribute("x", String(p.x + 1.3));
    label.setAttribute("y", String(p.y - 1.3));
    label.setAttribute("font-size", "1.1");
    label.setAttribute("fill", "#888");
    label.setAttribute("pointer-events", "none");
    g.append(c, label);
  }
  group.appendChild(g);
  updatePadMarkers(group, selected());
}

export function updatePadMarkers(group: SVGGElement, sel: { from: string; to: string }): void {
  for (const c of group.querySelectorAll<SVGCircleElement>("#an-pads circle")) {
    const id = c.dataset.pad!;
    const active = id === sel.from || id === sel.to;
    c.setAttribute("stroke", id === sel.from ? "#2e9e44" : id === sel.to ? "#d33" : "#999");
    c.setAttribute("stroke-width", active ? "0.45" : "0.25");
  }
}
