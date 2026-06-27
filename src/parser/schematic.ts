/**
 * Typed model of a KiCad `.kicad_sch` (single sheet) built from the generic
 * S-expression tree. We keep only what the viewer/net-engine need:
 *   - library symbol definitions (pins + drawable graphics, in LOCAL coords)
 *   - placed symbol instances (lib_id, placement, properties)
 *   - wires, junctions, labels, no-connects
 *
 * Coordinates are KiCad millimetres with Y pointing DOWN.
 */

import { parseSExpr, child, children, childStr, type SNode, type Atom } from "./sexpr.js";

export interface Point {
  x: number;
  y: number;
}

export interface Placement {
  x: number;
  y: number;
  angle: number; // degrees, CCW in KiCad math but applied on a Y-down plane
}

export type MirrorAxis = "x" | "y" | null;

export interface LibPin {
  number: string;
  name: string;
  at: Placement; // local coords; (x,y) is the electrical connection point
  length: number;
  type: string; // electrical type: passive/input/power_in/...
  shape: string; // graphic shape: line/inverted/...
  unit: number;
  bodyStyle: number;
}

export type FillType = "none" | "outline" | "background";

export type LibGraphic =
  | { kind: "rectangle"; start: Point; end: Point; fill: FillType; width: number }
  | { kind: "polyline"; pts: Point[]; fill: FillType; width: number }
  | { kind: "circle"; center: Point; radius: number; fill: FillType; width: number }
  | { kind: "arc"; start: Point; mid: Point; end: Point; width: number };

export interface LibSymbol {
  id: string; // e.g. "Device:R" or "ltspice:GND"
  isPower: boolean; // has a (power ...) marker
  pins: LibPin[];
  graphics: LibGraphic[];
}

export interface Property {
  key: string;
  value: string;
  at?: Placement;
  hidden: boolean;
}

export interface SymbolInstance {
  uuid: string;
  libId: string;
  placement: Placement;
  mirror: MirrorAxis;
  unit: number;
  bodyStyle: number;
  ref: string;
  value: string;
  properties: Property[];
  /** map from pin number -> instance pin uuid (rarely needed, kept for cross-probe) */
  pinUuids: Map<string, string>;
}

export interface Wire {
  uuid: string;
  pts: Point[];
}

export interface Junction {
  uuid: string;
  at: Point;
}

export interface Label {
  uuid: string;
  text: string;
  at: Placement;
  scope: "local" | "global" | "hierarchical";
}

export interface NoConnect {
  uuid: string;
  at: Point;
}

export interface Schematic {
  libSymbols: Map<string, LibSymbol>;
  instances: SymbolInstance[];
  wires: Wire[];
  junctions: Junction[];
  labels: Label[];
  noConnects: NoConnect[];
}

// ---- helpers -------------------------------------------------------------

function readPlacement(node: SNode | undefined): Placement {
  if (!node) return { x: 0, y: 0, angle: 0 };
  const [x = 0, y = 0, angle = 0] = node.values as number[];
  return { x: Number(x), y: Number(y), angle: Number(angle) };
}

function readPoint(node: SNode | undefined): Point {
  if (!node) return { x: 0, y: 0 };
  const [x = 0, y = 0] = node.values as number[];
  return { x: Number(x), y: Number(y) };
}

function fillType(node: SNode): FillType {
  const f = child(node, "fill");
  const t = f ? childStr(f, "type") : undefined;
  if (t === "outline" || t === "color") return "outline";
  if (t === "background") return "background";
  return "none";
}

function strokeWidth(node: SNode): number {
  const s = child(node, "stroke");
  const w = s ? (child(s, "width")?.values[0] as number | undefined) : undefined;
  return typeof w === "number" && w > 0 ? w : 0.1524;
}

function readPts(node: SNode): Point[] {
  const ptsNode = child(node, "pts");
  if (!ptsNode) return [];
  return children(ptsNode, "xy").map((xy) => {
    const [x = 0, y = 0] = xy.values as number[];
    return { x: Number(x), y: Number(y) };
  });
}

/** parse a lib sub-symbol name suffix "<name>_<unit>_<bodyStyle>" -> [unit, body] */
function parseUnitSuffix(name: string): [number, number] {
  const m = name.match(/_(\d+)_(\d+)$/);
  if (!m) return [0, 0];
  return [Number(m[1]), Number(m[2])];
}

function readGraphic(node: SNode): LibGraphic | null {
  switch (node.name) {
    case "rectangle":
      return {
        kind: "rectangle",
        start: readPoint(child(node, "start")),
        end: readPoint(child(node, "end")),
        fill: fillType(node),
        width: strokeWidth(node),
      };
    case "polyline":
      return { kind: "polyline", pts: readPts(node), fill: fillType(node), width: strokeWidth(node) };
    case "circle":
      return {
        kind: "circle",
        center: readPoint(child(node, "center")),
        radius: Number(child(node, "radius")?.values[0] ?? 0),
        fill: fillType(node),
        width: strokeWidth(node),
      };
    case "arc":
      return {
        kind: "arc",
        start: readPoint(child(node, "start")),
        mid: readPoint(child(node, "mid")),
        end: readPoint(child(node, "end")),
        width: strokeWidth(node),
      };
    default:
      return null;
  }
}

function readPin(node: SNode, unit: number, bodyStyle: number): LibPin {
  // (pin <type> <shape> (at x y angle) (length L) (name "..") (number ".."))
  const [type = "passive", shape = "line"] = node.values as string[];
  const nameNode = child(node, "name");
  const numberNode = child(node, "number");
  return {
    type: String(type),
    shape: String(shape),
    at: readPlacement(child(node, "at")),
    length: Number(child(node, "length")?.values[0] ?? 0),
    name: nameNode ? String(nameNode.values[0] ?? "") : "",
    number: numberNode ? String(numberNode.values[0] ?? "") : "",
    unit,
    bodyStyle,
  };
}

function readLibSymbol(node: SNode): LibSymbol {
  const id = String(node.values[0] ?? "");
  const isPower = !!child(node, "power");
  const pins: LibPin[] = [];
  const graphics: LibGraphic[] = [];

  // Pins/graphics live in nested sub-symbols named "<id>_<unit>_<body>".
  for (const sub of children(node, "symbol")) {
    const [unit, body] = parseUnitSuffix(String(sub.values[0] ?? ""));
    for (const p of children(sub, "pin")) pins.push(readPin(p, unit, body));
    for (const g of sub.children) {
      const gr = readGraphic(g);
      if (gr) graphics.push(gr);
    }
  }
  // Some defs put pins directly under the top symbol too.
  for (const p of children(node, "pin")) pins.push(readPin(p, 0, 0));

  return { id, isPower, pins, graphics };
}

function readProperty(node: SNode): Property {
  const key = String(node.values[0] ?? "");
  const value = String(node.values[1] ?? "");
  const hidden = !!children(node, "hide").find((h) => String(h.values[0]) === "yes") || false;
  return { key, value, at: child(node, "at") ? readPlacement(child(node, "at")) : undefined, hidden };
}

function readInstance(node: SNode): SymbolInstance {
  const properties = children(node, "property").map(readProperty);
  const propMap = new Map(properties.map((p) => [p.key, p.value]));
  const mirrorNode = child(node, "mirror");
  const mirror: MirrorAxis = mirrorNode ? (String(mirrorNode.values[0]) as MirrorAxis) : null;

  const pinUuids = new Map<string, string>();
  for (const p of children(node, "pin")) {
    const num = String(p.values[0] ?? "");
    const u = childStr(p, "uuid");
    if (u) pinUuids.set(num, u);
  }

  // reference: prefer the property, fall back to the instances/path reference
  let ref = propMap.get("Reference") ?? "";
  if (!ref) {
    const inst = child(node, "instances");
    const proj = inst ? child(inst, "project") : undefined;
    const path = proj ? child(proj, "path") : undefined;
    if (path) ref = childStr(path, "reference") ?? "";
  }

  return {
    uuid: childStr(node, "uuid") ?? "",
    libId: childStr(node, "lib_id") ?? "",
    placement: readPlacement(child(node, "at")),
    mirror,
    unit: Number(child(node, "unit")?.values[0] ?? 1),
    bodyStyle: Number(child(node, "body_style")?.values[0] ?? 1),
    ref,
    value: propMap.get("Value") ?? "",
    properties,
    pinUuids,
  };
}

export function parseSchematic(text: string): Schematic {
  const root = parseSExpr(text);
  if (root.name !== "kicad_sch") {
    throw new Error(`Not a kicad_sch file (root is "${root.name}")`);
  }

  const libSymbols = new Map<string, LibSymbol>();
  const libNode = child(root, "lib_symbols");
  if (libNode) {
    for (const s of children(libNode, "symbol")) {
      const lib = readLibSymbol(s);
      libSymbols.set(lib.id, lib);
    }
  }

  const instances: SymbolInstance[] = [];
  const wires: Wire[] = [];
  const junctions: Junction[] = [];
  const labels: Label[] = [];
  const noConnects: NoConnect[] = [];

  for (const node of root.children) {
    switch (node.name) {
      case "symbol":
        instances.push(readInstance(node));
        break;
      case "wire":
        wires.push({ uuid: childStr(node, "uuid") ?? "", pts: readPts(node) });
        break;
      case "junction":
        junctions.push({ uuid: childStr(node, "uuid") ?? "", at: readPoint(child(node, "at")) });
        break;
      case "label":
        labels.push({
          uuid: childStr(node, "uuid") ?? "",
          text: String(node.values[0] ?? ""),
          at: readPlacement(child(node, "at")),
          scope: "local",
        });
        break;
      case "global_label":
        labels.push({
          uuid: childStr(node, "uuid") ?? "",
          text: String(node.values[0] ?? ""),
          at: readPlacement(child(node, "at")),
          scope: "global",
        });
        break;
      case "hierarchical_label":
        labels.push({
          uuid: childStr(node, "uuid") ?? "",
          text: String(node.values[0] ?? ""),
          at: readPlacement(child(node, "at")),
          scope: "hierarchical",
        });
        break;
      case "no_connect":
        noConnects.push({ uuid: childStr(node, "uuid") ?? "", at: readPoint(child(node, "at")) });
        break;
    }
  }

  return { libSymbols, instances, wires, junctions, labels, noConnects };
}

export type { Atom };
