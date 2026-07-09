import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { microstripLoss, striplineLoss, skinDepthM, surfaceResistance, stripline } from "../src/index.js";

const fixtures: Array<{ w: number; er: number; f: number; rough: number; alphaC: number; alphaD: number }> = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/hj-losses-kicad9.json", import.meta.url)), "utf8"),
);

const H = 1.6e-3, T = 35e-6, TAND = 0.02;

describe("microstrip losses vs the KiCad-9 transcription of HJ (33)–(38)", () => {
  it(`matches all ${fixtures.length} fixture rows to 1e-11 relative`, () => {
    // 1e-11: the reference computes Rs as 1/(σ·δ) with σ = 1/ρ — the double
    // reciprocal costs an ulp vs our direct ρ/δ
    for (const fx of fixtures) {
      const r = microstripLoss({
        widthM: fx.w, heightM: H, epsilonR: fx.er, thicknessM: T,
        frequencyHz: fx.f, tanDelta: TAND, roughnessRmsM: fx.rough,
      });
      expect(Math.abs(r.alphaConductorDbPerM - fx.alphaC) / fx.alphaC, `αc w=${fx.w} er=${fx.er} f=${fx.f} Δ=${fx.rough}`).toBeLessThan(1e-11);
      expect(Math.abs(r.alphaDielectricDbPerM - fx.alphaD) / fx.alphaD, `αd w=${fx.w} er=${fx.er} f=${fx.f}`).toBeLessThan(1e-11);
    }
  });
});

describe("skin effect", () => {
  it("copper at 1 GHz: δ ≈ 2.09 µm; Rs = ρ/δ; δ ∝ 1/√f", () => {
    expect(skinDepthM(1e9) * 1e6).toBeCloseTo(2.09, 2);
    expect(surfaceResistance(1e9)).toBeCloseTo(1.724e-8 / skinDepthM(1e9), 12);
    expect(skinDepthM(4e9)).toBeCloseTo(skinDepthM(1e9) / 2, 12);
  });

  it("roughness multiplier grows with Δ/δ and saturates below 2×", () => {
    const smooth = surfaceResistance(1e9);
    const rough1 = surfaceResistance(1e9, undefined, 1e-6);
    const roughLots = surfaceResistance(1e9, undefined, 100e-6);
    expect(rough1).toBeGreaterThan(smooth);
    expect(roughLots).toBeLessThan(2 * smooth);
    expect(roughLots).toBeGreaterThan(1.99 * smooth);
  });
});

describe("loss scaling laws", () => {
  const g = { widthM: 2.9e-3, heightM: H, epsilonR: 4.6, thicknessM: T };

  it("conductor loss ∝ √f (smooth copper), dielectric loss ∝ f·tanδ", () => {
    const at = (f: number, tanDelta = TAND) => microstripLoss({ ...g, frequencyHz: f, tanDelta });
    // αc ~ Rs·√εeff/(Z0-ish) — Rs ∝ √f and the rest is f-independent statics
    expect(at(4e9).alphaConductorDbPerM / at(1e9).alphaConductorDbPerM).toBeCloseTo(2, 5);
    expect(at(2e9).alphaDielectricDbPerM / at(1e9).alphaDielectricDbPerM).toBeCloseTo(2, 9);
    expect(at(1e9, 0.04).alphaDielectricDbPerM / at(1e9, 0.02).alphaDielectricDbPerM).toBeCloseTo(2, 9);
  });

  it("flags thin copper (t < 3δ) where HJ's K is out of its validity range", () => {
    expect(microstripLoss({ ...g, frequencyHz: 10e9, tanDelta: TAND }).thickCopper).toBe(true); // δ ≈ 0.66 µm ≪ 35 µm
    expect(microstripLoss({ ...g, frequencyHz: 1e6, tanDelta: TAND }).thickCopper).toBe(false); // δ ≈ 66 µm > t/3
  });

  it("FR4 magnitude sanity at 1 GHz: αd dominates, total O(0.1 dB/cm)", () => {
    const r = microstripLoss({ ...g, frequencyHz: 1e9, tanDelta: 0.02 });
    expect(r.alphaDielectricDbPerM).toBeGreaterThan(r.alphaConductorDbPerM); // FR4 is dielectric-limited at 1 GHz
    expect(r.alphaDbPerM).toBeGreaterThan(1); // ≈ 2 dB/m
    expect(r.alphaDbPerM).toBeLessThan(10);
  });
});

describe("stripline losses", () => {
  const g = { widthM: 0.4e-3, planeSpacingM: 1e-3, thicknessM: 18e-6, epsilonR: 4.5 };

  it("dielectric loss is the exact homogeneous form (20π/ln10)·(f/c0)·√εr·tanδ", () => {
    const r = striplineLoss({ ...g, frequencyHz: 1e9, tanDelta: 0.02 });
    const exact = ((20 / Math.LN10) * Math.PI * 1e9 * Math.sqrt(4.5) * 0.02) / 299792458;
    expect(r.alphaDielectricDbPerM).toBeCloseTo(exact, 12);
  });

  it("incremental-inductance conductor loss hits the parallel-plate limit for wide strips", () => {
    // wide centered strip, gap g each side: R′ → (Rs/w)·(1 + g/w), αc = R′/(2Z0)
    const w = 20e-3, b = 1e-3, t = 18e-6, f = 1e9;
    const gap = (b - t) / 2;
    const rs = surfaceResistance(f);
    const z0 = stripline({ widthM: w, planeSpacingM: b, thicknessM: t, epsilonR: 1 }).z0;
    const analytic = (20 / Math.LN10) * ((rs / w) * (1 + gap / w)) / (2 * z0);
    const r = striplineLoss({ widthM: w, planeSpacingM: b, thicknessM: t, epsilonR: 1, frequencyHz: f });
    expect(Math.abs(r.alphaConductorDbPerM - analytic) / analytic).toBeLessThan(0.05);
  });

  it("conductor loss ∝ √f and grows when the strip nears a plane", () => {
    const at = (f: number) => striplineLoss({ ...g, frequencyHz: f }).alphaConductorDbPerM;
    expect(at(4e9) / at(1e9)).toBeCloseTo(2, 3);
    const centered = striplineLoss({ ...g, frequencyHz: 1e9 }).alphaConductorDbPerM;
    const off = striplineLoss({ ...g, offsetM: 0.15e-3, frequencyHz: 1e9 }).alphaConductorDbPerM;
    expect(off).toBeGreaterThan(centered); // current crowds toward the near plane
  });

  it("50 Ω FR4 stripline at 1 GHz: sane magnitudes, dielectric-limited", () => {
    const r = striplineLoss({ ...g, frequencyHz: 1e9, tanDelta: 0.02 });
    expect(r.alphaConductorDbPerM).toBeGreaterThan(0.5);
    expect(r.alphaConductorDbPerM).toBeLessThan(5);
    expect(r.alphaDielectricDbPerM).toBeGreaterThan(r.alphaConductorDbPerM);
  });
});
