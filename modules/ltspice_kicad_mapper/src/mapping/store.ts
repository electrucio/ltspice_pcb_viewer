/**
 * MappingStore — the source of truth for the LTspice↔KiCad correspondence.
 *
 * Two independent 1:1 bidirectional maps (one for nets, one for components).
 * Identifiers are the viewer-native names: KiCad net names / refs and LTspice
 * net names / InstNames. "ltspice" is treated as the forward key, "kicad" the
 * backward key, but the store is symmetric to query.
 */

import { deserialize, serialize, type Kind, type MappingFile, type Pair, type Side } from "./format.js";

class Bimap {
  private fwd = new Map<string, string>(); // ltspice -> kicad
  private bwd = new Map<string, string>(); // kicad -> ltspice

  /** Link ltspice<->kicad, removing any prior link involving either id (keeps 1:1). */
  link(ltspice: string, kicad: string): void {
    this.removeLtspice(ltspice);
    this.removeKicad(kicad);
    this.fwd.set(ltspice, kicad);
    this.bwd.set(kicad, ltspice);
  }
  removeLtspice(l: string): void {
    const k = this.fwd.get(l);
    if (k !== undefined) { this.fwd.delete(l); this.bwd.delete(k); }
  }
  removeKicad(k: string): void {
    const l = this.bwd.get(k);
    if (l !== undefined) { this.bwd.delete(k); this.fwd.delete(l); }
  }
  counterpart(side: Side, id: string): string | undefined {
    return side === "ltspice" ? this.fwd.get(id) : this.bwd.get(id);
  }
  has(side: Side, id: string): boolean {
    return this.counterpart(side, id) !== undefined;
  }
  pairs(): Pair[] {
    return [...this.fwd.entries()].map(([ltspice, kicad]) => ({ ltspice, kicad }));
  }
  clear(): void {
    this.fwd.clear();
    this.bwd.clear();
  }
  get size(): number {
    return this.fwd.size;
  }
}

/** Available native ids on each side, used for suggestions and stale-entry pruning. */
export interface AvailableIds {
  ltspice: { nets: Set<string>; components: Set<string> };
  kicad: { nets: Set<string>; components: Set<string> };
}

export interface MappingCounts {
  nets: number;
  components: number;
}

export class MappingStore {
  private maps: Record<Kind, Bimap> = { net: new Bimap(), component: new Bimap() };

  map(kind: Kind, ltspice: string, kicad: string): void {
    this.maps[kind].link(ltspice, kicad);
  }
  unmap(kind: Kind, side: Side, id: string): void {
    if (side === "ltspice") this.maps[kind].removeLtspice(id);
    else this.maps[kind].removeKicad(id);
  }
  counterpart(kind: Kind, side: Side, id: string): string | undefined {
    return this.maps[kind].counterpart(side, id);
  }
  isMapped(kind: Kind, side: Side, id: string): boolean {
    return this.maps[kind].has(side, id);
  }
  entries(kind: Kind): Pair[] {
    return this.maps[kind].pairs();
  }
  counts(): MappingCounts {
    return { nets: this.maps.net.size, components: this.maps.component.size };
  }
  clear(): void {
    this.maps.net.clear();
    this.maps.component.clear();
  }

  /**
   * Suggest counterpart id(s) on the other side for an unmapped item.
   * Exact (then case-insensitive) name/ref matches that exist and are still free.
   */
  suggest(kind: Kind, side: Side, id: string, available: AvailableIds): string[] {
    const otherSide: Side = side === "ltspice" ? "kicad" : "ltspice";
    const pool = available[otherSide][kind === "net" ? "nets" : "components"];
    const free = (cand: string) => !this.isMapped(kind, otherSide, cand);
    if (pool.has(id) && free(id)) return [id];
    const lower = id.toLowerCase();
    const ci = [...pool].filter((c) => c.toLowerCase() === lower && free(c));
    return ci;
  }

  // ---- import / export ---------------------------------------------------

  toFile(meta: { ltspiceSource?: string; kicadSource?: string; createdAt?: string } = {}): MappingFile {
    return { version: 1, ...meta, nets: this.entries("net"), components: this.entries("component") };
  }

  /**
   * Replace contents from a mapping file. If `available` is given, entries whose
   * ids no longer exist in the loaded schematics are skipped. Returns dropped count.
   */
  fromFile(file: string | object | MappingFile, available?: AvailableIds): { loaded: number; dropped: number } {
    const parsed = deserialize(file as string);
    this.clear();
    let loaded = 0, dropped = 0;
    const load = (kind: Kind, pairs: Pair[]) => {
      const setKey = kind === "net" ? "nets" : "components";
      for (const p of pairs) {
        if (available && (!available.ltspice[setKey].has(p.ltspice) || !available.kicad[setKey].has(p.kicad))) { dropped++; continue; }
        this.map(kind, p.ltspice, p.kicad);
        loaded++;
      }
    };
    load("net", parsed.nets);
    load("component", parsed.components);
    return { loaded, dropped };
  }
}

export { serialize };
export type { Kind, Side, Pair, MappingFile };
