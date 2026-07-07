/**
 * DC-resistance closed forms — the M0 slice that serves as the oracle for the M4 FEM
 * solver. Pure functions, **SI units** (m, Ω, °C for temperatures).
 *
 * Formula (same family as Saturn / pcb-toolkit / circuitcalculator.com):
 *   R(T) = ρ₂₀ · L / (W·t) · [1 + α·(T − 20 °C)]
 */

import { ALPHA_COPPER, COPPER_REF_TEMP_C, CORNER_SQUARES, RHO_COPPER_20C } from "./constants.js";

/** Copper resistivity at temperature `tempC`, Ω·m (linear model around 20 °C). */
export function copperResistivity(tempC: number = COPPER_REF_TEMP_C): number {
  return RHO_COPPER_20C * (1 + ALPHA_COPPER * (tempC - COPPER_REF_TEMP_C));
}

/** Sheet resistance of a copper film of thickness `thicknessM`, Ω/square. */
export function sheetResistance(thicknessM: number, tempC?: number): number {
  if (!(thicknessM > 0)) throw new RangeError(`thickness must be > 0 m (got ${thicknessM})`);
  return copperResistivity(tempC) / thicknessM;
}

export interface TraceGeometry {
  /** centerline length, m */
  length: number;
  /** trace width, m */
  width: number;
  /** copper thickness, m */
  thickness: number;
  /** °C, default 20 */
  tempC?: number;
}

/** DC resistance of a straight rectangular trace: ρL/(W·t), Ω. */
export function traceResistance(g: TraceGeometry): number {
  if (!(g.length >= 0) || !(g.width > 0)) throw new RangeError("length must be ≥ 0 and width > 0");
  return sheetResistance(g.thickness, g.tempC) * (g.length / g.width);
}

/**
 * DC resistance from a squares count (the "counting squares" estimation method):
 * straight-run squares = Σ length/width, plus CORNER_SQUARES per 90° corner.
 */
export function resistanceFromSquares(squares: number, thicknessM: number, tempC?: number): number {
  return sheetResistance(thicknessM, tempC) * squares;
}

/** Squares of a rectilinear path: Σ(segment length / width) + 0.56 per 90° corner. */
export function pathSquares(segments: Array<{ length: number; width: number }>, corners90 = 0): number {
  let sq = corners90 * CORNER_SQUARES;
  for (const s of segments) {
    if (!(s.width > 0)) throw new RangeError("segment width must be > 0");
    sq += s.length / s.width;
  }
  return sq;
}

export interface ViaBarrelGeometry {
  /** finished (plated) hole diameter, m — what the .kicad_pcb `drill` field stores */
  finishedHoleDiameter: number;
  /** copper plating wall thickness, m (typical 20–25 µm; Saturn default 0.7 mil ≈ 17.8 µm) */
  platingThickness: number;
  /** barrel length = board (or span) thickness, m */
  length: number;
  /** °C, default 20 */
  tempC?: number;
}

/**
 * DC resistance of a plated via barrel: ρL/A with the copper annulus
 * A = π·t·(d + t) for inner diameter d (finished hole) and wall t.
 */
export function viaBarrelResistance(v: ViaBarrelGeometry): number {
  const { finishedHoleDiameter: d, platingThickness: t, length: L } = v;
  if (!(d > 0) || !(t > 0) || !(L >= 0)) throw new RangeError("via dimensions must be positive");
  const area = Math.PI * t * (d + t);
  return (copperResistivity(v.tempC) * L) / area;
}
