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
 * Convert a wheel event's `deltaY` into a magnitude-proportional zoom factor, instead of a
 * fixed step per event. A trackpad pinch/scroll fires many small wheel events per gesture —
 * a fixed step compounds multiplicatively across them (e.g. 20 events × 1.1 ≈ 6.7× zoom from
 * a light touch), which is wildly oversensitive. `deltaY` is clamped first to guard against
 * occasional large delta spikes some browsers/trackpads report for a single event.
 */
export function wheelZoomFactor(deltaY: number): number {
  const clamped = Math.max(-100, Math.min(100, deltaY));
  return Math.exp(clamped * 0.00095); // deltaY≈±100 (a full wheel "notch") ≈ the old fixed 1.1
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
      this.zoomAt(e.clientX, e.clientY, wheelZoomFactor(e.deltaY), this.rect ?? this.svg.getBoundingClientRect());
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
      const r = this.rect!;
      if (tMode === 1 && e.touches.length === 1) {
        const p = tPos(e.touches[0]!);
        if (Math.hypot(p.x - tStart.x, p.y - tStart.y) > 8) tMoved = true;
        this.vb.x -= ((p.x - tLast.x) / r.width) * this.vb.w;
        this.vb.y -= ((p.y - tLast.y) / r.height) * this.vb.h;
        tLast = p;
        this.scheduleApplyViewBox();
      } else if (tMode === 2 && e.touches.length >= 2) {
        const d = tDistOf(e.touches[0]!, e.touches[1]!);
        const m = tMid(e.touches[0]!, e.touches[1]!);
        if (d > 0 && tDist > 0) this.zoomAt(m.x, m.y, tDist / d, r); // fingers apart → factor<1 → zoom in
        this.vb.x -= ((m.x - tLast.x) / r.width) * this.vb.w;
        this.vb.y -= ((m.y - tLast.y) / r.height) * this.vb.h;
        this.scheduleApplyViewBox();
        tDist = d; tLast = m;
      }
    }, { passive: false });
    const tEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) {
        this.rect = null;
        if (tMode === 1 && !tMoved) {
          this.handleClick(tDownHit);
          this.events.onNetHover?.(tDownHit.net ?? null);
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
