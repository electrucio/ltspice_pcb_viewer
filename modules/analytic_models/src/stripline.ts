/**
 * Stripline (inner-layer trace between two reference planes).
 *
 * Two models, deliberately both:
 *
 * 1. `striplineCohnExact` — S. B. Cohn's conformal-mapping solution for a
 *    zero-thickness strip CENTERED between planes (IRE Trans. MTT, 1954):
 *        Z0 = (η0 / 4√εr) · K(k)/K(k′),  k = sech(πw/2b),  k′ = tanh(πw/2b)
 *    with K the complete elliptic integral of the first kind (computed by AGM).
 *    This is EXACT — it serves as the in-repo oracle for the practical model.
 *
 * 2. `stripline` — the practical model for finite thickness and OFF-CENTER strips
 *    (real stackups are rarely symmetric): the Cohn-lineage fringing formulas with
 *    a wide-strip branch (w/(s−t) ≥ 0.35) and a narrow-strip round-wire equivalent,
 *    composing an offset strip as the parallel combination of the two single-plane
 *    impedances. Same model family as transcalc/qucs/KiCad's pcb_calculator; our
 *    transcription is fixture-verified against KiCad 9's independent one to 1e-12
 *    (reference copy: ~/git/papers/kicad9-stripline-reference.cpp).
 *
 * Stripline is homogeneous: ε_eff = εr exactly, no dispersion in the quasi-TEM model.
 */

import { C0 } from "./constants.js";
import { ETA0 } from "./microstrip.js";

/** arithmetic–geometric mean (K(k) = π / (2·agm(1, k′))). */
function agm(a0: number, b0: number): number {
  let a = a0;
  let b = b0;
  while (Math.abs(a - b) > 1e-15 * a) {
    const an = (a + b) / 2;
    b = Math.sqrt(a * b);
    a = an;
  }
  return a;
}

/**
 * Cohn 1954, exact: zero-thickness strip of width w centered between planes
 * spaced b apart, homogeneous εr.
 *
 * Z0 = (η0/4√εr)·K(k)/K(k′) with k = sech(πw/2b), k′ = tanh(πw/2b). Since
 * K(m) = π/(2·agm(1, complement)), the ratio is agm(1, k)/agm(1, k′) — using
 * sech/tanh directly as each other's exact complements keeps full precision for
 * wide strips, where forming √(1−tanh²) would round k′ to 1.
 */
export function striplineCohnExact(widthM: number, planeSpacingM: number, epsilonR: number): number {
  if (!(widthM > 0) || !(planeSpacingM > 0)) throw new Error("striplineCohnExact: dimensions must be > 0");
  const x = (Math.PI * widthM) / (2 * planeSpacingM);
  const k = 1 / Math.cosh(x); // sech
  const kp = Math.tanh(x);
  return (ETA0 / (4 * Math.sqrt(epsilonR))) * (agm(1, k) / agm(1, kp));
}

export interface StriplineInput {
  /** strip width, m */
  widthM: number;
  /** plane-to-plane spacing (dielectric total), m */
  planeSpacingM: number;
  /** substrate relative permittivity */
  epsilonR: number;
  /** strip (copper) thickness, m */
  thicknessM?: number;
  /**
   * distance from the strip's near face to ONE reference plane, m.
   * Default: centered, (planeSpacing − thickness)/2.
   */
  offsetM?: number;
}

export interface StriplineResult {
  /** characteristic impedance, Ω */
  z0: number;
  /** = εr (homogeneous line) */
  epsEff: number;
  /** propagation delay, s/m (√εr/c0) */
  delaySPerM: number;
  /** distributed inductance, H/m */
  inductanceHPerM: number;
  /** distributed capacitance, F/m */
  capacitanceFPerM: number;
}

/**
 * Impedance of a strip with ONE pair of symmetric planes at spacing `s` (i.e. a
 * symmetric stripline of plane spacing s), finite thickness t — Cohn's fringing
 * formula for wide strips, round-wire equivalent-diameter form for narrow ones.
 */
function symmetricZ0(w: number, s: number, t: number, er: number): number {
  const smt = s - t;
  if (!(smt > 0)) throw new Error("stripline: strip thickness must be smaller than the plane spacing");
  if (w / smt >= 0.35) {
    // wide strip: parallel-plate + Cohn fringing terms
    const fringe = t > 0
      ? (2 * s * Math.log((2 * s - t) / smt) - t * Math.log((s * s) / (smt * smt) - 1)) / Math.PI
      : (2 * s * Math.log(2)) / Math.PI; // t→0 limit of the expression above
    return (ETA0 * smt) / (Math.sqrt(er) * 4 * (w + fringe));
  }
  // narrow strip: equivalent-diameter (round-wire) model
  let tdw = t > 0 ? t / w : 1e-12;
  const swap = tdw > 1; // formula is symmetric in (w, t) via the aspect swap
  if (swap) tdw = w / t;
  let de = 1 + (tdw / Math.PI) * (1 + Math.log((4 * Math.PI) / tdw)) + 0.236 * Math.pow(tdw, 1.65);
  de *= (swap ? t : w) / 2;
  return (ETA0 / (2 * Math.PI * Math.sqrt(er))) * Math.log((4 * s) / (Math.PI * de));
}

export function stripline(input: StriplineInput): StriplineResult {
  const { widthM: w, planeSpacingM: b, epsilonR: er } = input;
  if (!(w > 0) || !(b > 0)) throw new Error("stripline: width and plane spacing must be > 0");
  if (!(er >= 1)) throw new Error("stripline: epsilonR must be ≥ 1");
  const t = input.thicknessM ?? 0;
  const a = input.offsetM ?? (b - t) / 2;
  if (!(a > 0) || !(a + t < b)) throw new Error("stripline: strip (offset + thickness) must lie between the planes");

  // offset strip = the two half-problems in parallel: mirror each plane distance
  // into an equivalent SYMMETRIC stripline (spacings 2a+t and 2(b−a−t)+t)
  const z1 = symmetricZ0(w, 2 * a + t, t, er);
  const z2 = symmetricZ0(w, 2 * (b - a - t) + t, t, er);
  const z0 = 2 / (1 / z1 + 1 / z2);

  const rootEr = Math.sqrt(er);
  return {
    z0,
    epsEff: er,
    delaySPerM: rootEr / C0,
    inductanceHPerM: (z0 * rootEr) / C0,
    capacitanceFPerM: rootEr / (z0 * C0),
  };
}
