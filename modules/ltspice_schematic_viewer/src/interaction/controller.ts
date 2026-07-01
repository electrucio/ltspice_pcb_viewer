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
  private hoverKey: string | null = null;
  private downHit: { net?: string; ref?: string } = {};
  // Cached across an active gesture (set on down/start, cleared on up/end) so pan/zoom never
  // calls getBoundingClientRect() more than once per gesture — repeated calls force a
  // synchronous layout flush on every move event, which is the main cause of pan/pinch lag on
  // older devices (e.g. iOS 12 Safari). Falls back to a fresh read when no gesture is active.
  private rect: DOMRect | null = null;
  private rafId: number | null = null;

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

  /** Coalesce viewBox writes to at most one per animation frame — multiple move events
   *  between two frames (common on a fast pinch/pan) collapse into a single paint. */
  private scheduleApplyViewBox(): void {
    if (this.rafId != null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.applyViewBox();
    });
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

  private clientToUser(clientX: number, clientY: number, rect: DOMRect): { x: number; y: number } {
    return {
      x: this.vb.x + ((clientX - rect.left) / rect.width) * this.vb.w,
      y: this.vb.y + ((clientY - rect.top) / rect.height) * this.vb.h,
    };
  }

  private zoomAt(clientX: number, clientY: number, factor: number, rect: DOMRect): void {
    const before = this.clientToUser(clientX, clientY, rect);
    this.vb.w *= factor;
    this.vb.h *= factor;
    const after = this.clientToUser(clientX, clientY, rect);
    this.vb.x += before.x - after.x;
    this.vb.y += before.y - after.y;
    this.scheduleApplyViewBox();
  }

  // ---- input -------------------------------------------------------------

  private attach(): void {
    this.svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.1 : 1 / 1.1, this.rect ?? this.svg.getBoundingClientRect());
    }, { passive: false });

    this.svg.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") return; // touch is handled by the Touch Events below
      this.dragging = true;
      this.moved = false;
      this.last = { x: e.clientX, y: e.clientY };
      this.rect = this.svg.getBoundingClientRect();
      // capture the hit NOW: setPointerCapture redirects the later pointerup to
      // the <svg>, so its composedPath would no longer include the clicked item.
      this.downHit = this.hitFrom(e);
      this.svg.classList.add("ksv-panning");
      this.svg.setPointerCapture(e.pointerId);
    });

    this.svg.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") return; // touch is handled by the Touch Events below
      if (this.dragging) {
        const dx = e.clientX - this.last.x;
        const dy = e.clientY - this.last.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) this.moved = true;
        const rect = this.rect!;
        this.vb.x -= (dx / rect.width) * this.vb.w;
        this.vb.y -= (dy / rect.height) * this.vb.h;
        this.last = { x: e.clientX, y: e.clientY };
        this.scheduleApplyViewBox();
      } else {
        this.handleHover(e);
      }
    });

    const end = () => {
      if (this.dragging && !this.moved) this.handleClick(this.downHit);
      this.dragging = false;
      this.rect = null;
      this.svg.classList.remove("ksv-panning");
    };
    this.svg.addEventListener("pointerup", end);
    this.svg.addEventListener("pointerleave", () => {
      if (this.hoverKey !== null) { this.hoverKey = null; this.clearHover(); this.events.onNetHover?.(null); }
    });

    // Touch: tap to select, one-finger pan, two-finger pinch-zoom (Touch Events — works on
    // iOS Safari 12+, which lacks Pointer Events; those are suppressed for touch above).
    // `touch-action: none` (theme) keeps the browser hands-off. A tap fires the same
    // handleClick as a mouse click AND emits a hover so the sim tooltip shows (no hover on touch).
    const tPos = (t: Touch) => ({ x: t.clientX, y: t.clientY });
    const tMid = (a: Touch, b: Touch) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
    const tDistOf = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    let tMode = 0; // 0 idle, 1 pan/tap, 2 pinch
    let tLast = { x: 0, y: 0 }, tStart = { x: 0, y: 0 };
    let tDist = 0, tMoved = false;
    let tDownHit: { net?: string; ref?: string } = {};
    this.svg.addEventListener("touchstart", (e) => {
      this.rect = this.svg.getBoundingClientRect();
      if (e.touches.length >= 2) { tMode = 2; tMoved = true; tDist = tDistOf(e.touches[0]!, e.touches[1]!); tLast = tMid(e.touches[0]!, e.touches[1]!); }
      else if (e.touches.length === 1) { tMode = 1; tMoved = false; tStart = tLast = tPos(e.touches[0]!); tDownHit = this.hitFrom(e); }
    }, { passive: false });
    this.svg.addEventListener("touchmove", (e) => {
      e.preventDefault();
      const rect = this.rect!;
      if (tMode === 1 && e.touches.length === 1) {
        const p = tPos(e.touches[0]!);
        if (Math.hypot(p.x - tStart.x, p.y - tStart.y) > 8) tMoved = true;
        this.vb.x -= ((p.x - tLast.x) / rect.width) * this.vb.w;
        this.vb.y -= ((p.y - tLast.y) / rect.height) * this.vb.h;
        tLast = p;
        this.scheduleApplyViewBox();
      } else if (tMode === 2 && e.touches.length >= 2) {
        const d = tDistOf(e.touches[0]!, e.touches[1]!);
        const m = tMid(e.touches[0]!, e.touches[1]!);
        if (d > 0 && tDist > 0) this.zoomAt(m.x, m.y, tDist / d, rect); // fingers apart → factor<1 → zoom in
        this.vb.x -= ((m.x - tLast.x) / rect.width) * this.vb.w;
        this.vb.y -= ((m.y - tLast.y) / rect.height) * this.vb.h;
        this.scheduleApplyViewBox();
        tDist = d; tLast = m;
      }
    }, { passive: false });
    const tEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) {
        this.rect = null;
        if (tMode === 1 && !tMoved) {
          this.handleClick(tDownHit);
          if (tDownHit.net) this.events.onNetHover?.(tDownHit.net);
          else if (tDownHit.ref) this.events.onComponentHover?.(tDownHit.ref);
          else this.events.onNetHover?.(null);
        }
        tMode = 0;
      } else if (e.touches.length === 1) {
        // one finger lifted out of a pinch: keep the cached rect (geometry is unaffected),
        // just re-seed the pan anchor to the remaining finger.
        tMode = 1; tMoved = true; tStart = tLast = tPos(e.touches[0]!);
      }
    };
    this.svg.addEventListener("touchend", tEnd);
    this.svg.addEventListener("touchcancel", tEnd);
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
    const key = hit.net ? `net:${hit.net}` : hit.ref ? `ref:${hit.ref}` : null;
    if (key === this.hoverKey) return;
    this.hoverKey = key;
    this.applyHover(hit);
    this.events.onNetHover?.(hit.net ?? null);
    if (hit.ref) this.events.onComponentHover?.(hit.ref);
  }

  private clearHover(): void {
    for (const elx of this.svg.querySelectorAll(".ksv-hover")) elx.classList.remove("ksv-hover");
  }

  private applyHover(hit: { net?: string; ref?: string }): void {
    this.clearHover();
    if (hit.net) {
      for (const elx of this.svg.querySelectorAll(`[data-net="${this.cssEscape(hit.net)}"]`)) elx.classList.add("ksv-hover");
    } else if (hit.ref) {
      this.svg.querySelector(`.ksv-component[data-ref="${this.cssEscape(hit.ref)}"]`)?.classList.add("ksv-hover");
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
    for (const elx of this.svg.querySelectorAll(".ksv-on,.ksv-sel,.ksv-on-host")) elx.classList.remove("ksv-on", "ksv-sel", "ksv-on-host");
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
      // un-dim the parent component so the net's pin shows, but DON'T recolor its body
      const comp = (elx as Element).closest(".ksv-component");
      if (comp) comp.classList.add("ksv-on-host");
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

  // ---- marks: faint persistent highlight of a SET, independent of selection ----

  markNets(names: string[]): void {
    for (const name of names)
      for (const elx of this.svg.querySelectorAll(`[data-net="${this.cssEscape(name)}"]`)) elx.classList.add("ksv-mark");
  }

  markComponents(refs: string[]): void {
    for (const ref of refs) {
      const comp = this.svg.querySelector(`.ksv-component[data-ref="${this.cssEscape(ref)}"]`);
      if (comp) comp.classList.add("ksv-mark");
    }
  }

  clearMarks(): void {
    for (const elx of this.svg.querySelectorAll(".ksv-mark")) elx.classList.remove("ksv-mark");
  }

  /** Fit the view to the union bounding box of the given component groups (+ margin). */
  zoomToComponents(refs: string[]): void {
    let b: BBox | null = null;
    for (const ref of refs) {
      const g = this.svg.querySelector(`.ksv-component[data-ref="${this.cssEscape(ref)}"]`) as SVGGraphicsElement | null;
      if (!g) continue;
      let bb: DOMRect;
      try { bb = g.getBBox(); } catch { continue; }
      if (bb.width === 0 && bb.height === 0) continue;
      const box = { minX: bb.x, minY: bb.y, maxX: bb.x + bb.width, maxY: bb.y + bb.height };
      b = b
        ? { minX: Math.min(b.minX, box.minX), minY: Math.min(b.minY, box.minY), maxX: Math.max(b.maxX, box.maxX), maxY: Math.max(b.maxY, box.maxY) }
        : box;
    }
    if (!b) return;
    this.fitWithContext(b);
  }

  /**
   * Fit to a target box but keep surrounding context: the view spans at least a fraction
   * of the whole schematic (and ~4x the target), centred on the target — never a tight crop.
   */
  private fitWithContext(b: BBox, minFraction = 0.45): void {
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const fullW = Math.max(this.bbox.maxX - this.bbox.minX, 1);
    const fullH = Math.max(this.bbox.maxY - this.bbox.minY, 1);
    const w = Math.min(Math.max((b.maxX - b.minX) * 4, fullW * minFraction), fullW * 1.1);
    const h = Math.min(Math.max((b.maxY - b.minY) * 4, fullH * minFraction), fullH * 1.1);
    this.fit({ minX: cx - w / 2, minY: cy - h / 2, maxX: cx + w / 2, maxY: cy + h / 2 });
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
    if (isFinite(b.minX)) this.fitWithContext(b);
  }
}
