/**
 * <kicad-pcb> — framework-agnostic PCB viewer for a KiCad `.kicad_pcb`.
 *
 *   <kicad-pcb src="board.kicad_pcb"></kicad-pcb>
 *
 * Single combined view of all layers. API: loadFromUrl/loadFromString, getLayers,
 * setLayer(layer, visible), setMirror/toggleMirror, highlightNet, highlightComponent,
 * clearHighlights, fit, getNets, getComponents. Events: ready, netselect,
 * componentselect, nethover.
 */

import { parsePcb, type Pcb } from "../parser/pcb.js";
import { renderPcb } from "../render/svg.js";
import { PcbController } from "../interaction/controller.js";
import { STYLESHEET } from "../render/theme.js";

export interface PcbComponentInfo {
  ref: string;
  value: string;
  nets: string[];
}

export class KicadPcbElement extends HTMLElement {
  static get observedAttributes(): string[] {
    return ["src"];
  }

  private rootEl: HTMLDivElement;
  private pcb: Pcb | null = null;
  private controller: PcbController | null = null;
  private layerVisible = new Map<string, boolean>();

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLESHEET;
    shadow.appendChild(style);
    this.rootEl = document.createElement("div");
    this.rootEl.className = "pcb-root";
    shadow.appendChild(this.rootEl);
  }

  connectedCallback(): void {
    const src = this.getAttribute("src");
    if (src && !this.pcb) void this.loadFromUrl(src);
  }
  attributeChangedCallback(name: string, oldV: string | null, newV: string | null): void {
    if (oldV === newV) return;
    if (name === "src" && newV) void this.loadFromUrl(newV);
  }

  async loadFromUrl(url: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    this.loadFromString(await res.text());
  }

  loadFromString(text: string): void {
    this.pcb = parsePcb(text);
    this.render();
    this.dispatchEvent(new CustomEvent("ready", { detail: { nets: this.pcb.nets.length, components: this.getComponents().length } }));
  }

  private render(): void {
    if (!this.pcb) return;
    this.rootEl.replaceChildren();
    const { svg, content, bbox, layers } = renderPcb(this.pcb);
    this.rootEl.appendChild(svg);
    const interactive = this.getAttribute("interactive") !== "false";
    this.controller = new PcbController(this.rootEl, svg, content, bbox, {
      onNetSelect: (n) => this.emit("netselect", n && { name: n }),
      onComponentSelect: (r) => this.emit("componentselect", r && this.componentInfo(r)),
      onNetHover: (n) => this.emit("nethover", n && { name: n }),
    }, interactive);
    // re-apply any layer visibility the host set before load
    for (const id of layers) if (this.layerVisible.get(id) === false) this.controller.setLayerVisible(id, false);
  }

  private emit(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  // ---- public API --------------------------------------------------------

  getLayers(): string[] {
    if (!this.pcb) return [];
    return renderLayerOrder.filter((id) => this.pcb!.layers.includes(id) || id === "pads" || id === "vias" || id === "refs" || id === "Edge.Cuts");
  }
  setLayer(layer: string, visible: boolean): void {
    this.layerVisible.set(layer, visible);
    this.controller?.setLayerVisible(layer, visible);
  }
  setMirror(on: boolean): void { this.controller?.setMirror(on); }
  toggleMirror(): void { this.controller?.setMirror(!this.controller.isMirrored()); }
  fit(): void { this.controller?.fit(); }
  highlightNet(name: string): void { this.controller?.highlightNet(name); }
  highlightComponent(ref: string): void { this.controller?.highlightComponent(ref); }
  clearHighlights(): void { this.controller?.clearHighlights(); }

  getNets(): string[] {
    return this.pcb?.nets ?? [];
  }
  getComponents(): PcbComponentInfo[] {
    if (!this.pcb) return [];
    return this.pcb.footprints
      .filter((f) => f.ref && !f.ref.startsWith("#"))
      .map((f) => ({ ref: f.ref, value: f.value, nets: [...new Set(f.pads.map((p) => p.net).filter(Boolean))] }));
  }

  private componentInfo(ref: string): PcbComponentInfo | null {
    return this.getComponents().find((c) => c.ref === ref) ?? null;
  }
}

const renderLayerOrder = ["B.Cu", "F.Cu", "pads", "vias", "B.SilkS", "F.SilkS", "Edge.Cuts", "refs"];

export function defineKicadPcb(tag = "kicad-pcb"): void {
  if (!customElements.get(tag)) customElements.define(tag, KicadPcbElement);
}
