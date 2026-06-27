/**
 * Pairing state machine (DOM-free, unit-testable).
 *
 * Drives the "select on one side, click the equivalent on the other to map" flow:
 *   - selecting a mapped item just activates it (its pair is shown);
 *   - selecting an unmapped item while an unmapped item of the same kind is pending
 *     on the OTHER side creates the mapping;
 *   - otherwise the item becomes the pending selection and the other side gets
 *     suggestions.
 *
 * It only mutates the MappingStore and tracks `active`/`pending`; the component reads
 * `active`/`pending` to paint highlights (pending=amber, mapped=green, suggestion=blue).
 */

import type { AvailableIds, MappingStore } from "../mapping/store.js";
import type { Kind, Side } from "../mapping/format.js";

export interface Selection {
  side: Side;
  kind: Kind;
  id: string;
}

export type PairingResult =
  | { type: "mapped"; kind: Kind; ltspice: string; kicad: string } // active item is mapped
  | { type: "created"; kind: Kind; ltspice: string; kicad: string } // a new mapping was made
  | { type: "pending"; selection: Selection; suggestions: string[] } // waiting for the other side
  | { type: "cleared" };

export class Pairing {
  active: Selection | null = null;
  pending: Selection | null = null;

  constructor(
    private readonly store: MappingStore,
    private readonly available: () => AvailableIds,
  ) {}

  select(side: Side, kind: Kind, id: string): PairingResult {
    this.active = { side, kind, id };

    // 1) already mapped -> just show the pair
    if (this.store.isMapped(kind, side, id)) {
      this.pending = null;
      return this.mappedResult(kind, side, id);
    }

    // 2) complete a pending pair (opposite side, same kind, both unmapped)
    const p = this.pending;
    if (p && p.kind === kind && p.side !== side && !this.store.isMapped(kind, p.side, p.id)) {
      const ltspice = side === "ltspice" ? id : p.id;
      const kicad = side === "kicad" ? id : p.id;
      this.store.map(kind, ltspice, kicad);
      this.pending = null;
      return { type: "created", kind, ltspice, kicad };
    }

    // 3) become the pending selection; offer suggestions on the other side
    this.pending = { side, kind, id };
    return { type: "pending", selection: this.pending, suggestions: this.store.suggest(kind, side, id, this.available()) };
  }

  /** Remove the mapping of the currently active item (if any). */
  unmapActive(): { kind: Kind; ltspice: string; kicad: string } | null {
    const a = this.active;
    if (!a || !this.store.isMapped(a.kind, a.side, a.id)) return null;
    const counterpart = this.store.counterpart(a.kind, a.side, a.id)!;
    const ltspice = a.side === "ltspice" ? a.id : counterpart;
    const kicad = a.side === "kicad" ? a.id : counterpart;
    this.store.unmap(a.kind, a.side, a.id);
    this.pending = null;
    return { kind: a.kind, ltspice, kicad };
  }

  clear(): void {
    this.active = null;
    this.pending = null;
  }

  private mappedResult(kind: Kind, side: Side, id: string): PairingResult {
    const counterpart = this.store.counterpart(kind, side, id)!;
    const ltspice = side === "ltspice" ? id : counterpart;
    const kicad = side === "kicad" ? id : counterpart;
    return { type: "mapped", kind, ltspice, kicad };
  }
}
