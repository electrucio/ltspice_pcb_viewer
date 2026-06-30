/**
 * Read-only cross-probe controller for the exported viewer.
 *
 * The mapping is keyed on LTspice ids ↔ KiCad **schematic** ids; the PCB shares KiCad
 * refs (by symbol UUID) and net names (via the net alias). Selecting a net/component in
 * any pane — by clicking the SVG or a sidebar row — highlights its mapped counterpart(s)
 * in the others and notifies listeners (so the sidebars can mark the rows). No editing.
 */

import type { MappingStore } from "../../ltspice_kicad_mapper/src/mapping/store.js";
import type { KicadNetAlias } from "../../ltspice_kicad_mapper/src/mapping/kicad-nets.js";

type Kind = "net" | "component";
type Origin = "lt" | "ksch" | "kpcb";

interface Viewer extends HTMLElement {
  highlightNet(name: string): void;
  highlightComponent(ref: string): void;
  clearHighlights(): void;
}

export interface RefAlias {
  schToPcb: Map<string, string>;
  pcbToSch: Map<string, string>;
}

/** The resolved current selection (any id may be absent if there is no counterpart). */
export interface ProbeSelection {
  kind: Kind;
  ltId?: string;
  kschId?: string;
}

export interface CrossProbeTargets {
  lt: Viewer;
  ksch: Viewer;
  kpcb: Viewer | null;
  store: MappingStore;
  alias: KicadNetAlias; // schematic↔PCB net names
  compAlias: RefAlias; // schematic↔PCB refs (by symbol UUID)
}

export interface CrossProbeController {
  /** Select from a given pane (id=null clears). Highlights all panes + notifies listeners. */
  select: (origin: Origin, kind: Kind, id: string | null) => void;
  /** Subscribe to selection changes (null = cleared). */
  onChange: (cb: (sel: ProbeSelection | null) => void) => void;
}

export function setupCrossProbe(t: CrossProbeTargets): CrossProbeController {
  const { lt, ksch, kpcb, store, alias, compAlias } = t;
  const listeners: ((sel: ProbeSelection | null) => void)[] = [];

  const clearAll = (): void => {
    lt.clearHighlights();
    ksch.clearHighlights();
    if (kpcb) kpcb.clearHighlights();
  };

  const apply = (kind: Kind, ltId?: string, kschId?: string): void => {
    clearAll();
    if (kind === "net") {
      if (ltId) lt.highlightNet(ltId);
      if (kschId) {
        ksch.highlightNet(kschId);
        if (kpcb) kpcb.highlightNet(alias.schToPcb.get(kschId) ?? kschId);
      }
    } else {
      if (ltId) lt.highlightComponent(ltId);
      if (kschId) {
        ksch.highlightComponent(kschId);
        if (kpcb) kpcb.highlightComponent(compAlias.schToPcb.get(kschId) ?? kschId);
      }
    }
    for (const cb of listeners) cb({ kind, ltId, kschId });
  };

  const select = (origin: Origin, kind: Kind, id: string | null): void => {
    if (!id) {
      clearAll();
      for (const cb of listeners) cb(null);
      return;
    }
    let ltId: string | undefined;
    let kschId: string | undefined;
    if (origin === "lt") {
      ltId = id;
      kschId = store.counterpart(kind, "ltspice", id);
    } else if (origin === "ksch") {
      kschId = id;
      ltId = store.counterpart(kind, "kicad", id);
    } else {
      kschId = kind === "net" ? alias.pcbToSch.get(id) ?? id : compAlias.pcbToSch.get(id) ?? id;
      ltId = store.counterpart(kind, "kicad", kschId);
    }
    apply(kind, ltId, kschId);
  };

  const wire = (v: Viewer | null, origin: Origin): void => {
    if (!v) return;
    v.addEventListener("netselect", (e) => select(origin, "net", ((e as CustomEvent).detail as { name: string } | null)?.name ?? null));
    v.addEventListener("componentselect", (e) => select(origin, "component", ((e as CustomEvent).detail as { ref: string } | null)?.ref ?? null));
  };
  wire(lt, "lt");
  wire(ksch, "ksch");
  wire(kpcb, "kpcb");

  return {
    select,
    onChange(cb) { listeners.push(cb); },
  };
}
