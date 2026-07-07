import { describe, it, expect } from "vitest";
import {
  RHO_COPPER_20C,
  ALPHA_COPPER,
  CORNER_SQUARES,
  copperResistivity,
  sheetResistance,
  traceResistance,
  resistanceFromSquares,
  pathSquares,
  viaBarrelResistance,
} from "../src/index.js";

const MIL = 25.4e-6; // m
const MM = 1e-3;

describe("constants cross-checked against independent implementations", () => {
  it("matches pcb-toolkit / Saturn resistivity exactly", () => {
    // pcb-toolkit constants.rs: 1.724e-6 Ω·cm; Saturn factor 6.787e-4 Ω·mil (rounded)
    expect(RHO_COPPER_20C).toBeCloseTo(1.724e-6 * 1e-2, 15); // Ω·cm → Ω·m
    expect(RHO_COPPER_20C / MIL).toBeCloseTo(6.787e-4, 7); // Saturn's rounded ohm-mil factor
    expect(ALPHA_COPPER).toBe(0.00393); // pcb-toolkit constants.rs:20
  });

  it("1 oz copper (35 µm) sheet resistance lands on the published ~0.5 mΩ/sq", () => {
    expect(sheetResistance(35e-6)).toBeGreaterThan(0.45e-3);
    expect(sheetResistance(35e-6)).toBeLessThan(0.55e-3);
  });
});

describe("trace resistance vs pcb-toolkit fixtures", () => {
  // Fixtures generated from the reverse-engineered Saturn implementation:
  //   ~/git/pcb-toolkit$ ./target/debug/pcb-toolkit current <args> --json
  // pcb-toolkit uses the ROUNDED factor 6.787e-4 Ω·mil (vs our exact
  // 1.724e-8/2.54e-5 = 6.7874015…e-4), hence the 1e-4 relative tolerance.
  const fixtures: Array<{ args: string; w: number; t: number; l: number; r: number }> = [
    { args: "-w 10mil -t 1.4mil -l 1000mil", w: 10 * MIL, t: 1.4 * MIL, l: 1000 * MIL, r: 0.048478571428571426 },
    { args: "-w 0.2mm -t 0.035mm -l 100mm", w: 0.2 * MM, t: 0.035 * MM, l: 100 * MM, r: 0.2462711428571428 },
    { args: "-w 6mil -t 2.8mil -l 500mil", w: 6 * MIL, t: 2.8 * MIL, l: 500 * MIL, r: 0.020199404761904766 },
  ];
  for (const f of fixtures) {
    it(`pcb-toolkit current ${f.args}`, () => {
      const r = traceResistance({ length: f.l, width: f.w, thickness: f.t });
      expect(Math.abs(r - f.r) / f.r).toBeLessThan(1e-4);
    });
  }

  it("the project-spec example: 10 cm × 0.2 mm × 35 µm ≈ 0.2463 Ω", () => {
    // exact: 1.724e-8 · 0.1 / (0.2e-3 · 35e-6)
    const r = traceResistance({ length: 0.1, width: 0.2e-3, thickness: 35e-6 });
    expect(r).toBeCloseTo(0.24628571428571428, 12);
  });
});

describe("temperature model (circuitcalculator.com formula family)", () => {
  it("is the linear IACS model referenced at 20 °C", () => {
    expect(copperResistivity(20)).toBe(RHO_COPPER_20C);
    expect(copperResistivity(120)).toBeCloseTo(RHO_COPPER_20C * (1 + 0.393), 12);
    // linearity
    const r0 = copperResistivity(0), r40 = copperResistivity(40);
    expect((r0 + r40) / 2).toBeCloseTo(copperResistivity(20), 15);
  });

  it("propagates through trace resistance", () => {
    const g = { length: 0.1, width: 0.2e-3, thickness: 35e-6 };
    expect(traceResistance({ ...g, tempC: 70 }) / traceResistance(g)).toBeCloseTo(1 + ALPHA_COPPER * 50, 12);
  });
});

describe("squares counting", () => {
  it("straight trace: resistance from squares == ρL/(W·t) exactly", () => {
    const g = { length: 0.05, width: 0.5e-3, thickness: 35e-6 };
    expect(resistanceFromSquares(g.length / g.width, g.thickness)).toBeCloseTo(traceResistance(g), 15);
  });

  it("uniform in-plane scaling leaves resistance invariant (sheet-resistance law)", () => {
    for (const k of [0.1, 2, 37]) {
      const r1 = traceResistance({ length: 0.03, width: 0.3e-3, thickness: 35e-6 });
      const rk = traceResistance({ length: 0.03 * k, width: 0.3e-3 * k, thickness: 35e-6 });
      expect(rk).toBeCloseTo(r1, 12);
    }
  });

  it("a 90° corner adds 0.56 squares (Jaeger; M4 FEM will re-derive this)", () => {
    // L-shaped trace: two 10 mm legs of 1 mm width + one corner
    const sq = pathSquares([{ length: 10e-3, width: 1e-3 }, { length: 10e-3, width: 1e-3 }], 1);
    expect(sq).toBeCloseTo(20 + CORNER_SQUARES, 12);
    expect(CORNER_SQUARES).toBe(0.56);
  });
});

describe("via barrel resistance", () => {
  it("hand-derived annulus fixture: d=0.3 mm, wall 25 µm, L=1.6 mm ≈ 1.08 mΩ", () => {
    // A = π·t·(d+t) = π·25e-6·325e-6 = 2.55254e-8 m²; R = 1.724e-8·1.6e-3/A
    const r = viaBarrelResistance({ finishedHoleDiameter: 0.3e-3, platingThickness: 25e-6, length: 1.6e-3 });
    expect(r).toBeCloseTo((1.724e-8 * 1.6e-3) / (Math.PI * 25e-6 * 325e-6), 15);
    expect(r * 1000).toBeGreaterThan(1.0); // mΩ — the published "about 1 mΩ" ballpark
    expect(r * 1000).toBeLessThan(1.2);
  });

  it("scales linearly with length and inversely with wall thickness (thin-wall limit)", () => {
    const base = { finishedHoleDiameter: 0.3e-3, platingThickness: 20e-6, length: 1.6e-3 };
    expect(viaBarrelResistance({ ...base, length: 3.2e-3 })).toBeCloseTo(2 * viaBarrelResistance(base), 12);
    // doubling a thin wall roughly halves R (up to the (d+t) term)
    const ratio = viaBarrelResistance(base) / viaBarrelResistance({ ...base, platingThickness: 40e-6 });
    expect(ratio).toBeGreaterThan(1.9);
    expect(ratio).toBeLessThan(2.2);
  });

  it("rejects nonsense input", () => {
    expect(() => viaBarrelResistance({ finishedHoleDiameter: 0, platingThickness: 25e-6, length: 1e-3 })).toThrow();
    expect(() => traceResistance({ length: 1, width: -1, thickness: 35e-6 })).toThrow();
    expect(() => sheetResistance(0)).toThrow();
  });
});
