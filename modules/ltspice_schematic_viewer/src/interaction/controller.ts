/**
 * Interaction layer: pan/zoom via the SVG viewBox, DOM hit-testing, and net /
 * component highlighting by toggling CSS classes. Emits semantic callbacks the
 * web component re-dispatches as DOM CustomEvents.
 */

import type { Netlist } from "../netlist/connectivity.js";
import type { BBox } from "../render/svg.js";

export interface ViewerEvents {
  onNetHover?: (name: string | null) => void;
  onNetSelect?: (name: string | null) => void;
  onComponentHover?: (ref: string | null) => void;
  onComponentSelect?: (ref: string | null) => void;
}

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PAD = 0.06; // 6% fit padding

export class ViewerController {
  private vb: ViewBox = { x: 0, y: 0, w: 100, h: 100 };
  private dragging = false;
  private moved = false;
  private last = { x: 0, y: 0 };
  private hoverNet: string | null = null;
  private downHit: { net?: string; ref?: string } = {};

  constructor(
    private readonly root: HTMLElement,
    private readonly svg: SVGSVGElement,
    private readonly bbox: BBox,
    private readonly netlist: Netlist,
    private readonly events: ViewerEvents = {},
    interactive = true,
  ) {
    this.fit();
    if (interactive) this.attach();
  }

  // ---- viewport ----------------------------------------------------------

  private applyViewBox(): void {
    this.svg.setAttribute("viewBox", `${this.vb.x} ${this.vb.y} ${this.vb.w} ${this.vb.h}`);
  }

  fit(target?: BBox): void {
    const b = target ?? this.bbox;
    const w = Math.max(b.maxX - b.minX, 1);
    const h = Math.max(b.maxY - b.minY, 1);
    const px = w * PAD;
    const py = h * PAD;
    this.vb = { x: b.minX - px, y: b.minY - py, w: w + 2 * px, h: h + 2 * py };
    this.applyViewBox();
  }

  private clientToUser(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.svg.getBoundingClientRect();
    return {
      x: this.vb.x + ((clientX - rect.left) / rect.width) * this.vb.w,
      y: this.vb.y + ((clientY - rect.top) / rect.height) * this.vb.h,
    };
  }

  private zoomAt(clientX: number, clientY: number, factor: number): void {
    const before = this.clientToUser(clientX, clientY);
    this.vb.w *= factor;
    this.vb.h *= factor;
    const after = this.clientToUser(clientX, clientY);
    this.vb.x += before.x - after.x;
    this.vb.y += before.y - after.y;
    this.applyViewBox();
  }

  // ---- input -------------------------------------------------------------

  private attach(): void {
    this.svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.1 : 1 / 1.1);
    }, { passive: false });

    this.svg.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      this.moved = false;
      this.last = { x: e.clientX, y: e.clientY };
      // capture the hit NOW: setPointerCapture redirects the later pointerup to
      // the <svg>, so its composedPath would no longer include the clicked item.
      this.downHit = this.hitFrom(e);
      this.svg.classList.add("ksv-panning");
      this.svg.setPointerCapture(e.pointerId);
    });

    this.svg.addEventListener("pointermove", (e) => {
      if (this.dragging) {
        const dx = e.clientX - this.last.x;
        const dy = e.clientY - this.last.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) this.moved = true;
        const rect = this.svg.getBoundingClientRect();
        this.vb.x -= (dx / rect.width) * this.vb.w;
        this.vb.y -= (dy / rect.height) * this.vb.h;
        this.last = { x: e.clientX, y: e.clientY };
        this.applyViewBox();
      } else {
        this.handleHover(e);
      }
    });

    const end = () => {
      if (this.dragging && !this.moved) this.handleClick(this.downHit);
      this.dragging = false;
      this.svg.classList.remove("ksv-panning");
    };
    this.svg.addEventListener("pointerup", end);
    this.svg.addEventListener("pointerleave", () => {
      if (this.hoverNet !== null) { this.hoverNet = null; this.events.onNetHover?.(null); }
    });
  }

  private hitFrom(e: Event): { net?: string; ref?: string } {
    const path = e.composedPath();
    for (const node of path) {
      if (!(node instanceof SVGElement || node instanceof HTMLElement)) continue;
      if (node === this.svg) break;
      const ds = (node as SVGElement).dataset;
      if (ds.net) return { net: ds.net, ref: ds.ref };
      if (ds.ref) return { ref: ds.ref };
    }
    return {};
  }

  private handleHover(e: PointerEvent): void {
    const hit = this.hitFrom(e);
    const net = hit.net ?? null;
    if (net !== this.hoverNet) {
      this.hoverNet = net;
      this.events.onNetHover?.(net);
      if (hit.ref) this.events.onComponentHover?.(hit.ref);
    }
  }

  private handleClick(hit: { net?: string; ref?: string }): void {
    if (hit.net) {
      // a wire/pin/label hit selects the NET
      this.highlightNet(hit.net);
      this.events.onNetSelect?.(hit.net);
    } else if (hit.ref) {
      this.highlightComponent(hit.ref);
      this.events.onComponentSelect?.(hit.ref);
    } else {
      this.clearHighlights();
      this.events.onNetSelect?.(null);
      this.events.onComponentSelect?.(null);
    }
  }

  // ---- highlighting ------------------------------------------------------

  private rootG(): HTMLElement {
    return this.root;
  }

  clearHighlights(): void {
    this.rootG().classList.remove("has-selection");
    for (const elx of this.svg.querySelectorAll(".ksv-on,.ksv-sel")) elx.classList.remove("ksv-on", "ksv-sel");
  }

  private cssEscape(v: string): string {
    return (window.CSS && CSS.escape) ? CSS.escape(v) : v.replace(/["\\]/g, "\\$&");
  }

  highlightNet(name: string): void {
    this.clearHighlights();
    const net = this.netlist.byName.get(name);
    if (!net) return;
    this.rootG().classList.add("has-selection");
    for (const elx of this.svg.querySelectorAll(`[data-net="${this.cssEscape(name)}"]`)) {
      elx.classList.add("ksv-on");
      // also light up the parent component group so its body shows
      const comp = (elx as Element).closest(".ksv-component");
      if (comp) comp.classList.add("ksv-on");
    }
  }

  highlightComponent(ref: string): void {
    this.clearHighlights();
    if (!this.netlist.componentToNets.has(ref)) {
      // still allow selecting a graphic-only component
    }
    this.rootG().classList.add("has-selection");
    const comp = this.svg.querySelector(`.ksv-component[data-ref="${this.cssEscape(ref)}"]`);
    if (comp) comp.classList.add("ksv-on");
    // light the nets this component touches
    for (const elx of this.svg.querySelectorAll(`.ksv-pin[data-ref="${this.cssEscape(ref)}"]`)) elx.classList.add("ksv-on");
  }

  zoomToNet(name: string): void {
    const net = this.netlist.byName.get(name);
    if (!net) return;
    const b: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const p of net.pins) {
      if (p.pos.x < b.minX) b.minX = p.pos.x;
      if (p.pos.y < b.minY) b.minY = p.pos.y;
      if (p.pos.x > b.maxX) b.maxX = p.pos.x;
      if (p.pos.y > b.maxY) b.maxY = p.pos.y;
    }
    if (isFinite(b.minX)) {
      const m = 5;
      this.fit({ minX: b.minX - m, minY: b.minY - m, maxX: b.maxX + m, maxY: b.maxY + m });
    }
  }
}
