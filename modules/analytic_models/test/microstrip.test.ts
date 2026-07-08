import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { microstrip, z0Homogeneous, epsEffStatic, ETA0, C0 } from "../src/index.js";

/**
 * Fixtures minted from an INDEPENDENT transcription of Hammerstad & Jensen 1980:
 * KiCad 9's pcb_calculator microstrip math (Narayanan/Girardi/Jahn lineage),
 * compiled as-is in a local harness (scratchpad hj-reference.c) over a
 * (u, εr, t/h) grid — the two transcriptions must agree to double precision.
 */
const fixtures: Array<{ u: number; er: number; tH: number; z0: number; epsEff: number }> = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/hj-microstrip-kicad9.json", import.meta.url)), "utf8"),
);

const H = 1e-3; // reference substrate height for de-normalizing the fixture grid

describe("Hammerstad–Jensen microstrip vs the KiCad-9 transcription", () => {
  it(`matches all ${fixtures.length} fixture rows to 1e-12 relative`, () => {
    for (const f of fixtures) {
      const r = microstrip({ widthM: f.u * H, heightM: H, epsilonR: f.er, thicknessM: f.tH * H });
      expect(Math.abs(r.z0Static - f.z0) / f.z0, `z0 u=${f.u} er=${f.er} t/h=${f.tH}`).toBeLessThan(1e-12);
      expect(Math.abs(r.epsEffStatic - f.epsEff) / f.epsEff, `εeff u=${f.u} er=${f.er} t/h=${f.tH}`).toBeLessThan(1e-12);
    }
  });
});

describe("physical limits and properties", () => {
  it("air line (εr = 1): εeff ≡ 1, and u = 1 gives the classic ≈126.4 Ω", () => {
    const r = microstrip({ widthM: 1e-3, heightM: 1e-3, epsilonR: 1 });
    expect(r.epsEffStatic).toBeCloseTo(1, 12);
    expect(r.z0Static).toBeGreaterThan(125);
    expect(r.z0Static).toBeLessThan(128);
  });

  it("εeff lives in [(εr+1)/2, εr] and rises with u toward εr", () => {
    const er = 4.5;
    let prev = 0;
    for (const u of [0.05, 0.2, 1, 5, 20, 100, 1000]) {
      const ee = epsEffStatic(u, er);
      expect(ee).toBeGreaterThan((er + 1) / 2 - 1e-9);
      expect(ee).toBeLessThan(er);
      expect(ee).toBeGreaterThan(prev);
      prev = ee;
    }
    expect(epsEffStatic(1000, er)).toBeGreaterThan(er * 0.98); // wide-strip limit
    // narrow-strip limit is approached only logarithmically: εeff(0.01) ≈ 2.89 vs 2.75
    expect(epsEffStatic(0.01, er)).toBeLessThan(((er + 1) / 2) * 1.06);
  });

  it("Z0 falls monotonically with width and with εr; thickness lowers Z0", () => {
    const at = (w: number, er: number, t = 0) => microstrip({ widthM: w, heightM: 1e-3, epsilonR: er, thicknessM: t }).z0Static;
    expect(at(0.5e-3, 4.5)).toBeGreaterThan(at(1e-3, 4.5));
    expect(at(1e-3, 4.5)).toBeGreaterThan(at(3e-3, 4.5));
    expect(at(1e-3, 2.2)).toBeGreaterThan(at(1e-3, 4.5));
    expect(at(1e-3, 4.5, 35e-6)).toBeLessThan(at(1e-3, 4.5));
    // t → 0 is continuous
    expect(Math.abs(at(1e-3, 4.5, 1e-12) - at(1e-3, 4.5))).toBeLessThan(1e-3);
  });

  it("homogeneous impedance: wide-strip parallel-plate limit η0/u", () => {
    const u = 1000;
    expect(Math.abs(z0Homogeneous(u) - ETA0 / u) / (ETA0 / u)).toBeLessThan(0.02);
  });

  it("dispersion: f=0 equals static, εeff rises monotonically to εr, Z0 rises", () => {
    const g = { widthM: 2.9e-3, heightM: 1.6e-3, epsilonR: 4.6, thicknessM: 35e-6 };
    const stat = microstrip(g);
    expect(microstrip({ ...g, frequencyHz: 0 }).epsEff).toBe(stat.epsEffStatic);
    let prev = stat.epsEffStatic;
    for (const f of [0.1e9, 1e9, 5e9, 20e9, 100e9]) {
      const r = microstrip({ ...g, frequencyHz: f });
      expect(r.epsEff).toBeGreaterThan(prev);
      expect(r.epsEff).toBeLessThan(g.epsilonR);
      expect(r.z0).toBeGreaterThanOrEqual(stat.z0Static);
      prev = r.epsEff;
    }
    expect(microstrip({ ...g, frequencyHz: 1e12 }).epsEff).toBeGreaterThan(g.epsilonR * 0.99); // f→∞ ⇒ εr
  });

  it("RLGC identities: √(L/C) = Z0 and 1/√(LC) = c0/√εeff", () => {
    const r = microstrip({ widthM: 2.9e-3, heightM: 1.6e-3, epsilonR: 4.6, thicknessM: 35e-6, frequencyHz: 1e9 });
    expect(Math.sqrt(r.inductanceHPerM / r.capacitanceFPerM)).toBeCloseTo(r.z0, 9);
    expect(1 / Math.sqrt(r.inductanceHPerM * r.capacitanceFPerM)).toBeCloseTo(C0 / Math.sqrt(r.epsEff), 0);
  });

  it("engineering sanity: the folklore 50 Ω FR4 microstrip (1.6 mm, ~2.9 mm wide)", () => {
    const r = microstrip({ widthM: 2.9e-3, heightM: 1.6e-3, epsilonR: 4.6, thicknessM: 35e-6 });
    expect(r.z0Static).toBeGreaterThan(48);
    expect(r.z0Static).toBeLessThan(52);
  });
});
