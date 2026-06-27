/**
 * <ltspice-schematic> — framework-agnostic custom element.
 *
 *   <ltspice-schematic src="amp.asc" theme="dark"></ltspice-schematic>
 *
 * Attributes: src, theme ("light"|"dark"), interactive ("false" to disable).
 * Methods:    loadFromUrl, loadFromString, registerSymbol, highlightNet,
 *             highlightComponent, clearHighlights, fit, zoomToNet,
 *             getNets, getComponents.
 * Events:     ready, nethover, netselect, componenthover, componentselect.
 */

import { parseAsc, decodeAsc, type AscSchematic } from "../parser/asc.js";
import { buildModel, type Model } from "../netlist/connectivity.js";
import { SymbolLibrary } from "../symbols/builtin.js";
import { renderModel } from "../render/svg.js";
import { ViewerController } from "../interaction/controller.js";
import { STYLESHEET } from "../render/theme.js";

export interface NetInfo {
  name: string;
  isPower: boolean;
  pins: { ref: string; number: string }[];
}

export interface ComponentInfo {
  ref: string;
  value: string;
  symbol: string;
  nets: string[];
  pos: { x: number; y: number };
}

export class LtspiceSchematicElement extends HTMLElement {
  static get observedAttributes(): string[] {
    return ["src", "theme", "interactive"];
  }

  private rootEl: HTMLDivElement;
  private lib = new SymbolLibrary();
  private schematic: AscSchematic | null = null;
  private model: Model | null = null;
  private controller: ViewerController | null = null;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLESHEET;
    shadow.appendChild(style);
    this.rootEl = document.createElement("div");
    this.rootEl.className = "ksv-root";
    shadow.appendChild(this.rootEl);
  }

  connectedCallback(): void {
    const src = this.getAttribute("src");
    if (src && !this.schematic) void this.loadFromUrl(src);
  }

  attributeChangedCallback(name: string, oldV: string | null, newV: string | null): void {
    if (oldV === newV) return;
    if (name === "src" && newV) void this.loadFromUrl(newV);
  }

  /** Register a custom symbol from raw `.asy` text (call before loading). */
  registerSymbol(name: string, asyText: string): void {
    this.lib.register(name, asyText);
  }

  async loadFromUrl(url: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    this.loadFromString(decodeAsc(await res.arrayBuffer()));
  }

  /** Load from already-decoded `.asc` text, or raw bytes (auto-decoded). */
  loadFromString(text: string | ArrayBuffer | Uint8Array): void {
    const decoded = typeof text === "string" ? text : decodeAsc(text);
    this.schematic = parseAsc(decoded);
    this.model = buildModel(this.schematic, this.lib);
    this.render();
    this.dispatchEvent(new CustomEvent("ready", { detail: { nets: this.getNets().length, components: this.getComponents().length } }));
  }

  private render(): void {
    if (!this.schematic || !this.model) return;
    this.rootEl.replaceChildren();
    const { svg, bbox } = renderModel(this.schematic, this.model);
    this.rootEl.appendChild(svg);
    const interactive = this.getAttribute("interactive") !== "false";
    this.controller = new ViewerController(this.rootEl, svg, bbox, this.model.netlist, {
      onNetHover: (name) => this.emit("nethover", name && this.netDetail(name)),
      onNetSelect: (name) => this.emit("netselect", name && this.netDetail(name)),
      onComponentHover: (ref) => this.emit("componenthover", ref && this.componentDetail(ref)),
      onComponentSelect: (ref) => this.emit("componentselect", ref && this.componentDetail(ref)),
    }, interactive);
  }

  private emit(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  highlightNet(name: string): void { this.controller?.highlightNet(name); }
  highlightComponent(ref: string): void { this.controller?.highlightComponent(ref); }
  clearHighlights(): void { this.controller?.clearHighlights(); }
  markNets(names: string[]): void { this.controller?.markNets(names); }
  markComponents(refs: string[]): void { this.controller?.markComponents(refs); }
  clearMarks(): void { this.controller?.clearMarks(); }
  fit(): void { this.controller?.fit(); }
  zoomToNet(name: string): void { this.controller?.zoomToNet(name); }

  getNets(): NetInfo[] {
    if (!this.model) return [];
    return this.model.netlist.nets
      .filter((n) => n.pins.length > 0)
      .map((n) => ({ name: n.name, isPower: n.isPower, pins: n.pins.map((p) => ({ ref: p.ref, number: p.number })) }));
  }

  getComponents(): ComponentInfo[] {
    if (!this.model) return [];
    const nl = this.model.netlist;
    return this.model.placed
      .filter((p) => !p.ref.startsWith("?"))
      .map((p) => ({
        ref: p.ref,
        value: p.value,
        symbol: p.name,
        nets: [...(nl.componentToNets.get(p.ref) ?? [])].map((id) => nl.nets[id]!.name),
        pos: { x: p.x, y: p.y },
      }));
  }

  private netDetail(name: string): NetInfo | null {
    return this.getNets().find((n) => n.name === name) ?? { name, isPower: false, pins: [] };
  }
  private componentDetail(ref: string): ComponentInfo | null {
    return this.getComponents().find((c) => c.ref === ref) ?? null;
  }
}

export function defineLtspiceSchematic(tag = "ltspice-schematic"): void {
  if (!customElements.get(tag)) customElements.define(tag, LtspiceSchematicElement);
}
