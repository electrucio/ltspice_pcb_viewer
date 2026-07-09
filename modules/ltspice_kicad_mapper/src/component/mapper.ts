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
import "../../../kicad_pcb_viewer/src/index.js";

import { MappingStore, serialize, type AvailableIds } from "../mapping/store.js";
import type { Kind, Side, MappingFile } from "../mapping/format.js";
import { Pairing } from "../interaction/pairing.js";
import { mutualComponentMatch, mutualNetMatch, chooseNextComponentPair, chooseNextNetPair, type SuggestInput } from "../suggest/chain.js";
import { reconcileKicadNets, reconcileKicadComponents, type KicadNetAlias, type KicadRefAlias } from "../mapping/kicad-nets.js";
import { createSimTooltip, type SimSummary, type SimTooltip } from "../sim/summary.js";
import { STYLESHEET } from "./style.js";

interface CompInfo { ref: string; value: string; nets: string[]; pos: { x: number; y: number }; uuid?: string }
interface NetInfoLite { name: string; isPower: boolean; pins: { ref: string }[] }

/** Structural view of either schematic viewer element (common subset the mapper uses). */
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
  zoomToComponents(refs: string[]): void;
  loadFromUrl(url: string): Promise<void>;
  loadFromString(text: string | ArrayBuffer | Uint8Array): void;
}

/** The KiCad PCB viewer element (a narrower surface than the schematic viewers). */
interface PcbViewerElement extends HTMLElement {
  getNets(): string[];
  getComponents(): { ref: string; value: string; nets: string[]; symbolUuid: string }[];
  highlightNet(name: string): void;
  highlightComponent(ref: string): void;
  clearHighlights(): void;
  fit(): void;
  rotate90(): number;
  getRotation(): number;
  toggleMirror(): void;
  loadFromString(text: string): void;
}

/** Raw sources of what is currently loaded, for baking into a static export. */
export interface MapperSources {
  /** base64 of the original `.asc` bytes (UTF-16; decoded by the viewer) */
  ltspice: string;
  /** `.kicad_sch` text */
  kicadSch: string;
  /** `.kicad_pcb` text (empty if none loaded) */
  kicadPcb: string;
  /** registered LTspice `.asy` symbols: name -> text */
  symbols: Record<string, string>;
  ltspiceSource: string;
  kicadSource: string;
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
  private autoSide: Side | null = null; // side whose selection was auto-filled from a suggestion
  private onKey = (e: KeyboardEvent) => this.handleKey(e);

  // KiCad side carries a second (PCB) view of the same project; highlights fan out to
  // both, translated through a schematic↔PCB net alias (refs are identical).
  private kicadPcb!: PcbViewerElement;
  private kicadView: "schematic" | "pcb" = "schematic";
  private kicadAlias: KicadNetAlias = { schToPcb: new Map(), pcbToSch: new Map() };
  // schematic-ref ↔ PCB-ref, matched by the stable schematic symbol UUID (so it survives
  // reference-designator differences between the schematic and the board, e.g. Q3 vs Q3*)
  private kicadCompAlias: KicadRefAlias = { schToPcb: new Map(), pcbToSch: new Map() };
  private pcbReady = false;
  private pcbFitted = false;
  private viewSegEl!: HTMLElement;
  private rotBtnEl: HTMLButtonElement | null = null;
  private mirBtnEl: HTMLButtonElement | null = null;

  // raw sources retained for static export
  private raw = { ltspice: "", kicadSch: "", kicadPcb: "" };
  private symbols: Record<string, string> = {};

  // simulation summary (hover-inspection); keyed on LTspice ids
  private simulation: SimSummary | null = null;
  private simTip: SimTooltip | null = null;
  private hoverXY = { x: 0, y: 0 };

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
    this.symbols[name] = asyText;
    (this.sides.ltspice.viewer as unknown as { registerSymbol(n: string, a: string): void }).registerSymbol(name, asyText);
  }

  // --- LTspice (raw kept as base64 bytes; the viewer auto-decodes UTF-16) ---
  loadLtspiceBytes(buf: ArrayBuffer, name = "schematic.asc"): void {
    this.raw.ltspice = bytesToBase64(buf);
    this.sides.ltspice.source = name;
    this.sides.ltspice.viewer.loadFromString(buf);
  }
  async loadLtspiceUrl(url: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    this.loadLtspiceBytes(await res.arrayBuffer(), basename(url));
  }

  // --- KiCad schematic (text) ---
  loadKicadString(text: string, name = "schematic.kicad_sch"): void {
    this.raw.kicadSch = text;
    this.sides.kicad.source = name;
    this.sides.kicad.viewer.loadFromString(text);
  }
  async loadKicadUrl(url: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    this.loadKicadString(await res.text(), basename(url));
  }

  // --- KiCad PCB (text) — shares the KiCad net/ref namespace with the schematic ---
  loadKicadPcbString(text: string, _name = "board.kicad_pcb"): void {
    this.raw.kicadPcb = text;
    this.kicadPcb.loadFromString(text);
  }
  async loadKicadPcbUrl(url: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    this.loadKicadPcbString(await res.text(), basename(url));
  }

  /** Switch which KiCad view is visible (highlights are kept on both). */
  setKicadView(view: "schematic" | "pcb"): void {
    this.kicadView = view;
    this.sides.kicad.viewer.classList.toggle("hidden", view !== "schematic");
    (this.kicadPcb as HTMLElement).classList.toggle("hidden", view !== "pcb");
    if (this.viewSegEl) {
      const btns = this.viewSegEl.querySelectorAll("button");
      btns[0]!.classList.toggle("active", view === "schematic");
      btns[1]!.classList.toggle("active", view === "pcb");
    }
    if (this.rotBtnEl) this.rotBtnEl.style.display = view === "pcb" ? "" : "none";
    if (this.mirBtnEl) this.mirBtnEl.style.display = view === "pcb" ? "" : "none";
    if (view === "pcb" && this.pcbReady && !this.pcbFitted) { this.kicadPcb.fit(); this.pcbFitted = true; }
  }

  /** The embedded PCB viewer element — hosts compose analysis UIs around it. */
  get pcbElement(): PcbViewerElement | null {
    return this.kicadPcb ?? null;
  }

  /** Raw sources of everything currently loaded, for baking into a static export. */
  getSources(): MapperSources {
    return {
      ltspice: this.raw.ltspice,
      kicadSch: this.raw.kicadSch,
      kicadPcb: this.raw.kicadPcb,
      symbols: { ...this.symbols },
      ltspiceSource: this.sides.ltspice.source,
      kicadSource: this.sides.kicad.source,
    };
  }

  // --- LTspice context + simulation (for the .raw summary feature) ---
  getLtspiceNets(): { name: string; isPower: boolean }[] {
    return this.sides.ltspice.nets.map((n) => ({ name: n.name, isPower: n.isPower }));
  }
  getLtspiceComponents(): { ref: string; value: string; nets: string[] }[] {
    return this.sides.ltspice.comps.map((c) => ({ ref: c.ref, value: c.value, nets: c.nets }));
  }
  getLtspiceDirectives(): string[] {
    return (this.sides.ltspice.viewer as unknown as { getDirectives?(): string[] }).getDirectives?.() ?? [];
  }
  /** Attach (or clear) the simulation summary shown on hover. */
  setSimulation(sim: SimSummary | null): void {
    this.simulation = sim;
    if (!sim && this.simTip) this.simTip.hide();
  }
  getSimulation(): SimSummary | null { return this.simulation; }

  loadMapping(file: string | object): { loaded: number; dropped: number } {
    const res = this.store.fromFile(file as string, this.available());
    this.pairing.clear();
    this.autoSide = null;
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
      this.fileButton("Load .kicad_pcb", ".kicad_pcb", (f) => this.loadFile("pcb", f)),
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
    const leftPane = this.sides.ltspice.viewer.closest(".pane") as HTMLElement;
    const rightPane = this.sides.kicad.viewer.closest(".pane") as HTMLElement;
    const divider = h("div", "pane-divider");
    divider.title = "Drag to resize · double-click to reset";
    panes.append(leftPane, divider, rightPane);
    wrap.appendChild(panes);
    this.setupPaneDivider(panes, divider, leftPane, rightPane);
    shadow.appendChild(wrap);

    this.setupKicadPcb();

    // hover tooltip for simulation summaries (follows the cursor)
    this.simTip = createSimTooltip(shadow);
    wrap.addEventListener("mousemove", (e) => {
      this.hoverXY = { x: e.clientX, y: e.clientY };
      this.simTip?.move(e.clientX, e.clientY);
    });
    // touch has no hover: track the tap position so the tooltip (shown on tap) is placed there
    wrap.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      if (t) this.hoverXY = { x: t.clientX, y: t.clientY };
    }, { passive: true });

    this.applyTheme(this.getAttribute("theme") ?? "light");
    this.updateCounts();
    this.setStatus("Select an item on each side, then press M to map");
  }

  private applyTheme(theme: string): void {
    this.shadowRoot!.host.setAttribute("data-theme", theme);
    for (const side of ["ltspice", "kicad"] as Side[]) this.sides[side].viewer.setAttribute("theme", theme);
  }

  /** Draggable split between the two panes (same UX as the read-only export). */
  private setupPaneDivider(panes: HTMLElement, divider: HTMLElement, left: HTMLElement, right: HTMLElement): void {
    let dragging = false;
    const setSplit = (clientX: number): void => {
      const r = panes.getBoundingClientRect();
      const p = Math.max(12, Math.min(88, ((clientX - r.left) / r.width) * 100));
      left.style.flex = `${p} 1 0`;
      right.style.flex = `${100 - p} 1 0`;
    };
    const start = (e: Event): void => { e.preventDefault(); dragging = true; divider.classList.add("drag"); document.body.style.userSelect = "none"; };
    const end = (): void => { dragging = false; divider.classList.remove("drag"); document.body.style.userSelect = ""; };
    divider.addEventListener("mousedown", start);
    window.addEventListener("mousemove", (e) => { if (dragging) setSplit(e.clientX); });
    window.addEventListener("mouseup", end);
    divider.addEventListener("touchstart", start, { passive: false });
    divider.addEventListener("touchmove", (e) => { e.preventDefault(); if (e.touches[0]) setSplit(e.touches[0].clientX); }, { passive: false });
    divider.addEventListener("touchend", end);
    divider.addEventListener("dblclick", () => { left.style.flex = "1 1 0"; right.style.flex = "1 1 0"; });
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
    // collapse toggle: fold the whole list section, giving the viewer the height
    const fold = this.button("▾", () => {
      const collapsed = lists.classList.toggle("collapsed");
      fold.textContent = collapsed ? "▸" : "▾";
      fold.title = collapsed ? "Expand nets/components" : "Collapse nets/components";
    });
    fold.classList.add("fold");
    fold.title = "Collapse nets/components";
    tabs.append(netTab, compTab, fold);
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
      if (side === "kicad") this.buildKicadAlias();
      this.refresh();
      this.updateCounts();
    });
    viewer.addEventListener("netselect", (e) => {
      const d = (e as CustomEvent).detail as { name: string } | null;
      if (d) this.handleSelect(side, "net", d.name);
      else this.clearSelection(); // clicked empty space -> unselect both sides
    });
    viewer.addEventListener("componentselect", (e) => {
      const d = (e as CustomEvent).detail as { ref: string } | null;
      if (d) this.handleSelect(side, "component", d.ref);
      else this.clearSelection();
    });
    viewer.addEventListener("nethover", (e) => {
      this.handleHover(side, "net", ((e as CustomEvent).detail as { name: string } | null)?.name ?? null);
    });
    viewer.addEventListener("componenthover", (e) => {
      this.handleHover(side, "component", ((e as CustomEvent).detail as { ref: string } | null)?.ref ?? null);
    });
    return st;
  }

  /** Show the sim summary for a hovered item (resolved to its LTspice id), or hide. */
  private handleHover(side: Side, kind: Kind, id: string | null): void {
    const tip = this.simTip;
    if (!tip || !this.simulation) return;
    const ltId = id == null ? null : side === "ltspice" ? id : this.store.counterpart(kind, "kicad", id) ?? null;
    if (ltId == null) { tip.hide(); return; }
    if (kind === "net") {
      const s = this.simulation.nets[ltId];
      if (s) { tip.showNet(ltId, s); tip.move(this.hoverXY.x, this.hoverXY.y); return; }
    } else {
      const s = this.simulation.comps[ltId];
      if (s) { tip.showComp(ltId, s); tip.move(this.hoverXY.x, this.hoverXY.y); return; }
    }
    tip.hide();
  }

  /** Add the KiCad PCB viewer + a Schematic/PCB toggle to the KiCad pane. */
  private setupKicadPcb(): void {
    const schViewer = this.sides.kicad.viewer;
    const header = schViewer.closest(".pane")!.querySelector("header")!;

    const seg = h("div", "viewseg");
    const schBtn = this.button("Schematic", () => this.setKicadView("schematic"));
    const pcbBtn = this.button("PCB", () => this.setKicadView("pcb"));
    schBtn.classList.add("active");
    seg.append(schBtn, pcbBtn);
    this.viewSegEl = seg;
    header.insertBefore(seg, this.sides.kicad.fnameEl);

    // Rotate button (PCB only) — cycles 0/90/180/270
    const rotBtn = this.button("⟳ 0°", () => { const r = this.kicadPcb.rotate90(); rotBtn.textContent = `⟳ ${r}°`; });
    rotBtn.classList.add("hdrbtn");
    rotBtn.style.display = "none";
    this.rotBtnEl = rotBtn;
    header.insertBefore(rotBtn, this.sides.kicad.fnameEl);

    // Mirror button (PCB only) — flips the board horizontally
    let mirrored = false;
    const mirBtn = this.button("⇄ Mirror", () => {
      this.kicadPcb.toggleMirror();
      mirrored = !mirrored;
      mirBtn.classList.toggle("active", mirrored);
    });
    mirBtn.classList.add("hdrbtn");
    mirBtn.style.display = "none";
    this.mirBtnEl = mirBtn;
    header.insertBefore(mirBtn, this.sides.kicad.fnameEl);

    const pcb = document.createElement("kicad-pcb") as PcbViewerElement;
    pcb.classList.add("viewer", "hidden");
    schViewer.after(pcb);
    this.kicadPcb = pcb;

    pcb.addEventListener("ready", () => {
      this.pcbReady = true;
      this.pcbFitted = false;
      this.buildKicadAlias();
      if (this.kicadView === "pcb") { pcb.fit(); this.pcbFitted = true; }
      this.refresh();
    });
    pcb.addEventListener("netselect", (e) => {
      const d = (e as CustomEvent).detail as { name: string } | null;
      if (d) this.handleSelect("kicad", "net", this.kicadAlias.pcbToSch.get(d.name) ?? d.name);
      else this.clearSelection();
    });
    pcb.addEventListener("componentselect", (e) => {
      const d = (e as CustomEvent).detail as { ref: string } | null;
      if (d) this.handleSelect("kicad", "component", this.kicadCompAlias.pcbToSch.get(d.ref) ?? d.ref);
      else this.clearSelection();
    });
    pcb.addEventListener("nethover", (e) => {
      const name = ((e as CustomEvent).detail as { name: string } | null)?.name ?? null;
      this.handleHover("kicad", "net", name == null ? null : this.kicadAlias.pcbToSch.get(name) ?? name);
    });
  }

  /** (Re)build the schematic↔PCB component + net aliases once both KiCad views have data. */
  private buildKicadAlias(): void {
    if (!this.pcbReady || !this.sides.kicad.nets.length) return;
    const pcbComps = this.kicadPcb.getComponents();

    // (1) component alias by stable schematic symbol UUID (robust to ref renames)
    this.kicadCompAlias = reconcileKicadComponents(this.sides.kicad.comps, pcbComps);

    // (2) net alias — PCB net ref-sets translated into schematic-ref space (via the UUID
    //     component alias) so structural matching compares like-for-like regardless of
    //     reference-designator differences.
    const schNets = this.sides.kicad.nets.map((n) => ({ name: n.name, refs: netComponentRefs(n) }));
    const pcbNetRefs = new Map<string, string[]>();
    for (const c of pcbComps) {
      if (c.ref.startsWith("#")) continue;
      const ref = this.kicadCompAlias.pcbToSch.get(c.ref) ?? c.ref;
      for (const net of c.nets) {
        const arr = pcbNetRefs.get(net) ?? pcbNetRefs.set(net, []).get(net)!;
        arr.push(ref);
      }
    }
    this.kicadAlias = reconcileKicadNets(schNets, this.kicadPcb.getNets(), pcbNetRefs);
  }

  // ---- selection / mapping ----------------------------------------------

  private handleSelect(side: Side, kind: Kind, id: string): void {
    const other: Side = side === "ltspice" ? "kicad" : "ltspice";
    this.autoSide = null;
    if (this.store.isMapped(kind, side, id)) {
      // a mapped item is always a single focus (cross-probed on both sides)
      this.pairing.setSingle(side, kind, id);
    } else {
      // keep the other side only if we're actively building a pair with it
      const otherSel = this.pairing[other];
      const building = !!otherSel && otherSel.kind === kind && !this.store.isMapped(kind, other, otherSel.id);
      if (building) {
        this.pairing.select(side, kind, id);
      } else {
        this.pairing.setSingle(side, kind, id);
        // auto-select the best contextual counterpart (above threshold) so M maps it
        const match = this.suggestMatch(side, kind, id);
        if (match) { this.pairing.select(other, kind, match); this.autoSide = other; }
      }
    }
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
    const inferred = this.runInference();
    this.autoSide = null;
    // chain of suggestions: after a map, pre-select the next likely pair OF THE SAME KIND
    const next = this.chainSuggest(m.kind);
    if (next) {
      this.pairing.setSingle("ltspice", m.kind, next.lt);
      this.pairing.select("kicad", m.kind, next.ki);
      this.autoSide = "kicad";
      this.setTab("ltspice", m.kind);
      this.setTab("kicad", m.kind);
      // bring the anchor + suggestion into view so the suggested items are easy to find
      if (m.kind === "component") {
        this.sides.ltspice.viewer.zoomToComponents([m.ltspice, next.lt]);
        this.sides.kicad.viewer.zoomToComponents([m.kicad, next.ki]);
      } else {
        this.sides.ltspice.viewer.zoomToNet(next.lt);
        this.sides.kicad.viewer.zoomToNet(next.ki);
      }
    } else {
      // focus the new pair as a single mapped selection (cross-probed green on both)
      this.pairing.setSingle("ltspice", m.kind, m.ltspice);
    }
    this.updateCounts();
    this.emitChange();
    this.refresh();
    const base = `Mapped ${m.kind}: ${m.ltspice} ↔ ${m.kicad}${inferred ? ` (+${inferred} inferred)` : ""}`;
    this.setStatus(next ? `${base}. Next suggestion: ${next.lt} ↔ ${next.ki} — press M` : base);
  }

  private unmapActive(): void {
    const removed = this.pairing.unmapActive();
    if (!removed) { this.setStatus("Select a mapped item first, then Unmap"); return; }
    this.pairing.clear();
    this.autoSide = null;
    this.updateCounts();
    this.emitChange();
    this.refresh();
    this.setStatus(`Unmapped ${removed.kind}: ${removed.ltspice} ↔ ${removed.kicad}`);
  }

  private clearSelection(): void {
    this.pairing.clear();
    this.autoSide = null;
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

  /** Snapshot of both schematics + current mappings for the suggestion engine. */
  private suggestInput(): SuggestInput {
    const nets = (st: SideState) => st.nets.map((n) => ({ name: n.name, comps: netComponentRefs(n) }));
    return {
      ltComps: this.sides.ltspice.comps,
      kiComps: this.sides.kicad.comps,
      ltNets: nets(this.sides.ltspice),
      kiNets: nets(this.sides.kicad),
      compCounterpartLt: (r) => this.store.counterpart("component", "ltspice", r),
      netCounterpartLt: (n) => this.store.counterpart("net", "ltspice", n),
      netCounterpartKi: (n) => this.store.counterpart("net", "kicad", n),
      compMappedLt: (r) => this.store.isMapped("component", "ltspice", r),
      compMappedKi: (r) => this.store.isMapped("component", "kicad", r),
      netMappedLt: (n) => this.store.isMapped("net", "ltspice", n),
      netMappedKi: (n) => this.store.isMapped("net", "kicad", n),
    };
  }

  /** Best contextual counterpart for a clicked unmapped item (above threshold), or null. */
  private suggestMatch(side: Side, kind: Kind, id: string): string | null {
    const s = side === "ltspice" ? "lt" : "ki";
    if (kind === "component") return mutualComponentMatch(this.suggestInput(), s, id)?.ref ?? null;
    return mutualNetMatch(this.suggestInput(), s, id)?.name ?? null;
  }

  /** Best next pair (same kind) to autosuggest in the chain, near the mapped region. */
  private chainSuggest(kind: Kind): { lt: string; ki: string } | null {
    const input = this.suggestInput();
    if (kind === "component") {
      const r = chooseNextComponentPair(input);
      return r ? { lt: r.ltRef, ki: r.kiRef } : null;
    }
    const r = chooseNextNetPair(input);
    return r ? { lt: r.ltNet, ki: r.kiNet } : null;
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

      // (c) a net whose connected components are all mapped -> the unique other-side net with the matching component set
      for (const net of this.sides.ltspice.nets) {
        if (this.store.isMapped("net", "ltspice", net.name)) continue;
        const comps = netComponentRefs(net);
        if (comps.length === 0 || !comps.every((r) => this.store.isMapped("component", "ltspice", r))) continue;
        const target = new Set(comps.map((r) => this.store.counterpart("component", "ltspice", r)!));
        const candidates = this.sides.kicad.nets.filter((kn) => {
          if (this.store.isMapped("net", "kicad", kn.name)) return false;
          const kr = netComponentRefs(kn);
          return kr.length === target.size && kr.every((r) => target.has(r));
        });
        if (candidates.length === 1) {
          this.store.map("net", net.name, candidates[0]!.name);
          total++; changed = true;
        }
      }
    }
    return total;
  }

  // ---- highlighting ------------------------------------------------------

  /** Faintly mark every mapped net/part on both sides — shown only when idle. */
  private applyMarks(): void {
    for (const side of ["ltspice", "kicad"] as Side[]) {
      const v = this.sides[side].viewer;
      v.markNets(this.store.entries("net").map((p) => p[side]));
      v.markComponents(this.store.entries("component").map((p) => p[side]));
    }
  }

  /**
   * Repaint highlights. While something is selected, show ONLY the active pair (clicked
   * item + its counterpart); when nothing is selected, faintly mark all mapped items.
   */
  private refresh(): void {
    for (const side of ["ltspice", "kicad"] as Side[]) {
      this.sides[side].viewer.clearHighlights();
      this.sides[side].viewer.clearMarks();
    }
    if (this.kicadPcb) this.kicadPcb.clearHighlights();
    const active = !!(this.pairing.ltspice || this.pairing.kicad);
    if (!active) {
      this.applyMarks();
      this.renderLists();
      return;
    }
    for (const side of ["ltspice", "kicad"] as Side[]) {
      const sel = this.pairing[side];
      if (!sel) continue;
      if (this.store.isMapped(sel.kind, side, sel.id)) {
        const other: Side = side === "ltspice" ? "kicad" : "ltspice";
        this.paint(side, sel.kind, sel.id, COLORS.mapped);
        this.paint(other, sel.kind, this.store.counterpart(sel.kind, side, sel.id)!, COLORS.mapped);
      } else {
        this.paint(side, sel.kind, sel.id, side === this.autoSide ? COLORS.suggestion : COLORS.pending);
      }
    }
    this.renderLists();
  }

  private paint(side: Side, kind: Kind, id: string, color: string): void {
    const v = this.sides[side].viewer;
    v.style.setProperty("--ksv-highlight", color);
    v.style.setProperty("--ksv-select", color);
    if (kind === "net") v.highlightNet(id);
    else v.highlightComponent(id);
    // fan KiCad highlights out to the PCB view too (net names translated via the alias)
    if (side === "kicad" && this.kicadPcb) {
      const pv = this.kicadPcb as HTMLElement;
      pv.style.setProperty("--ksv-highlight", color);
      pv.style.setProperty("--ksv-select", color);
      if (kind === "net") this.kicadPcb.highlightNet(this.kicadAlias.schToPcb.get(id) ?? id);
      else this.kicadPcb.highlightComponent(this.kicadCompAlias.schToPcb.get(id) ?? id);
    }
  }

  private selectStatus(): string {
    const m = this.pairing.mappable();
    if (m) return `Ready — press M to map ${m.kind} "${m.ltspice}" ↔ "${m.kicad}"${this.autoSide ? " (suggested — press M, or pick another)" : ""}`;
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
      ? st.nets.map((n) => ({ id: n.name, value: "", power: n.isPower }))
      : st.comps.map((c) => ({ id: c.ref, value: c.value, power: false }));

    for (const r of rows.filter((r) => r.id.toLowerCase().includes(term) || r.value.toLowerCase().includes(term))
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))) {
      const mappedTo = this.store.counterpart(kind, side, r.id);
      const row = h("div", "row");
      if (mappedTo) row.classList.add("mapped");
      if (sel && sel.kind === kind && sel.id === r.id) row.classList.add("sel");
      const name = h("span", "name" + (r.power ? " pow" : ""), r.id);
      row.append(name);
      // components keep their value visible in its own column (even when mapped)
      if (kind === "component") row.append(h("span", "val", r.value));
      const meta = h("span", "meta", mappedTo ? `→ ${mappedTo}` : (r.power ? "power" : ""));
      if (mappedTo) meta.classList.add("ok");
      row.append(meta);
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

  private async loadFile(side: Side | "pcb", file: File): Promise<void> {
    if (side === "ltspice") this.loadLtspiceBytes(await file.arrayBuffer(), file.name);
    else if (side === "kicad") this.loadKicadString(await file.text(), file.name);
    else { this.loadKicadPcbString(await file.text(), file.name); this.setKicadView("pcb"); }
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

/** Base64-encode raw bytes (chunked to avoid call-stack limits on large buffers). */
function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Unique real-component refs on a net (excludes power-symbol pins like #GND01). */
function netComponentRefs(net: { pins: { ref: string }[] }): string[] {
  return [...new Set(net.pins.map((p) => p.ref).filter((r) => r && !r.startsWith("#")))];
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
