/**
 * Transform of symbol-local coordinates into schematic (world) coordinates.
 *
 * KiCad stores symbol library graphics with Y pointing UP, while the schematic
 * sheet has Y pointing DOWN. A placed instance also has a rotation `angle`
 * (0/90/180/270) and an optional mirror across the X or Y axis.
 *
 * We express the whole thing as a 2x3 affine matrix:
 *   wx = a*lx + c*ly + e
 *   wy = b*lx + d*ly + f
 *
 * The exact composition (Y-flip, rotation sign, mirror order) is notoriously
 * fiddly, so it is captured by a single TransformConfig that we lock in after
 * validating that pins coincide with wire endpoints (see test + scripts).
 */

import type { Placement, MirrorAxis, Point } from "../parser/schematic.js";

export interface Matrix2x3 {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface TransformConfig {
  /** flip library Y (up) to schematic Y (down) before rotation */
  flipY: boolean;
  /** rotation direction: +1 = CCW for positive angle, -1 = CW */
  rotSign: 1 | -1;
}

/** The validated default (see test/connectivity.test.ts). */
export const DEFAULT_TRANSFORM: TransformConfig = { flipY: true, rotSign: -1 };

function applyPoint(m: Matrix2x3, x: number, y: number): Point {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

/** Build the affine matrix for an instance placement. */
export function instanceMatrix(
  placement: Placement,
  mirror: MirrorAxis,
  cfg: TransformConfig = DEFAULT_TRANSFORM,
): Matrix2x3 {
  // Start from identity 2x2 acting on local coords.
  let a = 1, b = 0, c = 0, d = 1;

  // 1) library Y-up -> schematic Y-down
  if (cfg.flipY) {
    d = -d; // y -> -y
  }

  // 2) mirror. KiCad: "mirror x" flips across the X axis (negates Y),
  //    "mirror y" flips across the Y axis (negates X). Applied in local space.
  if (mirror === "x") {
    // negate the y column contribution
    c = -c; d = -d;
  } else if (mirror === "y") {
    a = -a; b = -b;
  }

  // 3) rotation by angle (degrees). Compose R * current.
  const rad = (cfg.rotSign * placement.angle * Math.PI) / 180;
  const cos = Math.round(Math.cos(rad));
  const sin = Math.round(Math.sin(rad));
  // R = [[cos, -sin], [sin, cos]]; new = R * [[a,c],[b,d]]
  const na = cos * a - sin * b;
  const nb = sin * a + cos * b;
  const nc = cos * c - sin * d;
  const nd = sin * c + cos * d;

  return { a: na, b: nb, c: nc, d: nd, e: placement.x, f: placement.y };
}

export function transformPoint(m: Matrix2x3, p: Point): Point {
  return applyPoint(m, p.x, p.y);
}

/** World position of a pin's electrical connection point. */
export function pinWorldPos(m: Matrix2x3, pinAt: Placement): Point {
  return applyPoint(m, pinAt.x, pinAt.y);
}

/**
 * World position of a pin's *far* end (where the pin line meets the body).
 * Useful for rendering; the connection point is `pinWorldPos`.
 */
export function pinWorldFarEnd(m: Matrix2x3, pinAt: Placement, length: number): Point {
  const rad = (pinAt.angle * Math.PI) / 180;
  const fx = pinAt.x + length * Math.cos(rad);
  const fy = pinAt.y + length * Math.sin(rad);
  return applyPoint(m, fx, fy);
}

/** Quantize a coordinate to integer grid units for robust point matching. */
export const GRID = 10000; // 1e-4 mm resolution
export function quantize(p: Point): string {
  return `${Math.round(p.x * GRID)},${Math.round(p.y * GRID)}`;
}
