/**
 * SVG renderer for LTspice schematics.
 *
 * Renders in native LTspice units (Y down) and drives zoom via the viewBox.
 * Every element is tagged data-net / data-ref so the shared interaction
 * controller can hit-test and highlight. Strokes use non-scaling-stroke
 * (see theme) to stay crisp regardless of zoom.
 */

import type { AscSchematic } from "../parser/asc.js";
import type { SymbolDef, Arc } from "../parser/asy.js";
import type { Model, PlacedSymbol, BBox } from "../netlist/connectivity.js";
import { type Xform } from "../geometry/transform.js";

export type { BBox } from "../netlist/connectivity.js";

const SVGNS = "http://www.w3.org/2000/svg";
const FONT = [0.625, 1, 1.5, 2, 2.5, 3.5, 5, 7];
const FONT_BASE = 9;
const WINDOW_ATTR: Record<string, string> = { "0": "InstName", "3": "Value" };

export interface RenderResult {
  svg: SVGSVGElement;
  bbox: BBox;
}

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function fontPx(size: number): number {
  const i = Math.max(0, Math.min(7, Math.round(size)));
  return FONT_BASE * FONT[i]!;
}

function anchorFor(just: string): string {
  if (/Right/i.test(just)) return "end";
  if (/Center/i.test(just)) return "middle";
  return "start";
}

function makeText(str: string, x: number, y: number, just: string, size: number, cls: string): SVGTextElement {
  const t = el("text", { x, y, "font-size": fontPx(size), "text-anchor": anchorFor(just), "dominant-baseline": "middle" });
  t.setAttribute("class", cls);
  t.textContent = str;
  return t;
}

/** LTspice arc (ellipse bbox + start/end rays) -> sampled polyline points. */
function arcPoints(a: Arc, xf: Xform, ox: number, oy: number): string {
  const c1 = xf.pt(a[0], a[1]), c2 = xf.pt(a[2], a[3]);
  const s = xf.pt(a[4], a[5]), e = xf.pt(a[6], a[7]);
  const cx = ox + (c1.x + c2.x) / 2, cy = oy + (c1.y + c2.y) / 2;
  const rx = Math.abs(c2.x - c1.x) / 2, ry = Math.abs(c2.y - c1.y) / 2;
  const sx = ox + s.x, sy = oy + s.y, ex = ox + e.x, ey = oy + e.y;
  const a1 = Math.atan2(sy - cy, sx - cx), a2 = Math.atan2(ey - cy, ex - cx);
  const anticlockwise = !xf.mirror;
  let span = a2 - a1;
  if (anticlockwise) { while (span > 0) span -= 2 * Math.PI; if (span === 0) span = -2 * Math.PI; }
  else { while (span < 0) span += 2 * Math.PI; if (span === 0) span = 2 * Math.PI; }
  const steps = Math.max(3, Math.ceil(Math.abs(span) / (Math.PI / 24)));
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const th = a1 + (span * i) / steps;
    pts.push(`${(cx + rx * Math.cos(th)).toFixed(2)},${(cy + ry * Math.sin(th)).toFixed(2)}`);
  }
  return pts.join(" ");
}

/** Render a symbol definition's primitives into a group, transformed to world. */
function drawPrimitives(def: SymbolDef, xf: Xform, ox: number, oy: number, into: SVGGElement): void {
  const P = (px: number, py: number) => { const p = xf.pt(px, py); return [ox + p.x, oy + p.y] as const; };
  for (const l of def.lines) {
    const [x1, y1] = P(l[0], l[1]), [x2, y2] = P(l[2], l[3]);
    const e = el("line", { x1, y1, x2, y2 });
    e.setAttribute("class", "ksv-graphic");
    if (l[4]) e.setAttribute("stroke-dasharray", "4 3");
    into.appendChild(e);
  }
  for (const r of def.rects) {
    const [x1, y1] = P(r[0], r[1]), [x2, y2] = P(r[2], r[3]);
    const e = el("rect", { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) });
    e.setAttribute("class", "ksv-graphic");
    into.appendChild(e);
  }
  for (const c of def.circles) {
    const [x1, y1] = P(c[0], c[1]), [x2, y2] = P(c[2], c[3]);
    const e = el("ellipse", { cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, rx: Math.abs(x2 - x1) / 2, ry: Math.abs(y2 - y1) / 2 });
    e.setAttribute("class", "ksv-graphic");
    into.appendChild(e);
  }
  for (const a of def.arcs) {
    const e = el("polyline", { points: arcPoints(a, xf, ox, oy) });
    e.setAttribute("class", "ksv-graphic");
    into.appendChild(e);
  }
}

function drawMissing(p: PlacedSymbol, into: SVGGElement): void {
  const { minX, minY, maxX, maxY } = p.bbox;
  const r = el("rect", { x: minX, y: minY, width: maxX - minX, height: maxY - minY, "stroke-dasharray": "6 4" });
  r.setAttribute("class", "ksv-graphic");
  into.appendChild(r);
  into.appendChild(makeText("?", (minX + maxX) / 2, (minY + maxY) / 2, "Center", 3, "ksv-graphic"));
}

export function renderModel(sch: AscSchematic, model: Model): RenderResult {
  const { placed, netlist, junctions, bbox } = model;
  const svg = el("svg", { xmlns: SVGNS, preserveAspectRatio: "xMidYMid meet" });

  // --- wires ---
  const gWires = el("g", { class: "ksv-wires" });
  sch.wires.forEach((w, i) => {
    const netId = netlist.wireToNet.get(i);
    const name = netId != null ? netlist.nets[netId]!.name : undefined;
    const pts = `${w[0]},${w[1]} ${w[2]},${w[3]}`;
    const hit = el("polyline", { points: pts });
    hit.setAttribute("class", "ksv-wire-hit");
    if (name) hit.dataset.net = name;
    const line = el("polyline", { points: pts });
    line.setAttribute("class", "ksv-wire");
    if (name) line.dataset.net = name;
    gWires.append(hit, line);
  });
  svg.appendChild(gWires);

  // --- junction dots ---
  const gJ = el("g", { class: "ksv-junctions" });
  for (const j of junctions) {
    const netId = netlist.pointToNet.get(`${j.x},${j.y}`);
    const c = el("circle", { cx: j.x, cy: j.y, r: 4 });
    c.setAttribute("class", "ksv-junction");
    if (netId != null) c.dataset.net = netlist.nets[netId]!.name;
    gJ.appendChild(c);
  }
  svg.appendChild(gJ);

  // --- symbols ---
  const gComps = el("g", { class: "ksv-components" });
  for (const p of placed) {
    const g = el("g", { class: "ksv-component" });
    g.dataset.ref = p.ref;

    // body hit-area
    if (isFinite(p.bbox.minX)) {
      const pad = 4;
      const rect = el("rect", { x: p.bbox.minX - pad, y: p.bbox.minY - pad, width: p.bbox.maxX - p.bbox.minX + 2 * pad, height: p.bbox.maxY - p.bbox.minY + 2 * pad });
      rect.setAttribute("class", "ksv-comp-hit");
      rect.dataset.ref = p.ref;
      g.appendChild(rect);
    }

    if (p.def) drawPrimitives(p.def, p.xf, p.x, p.y, g);
    else drawMissing(p, g);

    // pin hit targets (clicking a pin selects its net)
    for (const pin of p.pins) {
      const nid = netlist.pinToNet.get(`${p.ref}.${pin.number}`);
      const hit = el("circle", { cx: pin.pos.x, cy: pin.pos.y, r: 6 });
      hit.setAttribute("class", "ksv-pin-hit");
      hit.dataset.ref = p.ref;
      hit.dataset.pin = pin.number;
      if (nid != null) hit.dataset.net = netlist.nets[nid]!.name;
      g.appendChild(hit);
    }

    // attribute windows: InstName + Value
    if (p.def && !p.ref.startsWith("?")) {
      const sym = p.instance;
      const slots = new Set([...Object.keys(p.def.windows), ...Object.keys(sym.windows)]);
      for (const n of slots) {
        const attr = WINDOW_ATTR[n];
        if (!attr) continue;
        const val = attr === "InstName" ? p.ref : p.value;
        if (!val) continue;
        const w = sym.windows[n] ?? p.def.windows[n]!;
        const pos = p.xf.pt(w.x, w.y);
        let just = w.just;
        if (p.xf.mirror) just = /Left/i.test(just) ? "Right" : /Right/i.test(just) ? "Left" : just;
        g.appendChild(makeText(val, p.x + pos.x, p.y + pos.y, just, w.size, attr === "InstName" ? "ksv-ref" : "ksv-value"));
      }
    }
    gComps.appendChild(g);
  }
  svg.appendChild(gComps);

  // --- flags (ground glyph for "0", net label otherwise) ---
  const gFlags = el("g", { class: "ksv-flags" });
  for (const f of sch.flags) {
    if (f.net === "0") {
      const tri = el("polyline", { points: `${f.x - 12},${f.y} ${f.x + 12},${f.y} ${f.x},${f.y + 12} ${f.x - 12},${f.y}` });
      tri.setAttribute("class", "ksv-ground");
      gFlags.appendChild(tri);
    } else {
      const grp = el("g", { class: "ksv-label" });
      grp.dataset.net = f.net;
      grp.appendChild(makeText(f.net, f.x, f.y - 8, "Center", 2, "ksv-label-text"));
      gFlags.appendChild(grp);
    }
  }
  svg.appendChild(gFlags);

  // --- schematic text (comments / SPICE directives) ---
  const gText = el("g", { class: "ksv-texts" });
  for (const t of sch.texts) {
    const directive = t.str.startsWith("!");
    const str = t.str.replace(/^[!;]/, "");
    for (const [i, ln] of str.split(/\\n/).entries()) {
      gText.appendChild(makeText(ln, t.x, t.y + i * fontPx(t.size) * 1.3, t.just, t.size, directive ? "ksv-directive" : "ksv-comment"));
    }
  }
  svg.appendChild(gText);

  return { svg, bbox };
}
