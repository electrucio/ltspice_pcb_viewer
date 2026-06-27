/**
 * Pairing state machine (DOM-free, unit-testable).
 *
 * Selection is *deliberate*, not sticky: clicking only selects (one current
 * selection per side). A mapping is created only when the user confirms
 * (presses M / the Map button). This avoids accidental mappings from stray clicks.
 *
 *   select("ltspice", "net", "VCC")   // highlight on the left
 *   select("kicad",   "net", "POW")   // highlight on the right
 *   confirm()                          // -> maps VCC <-> POW
 */

import type { MappingStore } from "../mapping/store.js";
import type { Kind, Side } from "../mapping/format.js";

export interface Selection {
  kind: Kind;
  id: string;
}

export interface PairCandidate {
  kind: Kind;
  ltspice: string;
  kicad: string;
}

export class Pairing {
  ltspice: Selection | null = null;
  kicad: Selection | null = null;
  last: Side | null = null;

  constructor(private readonly store: MappingStore) {}

  select(side: Side, kind: Kind, id: string): void {
    this[side] = { kind, id };
    this.last = side;
  }

  clear(): void {
    this.ltspice = null;
    this.kicad = null;
    this.last = null;
  }

  /** The pair that pressing M would map: both sides selected, same kind, both unmapped. */
  mappable(): PairCandidate | null {
    const l = this.ltspice, k = this.kicad;
    if (!l || !k || l.kind !== k.kind) return null;
    if (this.store.isMapped(l.kind, "ltspice", l.id) || this.store.isMapped(k.kind, "kicad", k.id)) return null;
    return { kind: l.kind, ltspice: l.id, kicad: k.id };
  }

  /** Create the mapping if one is ready; keeps the pair selected for feedback. */
  confirm(): PairCandidate | null {
    const m = this.mappable();
    if (!m) return null;
    this.store.map(m.kind, m.ltspice, m.kicad);
    return m;
  }

  /** The currently active (last-clicked) item, if it is mapped — target for Unmap. */
  unmapActive(): PairCandidate | null {
    if (!this.last) return null;
    const sel = this[this.last];
    if (!sel || !this.store.isMapped(sel.kind, this.last, sel.id)) return null;
    const counterpart = this.store.counterpart(sel.kind, this.last, sel.id)!;
    const ltspice = this.last === "ltspice" ? sel.id : counterpart;
    const kicad = this.last === "kicad" ? sel.id : counterpart;
    this.store.unmap(sel.kind, this.last, sel.id);
    return { kind: sel.kind, ltspice, kicad };
  }
}
