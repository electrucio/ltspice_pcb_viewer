/**
 * <ltspice-kicad-mapper> — shows an LTspice schematic and a KiCad schematic side by
 * side and lets the user build a 1:1 net/component correspondence between them.
 *
 * Mapping is deliberate: clicking only *selects* (one selection per side). The user
 * presses **M** (or the Map button) to commit the currently selected pair — so stray
 * clicks never create mappings. After a map, two inferences run:
 *   - if a mapped component has exactly one unmapped net on each side, map those nets;
 *   - if all of a component's nets are mapped and exactly one component on the other
 *     side has the matching net set, map the components.
 * When nothing is selected, all mapped nets/components are faintly marked on both sides.
 *
 * It embeds the two sibling viewer modules (registered by the imports below) and
 * recolors their highlights via the `--ksv-highlight`/`--ksv-select` CSS variables.
 */

import "../../../ltspice_schematic_viewer/src/index.js";
import "../../../kicad_schematic_viewer/src/index.js";

import { MappingStore, serialize, type AvailableIds } from "../mapping/store.js";
import type { Kind, Side, MappingFile } from "../mapping/format.js";
import { Pairing } from "../interaction/pairing.js";
import { STYLESHEET } from "./style.js";

interface CompInfo { ref: string; value: string; nets: string[] }
interface NetInfoLite { name: string; isPower: boolean }

/** Structural view of either viewer element (common subset the mapper uses). */
interface ViewerElement extends HTMLElement {
  getNets(): NetInfoLite[];
  getComponents(): CompInfo[];
  highlightNet(name: string): void;
  highlightComponent(ref: string): void;
  clearHighlights(): void;
  markNets(names: string[]): void;
  markComponents(refs: string[]): void;
  clearMarks(): void;
  zoomToNet(name: string): void;
  loadFromUrl(url: string): Promise<void>;
  loadFromString(text: string | ArrayBuffer | Uint8Array): void;
}

const COLORS = { pending: "#ff8c00", mapped: "#1a8f3c", suggestion: "#1f6feb" };

interface SideState {
  viewer: ViewerElement;
  listEl: HTMLDivElement;
  filterEl: HTMLInputElement;
  fnameEl: HTMLElement;
  tab: Kind;
  source: string;
  nets: NetInfoLite[];
  comps: CompInfo[];
}

export class LtspiceKicadMapperElement extends HTMLElement {
  static get observedAttributes(): string[] {
    return ["ltspice-src", "kicad-src", "theme"];
  }

  private store = new MappingStore();
  private pairing = new Pairing(this.store);
  private sides!: Record<Side, SideState>;
  private statusEl!: HTMLElement;
  private countsEl!: HTMLElement;
  private onKey = (e: KeyboardEvent) => this.handleKey(e);

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  connectedCallback(): void {
    this.build();
    window.addEventListener("keydown", this.onKey);
    const lt = this.getAttribute("ltspice-src");
    const ki = this.getAttribute("kicad-src");
    if (lt) void this.loadLtspiceUrl(lt);
    if (ki) void this.loadKicadUrl(ki);
  }

  disconnectedCallback(): void {
    window.removeEventListener("keydown", this.onKey);
  }

  attributeChangedCallback(name: string, oldV: string | null, newV: string | null): void {
    if (oldV === newV || !this.sides) return;
    if (name === "ltspice-src" && newV) void this.loadLtspiceUrl(newV);
    if (name === "kicad-src" && newV) void this.loadKicadUrl(newV);
    if (name === "theme") this.applyTheme(newV ?? "light");
  }

  // ---- public API --------------------------------------------------------

  registerLtspiceSymbol(name: string, asyText: string): void {
    (this.sides.ltspice.viewer as unknown as { registerSymbol(n: string, a: string): void }).registerSymbol(name, asyText);
  }
  loadLtspiceUrl(url: string): Promise<void> { this.sides.ltspice.source = basename(url); return this.sides.ltspice.viewer.loadFromUrl(url); }
  loadKicadUrl(url: string): Promise<void> { this.sides.kicad.source = basename(url); return this.sides.kicad.viewer.loadFromUrl(url); }

  loadMapping(file: string | object): { loaded: number; dropped: number } {
    const res = this.store.fromFile(file as string, this.available());
    this.pairing.clear();
    this.runInference();
    this.refresh();
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
      this.button("Map (M)", () => this.tryMap(), "primary"),
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

    this.applyTheme(this.getAttribute("theme") ?? "light");
    this.updateCounts();
    this.setStatus("Select an item on each side, then press M to map");
  }

  private applyTheme(theme: string): void {
    this.shadowRoot!.host.setAttribute("data-theme", theme);
    for (const side of ["ltspice", "kicad"] as Side[]) this.sides[side].viewer.setAttribute("theme", theme);
  }

  private buildPane(side: Side, label: string, tag: string): SideState {
    const pane = h("section", "pane");
    pane.dataset.side = side;
    const header = h("header", "");
    const fname = h("small", "fname", "—");
    header.append(h("span", "pane-title", label), fname);

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

    const st: SideState = { viewer, listEl, filterEl: filter, fnameEl: fname, tab: "net", source: "", nets: [], comps: [] };
    filter.oninput = () => this.renderList(side);

    viewer.addEventListener("ready", () => {
      st.nets = viewer.getNets();
      st.comps = viewer.getComponents();
      fname.textContent = st.source || `${st.nets.length} nets · ${st.comps.length} parts`;
      this.refresh();
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
    return st;
  }

  // ---- selection / mapping ----------------------------------------------

  private handleSelect(side: Side, kind: Kind, id: string): void {
    this.pairing.select(side, kind, id);
    this.refresh();
    this.setStatus(this.selectStatus());
  }

  private tryMap(): void {
    const m = this.pairing.confirm();
    if (!m) {
      const why = this.pairing.ltspice && this.pairing.kicad
        ? "those two can't be mapped (different kind, or one is already mapped — Unmap first)"
        : "select an unmapped item on each side (same kind) first";
      this.setStatus(`Can't map — ${why}`);
      return;
    }
    // keep the new pair selected for green feedback
    this.pairing.select("ltspice", m.kind, m.ltspice);
    this.pairing.select("kicad", m.kind, m.kicad);
    const inferred = this.runInference();
    this.updateCounts();
    this.emitChange();
    this.refresh();
    this.setStatus(`Mapped ${m.kind}: ${m.ltspice} ↔ ${m.kicad}${inferred ? ` (+${inferred} inferred)` : ""}`);
  }

  private unmapActive(): void {
    const removed = this.pairing.unmapActive();
    if (!removed) { this.setStatus("Select a mapped item first, then Unmap"); return; }
    this.updateCounts();
    this.emitChange();
    this.refresh();
    this.setStatus(`Unmapped ${removed.kind}: ${removed.ltspice} ↔ ${removed.kicad}`);
  }

  private clearSelection(): void {
    this.pairing.clear();
    this.refresh();
    this.setStatus("Selection cleared");
  }

  private handleKey(e: KeyboardEvent): void {
    const a = this.shadowRoot!.activeElement as HTMLElement | null;
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA")) return;
    if (e.key === "m" || e.key === "M") { e.preventDefault(); this.tryMap(); }
    else if (e.key === "Escape") { this.clearSelection(); }
    else if (e.key === "u" || e.key === "U") { this.unmapActive(); }
  }

  // ---- inference ---------------------------------------------------------

  private componentNets(side: Side, ref: string): string[] {
    return this.sides[side].comps.find((c) => c.ref === ref)?.nets ?? [];
  }

  /** Run net/component inference to a fixpoint; returns the number of mappings added. */
  private runInference(): number {
    let total = 0, changed = true;
    while (changed) {
      changed = false;

      // (a) a mapped component with exactly one unmapped net on each side -> map those nets
      for (const pair of this.store.entries("component")) {
        const ltFree = this.componentNets("ltspice", pair.ltspice).filter((n) => !this.store.isMapped("net", "ltspice", n));
        const kiFree = this.componentNets("kicad", pair.kicad).filter((n) => !this.store.isMapped("net", "kicad", n));
        if (ltFree.length === 1 && kiFree.length === 1) {
          this.store.map("net", ltFree[0]!, kiFree[0]!);
          total++; changed = true;
        }
      }

      // (b) a component whose nets are all mapped -> the unique other-side component with the matching net set
      for (const c of this.sides.ltspice.comps) {
        if (!c.nets.length || this.store.isMapped("component", "ltspice", c.ref)) continue;
        if (!c.nets.every((n) => this.store.isMapped("net", "ltspice", n))) continue;
        const target = new Set(c.nets.map((n) => this.store.counterpart("net", "ltspice", n)!));
        const candidates = this.sides.kicad.comps.filter(
          (k) => !this.store.isMapped("component", "kicad", k.ref) && k.nets.length === target.size && k.nets.every((n) => target.has(n)),
        );
        if (candidates.length === 1) {
          this.store.map("component", c.ref, candidates[0]!.ref);
          total++; changed = true;
        }
      }
    }
    return total;
  }

  // ---- highlighting ------------------------------------------------------

  private clearAll(): void {
    for (const side of ["ltspice", "kicad"] as Side[]) {
      this.sides[side].viewer.clearHighlights();
      this.sides[side].viewer.clearMarks();
    }
  }

  /** Repaint highlights/marks from the current selection + store, and refresh lists. */
  private refresh(): void {
    this.clearAll();
    const l = this.pairing.ltspice, k = this.pairing.kicad;

    if (!l && !k) {
      this.showMarks();
    } else {
      if (l) this.paintSelection("ltspice", l.kind, l.id);
      if (k) this.paintSelection("kicad", k.kind, k.id);
      if (l && !k && !this.store.isMapped(l.kind, "ltspice", l.id)) this.paintSuggestion("ltspice", l.kind, l.id);
      if (k && !l && !this.store.isMapped(k.kind, "kicad", k.id)) this.paintSuggestion("kicad", k.kind, k.id);
    }
    this.renderLists();
  }

  private showMarks(): void {
    for (const side of ["ltspice", "kicad"] as Side[]) {
      const nets = this.store.entries("net").map((p) => p[side]);
      const comps = this.store.entries("component").map((p) => p[side]);
      this.sides[side].viewer.markNets(nets);
      this.sides[side].viewer.markComponents(comps);
    }
  }

  private paintSelection(side: Side, kind: Kind, id: string): void {
    if (this.store.isMapped(kind, side, id)) {
      this.paint(side, kind, id, COLORS.mapped);
      const other: Side = side === "ltspice" ? "kicad" : "ltspice";
      this.paint(other, kind, this.store.counterpart(kind, side, id)!, COLORS.mapped);
    } else {
      this.paint(side, kind, id, COLORS.pending);
    }
  }

  private paintSuggestion(side: Side, kind: Kind, id: string): void {
    const other: Side = side === "ltspice" ? "kicad" : "ltspice";
    const sugg = this.store.suggest(kind, side, id, this.available());
    if (sugg[0]) this.paint(other, kind, sugg[0], COLORS.suggestion);
  }

  private paint(side: Side, kind: Kind, id: string, color: string): void {
    const v = this.sides[side].viewer;
    v.style.setProperty("--ksv-highlight", color);
    v.style.setProperty("--ksv-select", color);
    if (kind === "net") v.highlightNet(id);
    else v.highlightComponent(id);
  }

  private selectStatus(): string {
    const m = this.pairing.mappable();
    if (m) return `Ready — press M to map ${m.kind} "${m.ltspice}" ↔ "${m.kicad}"`;
    const l = this.pairing.ltspice, k = this.pairing.kicad;
    const sel = this.pairing.last ? this.pairing[this.pairing.last] : null;
    if (sel && this.pairing.last && this.store.isMapped(sel.kind, this.pairing.last, sel.id)) {
      const cp = this.store.counterpart(sel.kind, this.pairing.last, sel.id);
      return `${sel.kind} "${sel.id}" is mapped to "${cp}" — press U/Unmap to remove`;
    }
    if (l && k && l.kind !== k.kind) return "Both selected are different kinds — pick the same kind on each side";
    return "Select the matching item on the other side, then press M";
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
    const sel = this.pairing[side];
    st.listEl.replaceChildren();

    const rows = kind === "net"
      ? st.nets.map((n) => ({ id: n.name, meta: n.isPower ? "power" : "", power: n.isPower }))
      : st.comps.map((c) => ({ id: c.ref, meta: c.value, power: false }));

    for (const r of rows.filter((r) => r.id.toLowerCase().includes(term) || r.meta.toLowerCase().includes(term))
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))) {
      const mappedTo = this.store.counterpart(kind, side, r.id);
      const row = h("div", "row");
      if (mappedTo) row.classList.add("mapped");
      if (sel && sel.kind === kind && sel.id === r.id) row.classList.add("sel");
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
    const blob = new Blob([serialize(this.exportMapping())], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ltspice-kicad-mapping.json";
    a.click();
    URL.revokeObjectURL(url);
    this.setStatus("Exported mapping JSON");
  }

  private button(label: string, onClick: () => void, cls = ""): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.classList.add(cls);
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
