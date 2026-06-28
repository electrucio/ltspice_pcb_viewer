/**
 * Placement maths for KiCad PCB items. The board uses millimetres with Y pointing
 * DOWN (same as SVG). A footprint has a position and orientation; its pads and
 * graphics are stored in the footprint's local frame and must be rotated + translated
 * into board coordinates.
 *
 * KiCad's rotation sign (CW vs CCW on a Y-down plane) is captured by ROT_SIGN, locked
 * empirically by maximizing pad↔track-endpoint coincidence (see scripts/diagnose-transform).
 */

export interface Point {
  x: number;
  y: number;
}

/** +1 or -1: validated so that pads land on the ends of their nets' tracks. */
export const ROT_SIGN = -1;

/** Rotate a local point by `deg` (footprint orientation). */
export function rotate(p: Point, deg: number, sign: number = ROT_SIGN): Point {
  const a = (sign * deg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

/** Local footprint point -> board coordinates, given footprint pos + orientation. */
export function toWorld(local: Point, origin: Point, deg: number, sign: number = ROT_SIGN): Point {
  const r = rotate(local, deg, sign);
  return { x: origin.x + r.x, y: origin.y + r.y };
}

/** Quantize a coordinate for robust point matching (1e-3 mm). */
export function key(p: Point): string {
  return `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;
}
