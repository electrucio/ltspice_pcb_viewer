/**
 * SVG renderer. Builds an <svg> from the schematic model + netlist, tagging every
 * element with data-ref / data-net / data-uuid so the interaction layer can do
 * DOM hit-testing and per-net CSS highlighting.
 *
 * The schematic uses KiCad mm with Y pointing down — SVG's native orientation —
 * so we render in mm user units directly and drive zoom via the viewBox.
 */

import type { Schematic, LibGraphic, FillType, Point, Placement } from "../parser/schematic.js";
import type { Netlist } from "../netlist/connectivity.js";
import { instanceMatrix, transformPoint, pinWorldPos, pinWorldFarEnd, type Matrix2x3 } from "../geometry/transform.js";

const SVGNS = "http://www.w3.org/2000/svg";

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface RenderResult {
  svg: SVGSVGElement;
  bbox: BBox;
}

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function grow(b: BBox, p: Point): void {
  if (p.x < b.minX) b.minX = p.x;
  if (p.y < b.minY) b.minY = p.y;
  if (p.x > b.maxX) b.maxX = p.x;
  if (p.y > b.maxY) b.maxY = p.y;
}

function arcPath(s: Point, m: Point, e: Point): string {
  // circle through 3 points -> SVG arc
  const ax = s.x, ay = s.y, bx = m.x, by = m.y, cx = e.x, cy = e.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return `M ${ax} ${ay} L ${cx} ${cy}`;
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const sweep = cross < 0 ? 1 : 0;
  return `M ${ax} ${ay} A ${r} ${r} 0 0 ${sweep} ${cx} ${cy}`;
}

function fillClass(fill: FillType): string {
  return fill === "outline" ? " fill-outline" : fill === "background" ? " fill-bg" : "";
}

function drawGraphic(g: LibGraphic, m: Matrix2x3, b: BBox): SVGElement | null {
  switch (g.kind) {
    case "rectangle": {
      const p1 = transformPoint(m, g.start);
      const p2 = transformPoint(m, g.end);
      grow(b, p1); grow(b, p2);
      const x = Math.min(p1.x, p2.x), y = Math.min(p1.y, p2.y);
      const r = el("rect", { x, y, width: Math.abs(p2.x - p1.x), height: Math.abs(p2.y - p1.y), "stroke-width": g.width });
      r.setAttribute("class", `ksv-graphic${fillClass(g.fill)}`);
      return r;
    }
    case "polyline": {
      const pts = g.pts.map((p) => transformPoint(m, p));
      for (const p of pts) grow(b, p);
      const closed = g.fill !== "none";
      const poly = el(closed ? "polygon" : "polyline", { points: pts.map((p) => `${p.x},${p.y}`).join(" "), "stroke-width": g.width });
      poly.setAttribute("class", `ksv-graphic${fillClass(g.fill)}`);
      return poly;
    }
    case "circle": {
      const c = transformPoint(m, g.center);
      grow(b, { x: c.x - g.radius, y: c.y - g.radius });
      grow(b, { x: c.x + g.radius, y: c.y + g.radius });
      const circ = el("circle", { cx: c.x, cy: c.y, r: g.radius, "stroke-width": g.width });
      circ.setAttribute("class", `ksv-graphic${fillClass(g.fill)}`);
      return circ;
    }
    case "arc": {
      const s = transformPoint(m, g.start), mm = transformPoint(m, g.mid), e = transformPoint(m, g.end);
      grow(b, s); grow(b, mm); grow(b, e);
      const path = el("path", { d: arcPath(s, mm, e), "stroke-width": g.width });
      path.setAttribute("class", "ksv-graphic");
      return path;
    }
  }
}

function text(content: string, at: Placement, cls: string, size = 1.27, justify = "middle"): SVGTextElement {
  const t = el("text", {
    x: at.x,
    y: at.y,
    "font-size": size,
    "text-anchor": justify === "left" ? "start" : justify === "right" ? "end" : "middle",
    "dominant-baseline": "middle",
  });
  // KiCad text isn't affected by the Y-down flip the way symbol bodies are; keep upright.
  t.setAttribute("class", cls);
  t.textContent = content;
  return t;
}

export function renderSchematic(sch: Schematic, nl: Netlist): RenderResult {
  const bbox: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const svg = el("svg", { xmlns: SVGNS, preserveAspectRatio: "xMidYMid meet" });

  // --- wires (under components) ---
  const gWires = el("g", { class: "ksv-wires" });
  for (const w of sch.wires) {
    if (w.pts.length < 2) continue;
    for (const p of w.pts) grow(bbox, p);
    const netId = nl.wireToNet.get(w.uuid);
    const net = netId != null ? nl.nets[netId] : undefined;
    const points = w.pts.map((p) => `${p.x},${p.y}`).join(" ");
    // fat invisible hit target so thin wires are clickable/hoverable
    const hit = el("polyline", { points });
    hit.setAttribute("class", "ksv-wire-hit");
    hit.dataset.uuid = w.uuid;
    if (net) hit.dataset.net = net.name;
    // visible wire (carries data-net so highlight finds it)
    const line = el("polyline", { points });
    line.setAttribute("class", "ksv-wire");
    line.dataset.uuid = w.uuid;
    if (net) line.dataset.net = net.name;
    gWires.append(hit, line);
  }
  svg.appendChild(gWires);

  // --- junctions ---
  const gJ = el("g", { class: "ksv-junctions" });
  for (const j of sch.junctions) {
    grow(bbox, j.at);
    const netId = nl.pointToNet.get(`${Math.round(j.at.x * 10000)},${Math.round(j.at.y * 10000)}`);
    const c = el("circle", { cx: j.at.x, cy: j.at.y, r: 0.4 });
    c.setAttribute("class", "ksv-junction ksv-hit");
    if (netId != null) c.dataset.net = nl.nets[netId]!.name;
    gJ.appendChild(c);
  }
  svg.appendChild(gJ);

  // --- components (graphics + pins + ref/value) ---
  const gComps = el("g", { class: "ksv-components" });
  for (const inst of sch.instances) {
    const lib = sch.libSymbols.get(inst.libId);
    if (!lib) continue;
    const m = instanceMatrix(inst.placement, inst.mirror);
    const g = el("g", { class: "ksv-component" });
    g.dataset.ref = inst.ref;
    g.dataset.uuid = inst.uuid;

    // tight bbox over the symbol body graphics, for a clickable body hit-area
    const cb: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    const graphicNodes: SVGElement[] = [];
    for (const gr of lib.graphics) {
      const node = drawGraphic(gr, m, cb);
      if (node) graphicNodes.push(node);
    }
    if (isFinite(cb.minX)) {
      const pad = 0.6;
      const rect = el("rect", { x: cb.minX - pad, y: cb.minY - pad, width: cb.maxX - cb.minX + 2 * pad, height: cb.maxY - cb.minY + 2 * pad });
      rect.setAttribute("class", "ksv-comp-hit");
      rect.dataset.ref = inst.ref;
      g.appendChild(rect); // behind graphics within the group
      grow(bbox, { x: cb.minX, y: cb.minY }); grow(bbox, { x: cb.maxX, y: cb.maxY });
    }
    for (const node of graphicNodes) g.appendChild(node);

    for (const pin of lib.pins) {
      if (pin.unit !== 0 && pin.unit !== inst.unit) continue;
      if (pin.bodyStyle !== 0 && pin.bodyStyle !== inst.bodyStyle) continue;
      const cp = pinWorldPos(m, pin.at);
      const fe = pinWorldFarEnd(m, pin.at, pin.length);
      grow(bbox, cp); grow(bbox, fe);
      const nid = nl.pinToNet.get(`${inst.ref}.${pin.number}`);
      const netName = nid != null ? nl.nets[nid]!.name : undefined;
      // fat invisible hit target for the pin
      const hit = el("line", { x1: cp.x, y1: cp.y, x2: fe.x, y2: fe.y });
      hit.setAttribute("class", "ksv-pin-hit");
      if (netName) hit.dataset.net = netName;
      hit.dataset.ref = inst.ref;
      hit.dataset.pin = pin.number;
      const line = el("line", { x1: cp.x, y1: cp.y, x2: fe.x, y2: fe.y });
      line.setAttribute("class", "ksv-pin");
      if (netName) line.dataset.net = netName;
      line.dataset.ref = inst.ref;
      line.dataset.pin = pin.number;
      g.append(hit, line);
    }

    // reference + value text (hidden for power/ground and unnamed refs)
    if (inst.ref && !inst.ref.startsWith("#")) {
      const refProp = inst.properties.find((p) => p.key === "Reference");
      const valProp = inst.properties.find((p) => p.key === "Value");
      if (refProp?.at && !refProp.hidden) g.appendChild(text(inst.ref, refProp.at, "ksv-ref", 1.0, "left"));
      if (valProp?.at && !valProp.hidden) g.appendChild(text(inst.value, valProp.at, "ksv-value", 1.0, "left"));
    }
    gComps.appendChild(g);
  }
  svg.appendChild(gComps);

  // --- labels ---
  const gLabels = el("g", { class: "ksv-labels" });
  for (const lbl of sch.labels) {
    grow(bbox, { x: lbl.at.x, y: lbl.at.y });
    const grp = el("g", { class: "ksv-label ksv-hit" });
    grp.dataset.net = lbl.text;
    grp.appendChild(text(lbl.text, lbl.at, "ksv-label-text", 1.27, "left"));
    gLabels.appendChild(grp);
  }
  svg.appendChild(gLabels);

  if (!isFinite(bbox.minX)) Object.assign(bbox, { minX: 0, minY: 0, maxX: 100, maxY: 100 });
  return { svg, bbox };
}
