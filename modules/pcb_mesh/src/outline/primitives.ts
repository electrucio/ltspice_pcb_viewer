/**
 * Polygonization of PCB copper primitives (board mm, Y down). Each function returns a
 * single outline Ring (open convention — no repeated closing point).
 *
 * Pad shape orientation reuses the viewer's `rotate()` (ROT_SIGN = -1): the renderer
 * draws pads axis-aligned and applies SVG `rotate(-angle)`, which is exactly
 * `rotate(local, angle)` with the default sign — so meshes land where the validated
 * rendering puts the copper.
 */

import type { Pad, Track, Via } from "../../../kicad_pcb_viewer/src/parser/pcb.js";
import { rotate, type Point } from "../../../kicad_pcb_viewer/src/geometry/transform.js";
import type { Ring, Vec2 } from "../types.js";

/**
 * Segments per full circle so the chord sagitta stays ≤ `chordTolerance`.
 * n grows ~ π·√(r/(2·tol)) — big vias get more segments, tiny drills fewer, and the
 * inscribed-polygon area deficit is bounded by ~2·tol/r everywhere.
 */
export function segmentsForRadius(radius: number, chordTolerance: number, minSegments = 8, maxSegments = 512): number {
  if (!(radius > 0) || !(chordTolerance > 0)) return minSegments;
  const theta = 2 * Math.acos(1 - Math.min(1, chordTolerance / radius));
  if (!(theta > 1e-6)) return maxSegments;
  return Math.min(maxSegments, Math.max(minSegments, Math.ceil((2 * Math.PI) / theta)));
}

/** Radius of a pad outline's round features (0 = fully straight-edged, e.g. rect). */
export function padArcRadius(p: Pad): number {
  switch (p.shape) {
    case "circle":
      return p.size.w / 2;
    case "oval":
      return Math.min(p.size.w, p.size.h) / 2;
    case "roundrect":
      return Math.min(p.rratio * Math.min(p.size.w, p.size.h), p.size.w / 2, p.size.h / 2);
    default:
      return 0;
  }
}

export function circleOutline(cx: number, cy: number, r: number, segments: number): Ring {
  const ring: Ring = [];
  for (let i = 0; i < segments; i++) {
    const a = (2 * Math.PI * i) / segments;
    ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return ring;
}

/**
 * Capsule / stadium: a segment from `a` to `b` drawn with round caps of radius
 * `width / 2` — the exact copper shape of a KiCad track segment.
 * Zero-length segments degrade to a circle.
 */
export function stadiumOutline(a: Point, b: Point, width: number, segments: number): Ring {
  const r = width / 2;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return circleOutline(a.x, a.y, r, segments);
  const theta = Math.atan2(dy, dx);
  const capSegs = Math.max(4, Math.round(segments / 2));
  const ring: Ring = [];
  // cap around b: from theta-90° to theta+90°, then cap around a: theta+90° to theta+270°
  for (let i = 0; i <= capSegs; i++) {
    const ang = theta - Math.PI / 2 + (Math.PI * i) / capSegs;
    ring.push([b.x + r * Math.cos(ang), b.y + r * Math.sin(ang)]);
  }
  for (let i = 0; i <= capSegs; i++) {
    const ang = theta + Math.PI / 2 + (Math.PI * i) / capSegs;
    ring.push([a.x + r * Math.cos(ang), a.y + r * Math.sin(ang)]);
  }
  return ring;
}

export function trackOutline(t: Track, segments: number): Ring {
  return stadiumOutline(t.start, t.end, t.width, segments);
}

/** Outer copper of a via: a circle of its `size` diameter. */
export function viaOutline(v: Via, segments: number): Ring {
  return circleOutline(v.pos.x, v.pos.y, v.size / 2, segments);
}

export function viaDrillOutline(v: Via, segments: number): Ring {
  return circleOutline(v.pos.x, v.pos.y, v.drill / 2, segments);
}

/** Map a pad-local point (pad center = origin, axis-aligned) into board coords. */
function padLocalToBoard(p: Pad, local: Vec2): Vec2 {
  const r = rotate({ x: local[0], y: local[1] }, p.angle);
  return [p.pos.x + r.x, p.pos.y + r.y];
}

/** Axis-aligned rounded-rect ring centered at the origin (rr = 0 → plain rect). */
function roundRectLocal(w: number, h: number, rr: number, segments: number): Ring {
  const hw = w / 2, hh = h / 2;
  const r = Math.min(rr, hw, hh);
  if (r <= 1e-9) {
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  }
  const q = Math.max(2, Math.round(segments / 4));
  const corners: Array<{ cx: number; cy: number; start: number }> = [
    { cx: hw - r, cy: -(hh - r), start: -Math.PI / 2 }, // top-right (Y down: -hh is top)
    { cx: hw - r, cy: hh - r, start: 0 },               // bottom-right
    { cx: -(hw - r), cy: hh - r, start: Math.PI / 2 },  // bottom-left
    { cx: -(hw - r), cy: -(hh - r), start: Math.PI },   // top-left
  ];
  const ring: Ring = [];
  for (const c of corners) {
    for (let i = 0; i <= q; i++) {
      const a = c.start + (Math.PI / 2) * (i / q);
      ring.push([c.cx + r * Math.cos(a), c.cy + r * Math.sin(a)]);
    }
  }
  return ring;
}

/**
 * Copper outline of a pad in board coordinates.
 * `trapezoid` and `custom` fall back to their bounding rect (parser keeps no
 * trapezoid delta / custom primitives — documented v1 limitation).
 */
export function padOutline(p: Pad, segments: number): Ring {
  const { w, h } = p.size;
  let local: Ring;
  switch (p.shape) {
    case "circle":
      local = circleOutline(0, 0, w / 2, segments);
      break;
    case "oval": {
      // stadium along the major axis
      if (Math.abs(w - h) < 1e-9) {
        local = circleOutline(0, 0, w / 2, segments);
      } else if (w > h) {
        const half = (w - h) / 2;
        local = stadiumOutline({ x: -half, y: 0 }, { x: half, y: 0 }, h, segments);
      } else {
        const half = (h - w) / 2;
        local = stadiumOutline({ x: 0, y: -half }, { x: 0, y: half }, w, segments);
      }
      break;
    }
    case "roundrect":
      local = roundRectLocal(w, h, p.rratio * Math.min(w, h), segments);
      break;
    case "rect":
    case "trapezoid":
    case "custom":
    default:
      local = roundRectLocal(w, h, 0, segments);
      break;
  }
  return local.map((v) => padLocalToBoard(p, v));
}

/** Drill hole of a thru-hole pad (oval drills → stadium), or null if not drilled. */
export function padDrillOutline(p: Pad, segments: number): Ring | null {
  if (!p.drill || (p.drill.w <= 0 && p.drill.h <= 0)) return null;
  const { w, h } = p.drill;
  let local: Ring;
  if (Math.abs(w - h) < 1e-9) {
    local = circleOutline(0, 0, w / 2, segments);
  } else if (w > h) {
    const half = (w - h) / 2;
    local = stadiumOutline({ x: -half, y: 0 }, { x: half, y: 0 }, h, segments);
  } else {
    const half = (h - w) / 2;
    local = stadiumOutline({ x: 0, y: -half }, { x: 0, y: half }, w, segments);
  }
  return local.map((v) => padLocalToBoard(p, v));
}
