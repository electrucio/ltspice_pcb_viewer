/**
 * SVG renderer for a KiCad PCB — a single combined view of all layers (no top/bottom
 * split). Elements are grouped by `data-layer` (for toggling) and tagged with
 * `data-net` / `data-ref` (for hit-testing + highlight). Rendered in board mm (Y down);
 * pan/zoom + mirror are applied by the controller via the SVG viewBox / a content group.
 */

import type { Pcb, Pad, FpGraphic, BoardGraphic } from "../parser/pcb.js";
import type { Point } from "../geometry/transform.js";

const SVGNS = "http://www.w3.org/2000/svg";

export interface RenderResult {
  svg: SVGSVGElement;
  content: SVGGElement; // pan/zoom + mirror are applied here
  bbox: Pcb["bbox"];
  layers: string[]; // toggleable data-layer ids, in UI order
}

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}
const layerId = (layer: string): string => layer.replace(/[.+]/g, "_");

/**
 * SVG path for a circular arc given by three points on it (KiCad's `start`/`mid`/`end`).
 * Both the sweep-flag and the large-arc-flag are derived from the arc angles so that the
 * rendered arc actually passes through `mid` (KiCad stores arcs Y-down, same as SVG here,
 * so a positive-angle sweep maps directly to SVG sweep-flag 1). Collinear points → a line.
 */
export function arcPath(s: Point, m: Point, e: Point): string {
  const ax = s.x, ay = s.y, bx = m.x, by = m.y, cx = e.x, cy = e.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return `M ${ax} ${ay} L ${cx} ${cy}`;
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const TAU = 2 * Math.PI;
  const norm = (t: number): number => ((t % TAU) + TAU) % TAU;
  const a0 = Math.atan2(ay - uy, ax - ux);
  const dM = norm(Math.atan2(by - uy, bx - ux) - a0);
  const dE = norm(Math.atan2(cy - uy, cx - ux) - a0);
  const sweep = dM <= dE ? 1 : 0; // positive-angle direction reaches mid before end
  const span = sweep ? dE : TAU - dE;
  const large = span > Math.PI ? 1 : 0;
  return `M ${ax} ${ay} A ${r} ${r} 0 ${large} ${sweep} ${cx} ${cy}`;
}

function strokeGraphic(g: FpGraphic | BoardGraphic, cls: string): SVGElement | null {
  switch (g.kind) {
    case "line": {
      const e = el("line", { x1: g.a.x, y1: g.a.y, x2: g.b.x, y2: g.b.y, "stroke-width": g.width });
      e.setAttribute("class", cls);
      return e;
    }
    case "rect": {
      const e = el("rect", { x: Math.min(g.a.x, g.b.x), y: Math.min(g.a.y, g.b.y), width: Math.abs(g.b.x - g.a.x), height: Math.abs(g.b.y - g.a.y), "stroke-width": g.width });
      e.setAttribute("class", cls + (g.fill ? " filled" : ""));
      return e;
    }
    case "circle": {
      const e = el("circle", { cx: g.center.x, cy: g.center.y, r: g.radius, "stroke-width": g.width });
      e.setAttribute("class", cls);
      return e;
    }
    case "arc": {
      const e = el("path", { d: arcPath(g.start, g.mid, g.end), "stroke-width": g.width });
      e.setAttribute("class", cls);
      return e;
    }
    case "poly": {
      const e = el(g.fill ? "polygon" : "polyline", { points: g.pts.map((p) => `${p.x},${p.y}`).join(" "), "stroke-width": g.width });
      e.setAttribute("class", cls + (g.fill ? " filled" : ""));
      return e;
    }
  }
}

/** Pad copper shape (data-net/data-ref) — caller adds the drill hole on top. */
function padCopper(p: Pad): SVGElement {
  const { w, h } = p.size;
  let shape: SVGElement;
  if (p.shape === "circle") {
    shape = el("circle", { cx: p.pos.x, cy: p.pos.y, r: Math.max(w, h) / 2 });
  } else {
    const rx = p.shape === "oval" ? Math.min(w, h) / 2 : p.shape === "roundrect" ? Math.min(w, h) * p.rratio : 0;
    shape = el("rect", { x: p.pos.x - w / 2, y: p.pos.y - h / 2, width: w, height: h, rx, ry: rx });
    if (p.angle) shape.setAttribute("transform", `rotate(${-p.angle} ${p.pos.x} ${p.pos.y})`);
  }
  shape.setAttribute("class", "pcb-pad-copper");
  if (p.net) shape.dataset.net = p.net;
  if (p.ref) shape.dataset.ref = p.ref;
  return shape;
}

function drillHole(p: Pad): SVGElement | null {
  if (!p.drill) return null;
  const e = el("ellipse", { cx: p.pos.x, cy: p.pos.y, rx: p.drill.w / 2, ry: p.drill.h / 2 });
  e.setAttribute("class", "pcb-hole");
  if (p.drill.w !== p.drill.h && p.angle) e.setAttribute("transform", `rotate(${-p.angle} ${p.pos.x} ${p.pos.y})`);
  return e;
}

export function renderPcb(pcb: Pcb): RenderResult {
  const svg = el("svg", { xmlns: SVGNS, preserveAspectRatio: "xMidYMid meet" });
  const content = el("g", { class: "pcb-content" });
  svg.appendChild(content);

  // one group per data-layer; appended in z-order (first = bottom)
  const order = ["board", "B.Cu", "F.Cu", "pads", "vias", "B.SilkS", "F.SilkS", "Edge.Cuts", "refs"];
  const groups = new Map<string, SVGGElement>();
  for (const id of order) {
    const g = el("g", { class: "pcb-layer" });
    g.dataset.layer = id;
    groups.set(id, g);
    content.appendChild(g);
  }
  const into = (id: string) => groups.get(id)!;

  // board substrate
  const b = pcb.bbox;
  if (Number.isFinite(b.minX)) {
    const rect = el("rect", { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY });
    rect.setAttribute("class", "pcb-board");
    into("board").appendChild(rect);
  }

  // zones (under tracks, in their copper layer group)
  for (const z of pcb.zones) {
    if (z.pts.length < 3 || !groups.has(z.layer)) continue;
    const poly = el("polygon", { points: z.pts.map((p) => `${p.x},${p.y}`).join(" ") });
    poly.setAttribute("class", `pcb-zone layer-${layerId(z.layer)}`);
    if (z.net) poly.dataset.net = z.net;
    into(z.layer).appendChild(poly);
  }

  // tracks (visible + fat transparent hit target) per copper layer
  for (const t of pcb.tracks) {
    if (!groups.has(t.layer)) continue;
    const pts = `${t.start.x},${t.start.y} ${t.end.x},${t.end.y}`;
    const hit = el("polyline", { points: pts, "stroke-width": Math.max(t.width + 0.4, 0.6) });
    hit.setAttribute("class", "pcb-track-hit");
    if (t.net) hit.dataset.net = t.net;
    const line = el("polyline", { points: pts, "stroke-width": t.width });
    line.setAttribute("class", `pcb-track layer-${layerId(t.layer)}`);
    if (t.net) line.dataset.net = t.net;
    into(t.layer).append(hit, line);
  }

  // copper board graphics (KiCad 9/10: gr_poly & co. on copper, optionally
  // net-assigned — real connected copper, drawn like tracks and net-highlightable)
  for (const g of pcb.graphics) {
    if (!g.layer.endsWith(".Cu") || !groups.has(g.layer)) continue;
    const node = strokeGraphic(g, `pcb-copper-gfx layer-${layerId(g.layer)}`);
    if (!node) continue;
    if (g.net) node.dataset.net = g.net;
    into(g.layer).appendChild(node);
  }
  // footprint copper graphics (fp_poly & co. on copper — e.g. microwave footprints)
  for (const f of pcb.footprints) {
    for (const g of f.graphics) {
      if (!g.layer.endsWith(".Cu") || !groups.has(g.layer)) continue;
      const node = strokeGraphic(g, `pcb-copper-gfx layer-${layerId(g.layer)}`);
      if (!node) continue;
      if (f.ref) node.dataset.ref = f.ref;
      into(g.layer).appendChild(node);
    }
  }

  // pads (through-hole pads live on the shared "pads" layer)
  for (const f of pcb.footprints) {
    for (const p of f.pads) {
      into("pads").appendChild(padCopper(p));
      const hole = drillHole(p);
      if (hole) into("pads").appendChild(hole);
    }
  }

  // vias
  for (const v of pcb.vias) {
    const cu = el("circle", { cx: v.pos.x, cy: v.pos.y, r: v.size / 2 });
    cu.setAttribute("class", "pcb-via-copper");
    if (v.net) cu.dataset.net = v.net;
    const hole = el("circle", { cx: v.pos.x, cy: v.pos.y, r: v.drill / 2 });
    hole.setAttribute("class", "pcb-hole");
    into("vias").append(cu, hole);
  }

  // silkscreen (footprint graphics on silk layers + board gr_* on silk)
  const silkOf = (layer: string) => (layer === "F.SilkS" ? "F.SilkS" : layer === "B.SilkS" ? "B.SilkS" : null);
  for (const f of pcb.footprints) {
    for (const g of f.graphics) {
      const sl = silkOf(g.layer);
      if (!sl) continue;
      const node = strokeGraphic(g, "pcb-silk");
      if (node) into(sl).appendChild(node);
    }
  }
  for (const g of pcb.graphics) {
    const sl = silkOf(g.layer);
    if (sl) { const node = strokeGraphic(g, "pcb-silk"); if (node) into(sl).appendChild(node); }
  }

  // board text (gr_text): silk + copper layers; mirrored text (bottom side) flips
  for (const t of pcb.texts) {
    const grp = silkOf(t.layer) ?? (t.layer.endsWith(".Cu") && groups.has(t.layer) ? t.layer : null);
    if (!grp) continue;
    const el2 = el("text", { x: 0, y: 0, "font-size": t.size, "text-anchor": "middle", "dominant-baseline": "middle" });
    el2.setAttribute("class", t.layer.endsWith(".Cu") ? `pcb-copper-text layer-${layerId(t.layer)}` : "pcb-silk-text");
    el2.setAttribute("transform", `translate(${t.pos.x} ${t.pos.y}) rotate(${-t.angle})${t.mirror ? " scale(-1 1)" : ""}`);
    el2.textContent = t.text.replace(/\\n/g, " ");
    into(grp).appendChild(el2);
  }

  // board outline (Edge.Cuts) + any other gr_ we want visible
  for (const g of pcb.graphics) {
    if (g.layer !== "Edge.Cuts") continue;
    const node = strokeGraphic(g, "pcb-edge");
    if (node) into("Edge.Cuts").appendChild(node);
  }

  // reference designators (clickable to select the component)
  for (const f of pcb.footprints) {
    if (!f.ref || f.ref.startsWith("#")) continue;
    const t = el("text", { x: f.refPos.x, y: f.refPos.y, "font-size": 1, "text-anchor": "middle", "dominant-baseline": "middle" });
    t.setAttribute("class", "pcb-ref");
    t.dataset.ref = f.ref;
    t.textContent = f.ref;
    into("refs").appendChild(t);
  }

  // overlay: an empty topmost group in BOARD coordinates for external annotations
  // (analysis heatmaps, markers). Lives inside `content` so pan/zoom/mirror/rotation
  // apply; hosts fill it via KicadPcbElement.overlayGroup().
  const overlay = el("g", { class: "pcb-overlay" });
  content.appendChild(overlay);

  return { svg, content, bbox: pcb.bbox, layers: order.filter((id) => id !== "board") };
}
