/**
 * Single microstrip line — Hammerstad & Jensen, "Accurate Models for Microstrip
 * Computer-Aided Design", IEEE MTT-S 1980, pp. 407–409 (the paper is filed at
 * ~/git/papers/hammerstad-jensen-1980-accurate-models-microstrip.pdf).
 *
 * Equation numbers in comments refer to the paper. The static model (1)–(5) is
 * quoted at ≤0.03 % for u ≤ 1000 (impedance) and ≤0.2 % for εr ≤ 128 (ε_eff);
 * strip thickness is included via Wheeler-style width corrections (6)–(9), and
 * dispersion via Getsinger's model with HJ's G (10)–(12).
 *
 * Transcription is cross-checked against an independent transcription of the same
 * paper (KiCad 9 pcb_calculator, Narayanan/Girardi/Jahn lineage — reference copy in
 * ~/git/papers/kicad9-microstrip-reference.cpp): identical for t = 0; for t > 0 the
 * two differ by design (KiCad adds a filling-factor thickness term from Hammerstad's
 * 1975 handbook; we follow the 1980 paper's (8)/(9) exactly) — tests bound the gap.
 */

import { C0 } from "./constants.js";

/** wave impedance of vacuum, Ω (η0 in the paper) */
export const ETA0 = 376.730313668;
const MU0 = 4e-7 * Math.PI;

export interface MicrostripInput {
  /** strip width, m */
  widthM: number;
  /** substrate height (dielectric between strip and plane), m */
  heightM: number;
  /** substrate relative permittivity */
  epsilonR: number;
  /** strip (copper) thickness, m — 0/omitted = infinitely thin */
  thicknessM?: number;
  /** evaluation frequency, Hz — 0/omitted = quasi-static values */
  frequencyHz?: number;
}

export interface MicrostripResult {
  /** characteristic impedance at the requested frequency, Ω */
  z0: number;
  /** effective dielectric constant at the requested frequency */
  epsEff: number;
  /** quasi-static (f = 0) values — equal to z0/epsEff when no frequency was given */
  z0Static: number;
  epsEffStatic: number;
  /** propagation delay, s/m (√ε_eff/c0) */
  delaySPerM: number;
  /** distributed inductance, H/m (Z0·√ε_eff/c0) */
  inductanceHPerM: number;
  /** distributed capacitance, F/m (√ε_eff/(Z0·c0)) */
  capacitanceFPerM: number;
}

/** (1)+(2): impedance of microstrip in a HOMOGENEOUS medium (ε = 1). */
export function z0Homogeneous(u: number): number {
  const f = 6 + (2 * Math.PI - 6) * Math.exp(-Math.pow(30.666 / u, 0.7528)); // (1)
  return (ETA0 / (2 * Math.PI)) * Math.log(f / u + Math.sqrt(1 + 4 / (u * u))); // (2)
}

/** (3)–(5): quasi-static effective dielectric constant, zero thickness. */
export function epsEffStatic(u: number, er: number): number {
  const u2 = u * u, u4 = u2 * u2;
  const a =
    1 +
    Math.log((u4 + (u / 52) * (u / 52)) / (u4 + 0.432)) / 49 + // (4)
    Math.log(1 + Math.pow(u / 18.1, 3)) / 18.7;
  const b = 0.564 * Math.pow((er - 0.9) / (er + 3), 0.053); // (5)
  return (er + 1) / 2 + ((er - 1) / 2) * Math.pow(1 + 10 / u, -a * b); // (3)
}

/**
 * (6)+(7): Wheeler-style normalized-width correction for strip thickness t/h.
 * er = 1 gives Δu1 (homogeneous); real er gives Δur (mixed media).
 * Note 1/coth² = tanh² — written as in the reference transcription.
 */
export function deltaU(u: number, tH: number, er: number): number {
  if (!(tH > 0)) return 0;
  const du1 = (tH / Math.PI) * Math.log(1 + (4 * Math.E * Math.pow(Math.tanh(Math.sqrt(6.517 * u)), 2)) / tH); // (6)
  return er === 1 ? du1 : 0.5 * du1 * (1 + 1 / Math.cosh(Math.sqrt(er - 1))); // (7)
}

export function microstrip(input: MicrostripInput): MicrostripResult {
  const { widthM: w, heightM: h, epsilonR: er } = input;
  if (!(w > 0) || !(h > 0)) throw new Error("microstrip: width and height must be > 0");
  if (!(er >= 1)) throw new Error("microstrip: epsilonR must be ≥ 1");
  const u = w / h;
  const tH = (input.thicknessM ?? 0) / h;

  // (6)–(9): thickness-corrected widths; ur feeds the mixed-media equations,
  // u1 the homogeneous one, and their Z01 ratio corrects ε_eff
  const u1 = u + deltaU(u, tH, 1);
  const ur = u + deltaU(u, tH, er);
  const z01ur = z0Homogeneous(ur);
  const ee = epsEffStatic(ur, er);
  const z0Stat = z01ur / Math.sqrt(ee); // (8)
  const eeStat = ee * Math.pow(z0Homogeneous(u1) / z01ur, 2); // (9)

  // (10)–(12): Getsinger dispersion with HJ's G — ε_eff rises toward εr with f,
  // Z0 rises slightly (parallel-plate dielectric model)
  let z0 = z0Stat;
  let epsEff = eeStat;
  const f = input.frequencyHz ?? 0;
  if (f > 0 && er > 1) {
    const fp = z0Stat / (2 * MU0 * h); // ≈ first TE-mode cutoff (after (10))
    const G = ((Math.PI * Math.PI) / 12) * ((er - 1) / eeStat) * Math.sqrt((2 * Math.PI * z0Stat) / ETA0); // (11)
    epsEff = er - (er - eeStat) / (1 + G * Math.pow(f / fp, 2)); // (10)
    z0 = z0Stat * Math.sqrt(eeStat / epsEff) * ((epsEff - 1) / (eeStat - 1)); // (12)
  }

  const rootEe = Math.sqrt(epsEff);
  return {
    z0,
    epsEff,
    z0Static: z0Stat,
    epsEffStatic: eeStat,
    delaySPerM: rootEe / C0,
    inductanceHPerM: (z0 * rootEe) / C0,
    capacitanceFPerM: rootEe / (z0 * C0),
  };
}
