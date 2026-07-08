import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stripline, striplineCohnExact, C0 } from "../src/index.js";

/**
 * Fixtures minted from KiCad 9's stripline transcription (Cohn-lineage practical
 * model), compiled verbatim in a local harness (scratchpad stripline-reference.c)
 * over a (w, b, t, offset, εr) grid — dimensions there are mm (model is
 * scale-invariant; we feed metres by scaling 1e-3).
 */
const fixtures: Array<{ w: number; h: number; t: number; a: number; er: number; z0: number }> = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/stripline-kicad9.json", import.meta.url)), "utf8"),
);

const MM = 1e-3;

describe("practical stripline vs the KiCad-9 transcription", () => {
  it(`matches all ${fixtures.length} fixture rows (1e-12; degenerate-t rows 1e-8)`, () => {
    // the t = 1e-9 mm rows (the reference NaNs at exactly t = 0) hit float
    // cancellation in log(s²/(s−t)² − 1), amplifying rounding-order noise
    for (const f of fixtures) {
      const tol = f.t < 1e-6 ? 1e-8 : 1e-12;
      const r = stripline({ widthM: f.w * MM, planeSpacingM: f.h * MM, thicknessM: f.t * MM, offsetM: f.a * MM, epsilonR: f.er });
      expect(Math.abs(r.z0 - f.z0) / f.z0, `w=${f.w} h=${f.h} t=${f.t} a=${f.a} er=${f.er}`).toBeLessThan(tol);
    }
  });
});

describe("Cohn exact solution as oracle", () => {
  it("practical model agrees with the EXACT conformal mapping (t=0, centered) within 1.5%", () => {
    for (const er of [1, 4.5]) {
      for (const wOverB of [0.2, 0.5, 1, 2, 4]) {
        const b = 1e-3, w = wOverB * b;
        const exact = striplineCohnExact(w, b, er);
        const approx = stripline({ widthM: w, planeSpacingM: b, epsilonR: er }).z0;
        expect(Math.abs(approx - exact) / exact, `w/b=${wOverB} er=${er} (exact ${exact.toFixed(2)})`).toBeLessThan(0.015);
      }
    }
  });

  it("exact solution approaches the parallel-plate limit η0·b/(4w√εr) for wide strips", () => {
    const b = 1e-3, er = 4;
    // fringing decays like ln2/(πw/2b): ≈0.9% at w/b = 50, ≈0.2% at w/b = 200
    for (const [wOverB, tol] of [[50, 0.01], [200, 0.0025]] as const) {
      const w = wOverB * b;
      const limit = (376.730313668 * b) / (4 * w * Math.sqrt(er));
      expect(Math.abs(striplineCohnExact(w, b, er) - limit) / limit).toBeLessThan(tol);
    }
  });

  it("exact solution scales as 1/√εr exactly (homogeneous line)", () => {
    const z1 = striplineCohnExact(0.5e-3, 1e-3, 1);
    const z4 = striplineCohnExact(0.5e-3, 1e-3, 4);
    expect(z4 * 2).toBeCloseTo(z1, 10);
  });
});

describe("physical properties", () => {
  it("centered default equals explicit center; symmetric in the offset", () => {
    const g = { widthM: 0.2e-3, planeSpacingM: 1e-3, thicknessM: 35e-6, epsilonR: 4.5 };
    const centered = stripline(g).z0;
    expect(stripline({ ...g, offsetM: (1e-3 - 35e-6) / 2 }).z0).toBeCloseTo(centered, 12);
    const off = 0.3e-3;
    const mirror = 1e-3 - 0.3e-3 - 35e-6;
    expect(stripline({ ...g, offsetM: off }).z0).toBeCloseTo(stripline({ ...g, offsetM: mirror }).z0, 12);
  });

  it("Z0 falls with width, falls toward a nearer plane, falls with thickness", () => {
    const base = { planeSpacingM: 1e-3, epsilonR: 4.5, thicknessM: 35e-6 };
    expect(stripline({ ...base, widthM: 0.1e-3 }).z0).toBeGreaterThan(stripline({ ...base, widthM: 0.3e-3 }).z0);
    const cen = stripline({ ...base, widthM: 0.2e-3 }).z0;
    const off = stripline({ ...base, widthM: 0.2e-3, offsetM: 0.15e-3 }).z0;
    expect(off).toBeLessThan(cen); // closer to one plane → more capacitance → lower Z0
    expect(stripline({ ...base, widthM: 0.2e-3, thicknessM: 70e-6 }).z0).toBeLessThan(cen);
  });

  it("εeff = εr, delay = √εr/c0, RLGC identities hold", () => {
    const r = stripline({ widthM: 0.2e-3, planeSpacingM: 0.96e-3, thicknessM: 35e-6, epsilonR: 4.5 });
    expect(r.epsEff).toBe(4.5);
    expect(r.delaySPerM).toBeCloseTo(Math.sqrt(4.5) / C0, 15);
    expect(Math.sqrt(r.inductanceHPerM / r.capacitanceFPerM)).toBeCloseTo(r.z0, 9);
  });

  it("rejects impossible geometry (strip not between the planes)", () => {
    expect(() => stripline({ widthM: 0.2e-3, planeSpacingM: 0.1e-3, thicknessM: 0.2e-3, epsilonR: 4 })).toThrow();
    expect(() => stripline({ widthM: 0.2e-3, planeSpacingM: 1e-3, offsetM: 1.1e-3, epsilonR: 4 })).toThrow();
  });

  it("engineering sanity: 50 Ω inner-layer stripline on FR4 (~0.4 mm wide in 1 mm)", () => {
    // b = 1 mm, εr 4.5, t 18 µm → 50 Ω at w ≈ 0.40 mm (w/b ≈ 0.4, the classic ratio)
    const r = stripline({ widthM: 0.4e-3, planeSpacingM: 1e-3, thicknessM: 18e-6, epsilonR: 4.5 });
    expect(r.z0).toBeGreaterThan(48);
    expect(r.z0).toBeLessThan(52);
  });
});
