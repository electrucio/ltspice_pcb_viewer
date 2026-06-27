/**
 * Connectivity / net engine for LTspice schematics.
 *
 * Like KiCad, `.asc` stores no netlist — it is derived from geometry:
 *   1. each WIRE connects its two endpoints;
 *   2. a wire endpoint lying on another wire (a T-junction) connects them
 *      (a bare crossing with no shared endpoint does NOT connect);
 *   3. pins / flags sitting on a wire join that net;
 *   4. FLAGs name nets; same-named flags merge; flag "0" is ground.
 *
 * Union-find over integer point keys; anything at the same point is one node.
 */

import type { AscSchematic, Wire, SymbolInstance } from "../parser/asc.js";
import type { SymbolDef } from "../parser/asy.js";
import { makeXform, key, type Xform, type Point } from "../geometry/transform.js";
import { SymbolLibrary } from "../symbols/builtin.js";

export interface PlacedPin {
  number: string; // 1-based pin index (SpiceOrder)
  name: string;
  pos: Point;
}

export interface PlacedSymbol {
  ref: string; // InstName (e.g. R1, Q3, V2); synthetic if missing
  value: string;
  name: string; // symbol name (res, npn, ...)
  x: number;
  y: number;
  xf: Xform;
  def: SymbolDef | null; // null => symbol geometry missing
  pins: PlacedPin[];
  bbox: BBox;
  instance: SymbolInstance; // source .asc SYMBOL (for window overrides)
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface NetPin {
  ref: string;
  number: string;
  pos: Point;
  key: string;
}

export interface Net {
  id: number;
  name: string;
  isPower: boolean; // ground / named power
  pins: NetPin[];
  pointKeys: string[];
  wireIdx: number[];
  flags: string[];
}

export interface Netlist {
  nets: Net[];
  pinToNet: Map<string, number>; // `${ref}.${number}` -> id
  componentToNets: Map<string, Set<number>>;
  pointToNet: Map<string, number>; // point key -> id
  wireToNet: Map<number, number>; // wire index -> id
  byName: Map<string, Net>;
}

export interface Model {
  placed: PlacedSymbol[];
  netlist: Netlist;
  junctions: Point[];
  bbox: BBox;
}

// ---- union-find ----------------------------------------------------------

class DSU {
  parent = new Map<string, string>();
  add(k: string): void {
    if (!this.parent.has(k)) this.parent.set(k, k);
  }
  find(k: string): string {
    this.add(k);
    let r = k;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    let c = k;
    while (this.parent.get(c) !== r) {
      const n = this.parent.get(c)!;
      this.parent.set(c, r);
      c = n;
    }
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

function segHasPoint(w: Wire, x: number, y: number, excludeEnds: boolean): boolean {
  const [x1, y1, x2, y2] = w;
  if (x < Math.min(x1, x2) || x > Math.max(x1, x2) || y < Math.min(y1, y2) || y > Math.max(y1, y2)) return false;
  if ((x2 - x1) * (y - y1) !== (y2 - y1) * (x - x1)) return false; // collinear
  if (excludeEnds && ((x === x1 && y === y1) || (x === x2 && y === y2))) return false;
  return true;
}

function growBox(b: BBox, x: number, y: number): void {
  if (x < b.minX) b.minX = x;
  if (y < b.minY) b.minY = y;
  if (x > b.maxX) b.maxX = x;
  if (y > b.maxY) b.maxY = y;
}

/** Place every instance: resolve its symbol, transform pins/graphics to world. */
export function placeSymbols(sch: AscSchematic, lib: SymbolLibrary): PlacedSymbol[] {
  let auto = 0;
  return sch.symbols.map((sym) => {
    const def = lib.lookup(sym.name);
    const xf = makeXform(sym.rot);
    const bbox: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    const grow = (px: number, py: number) => {
      const p = xf.pt(px, py);
      growBox(bbox, sym.x + p.x, sym.y + p.y);
    };
    if (def) {
      for (const l of def.lines) { grow(l[0], l[1]); grow(l[2], l[3]); }
      for (const r of def.rects) { grow(r[0], r[1]); grow(r[2], r[3]); }
      for (const c of def.circles) { grow(c[0], c[1]); grow(c[2], c[3]); }
      for (const a of def.arcs) { grow(a[0], a[1]); grow(a[2], a[3]); }
      for (const p of def.pins) grow(p.x, p.y);
    } else {
      grow(0, 0); grow(64, 64);
    }
    const pins: PlacedPin[] = def
      ? def.pins.map((p, i) => {
          const w = xf.pt(p.x, p.y);
          return { number: String(i + 1), name: p.name, pos: { x: sym.x + w.x, y: sym.y + w.y } };
        })
      : [];
    const ref = sym.attrs.InstName || `?${sym.name}${auto++}`;
    return { ref, value: sym.attrs.Value ?? def?.value ?? "", name: sym.name, x: sym.x, y: sym.y, xf, def, pins, bbox, instance: sym };
  });
}

export function buildModel(sch: AscSchematic, lib: SymbolLibrary): Model {
  const placed = placeSymbols(sch, lib);
  const dsu = new DSU();

  // 1) wires
  const endCount = new Map<string, number>();
  sch.wires.forEach((w) => {
    const a = key(w[0], w[1]), b = key(w[2], w[3]);
    dsu.union(a, b);
    endCount.set(a, (endCount.get(a) ?? 0) + 1);
    endCount.set(b, (endCount.get(b) ?? 0) + 1);
  });

  // 2) T-junctions: an endpoint lying on another wire connects them
  const junctions: Point[] = [];
  for (const k of [...endCount.keys()]) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    let touching = endCount.get(k)!;
    for (const w of sch.wires) {
      if (segHasPoint(w, x, y, true)) {
        touching += 2;
        dsu.union(k, key(w[0], w[1]));
      }
    }
    if (touching >= 3) junctions.push({ x, y });
  }

  // 3) flags: connect to a wire passing through, then merge same names
  const flagsByName = new Map<string, string[]>();
  for (const f of sch.flags) {
    const k = key(f.x, f.y);
    dsu.add(k);
    for (const w of sch.wires) if (segHasPoint(w, f.x, f.y, false)) dsu.union(k, key(w[0], w[1]));
    (flagsByName.get(f.net) ?? flagsByName.set(f.net, []).get(f.net)!).push(k);
  }
  for (const ks of flagsByName.values()) for (let i = 1; i < ks.length; i++) dsu.union(ks[0]!, ks[i]!);

  // 4) pins: connect to a wire passing through (coincident pins auto-merge by key)
  for (const p of placed) for (const pin of p.pins) {
    const k = key(pin.pos.x, pin.pos.y);
    dsu.add(k);
    for (const w of sch.wires) if (segHasPoint(w, pin.pos.x, pin.pos.y, false)) dsu.union(k, key(w[0], w[1]));
  }

  // 5) assemble nets by root
  const roots = new Map<string, Net>();
  let nextId = 0;
  const netForKey = (k: string): Net => {
    const r = dsu.find(k);
    let n = roots.get(r);
    if (!n) { n = { id: nextId++, name: "", isPower: false, pins: [], pointKeys: [], wireIdx: [], flags: [] }; roots.set(r, n); }
    return n;
  };
  for (const k of dsu.parent.keys()) netForKey(k).pointKeys.push(k);

  const wireToNet = new Map<number, number>();
  sch.wires.forEach((w, i) => {
    const n = netForKey(key(w[0], w[1]));
    n.wireIdx.push(i);
    wireToNet.set(i, n.id);
  });
  for (const p of placed) for (const pin of p.pins) {
    const k = key(pin.pos.x, pin.pos.y);
    netForKey(k).pins.push({ ref: p.ref, number: pin.number, pos: pin.pos, key: k });
  }
  for (const f of sch.flags) {
    const n = netForKey(key(f.x, f.y));
    if (!n.flags.includes(f.net)) n.flags.push(f.net);
  }

  // 6) naming: flag name > ground "0" > auto Net-(ref.pin) > N<id>
  for (const net of roots.values()) {
    const named = net.flags.find((f) => f !== "0");
    if (net.flags.includes("0")) { net.name = "0"; net.isPower = true; }
    else if (named) { net.name = named; net.isPower = false; }
    else if (net.pins.length > 0) {
      const rep = [...net.pins].sort((a, b) =>
        a.ref === b.ref ? a.number.localeCompare(b.number, undefined, { numeric: true }) : a.ref.localeCompare(b.ref, undefined, { numeric: true }),
      )[0]!;
      net.name = `Net-(${rep.ref}.${rep.number})`;
    } else {
      net.name = `N${String(net.id).padStart(3, "0")}`;
    }
  }

  // indices
  const nets = [...roots.values()].sort((a, b) => a.id - b.id);
  const pinToNet = new Map<string, number>();
  const componentToNets = new Map<string, Set<number>>();
  const pointToNet = new Map<string, number>();
  const byName = new Map<string, Net>();
  for (const net of nets) {
    byName.set(net.name, net);
    for (const k of net.pointKeys) pointToNet.set(k, net.id);
    for (const p of net.pins) {
      pinToNet.set(`${p.ref}.${p.number}`, net.id);
      (componentToNets.get(p.ref) ?? componentToNets.set(p.ref, new Set()).get(p.ref)!).add(net.id);
    }
  }

  // overall bbox
  const bbox: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const w of sch.wires) { growBox(bbox, w[0], w[1]); growBox(bbox, w[2], w[3]); }
  for (const p of placed) { growBox(bbox, p.bbox.minX, p.bbox.minY); growBox(bbox, p.bbox.maxX, p.bbox.maxY); }
  for (const f of sch.flags) { growBox(bbox, f.x - 40, f.y - 20); growBox(bbox, f.x + 40, f.y + 20); }
  if (!isFinite(bbox.minX)) Object.assign(bbox, { minX: 0, minY: 0, maxX: 1000, maxY: 800 });

  return { placed, junctions, bbox, netlist: { nets, pinToNet, componentToNets, pointToNet, wireToNet, byName } };
}
