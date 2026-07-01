/**
 * Interaction for the PCB view: pan/zoom (SVG viewBox), horizontal mirror (a transform on
 * the content group), per-layer visibility, DOM hit-testing, and net/component
 * highlighting (CSS classes, recolored via `--ksv-highlight`). Emits semantic callbacks
 * the web component re-dispatches as DOM events.
 */

import type { BBox } from "../parser/pcb.js";

export interface PcbEvents {
  onNetSelect?: (name: string | null) => void;
  onComponentSelect?: (ref: string | null) => void;
  onNetHover?: (name: string | null) => void;
}

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PAD = 0.06;

export class PcbController {
  private vb: ViewBox = { x: 0, y: 0, w: 100, h: 100 };
  private dragging = false;
  private moved = false;
  private last = { x: 0, y: 0 };
  private downHit: { net?: string; ref?: string } = {};
  private mirrored = false;
  private rotation = 0; // 0 | 90 | 180 | 270 (degrees, clockwise)

  constructor(
    private readonly root: HTMLElement,
    private readonly svg: SVGSVGElement,
    private readonly content: SVGGElement,
    private readonly bbox: BBox,
    private readonly events: PcbEvents = {},
    interactive = true,
  ) {
    this.fit();
    if (interactive) this.attach();
  }

  // ---- viewport ----------------------------------------------------------

  private applyViewBox(): void {
    this.svg.setAttribute("viewBox", `${this.vb.x} ${this.vb.y} ${this.vb.w} ${this.vb.h}`);
  }

  private center(): { cx: number; cy: number } {
    return { cx: (this.bbox.minX + this.bbox.maxX) / 2, cy: (this.bbox.minY + this.bbox.maxY) / 2 };
  }

  /** Rebuild the content transform from the current rotation + mirror (about the center). */
  private applyTransform(): void {
    const { cx, cy } = this.center();
    const parts: string[] = [];
    if (this.rotation) parts.push(`rotate(${this.rotation} ${cx} ${cy})`);
    if (this.mirrored) parts.push(`translate(${2 * cx} 0) scale(-1 1)`);
    this.content.setAttribute("transform", parts.join(" "));
  }

  fit(): void {
    let w = Math.max(this.bbox.maxX - this.bbox.minX, 1);
    let h = Math.max(this.bbox.maxY - this.bbox.minY, 1);
    if (this.rotation === 90 || this.rotation === 270) { const t = w; w = h; h = t; } // board reorients
    const { cx, cy } = this.center();
    const px = w * PAD, py = h * PAD;
    this.vb = { x: cx - w / 2 - px, y: cy - h / 2 - py, w: w + 2 * px, h: h + 2 * py };
    this.applyViewBox();
  }

  setMirror(on: boolean): void {
    this.mirrored = on;
    this.applyTransform();
  }
  isMirrored(): boolean {
    return this.mirrored;
  }

  /** Set absolute rotation (snapped to 0/90/180/270) and reframe. */
  setRotation(deg: number): void {
    this.rotation = (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
    this.applyTransform();
    this.fit();
  }
  getRotation(): number {
    return this.rotation;
  }

  setLayerVisible(layer: string, visible: boolean): void {
    const g = this.content.querySelector(`[data-layer="${cssEscape(layer)}"]`) as SVGGElement | null;
    if (g) g.style.display = visible ? "" : "none";
  }

  private clientToUser(cx: number, cy: number): { x: number; y: number } {
    const r = this.svg.getBoundingClientRect();
    return { x: this.vb.x + ((cx - r.left) / r.width) * this.vb.w, y: this.vb.y + ((cy - r.top) / r.height) * this.vb.h };
  }

  private zoomAt(cx: number, cy: number, factor: number): void {
    const before = this.clientToUser(cx, cy);
    this.vb.w *= factor;
    this.vb.h *= factor;
    const after = this.clientToUser(cx, cy);
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
      if (e.pointerType === "touch") return; // touch is handled by the Touch Events below
      this.dragging = true;
      this.moved = false;
      this.last = { x: e.clientX, y: e.clientY };
      this.downHit = this.hitFrom(e);
      this.svg.classList.add("pcb-panning");
      this.svg.setPointerCapture(e.pointerId);
    });
    this.svg.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") return; // touch is handled by the Touch Events below
      if (!this.dragging) { this.events.onNetHover?.(this.hitFrom(e).net ?? null); return; }
      const dx = e.clientX - this.last.x, dy = e.clientY - this.last.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) this.moved = true;
      const r = this.svg.getBoundingClientRect();
      this.vb.x -= (dx / r.width) * this.vb.w;
      this.vb.y -= (dy / r.height) * this.vb.h;
      this.last = { x: e.clientX, y: e.clientY };
      this.applyViewBox();
    });
    const end = () => {
      if (this.dragging && !this.moved) this.handleClick(this.downHit);
      this.dragging = false;
      this.svg.classList.remove("pcb-panning");
    };
    this.svg.addEventListener("pointerup", end);

    // Touch: one-finger pan + two-finger pinch-zoom (Touch Events — works on iOS Safari 12+,
    // which lacks Pointer Events). `touch-action: none` (theme) keeps the browser hands-off.
    const tMid = (a: Touch, b: Touch) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
    const tDistOf = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    let tMode = 0; // 0 idle, 1 pan, 2 pinch
    let tLast = { x: 0, y: 0 };
    let tDist = 0;
    const tSeed = (e: TouchEvent) => {
      if (e.touches.length >= 2) { tMode = 2; tDist = tDistOf(e.touches[0]!, e.touches[1]!); tLast = tMid(e.touches[0]!, e.touches[1]!); }
      else if (e.touches.length === 1) { tMode = 1; tLast = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY }; }
      else { tMode = 0; }
    };
    this.svg.addEventListener("touchstart", tSeed, { passive: false });
    this.svg.addEventListener("touchend", tSeed);
    this.svg.addEventListener("touchcancel", tSeed);
    this.svg.addEventListener("touchmove", (e) => {
      e.preventDefault();
      const r = this.svg.getBoundingClientRect();
      if (tMode === 1 && e.touches.length === 1) {
        const p = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY };
        this.vb.x -= ((p.x - tLast.x) / r.width) * this.vb.w;
        this.vb.y -= ((p.y - tLast.y) / r.height) * this.vb.h;
        tLast = p;
        this.applyViewBox();
      } else if (tMode === 2 && e.touches.length >= 2) {
        const d = tDistOf(e.touches[0]!, e.touches[1]!);
        const m = tMid(e.touches[0]!, e.touches[1]!);
        if (d > 0 && tDist > 0) this.zoomAt(m.x, m.y, tDist / d); // fingers apart → factor<1 → zoom in
        this.vb.x -= ((m.x - tLast.x) / r.width) * this.vb.w;
        this.vb.y -= ((m.y - tLast.y) / r.height) * this.vb.h;
        this.applyViewBox();
        tDist = d; tLast = m;
      }
    }, { passive: false });
  }

  private hitFrom(e: Event): { net?: string; ref?: string } {
    for (const node of e.composedPath()) {
      if (node === this.svg) break;
      if (!(node instanceof SVGElement)) continue;
      const ds = node.dataset;
      if (ds.net) return { net: ds.net, ref: ds.ref };
      if (ds.ref) return { ref: ds.ref };
    }
    return {};
  }

  private handleClick(hit: { net?: string; ref?: string }): void {
    if (hit.net) { this.highlightNet(hit.net); this.events.onNetSelect?.(hit.net); }
    else if (hit.ref) { this.highlightComponent(hit.ref); this.events.onComponentSelect?.(hit.ref); }
    else { this.clearHighlights(); this.events.onNetSelect?.(null); this.events.onComponentSelect?.(null); }
  }

  // ---- highlight ---------------------------------------------------------

  clearHighlights(): void {
    this.root.classList.remove("has-selection");
    for (const el of this.content.querySelectorAll(".ksv-on")) el.classList.remove("ksv-on");
  }

  highlightNet(name: string): void {
    this.clearHighlights();
    this.root.classList.add("has-selection");
    for (const el of this.content.querySelectorAll(`[data-net="${cssEscape(name)}"]`)) el.classList.add("ksv-on");
  }

  highlightComponent(ref: string): void {
    this.clearHighlights();
    this.root.classList.add("has-selection");
    for (const el of this.content.querySelectorAll(`[data-ref="${cssEscape(ref)}"]`)) el.classList.add("ksv-on");
  }
}

function cssEscape(v: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, "\\$&");
}
