/**
 * Connectivity / net engine.
 *
 * A `.kicad_sch` stores no netlist — it is derived from geometry. We replicate
 * KiCad's derivation:
 *   1. Each wire segment connects its two endpoints.
 *   2. A junction connects every wire passing through that point (a mid-span T or
 *      a crossing connects ONLY when a junction dot is present).
 *   3. Pins/labels/power-symbol pins sitting on the same point share the node.
 *   4. Local/global labels with the same text merge; power symbols merge by value.
 *
 * Nodes are keyed by quantized world coordinate, so anything at the same physical
 * point is automatically the same electrical node (union-find over coordinates).
 *
 * NOTE: we reproduce CONNECTIVITY exactly; the auto-generated *name* of an
 * anonymous net (`Net-(REF-PIN)`) follows KiCad's convention but its exact string
 * is not guaranteed to match KiCad's internal pick — connectivity is what matters.
 */

import type { Schematic, Point } from "../parser/schematic.js";
import { instanceMatrix, pinWorldPos, transformPoint, quantize, GRID } from "../geometry/transform.js";

export interface NetPin {
  ref: string;
  number: string;
  name: string;
  pos: Point;
  key: string;
}

export interface Net {
  id: number;
  name: string;
  isPower: boolean;
  pins: NetPin[];
  /** quantized coordinate keys belonging to this net */
  pointKeys: string[];
  wireUuids: string[];
  junctionUuids: string[];
  labels: string[];
}

export interface Netlist {
  nets: Net[];
  /** `${ref}.${pinNumber}` -> net id */
  pinToNet: Map<string, number>;
  /** ref -> set of net ids the component touches */
  componentToNets: Map<string, Set<number>>;
  /** quantized point key -> net id (for hit-testing a clicked point) */
  pointToNet: Map<string, number>;
  /** wire uuid -> net id */
  wireToNet: Map<string, number>;
  byName: Map<string, Net>;
}

// ---- union-find over coordinate keys -------------------------------------

class DSU {
  private parent = new Map<string, string>();

  add(key: string): void {
    if (!this.parent.has(key)) this.parent.set(key, key);
  }

  find(key: string): string {
    this.add(key);
    let root = key;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    // path compression
    let cur = key;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  keys(): IterableIterator<string> {
    return this.parent.keys();
  }
}

// integer coords for exact geometry math
function ipt(p: Point): [number, number] {
  return [Math.round(p.x * GRID), Math.round(p.y * GRID)];
}

/** Is integer point q on the segment a-b (inclusive)? */
function onSegment(ax: number, ay: number, bx: number, by: number, qx: number, qy: number): boolean {
  const cross = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
  if (cross !== 0) return false;
  const minx = Math.min(ax, bx), maxx = Math.max(ax, bx);
  const miny = Math.min(ay, by), maxy = Math.max(ay, by);
  return qx >= minx && qx <= maxx && qy >= miny && qy <= maxy;
}

function isMeaningfulPinName(name: string): boolean {
  return name.length > 0 && name !== "~";
}

export function buildNetlist(sch: Schematic): Netlist {
  const dsu = new DSU();

  // metadata attached to coordinate keys
  const pinsAt = new Map<string, NetPin[]>();
  const powerAt = new Map<string, string>(); // key -> power net name
  const labelAt = new Map<string, string[]>(); // key -> label texts

  // integer segments, for junction resolution
  const segments: Array<{ uuid: string; ax: number; ay: number; bx: number; by: number; keyA: string; keyB: string }> = [];

  // 1) wires
  for (const w of sch.wires) {
    for (let i = 0; i + 1 < w.pts.length; i++) {
      const p0 = w.pts[i]!;
      const p1 = w.pts[i + 1]!;
      const k0 = quantize(p0);
      const k1 = quantize(p1);
      dsu.union(k0, k1);
      const [ax, ay] = ipt(p0);
      const [bx, by] = ipt(p1);
      segments.push({ uuid: w.uuid, ax, ay, bx, by, keyA: k0, keyB: k1 });
    }
  }

  // 2) junctions: connect every wire passing through the junction point
  for (const j of sch.junctions) {
    const jk = quantize(j.at);
    dsu.add(jk);
    const [qx, qy] = ipt(j.at);
    for (const s of segments) {
      if (onSegment(s.ax, s.ay, s.bx, s.by, qx, qy)) {
        dsu.union(jk, s.keyA);
      }
    }
  }

  // 3) pins + power-symbol naming
  for (const inst of sch.instances) {
    const lib = sch.libSymbols.get(inst.libId);
    if (!lib) continue;
    const m = instanceMatrix(inst.placement, inst.mirror);
    for (const pin of lib.pins) {
      if (pin.unit !== 0 && pin.unit !== inst.unit) continue;
      if (pin.bodyStyle !== 0 && pin.bodyStyle !== inst.bodyStyle) continue;
      const pos = pinWorldPos(m, pin.at);
      const key = quantize(pos);
      dsu.add(key);
      const np: NetPin = { ref: inst.ref, number: pin.number, name: pin.name, pos, key };
      (pinsAt.get(key) ?? pinsAt.set(key, []).get(key)!).push(np);
      if (lib.isPower && inst.value) {
        powerAt.set(key, inst.value);
      }
    }
  }

  // 4) labels. The anchor sits ON a wire but often mid-span (not at an endpoint),
  //    so connect it to any wire passing through, like a junction.
  for (const lbl of sch.labels) {
    const key = quantize({ x: lbl.at.x, y: lbl.at.y });
    dsu.add(key);
    const [qx, qy] = ipt(lbl.at);
    for (const s of segments) {
      if (onSegment(s.ax, s.ay, s.bx, s.by, qx, qy)) dsu.union(key, s.keyA);
    }
    (labelAt.get(key) ?? labelAt.set(key, []).get(key)!).push(lbl.text);
  }

  // 5) merge by name: same label text -> same net; same power name -> same net
  const byLabel = new Map<string, string[]>();
  for (const [key, texts] of labelAt) for (const t of texts) (byLabel.get(t) ?? byLabel.set(t, []).get(t)!).push(key);
  for (const keys of byLabel.values()) for (let i = 1; i < keys.length; i++) dsu.union(keys[0]!, keys[i]!);

  const byPower = new Map<string, string[]>();
  for (const [key, name] of powerAt) (byPower.get(name) ?? byPower.set(name, []).get(name)!).push(key);
  for (const keys of byPower.values()) for (let i = 1; i < keys.length; i++) dsu.union(keys[0]!, keys[i]!);

  // 6) assemble nets by DSU root
  const roots = new Map<string, Net>();
  let nextId = 0;
  function netForKey(key: string): Net {
    const root = dsu.find(key);
    let net = roots.get(root);
    if (!net) {
      net = { id: nextId++, name: "", isPower: false, pins: [], pointKeys: [], wireUuids: [], junctionUuids: [], labels: [] };
      roots.set(root, net);
    }
    return net;
  }

  for (const key of dsu.keys()) netForKey(key).pointKeys.push(key);
  for (const [key, pins] of pinsAt) netForKey(key).pins.push(...pins);
  for (const [key, name] of powerAt) { const n = netForKey(key); n.isPower = true; if (!n.name) n.name = name; }
  for (const [key, texts] of labelAt) { const n = netForKey(key); for (const t of texts) if (!n.labels.includes(t)) n.labels.push(t); }

  // wires + junctions -> nets
  const wireToNet = new Map<string, number>();
  for (const s of segments) {
    const n = netForKey(s.keyA);
    if (!n.wireUuids.includes(s.uuid)) n.wireUuids.push(s.uuid);
    wireToNet.set(s.uuid, n.id);
  }
  for (const j of sch.junctions) netForKey(quantize(j.at)).junctionUuids.push(j.uuid);

  // 7) naming: label > power > auto Net-(REF-PIN)
  for (const net of roots.values()) {
    if (net.labels.length > 0) {
      net.name = [...net.labels].sort()[0]!; // explicit label wins
    } else if (net.name) {
      // power-symbol name already assigned above
    } else if (net.pins.length > 0) {
      const rep = [...net.pins].sort((a, b) =>
        a.ref === b.ref ? a.number.localeCompare(b.number, undefined, { numeric: true }) : a.ref.localeCompare(b.ref, undefined, { numeric: true }),
      )[0]!;
      const pinTag = isMeaningfulPinName(rep.name) ? rep.name : `Pad${rep.number}`;
      net.name = `Net-(${rep.ref}-${pinTag})`;
    } else {
      net.name = `unconnected-${net.id}`;
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

  return { nets, pinToNet, componentToNets, pointToNet, wireToNet, byName };
}

/** Convenience: world position of every pin of an instance (for rendering). */
export function instancePinPositions(sch: Schematic, ref: string): NetPin[] {
  const inst = sch.instances.find((i) => i.ref === ref);
  if (!inst) return [];
  const lib = sch.libSymbols.get(inst.libId);
  if (!lib) return [];
  const m = instanceMatrix(inst.placement, inst.mirror);
  const out: NetPin[] = [];
  for (const pin of lib.pins) {
    if (pin.unit !== 0 && pin.unit !== inst.unit) continue;
    const pos = pinWorldPos(m, pin.at);
    out.push({ ref, number: pin.number, name: pin.name, pos, key: quantize(pos) });
  }
  return out;
}

export { transformPoint };
