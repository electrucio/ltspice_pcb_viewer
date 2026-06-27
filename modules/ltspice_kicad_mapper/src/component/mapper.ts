/**
 * <ltspice-kicad-mapper> — shows an LTspice schematic and a KiCad schematic side by
 * side and lets the user build a 1:1 net/component correspondence between them.
 *
 * It embeds the two sibling viewer modules (registered by the imports below), wires
 * their selection events into a pairing state machine + MappingStore, and recolors
 * the viewers' highlights per state via the `--ksv-highlight`/`--ksv-select` CSS
 * variables (pending=amber, mapped=green, suggestion=blue) — no viewer changes needed.
 */

// register the two custom elements (side-effect imports)
import "../../../ltspice_schematic_viewer/src/index.js";
import "../../../kicad_schematic_viewer/src/index.js";

import { MappingStore, serialize, type AvailableIds } from "../mapping/store.js";
import type { Kind, Side, MappingFile } from "../mapping/format.js";
import { Pairing } from "../interaction/pairing.js";
import { STYLESHEET } from "./style.js";

/** Structural view of either viewer element (common subset the mapper uses). */
interface ViewerElement extends HTMLElement {
  getNets(): { name: string; isPower: boolean }[];
  getComponents(): { ref: string; value: string }[];
  highlightNet(name: string): void;
  highlightComponent(ref: string): void;
  clearHighlights(): void;
  zoomToNet(name: string): void;
  loadFromUrl(url: string): Promise<void>;
  loadFromString(text: string | ArrayBuffer | Uint8Array): void;
}

const COLORS = { pending: "#ff8c00", mapped: "#39d353", suggestion: "#4aa3ff" };

interface SideState {
  viewer: ViewerElement;
  listEl: HTMLDivElement;
  filterEl: HTMLInputElement;
  tab: Kind;
  source: string;
  nets: { name: string; isPower: boolean }[];
  comps: { ref: string; value: string }[];
}

export class LtspiceKicadMapperElement extends HTMLElement {
  static get observedAttributes(): string[] {
    return ["ltspice-src", "kicad-src", "mapping-src", "theme"];
  }

  private store = new MappingStore();
  private pairing = new Pairing(this.store, () => this.available());
  private sides!: Record<Side, SideState>;
  private statusEl!: HTMLElement;
  private countsEl!: HTMLElement;

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  connectedCallback(): void {
    this.build();
    const lt = this.getAttribute("ltspice-src");
    const ki = this.getAttribute("kicad-src");
    if (lt) void this.sides.ltspice.viewer.loadFromUrl(lt);
    if (ki) void this.sides.kicad.viewer.loadFromUrl(ki);
  }

  attributeChangedCallback(name: string, oldV: string | null, newV: string | null): void {
    if (oldV === newV || !this.sides) return;
    if (name === "ltspice-src" && newV) void this.sides.ltspice.viewer.loadFromUrl(newV);
    if (name === "kicad-src" && newV) void this.sides.kicad.viewer.loadFromUrl(newV);
    if (name === "theme") {
      this.sides.ltspice.viewer.setAttribute("theme", newV ?? "dark");
      this.sides.kicad.viewer.setAttribute("theme", newV ?? "dark");
    }
  }

  // ---- public API --------------------------------------------------------

  registerLtspiceSymbol(name: string, asyText: string): void {
    (this.sides.ltspice.viewer as unknown as { registerSymbol(n: string, a: string): void }).registerSymbol(name, asyText);
  }
  loadLtspiceUrl(url: string): Promise<void> { this.sides.ltspice.source = basename(url); return this.sides.ltspice.viewer.loadFromUrl(url); }
  loadKicadUrl(url: string): Promise<void> { this.sides.kicad.source = basename(url); return this.sides.kicad.viewer.loadFromUrl(url); }

  /** Replace the mapping from a file object/text; prunes ids absent in the schematics. */
  loadMapping(file: string | object): { loaded: number; dropped: number } {
    const res = this.store.fromFile(file as string, this.available());
    this.pairing.clear();
    this.clearHighlights();
    this.renderLists();
    this.updateCounts();
    this.emitChange();
    this.setStatus(`Imported ${res.loaded} mappings${res.dropped ? `, dropped ${res.dropped} stale` : ""}`);
    return res;
  }

  exportMapping(): MappingFile {
    return this.store.toFile({ ltspiceSource: this.sides.ltspice.source, kicadSource: this.sides.kicad.source });
  }

  getStore(): MappingStore { return this.store; }

  // ---- build DOM ---------------------------------------------------------

  private build(): void {
    const shadow = this.shadowRoot!;
    const style = document.createElement("style");
    style.textContent = STYLESHEET;
    shadow.appendChild(style);

    const wrap = h("div", "wrap");
    const toolbar = h("div", "toolbar");
    toolbar.append(
      h("span", "title", "LTspice ↔ KiCad mapper"),
      this.fileButton("Load .asc", ".asc", (f) => this.loadFile("ltspice", f)),
      this.fileButton("Load .kicad_sch", ".kicad_sch", (f) => this.loadFile("kicad", f)),
      this.fileButton("Import mapping", ".json", (f) => void f.text().then((t) => this.loadMapping(t))),
      this.button("Export mapping", () => this.exportDownload()),
      this.button("Unmap", () => this.unmapActive()),
      this.button("Clear", () => this.clearSelection()),
    );
    this.countsEl = h("span", "counts");
    this.statusEl = h("span", "status");
    toolbar.append(this.countsEl, this.statusEl);
    wrap.appendChild(toolbar);

    const panes = h("div", "panes");
    this.sides = {
      ltspice: this.buildPane("ltspice", "LTspice", "ltspice-schematic"),
      kicad: this.buildPane("kicad", "KiCad", "kicad-schematic"),
    };
    panes.append(this.sides.ltspice.viewer.closest(".pane")!, this.sides.kicad.viewer.closest(".pane")!);
    wrap.appendChild(panes);
    shadow.appendChild(wrap);

    const theme = this.getAttribute("theme") ?? "dark";
    for (const side of ["ltspice", "kicad"] as Side[]) this.sides[side].viewer.setAttribute("theme", theme);
    this.updateCounts();
  }

  private buildPane(side: Side, label: string, tag: string): SideState {
    const pane = h("section", "pane");
    pane.dataset.side = side;
    const header = h("header", "");
    const title = h("span", "pane-title", label);
    const fname = h("small", "fname", "—");
    header.append(title, fname);

    const viewer = document.createElement(tag) as ViewerElement;
    viewer.classList.add("viewer");

    const lists = h("div", "lists");
    const tabs = h("div", "tabs");
    const netTab = this.button("Nets", () => this.setTab(side, "net"));
    const compTab = this.button("Components", () => this.setTab(side, "component"));
    netTab.classList.add("tab", "active");
    compTab.classList.add("tab");
    tabs.append(netTab, compTab);
    const filter = document.createElement("input");
    filter.placeholder = "Filter…";
    filter.className = "filter";
    const listEl = h("div", "list") as HTMLDivElement;
    lists.append(tabs, filter, listEl);

    pane.append(header, viewer, lists);

    const st: SideState = { viewer, listEl, filterEl: filter, tab: "net", source: "", nets: [], comps: [] };
    filter.oninput = () => this.renderList(side);

    viewer.addEventListener("ready", () => {
      st.nets = viewer.getNets();
      st.comps = viewer.getComponents();
      fname.textContent = st.source || `${st.nets.length} nets · ${st.comps.length} parts`;
      this.renderList(side);
      this.updateCounts();
    });
    viewer.addEventListener("netselect", (e) => {
      const d = (e as CustomEvent).detail as { name: string } | null;
      if (d) this.handleSelect(side, "net", d.name);
    });
    viewer.addEventListener("componentselect", (e) => {
      const d = (e as CustomEvent).detail as { ref: string } | null;
      if (d) this.handleSelect(side, "component", d.ref);
    });
    // store the SideState on the element for closest() reattach
    (pane as HTMLElement & { _state?: SideState })._state = st;
    return st;
  }

  // ---- selection / pairing ----------------------------------------------

  private handleSelect(side: Side, kind: Kind, id: string): void {
    const before = this.store.counts();
    const result = this.pairing.select(side, kind, id);
    this.refreshHighlights();
    this.renderLists();
    this.updateCounts();
    if (result.type === "created") {
      this.setStatus(`Mapped ${kind}: LTspice ${result.ltspice} ↔ KiCad ${result.kicad}`);
      this.emitChange();
    } else if (result.type === "mapped") {
      this.setStatus(`${kind} mapped: LTspice ${result.ltspice} ↔ KiCad ${result.kicad}`);
    } else if (result.type === "pending") {
      const n = result.suggestions.length;
      this.setStatus(`Selected ${kind} "${id}" on ${side} — click its match on the other side${n ? ` (suggested: ${result.suggestions.join(", ")})` : ""}`);
    }
    void before;
  }

  private unmapActive(): void {
    const removed = this.pairing.unmapActive();
    if (!removed) { this.setStatus("Nothing mapped to unmap (select a mapped item first)"); return; }
    this.refreshHighlights();
    this.renderLists();
    this.updateCounts();
    this.emitChange();
    this.setStatus(`Unmapped ${removed.kind}: ${removed.ltspice} ↔ ${removed.kicad}`);
  }

  private clearSelection(): void {
    this.pairing.clear();
    this.clearHighlights();
    this.renderLists();
    this.setStatus("");
  }

  private clearHighlights(): void {
    this.sides.ltspice.viewer.clearHighlights();
    this.sides.kicad.viewer.clearHighlights();
  }

  /** Paint highlights from the current pairing state. */
  private refreshHighlights(): void {
    this.clearHighlights();
    const { active, pending } = this.pairing;

    if (active && this.store.isMapped(active.kind, active.side, active.id)) {
      const counterpart = this.store.counterpart(active.kind, active.side, active.id)!;
      const ltId = active.side === "ltspice" ? active.id : counterpart;
      const kiId = active.side === "kicad" ? active.id : counterpart;
      this.paint("ltspice", active.kind, ltId, COLORS.mapped);
      this.paint("kicad", active.kind, kiId, COLORS.mapped);
      return;
    }
    if (pending) {
      this.paint(pending.side, pending.kind, pending.id, COLORS.pending);
      const otherSide: Side = pending.side === "ltspice" ? "kicad" : "ltspice";
      const sugg = this.store.suggest(pending.kind, pending.side, pending.id, this.available());
      if (sugg[0]) this.paint(otherSide, pending.kind, sugg[0], COLORS.suggestion);
    }
  }

  private paint(side: Side, kind: Kind, id: string, color: string): void {
    const v = this.sides[side].viewer;
    v.style.setProperty("--ksv-highlight", color);
    v.style.setProperty("--ksv-select", color);
    if (kind === "net") v.highlightNet(id);
    else v.highlightComponent(id);
  }

  // ---- lists -------------------------------------------------------------

  private setTab(side: Side, tab: Kind): void {
    this.sides[side].tab = tab;
    const pane = this.sides[side].viewer.closest(".pane")!;
    const tabs = pane.querySelectorAll(".tab");
    tabs[0]!.classList.toggle("active", tab === "net");
    tabs[1]!.classList.toggle("active", tab === "component");
    this.renderList(side);
  }

  private renderLists(): void {
    this.renderList("ltspice");
    this.renderList("kicad");
  }

  private renderList(side: Side): void {
    const st = this.sides[side];
    const kind = st.tab;
    const term = st.filterEl.value.trim().toLowerCase();
    const active = this.pairing.active;
    st.listEl.replaceChildren();

    const rows = kind === "net"
      ? st.nets.map((n) => ({ id: n.name, meta: n.isPower ? "power" : "", power: n.isPower }))
      : st.comps.map((c) => ({ id: c.ref, meta: c.value, power: false }));

    for (const r of rows.filter((r) => r.id.toLowerCase().includes(term) || r.meta.toLowerCase().includes(term))
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))) {
      const mappedTo = this.store.counterpart(kind, side, r.id);
      const row = h("div", "row");
      if (mappedTo) row.classList.add("mapped");
      if (active && active.side === side && active.kind === kind && active.id === r.id) row.classList.add("sel");
      const name = h("span", "name" + (r.power ? " pow" : ""), r.id);
      const meta = h("span", "meta", mappedTo ? `→ ${mappedTo}` : r.meta);
      if (mappedTo) meta.classList.add("ok");
      row.append(name, meta);
      row.onclick = () => this.handleSelect(side, kind, r.id);
      st.listEl.appendChild(row);
    }
    st.listEl.querySelector(".row.sel")?.scrollIntoView({ block: "nearest" });
  }

  // ---- helpers -----------------------------------------------------------

  private available(): AvailableIds {
    const ids = (st: SideState) => ({ nets: new Set(st.nets.map((n) => n.name)), components: new Set(st.comps.map((c) => c.ref)) });
    return { ltspice: ids(this.sides.ltspice), kicad: ids(this.sides.kicad) };
  }

  private updateCounts(): void {
    const c = this.store.counts();
    this.countsEl.textContent = `nets ${c.nets} · components ${c.components} mapped`;
  }

  private setStatus(msg: string): void {
    this.statusEl.textContent = msg;
  }

  private emitChange(): void {
    this.dispatchEvent(new CustomEvent("mappingchange", { detail: this.store.counts(), bubbles: true, composed: true }));
  }

  private async loadFile(side: Side, file: File): Promise<void> {
    const st = this.sides[side];
    st.source = file.name;
    if (side === "ltspice") st.viewer.loadFromString(await file.arrayBuffer());
    else st.viewer.loadFromString(await file.text());
  }

  private exportDownload(): void {
    const text = serialize(this.exportMapping());
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ltspice-kicad-mapping.json";
    a.click();
    URL.revokeObjectURL(url);
    this.setStatus("Exported mapping JSON");
  }

  private button(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = onClick;
    return b;
  }

  private fileButton(label: string, accept: string, onFile: (f: File) => void): HTMLButtonElement {
    const b = this.button(label, () => input.click());
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    input.onchange = () => { const f = input.files?.[0]; if (f) onFile(f); input.value = ""; };
    b.appendChild(input);
    return b;
  }
}

function basename(url: string): string {
  return url.split(/[\\/]/).pop() ?? url;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function defineLtspiceKicadMapper(tag = "ltspice-kicad-mapper"): void {
  if (!customElements.get(tag)) customElements.define(tag, LtspiceKicadMapperElement);
}
