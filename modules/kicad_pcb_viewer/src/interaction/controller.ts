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

export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Compute the committed viewBox for a touch pan/pinch-zoom gesture PHASE, given the phase's
 * frozen starting viewBox `vb0` + element rect, its start point `p0` (rect-relative) and
 * current point `p1` (rect-relative), and the scale factor since the phase started (1 = pure
 * pan). Keeps the content point that was under `p0` mapped to wherever `p1`/scale now are —
 * for a pure pan (scale=1) this reduces algebraically to the incremental per-frame pan formula
 * (`vb.x -= (p1.x-p0.x)/rect.width*vb.w`), so committing once at phase-end instead of on every
 * touchmove produces the exact same final result. Exported (DOM-free) for unit testing.
 */
export function computeGestureViewBox(
  vb0: ViewBox,
  rect: { width: number; height: number },
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  scale: number,
): ViewBox {
  const contentAtStart = { x: vb0.x + (p0.x / rect.width) * vb0.w, y: vb0.y + (p0.y / rect.height) * vb0.h };
  const w = vb0.w / scale, h = vb0.h / scale;
  return {
    x: contentAtStart.x - (p1.x / rect.width) * w,
    y: contentAtStart.y - (p1.y / rect.height) * h,
    w, h,
  };
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
  // Cached across an active gesture (set on down/start, cleared on up/end) so pan/zoom never
  // calls getBoundingClientRect() more than once per gesture — repeated calls force a
  // synchronous layout flush on every move event, which is the main cause of pan/pinch lag on
  // older devices (e.g. iOS 12 Safari). Falls back to a fresh read when no gesture is active.
  private rect: DOMRect | null = null;
  private rafId: number | null = null;

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

  /** Coalesce viewBox writes to at most one per animation frame — multiple move events
   *  between two frames (common on a fast pinch/pan) collapse into a single paint. */
  private scheduleApplyViewBox(): void {
    if (this.rafId != null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.applyViewBox();
    });
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

  private clientToUser(cx: number, cy: number, r: DOMRect): { x: number; y: number } {
    return { x: this.vb.x + ((cx - r.left) / r.width) * this.vb.w, y: this.vb.y + ((cy - r.top) / r.height) * this.vb.h };
  }

  private zoomAt(cx: number, cy: number, factor: number, r: DOMRect): void {
    const before = this.clientToUser(cx, cy, r);
    this.vb.w *= factor;
    this.vb.h *= factor;
    const after = this.clientToUser(cx, cy, r);
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
      this.downHit = this.hitFrom(e);
      this.svg.classList.add("pcb-panning");
      this.svg.setPointerCapture(e.pointerId);
    });
    this.svg.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") return; // touch is handled by the Touch Events below
      if (!this.dragging) { this.events.onNetHover?.(this.hitFrom(e).net ?? null); return; }
      const dx = e.clientX - this.last.x, dy = e.clientY - this.last.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) this.moved = true;
      const r = this.rect!;
      this.vb.x -= (dx / r.width) * this.vb.w;
      this.vb.y -= (dy / r.height) * this.vb.h;
      this.last = { x: e.clientX, y: e.clientY };
      this.scheduleApplyViewBox();
    });
    const end = () => {
      if (this.dragging && !this.moved) this.handleClick(this.downHit);
      this.dragging = false;
      this.rect = null;
      this.svg.classList.remove("pcb-panning");
    };
    this.svg.addEventListener("pointerup", end);

    // Touch: tap to select, one-finger pan, two-finger pinch-zoom (Touch Events — works on
    // iOS Safari 12+, which lacks Pointer Events; those are suppressed for touch above).
    // `touch-action: none` (theme) keeps the browser hands-off. A tap fires the same
    // handleClick as a mouse click AND emits a net hover so the sim tooltip shows on touch.
    //
    // Live feedback during the gesture is a CSS `transform` PREVIEW on the <svg> itself (cheap,
    // GPU-compositable, no SVG repaint) computed relative to the current PHASE's frozen start
    // state — never a live viewBox mutation. The real viewBox is committed once per phase (at
    // gesture end, or when the finger count changes) via `computeGestureViewBox`.
    const tPos = (t: Touch) => ({ x: t.clientX, y: t.clientY });
    const tMid = (a: Touch, b: Touch) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
    const tDistOf = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const rel = (p: { x: number; y: number }): { x: number; y: number } => {
      const r = this.rect!;
      return { x: p.x - r.left, y: p.y - r.top };
    };

    let tMode = 0; // 0 idle, 1 pan/tap, 2 pinch
    let tStart = { x: 0, y: 0 }; // phase-start anchor point (rect-relative)
    let tDistStart = 0; // phase-start finger distance (pinch only)
    let tVb0: ViewBox = this.vb; // frozen viewBox at phase start
    let tLastP = { x: 0, y: 0 }, tLastScale = 1; // most recent preview state (for commit)
    let tMoved = false;
    let tDownHit: { net?: string; ref?: string } = {};

    const previewTransform = (p1: { x: number; y: number }, scale: number): void => {
      const tx = p1.x - scale * tStart.x, ty = p1.y - scale * tStart.y;
      this.svg.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`;
      tLastP = p1; tLastScale = scale;
    };
    const commit = (): void => {
      this.svg.style.transform = "";
      this.vb = computeGestureViewBox(tVb0, this.rect!, tStart, tLastP, tLastScale);
      this.applyViewBox();
    };
    const startPan = (p: { x: number; y: number }): void => {
      tMode = 1; tVb0 = this.vb; tStart = rel(p); tLastP = tStart; tLastScale = 1;
    };
    const startPinch = (a: Touch, b: Touch): void => {
      tMode = 2; tVb0 = this.vb; tStart = rel(tMid(a, b)); tDistStart = tDistOf(a, b); tLastP = tStart; tLastScale = 1;
    };

    this.svg.addEventListener("touchstart", (e) => {
      this.rect = this.svg.getBoundingClientRect();
      if (tMode !== 0) commit(); // finalize whatever phase was running (e.g. adding a 2nd finger)
      if (e.touches.length >= 2) { startPinch(e.touches[0]!, e.touches[1]!); tMoved = true; }
      else if (e.touches.length === 1) { startPan(tPos(e.touches[0]!)); tMoved = false; tDownHit = this.hitFrom(e); }
    }, { passive: false });

    this.svg.addEventListener("touchmove", (e) => {
      e.preventDefault();
      if (tMode === 1 && e.touches.length === 1) {
        const p1 = rel(tPos(e.touches[0]!));
        if (Math.hypot(p1.x - tStart.x, p1.y - tStart.y) > 8) tMoved = true;
        previewTransform(p1, 1);
      } else if (tMode === 2 && e.touches.length >= 2) {
        const d = tDistOf(e.touches[0]!, e.touches[1]!);
        const m = rel(tMid(e.touches[0]!, e.touches[1]!));
        previewTransform(m, tDistStart > 0 ? d / tDistStart : 1); // fingers apart → scale>1 → zoom in
      }
    }, { passive: false });

    const tEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) {
        commit();
        this.rect = null;
        if (tMode === 1 && !tMoved) {
          this.handleClick(tDownHit);
          this.events.onNetHover?.(tDownHit.net ?? null);
        }
        tMode = 0;
      } else if (e.touches.length === 1) {
        commit(); // finalize the pinch phase
        startPan(tPos(e.touches[0]!)); // fresh pan phase anchored to the remaining finger
        tMoved = true; // this gesture already involved 2 fingers — never a tap
      }
    };
    this.svg.addEventListener("touchend", tEnd);
    this.svg.addEventListener("touchcancel", tEnd);
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
