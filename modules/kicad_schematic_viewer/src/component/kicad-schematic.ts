/**
 * <kicad-schematic> — framework-agnostic custom element.
 *
 *   <kicad-schematic src="poweramp.kicad_sch" theme="dark"></kicad-schematic>
 *
 * Attributes: src, theme ("light"|"dark"), interactive ("false" to disable).
 * Methods:    loadFromString, loadFromUrl, highlightNet, highlightComponent,
 *             clearHighlights, fit, zoomToNet, getNets, getComponents.
 * Events:     ready, nethover, netselect, componenthover, componentselect.
 */

import { parseSchematic, type Schematic } from "../parser/schematic.js";
import { buildNetlist, type Netlist } from "../netlist/connectivity.js";
import { renderSchematic } from "../render/svg.js";
import { ViewerController } from "../interaction/controller.js";
import { STYLESHEET } from "../render/theme.js";

export interface NetInfo {
  name: string;
  isPower: boolean;
  pins: { ref: string; number: string; name: string }[];
}

export interface ComponentInfo {
  ref: string;
  value: string;
  libId: string;
  nets: string[];
  pos: { x: number; y: number };
}

export class KicadSchematicElement extends HTMLElement {
  static get observedAttributes(): string[] {
    return ["src", "theme", "interactive"];
  }

  private rootEl: HTMLDivElement;
  private schematic: Schematic | null = null;
  private netlist: Netlist | null = null;
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

  // ---- loading -----------------------------------------------------------

  async loadFromUrl(url: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    this.loadFromString(await res.text());
  }

  loadFromString(text: string): void {
    this.schematic = parseSchematic(text);
    this.netlist = buildNetlist(this.schematic);
    this.render();
    this.dispatchEvent(new CustomEvent("ready", { detail: { nets: this.getNets().length, components: this.getComponents().length } }));
  }

  private render(): void {
    if (!this.schematic || !this.netlist) return;
    this.rootEl.replaceChildren();
    const { svg, bbox } = renderSchematic(this.schematic, this.netlist);
    this.rootEl.appendChild(svg);
    const interactive = this.getAttribute("interactive") !== "false";
    this.controller = new ViewerController(this.rootEl, svg, bbox, this.netlist, {
      onNetHover: (name) => this.emit("nethover", name && this.netDetail(name)),
      onNetSelect: (name) => this.emit("netselect", name && this.netDetail(name)),
      onComponentHover: (ref) => this.emit("componenthover", ref && this.componentDetail(ref)),
      onComponentSelect: (ref) => this.emit("componentselect", ref && this.componentDetail(ref)),
    }, interactive);
  }

  private emit(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  // ---- public API --------------------------------------------------------

  highlightNet(name: string): void {
    this.controller?.highlightNet(name);
  }
  highlightComponent(ref: string): void {
    this.controller?.highlightComponent(ref);
  }
  clearHighlights(): void {
    this.controller?.clearHighlights();
  }
  markNets(names: string[]): void {
    this.controller?.markNets(names);
  }
  markComponents(refs: string[]): void {
    this.controller?.markComponents(refs);
  }
  clearMarks(): void {
    this.controller?.clearMarks();
  }
  fit(): void {
    this.controller?.fit();
  }
  zoomToNet(name: string): void {
    this.controller?.zoomToNet(name);
  }
  zoomToComponents(refs: string[]): void {
    this.controller?.zoomToComponents(refs);
  }

  getNets(): NetInfo[] {
    if (!this.netlist) return [];
    return this.netlist.nets
      .filter((n) => n.pins.length > 0)
      .map((n) => ({
        name: n.name,
        isPower: n.isPower,
        pins: n.pins.map((p) => ({ ref: p.ref, number: p.number, name: p.name })),
      }));
  }

  getComponents(): ComponentInfo[] {
    if (!this.schematic || !this.netlist) return [];
    const nl = this.netlist;
    return this.schematic.instances
      .filter((i) => i.ref && !i.ref.startsWith("#"))
      .map((i) => ({
        ref: i.ref,
        value: i.value,
        libId: i.libId,
        nets: [...(nl.componentToNets.get(i.ref) ?? [])].map((id) => nl.nets[id]!.name),
        pos: { x: i.placement.x, y: i.placement.y },
      }));
  }

  private netDetail(name: string): NetInfo | null {
    return this.getNets().find((n) => n.name === name) ?? { name, isPower: false, pins: [] };
  }
  private componentDetail(ref: string): ComponentInfo | null {
    return this.getComponents().find((c) => c.ref === ref) ?? null;
  }
}

export function defineKicadSchematic(tag = "kicad-schematic"): void {
  if (!customElements.get(tag)) customElements.define(tag, KicadSchematicElement);
}
