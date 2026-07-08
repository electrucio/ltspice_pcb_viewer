/**
 * Parser for KiCad `.kicad_pcb` (S-expression). Produces a flat, render-ready model in
 * board coordinates (mm, Y down): board edges, copper tracks, vias, zone fills, and
 * footprints with their pads + silkscreen graphics + reference label. Net references are
 * CANONICALIZED to the net NAME: number-style files (`(net 4)` on elements, root table
 * `(net 4 "+3V3")`) are mapped through the table; name-style files pass through as-is.
 */

import { parseSExpr, child, children, childStr, type SNode } from "./sexpr.js";
import { toWorld, ROT_SIGN, type Point } from "../geometry/transform.js";

export type PadShape = "circle" | "oval" | "rect" | "roundrect" | "trapezoid" | "custom";

export interface Pad {
  ref: string; // owning footprint reference
  number: string;
  shape: PadShape;
  thruHole: boolean;
  pos: Point; // board coords
  size: { w: number; h: number };
  angle: number; // board-frame angle (deg)
  rratio: number; // roundrect corner ratio
  drill?: { w: number; h: number };
  layers: string[];
  net: string;
}

export type FpGraphic =
  | { kind: "line"; layer: string; a: Point; b: Point; width: number }
  | { kind: "circle"; layer: string; center: Point; radius: number; width: number }
  | { kind: "arc"; layer: string; start: Point; mid: Point; end: Point; width: number }
  | { kind: "rect"; layer: string; a: Point; b: Point; width: number; fill: boolean }
  /** fp_poly — on copper layers this is REAL copper (KiCad's microwave footprints) */
  | { kind: "poly"; layer: string; pts: Point[]; width: number; fill: boolean };

export interface Footprint {
  ref: string; // reference designator as drawn on the board (e.g. "Q3" or "Q3*")
  /** schematic symbol UUID (last segment of the footprint `path`), "" if unlinked —
   *  the stable identity that survives reference-designator renames */
  symbolUuid: string;
  value: string;
  pos: Point;
  angle: number;
  layer: string; // F.Cu or B.Cu
  pads: Pad[];
  graphics: FpGraphic[]; // silkscreen / fab, in board coords
  refPos: Point;
  refLayer: string;
}

export interface Track {
  start: Point;
  end: Point;
  width: number;
  layer: string;
  net: string;
}

export interface Via {
  pos: Point;
  size: number;
  drill: number;
  layers: string[];
  net: string;
}

export interface ZoneFill {
  layer: string;
  net: string;
  pts: Point[];
}

/** Board-level graphic. On copper layers KiCad 9/10 can assign these a net
 *  (`(net "…")`) — they are then real, connected copper, not decoration. */
export type BoardGraphic = { net?: string } & (
  | { kind: "line"; layer: string; a: Point; b: Point; width: number }
  | { kind: "rect"; layer: string; a: Point; b: Point; width: number; fill: boolean }
  | { kind: "circle"; layer: string; center: Point; radius: number; width: number }
  | { kind: "arc"; layer: string; start: Point; mid: Point; end: Point; width: number }
  | { kind: "poly"; layer: string; pts: Point[]; width: number; fill: boolean }
);

/** Board-level text (gr_text). On copper layers this is real copper the mesher
 *  cannot yet reproduce (font stroking) — counted there, rendered here. */
export interface BoardText {
  text: string;
  pos: Point;
  angle: number;
  layer: string;
  /** font height, mm (default 1.27) */
  size: number;
  mirror: boolean;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** One physical layer from `(setup (stackup …))` — copper, dielectric, mask, silk. */
export interface StackupLayer {
  name: string; // "F.Cu", "dielectric 1", …
  type: string; // "copper" | "core" | "prepreg" | "Top Solder Mask" | …
  thicknessMm?: number;
  epsilonR?: number;
  lossTangent?: number;
  material?: string;
}

export interface Pcb {
  footprints: Footprint[];
  tracks: Track[];
  vias: Via[];
  zones: ZoneFill[];
  graphics: BoardGraphic[]; // gr_* (board outline on Edge.Cuts, other layers)
  texts: BoardText[]; // gr_text on any layer
  nets: string[];
  layers: string[]; // layer names present
  /** copper layer names in physical stack order (from the file's `(layers …)`
   *  declaration, F.Cu → … → B.Cu) — the authority for via SPAN questions */
  copperStack: string[];
  /** physical stackup in top-to-bottom order; undefined when the file has none (pre-KiCad-6) */
  stackup?: StackupLayer[];
  bbox: BBox;
}

/** Copper thickness of a layer from the stackup, mm — undefined when unknown (caller owns defaults). */
export function copperThicknessMm(pcb: Pcb, layer: string): number | undefined {
  return pcb.stackup?.find((l) => l.type === "copper" && l.name === layer)?.thicknessMm;
}

/** Physical board thickness (copper + dielectrics, no mask/silk), mm — undefined when unknown. */
export function boardThicknessMm(pcb: Pcb): number | undefined {
  if (!pcb.stackup) return undefined;
  const phys = pcb.stackup.filter((l) => l.type === "copper" || l.type === "core" || l.type === "prepreg");
  if (!phys.length) return undefined;
  let sum = 0;
  for (const l of phys) sum += l.thicknessMm ?? 0;
  return sum > 0 ? sum : undefined;
}

// ---- small readers -------------------------------------------------------

function nums(node: SNode | undefined): number[] {
  return node ? (node.values.map(Number).filter((n) => !Number.isNaN(n))) : [];
}
function xy(node: SNode | undefined): Point {
  const [x = 0, y = 0] = nums(node);
  return { x, y };
}
/** an (at x y [angle]) triple */
function at(node: SNode | undefined): { x: number; y: number; angle: number } {
  const [x = 0, y = 0, angle = 0] = nums(node);
  return { x, y, angle };
}
function strokeWidth(node: SNode): number {
  const s = child(node, "stroke");
  const w = s ? Number(child(s, "width")?.values[0]) : Number(child(node, "width")?.values[0]);
  return Number.isFinite(w) && w > 0 ? w : 0.12;
}
function isFilled(node: SNode): boolean {
  const f = child(node, "fill");
  if (!f) return false;
  const v = String(f.values[0]);
  return v === "yes" || v === "solid";
}
function pts(node: SNode | undefined): Point[] {
  const p = node ? child(node, "pts") : undefined;
  if (!p) return [];
  return children(p, "xy").map((c) => xy(c));
}

function grow(b: BBox, p: Point): void {
  if (p.x < b.minX) b.minX = p.x;
  if (p.y < b.minY) b.minY = p.y;
  if (p.x > b.maxX) b.maxX = p.x;
  if (p.y > b.maxY) b.maxY = p.y;
}

// ---- footprint internals -------------------------------------------------

function readPad(node: SNode, fpos: Point, fangle: number, ref: string, sign: number): Pad {
  const number = String(node.values[0] ?? "");
  const type = String(node.values[1] ?? "smd"); // smd | thru_hole | np_thru_hole | connect
  const shape = String(node.values[2] ?? "rect") as PadShape;
  const a = at(child(node, "at"));
  const [w = 0, h = w] = nums(child(node, "size"));
  const pos = toWorld({ x: a.x, y: a.y }, fpos, fangle, sign);
  const drillNode = child(node, "drill");
  let drill: { w: number; h: number } | undefined;
  if (drillNode) {
    const dn = nums(drillNode);
    if (drillNode.values[0] === "oval") drill = { w: dn[0] ?? 0, h: dn[1] ?? dn[0] ?? 0 };
    else if (dn.length) drill = { w: dn[0]!, h: dn[1] ?? dn[0]! };
  }
  return {
    ref,
    number,
    shape,
    thruHole: type === "thru_hole" || type === "np_thru_hole",
    pos,
    size: { w, h },
    // KiCad stores the pad angle ABSOLUTE (board frame, footprint rotation already
    // included) even though the position is footprint-relative — e.g. poweramp Q7:
    // footprint (at … 90), pads (at … 90) = relative 0. Adding fangle double-rotates.
    angle: a.angle,
    rratio: Number(child(node, "roundrect_rratio")?.values[0] ?? 0.25),
    drill,
    layers: children(node, "layers").flatMap((l) => l.values.map(String)),
    net: childStr(node, "net") ?? "",
  };
}

function readFpGraphic(node: SNode, fpos: Point, fangle: number, sign: number): FpGraphic | null {
  const layer = childStr(node, "layer") ?? "";
  const w = strokeWidth(node);
  const W = (p: Point) => toWorld(p, fpos, fangle, sign);
  switch (node.name) {
    case "fp_line":
      return { kind: "line", layer, a: W(xy(child(node, "start"))), b: W(xy(child(node, "end"))), width: w };
    case "fp_rect":
      return { kind: "rect", layer, a: W(xy(child(node, "start"))), b: W(xy(child(node, "end"))), width: w, fill: isFilled(node) };
    case "fp_circle": {
      const c = W(xy(child(node, "center")));
      const e = W(xy(child(node, "end")));
      return { kind: "circle", layer, center: c, radius: Math.hypot(e.x - c.x, e.y - c.y), width: w };
    }
    case "fp_arc":
      return { kind: "arc", layer, start: W(xy(child(node, "start"))), mid: W(xy(child(node, "mid"))), end: W(xy(child(node, "end"))), width: w };
    case "fp_poly":
      return { kind: "poly", layer, pts: pts(node).map(W), width: w, fill: isFilled(node) };
    default:
      return null;
  }
}

function readFootprint(node: SNode, sign: number): Footprint {
  const a = at(child(node, "at"));
  const fpos = { x: a.x, y: a.y };
  const layer = childStr(node, "layer") ?? "F.Cu";
  const props = children(node, "property");
  const refProp = props.find((p) => String(p.values[0]) === "Reference");
  const valProp = props.find((p) => String(p.values[0]) === "Value");
  const ref = refProp ? String(refProp.values[1] ?? "") : "";
  const refAt = at(child(refProp ?? node, "at"));
  // (path "/<sheet-uuid…>/<symbol-uuid>") — the last segment is the schematic symbol's
  // UUID, the stable cross-tool identity (survives reference renames).
  const path = childStr(node, "path") ?? "";
  const symbolUuid = path.split("/").filter(Boolean).pop() ?? "";

  const pads = children(node, "pad").map((p) => readPad(p, fpos, a.angle, ref, sign));
  const graphics: FpGraphic[] = [];
  for (const g of node.children) {
    const fg = readFpGraphic(g, fpos, a.angle, sign);
    if (fg) graphics.push(fg);
  }
  return {
    ref,
    symbolUuid,
    value: valProp ? String(valProp.values[1] ?? "") : "",
    pos: fpos,
    angle: a.angle,
    layer,
    pads,
    graphics,
    refPos: toWorld({ x: refAt.x, y: refAt.y }, fpos, a.angle, sign),
    refLayer: refProp ? childStr(refProp, "layer") ?? "F.SilkS" : "F.SilkS",
  };
}

function readBoardGraphic(node: SNode): BoardGraphic | null {
  const layer = childStr(node, "layer") ?? "";
  const w = strokeWidth(node);
  const g = readBoardGraphicShape(node, layer, w);
  if (!g) return null;
  const net = childStr(node, "net");
  if (net !== undefined) g.net = net;
  return g;
}

function readBoardGraphicShape(node: SNode, layer: string, w: number): BoardGraphic | null {
  switch (node.name) {
    case "gr_line":
      return { kind: "line", layer, a: xy(child(node, "start")), b: xy(child(node, "end")), width: w };
    case "gr_rect":
      return { kind: "rect", layer, a: xy(child(node, "start")), b: xy(child(node, "end")), width: w, fill: isFilled(node) };
    case "gr_circle": {
      const c = xy(child(node, "center"));
      const e = xy(child(node, "end"));
      return { kind: "circle", layer, center: c, radius: Math.hypot(e.x - c.x, e.y - c.y), width: w };
    }
    case "gr_arc":
      return { kind: "arc", layer, start: xy(child(node, "start")), mid: xy(child(node, "mid")), end: xy(child(node, "end")), width: w };
    case "gr_poly":
      return { kind: "poly", layer, pts: pts(node), width: w, fill: isFilled(node) };
    default:
      return null;
  }
}

export function parsePcb(text: string, sign: number = ROT_SIGN): Pcb {
  const root = parseSExpr(text);
  if (root.name !== "kicad_pcb") throw new Error(`Not a kicad_pcb file (root is "${root.name}")`);

  // declared copper stack: KiCad writes the copper layers of the `(layers …)` table
  // in PHYSICAL order (F.Cu, In1…, B.Cu) — the numeric ids are legacy-stable and NOT
  // ordered (B.Cu is always 2, inner layers 4, 6, …), so keep the textual order.
  const copperStack: string[] = [];
  const layersDecl = child(root, "layers");
  if (layersDecl) {
    for (const l of layersDecl.children) {
      const name = String(l.values[0] ?? "");
      if (Number.isFinite(Number(l.name)) && name.endsWith(".Cu")) copperStack.push(name);
    }
  }

  // physical stackup: (setup (stackup (layer "F.Cu" (type "copper") (thickness 0.035)) …))
  let stackup: StackupLayer[] | undefined;
  const setup = child(root, "setup");
  const stackupNode = setup ? child(setup, "stackup") : undefined;
  if (stackupNode) {
    stackup = [];
    for (const l of children(stackupNode, "layer")) {
      const num = (n: string): number | undefined => {
        const v = Number(child(l, n)?.values[0]);
        return Number.isFinite(v) ? v : undefined;
      };
      stackup.push({
        name: String(l.values[0] ?? ""),
        type: childStr(l, "type") ?? "",
        thicknessMm: num("thickness"),
        epsilonR: num("epsilon_r"),
        lossTangent: num("loss_tangent"),
        material: childStr(l, "material"),
      });
    }
  }

  const footprints: Footprint[] = [];
  const texts: BoardText[] = [];
  const tracks: Track[] = [];
  const vias: Via[] = [];
  const zones: ZoneFill[] = [];
  const graphics: BoardGraphic[] = [];
  const netSet = new Set<string>();

  for (const node of root.children) {
    switch (node.name) {
      case "footprint": {
        const fp = readFootprint(node, sign);
        footprints.push(fp);
        for (const p of fp.pads) if (p.net) netSet.add(p.net);
        break;
      }
      case "segment":
      case "arc": { // arc tracks (rare); treat endpoints as a straight track for hit/highlight
        const net = childStr(node, "net") ?? "";
        tracks.push({ start: xy(child(node, "start")), end: xy(child(node, "end")), width: Number(child(node, "width")?.values[0] ?? 0.2), layer: childStr(node, "layer") ?? "", net });
        if (net) netSet.add(net);
        break;
      }
      case "via": {
        const net = childStr(node, "net") ?? "";
        vias.push({ pos: xy(child(node, "at")), size: Number(child(node, "size")?.values[0] ?? 0.6), drill: Number(child(node, "drill")?.values[0] ?? 0.3), layers: (child(node, "layers")?.values ?? []).map(String), net });
        if (net) netSet.add(net);
        break;
      }
      case "zone": {
        const net = childStr(node, "net_name") ?? childStr(node, "net") ?? "";
        const layer = childStr(node, "layer") ?? children(node, "layers")[0]?.values[0]?.toString() ?? "";
        for (const fp of children(node, "filled_polygon")) {
          zones.push({ layer: childStr(fp, "layer") ?? layer, net, pts: pts(fp) });
        }
        if (net) netSet.add(net);
        break;
      }
      case "gr_text": {
        const a = at(child(node, "at"));
        const effects = child(node, "effects");
        const font = effects ? child(effects, "font") : undefined;
        const size = font ? (nums(child(font, "size"))[0] ?? 1.27) : 1.27;
        const justify = effects ? child(effects, "justify") : undefined;
        texts.push({
          text: String(node.values[0] ?? ""),
          pos: { x: a.x, y: a.y },
          angle: a.angle,
          layer: childStr(node, "layer") ?? "",
          size,
          mirror: justify ? justify.values.map(String).includes("mirror") : false,
        });
        break;
      }
      default: {
        const g = readBoardGraphic(node);
        if (g) {
          graphics.push(g);
          if (g.net) netSet.add(g.net);
        }
      }
    }
  }

  // Net normalization: KiCad has two net-reference dialects. Name-style files put
  // the net NAME everywhere (`(net "GND")` on segments — poweramp fixture). Number-
  // style files (jetson, openair-max) declare a table at root — `(net 4 "+3V3")` —
  // and elements reference `(net 4)`, while zones ALSO carry `(net_name "+3V3")`.
  // Without canonicalization the same net splits in two ("4" tracks vs "+3V3" zone
  // fills) and nets falsely report as disconnected. Map every reference to the NAME.
  // Only id+name table rows count: single-value root decls (`(net "GND")`) are the
  // name dialect's own list, not a table.
  const netById = new Map<string, string>();
  for (const n of children(root, "net")) {
    if (n.values.length >= 2) netById.set(String(n.values[0]), String(n.values[1]));
  }
  if (netById.size) {
    const canon = (s: string): string => netById.get(s) ?? s;
    for (const f of footprints) for (const p of f.pads) p.net = canon(p.net);
    for (const t of tracks) t.net = canon(t.net);
    for (const v of vias) v.net = canon(v.net);
    for (const z of zones) z.net = canon(z.net);
    for (const g of graphics) if (g.net !== undefined) g.net = canon(g.net);
    netSet.clear();
    for (const f of footprints) for (const p of f.pads) if (p.net) netSet.add(p.net);
    for (const t of tracks) if (t.net) netSet.add(t.net);
    for (const z of zones) if (z.net) netSet.add(z.net);
    for (const g of graphics) if (g.net) netSet.add(g.net);
  }

  // bounding box (board outline preferred, else everything)
  const bbox: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const g of graphics) {
    if (g.layer !== "Edge.Cuts") continue;
    if (g.kind === "line" || g.kind === "rect" || g.kind === "arc") { grow(bbox, (g as { a?: Point }).a ?? (g as { start: Point }).start); }
    if (g.kind === "rect" || g.kind === "line") { grow(bbox, g.a); grow(bbox, g.b); }
    if (g.kind === "circle") { grow(bbox, { x: g.center.x - g.radius, y: g.center.y - g.radius }); grow(bbox, { x: g.center.x + g.radius, y: g.center.y + g.radius }); }
    if (g.kind === "poly") for (const p of g.pts) grow(bbox, p);
    if (g.kind === "arc") { grow(bbox, g.start); grow(bbox, g.end); }
  }
  if (!Number.isFinite(bbox.minX)) {
    for (const t of tracks) { grow(bbox, t.start); grow(bbox, t.end); }
    for (const f of footprints) for (const p of f.pads) grow(bbox, p.pos);
  }

  return { footprints, tracks, vias, zones, graphics, texts, copperStack, stackup, nets: [...netSet].sort(), layers: [...new Set([...tracks.map((t) => t.layer), ...graphics.map((g) => g.layer)])], bbox };
}
