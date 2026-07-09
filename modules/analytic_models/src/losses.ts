/**
 * Transmission-line losses (the R and G of RLGC, expressed as attenuation).
 *
 * Microstrip: Hammerstad & Jensen 1980 eqs (33)–(38) — dielectric Q from the
 * filling fraction, conductor Q from skin resistance with the current-distribution
 * factor K (36), surface-roughness correction (35). Cross-checked against KiCad 9's
 * independent transcription (reference: ~/git/papers/kicad9-microstrip-reference.cpp).
 *
 * Stripline: dielectric loss is exact (homogeneous line ⇒ Q_d = 1/tanδ); conductor
 * loss by Wheeler's incremental-inductance rule (H. A. Wheeler, "Formulas for the
 * skin effect", Proc. IRE 1942): R′ = (Rs/µ0)·∂L/∂n with every metal surface
 * receding by n, evaluated numerically on our own stripline model — no empirical
 * constants. Verified against the exact parallel-plate limit.
 *
 * All attenuations in dB/m (20/ln10 · Np/m).
 */

import { C0, RHO_COPPER_20C } from "./constants.js";
import { microstrip, z0Homogeneous, deltaU, ETA0, type MicrostripInput } from "./microstrip.js";
import { stripline, type StriplineInput } from "./stripline.js";

const MU0 = 4e-7 * Math.PI;
const NP_TO_DB = 20 / Math.LN10; // 8.686 dB per neper

/** Skin depth δ = √(ρ/(π·f·µ0)), m. Copper at 1 GHz ≈ 2.09 µm. */
export function skinDepthM(frequencyHz: number, rhoOhmM: number = RHO_COPPER_20C): number {
  if (!(frequencyHz > 0)) throw new Error("skinDepthM: frequency must be > 0");
  return Math.sqrt(rhoOhmM / (Math.PI * frequencyHz * MU0));
}

/**
 * Skin (surface) resistance Rs = ρ/δ, Ω/sq, with HJ eq (35) roughness correction:
 * Rs·(1 + (2/π)·arctan(1.4·(Δ/δ)²)) — Δ is the rms surface roughness. The factor
 * saturates at 2× for very rough surfaces.
 */
export function surfaceResistance(frequencyHz: number, rhoOhmM: number = RHO_COPPER_20C, roughnessRmsM = 0): number {
  const delta = skinDepthM(frequencyHz, rhoOhmM);
  const rs = rhoOhmM / delta;
  return roughnessRmsM > 0 ? rs * (1 + (2 / Math.PI) * Math.atan(1.4 * Math.pow(roughnessRmsM / delta, 2))) : rs; // (35)
}

export interface LossInput {
  /** evaluation frequency, Hz (losses are 0 at DC in this model) */
  frequencyHz: number;
  /** substrate loss tangent (default 0 — lossless dielectric) */
  tanDelta?: number;
  /** conductor resistivity, Ω·m (default annealed copper) */
  rhoOhmM?: number;
  /** rms surface roughness, m (default 0 — smooth) */
  roughnessRmsM?: number;
}

export interface LossResult {
  /** conductor attenuation, dB/m */
  alphaConductorDbPerM: number;
  /** dielectric attenuation, dB/m */
  alphaDielectricDbPerM: number;
  /** total, dB/m */
  alphaDbPerM: number;
  /** skin depth at f, m */
  skinDepthM: number;
  /** HJ's K (36) is derived for t > 3δ — false means the conductor number is shaky */
  thickCopper: boolean;
}

/** Microstrip losses, HJ eqs (33)–(38). */
export function microstripLoss(input: MicrostripInput & LossInput): LossResult {
  const f = input.frequencyHz;
  const rho = input.rhoOhmM ?? RHO_COPPER_20C;
  const t = input.thicknessM ?? 0;
  const delta = skinDepthM(f, rho);
  const { epsEffStatic: ee } = microstrip({ ...input, frequencyHz: 0 });
  const er = input.epsilonR;

  // (38): α = (20π/ln10)·f·√εeff/(c0·Q) per Q-channel
  const alphaOfQ = (Q: number): number => ((NP_TO_DB * Math.PI) * f * Math.sqrt(ee)) / (C0 * Q);

  // dielectric: Qd from (33) with a lossless upper half-space (QA → ∞), which
  // reduces to αd = (20π/ln10)·(f/c0)·(εr/√εeff)·((εeff−1)/(εr−1))·tanδ
  const tanD = input.tanDelta ?? 0;
  const alphaD = er > 1 && tanD > 0
    ? NP_TO_DB * Math.PI * (f / C0) * (er / Math.sqrt(ee)) * ((ee - 1) / (er - 1)) * tanD
    : 0;

  // conductor: (34) Qc = π·Z01·h·f·u/(Rs·c·K) — h·u = w; Z01 at the
  // homogeneous thickness-corrected width u1 (as in the reference transcription)
  const u = input.widthM / input.heightM;
  const z01u1 = z0Homogeneous(u + deltaU(u, t / input.heightM, 1));
  const K = Math.exp(-1.2 * Math.pow(z01u1 / ETA0, 0.7)); // (36)
  const rs = surfaceResistance(f, rho, input.roughnessRmsM);
  const Qc = (Math.PI * z01u1 * input.widthM * f) / (rs * C0 * K); // (34)
  const alphaC = alphaOfQ(Qc);

  return {
    alphaConductorDbPerM: alphaC,
    alphaDielectricDbPerM: alphaD,
    alphaDbPerM: alphaC + alphaD,
    skinDepthM: delta,
    thickCopper: t > 3 * delta,
  };
}

/** Stripline losses: exact homogeneous dielectric + Wheeler incremental inductance. */
export function striplineLoss(input: StriplineInput & LossInput): LossResult {
  const f = input.frequencyHz;
  const rho = input.rhoOhmM ?? RHO_COPPER_20C;
  const t = input.thicknessM ?? 0;
  if (!(t > 0)) throw new Error("striplineLoss: conductor loss needs a real thickness (> 0)");
  const delta = skinDepthM(f, rho);
  const er = input.epsilonR;

  // homogeneous line: εeff = εr exactly, so Qd = 1/tanδ and
  // αd = (20π/ln10)·(f/c0)·√εr·tanδ
  const tanD = input.tanDelta ?? 0;
  const alphaD = tanD > 0 ? NP_TO_DB * Math.PI * (f / C0) * Math.sqrt(er) * tanD : 0;

  // Wheeler: R′ = (Rs/µ0)·∂L/∂n, every metal surface receding by n.
  // Strip: w−2n, t−2n; planes move apart: b+2n; the near-plane gap a grows by 2n.
  // L = Z0(vacuum)/c0; central-ish finite difference with a tiny recession.
  const b = input.planeSpacingM;
  const a = input.offsetM ?? (b - t) / 2;
  const lOf = (n: number): number =>
    stripline({
      widthM: input.widthM - 2 * n,
      planeSpacingM: b + 2 * n,
      thicknessM: t - 2 * n,
      offsetM: a + 2 * n,
      epsilonR: 1,
    }).z0 / C0;
  const n = 1e-6 * Math.min(input.widthM, b); // recession step ≪ any dimension
  const dLdn = (lOf(n) - lOf(0)) / n;
  const rs = surfaceResistance(f, rho, input.roughnessRmsM);
  const rPrime = (rs / MU0) * dLdn; // Ω/m
  const z0 = stripline(input).z0;
  const alphaC = NP_TO_DB * (rPrime / (2 * z0));

  return {
    alphaConductorDbPerM: alphaC,
    alphaDielectricDbPerM: alphaD,
    alphaDbPerM: alphaC + alphaD,
    skinDepthM: delta,
    thickCopper: t > 3 * delta,
  };
}
