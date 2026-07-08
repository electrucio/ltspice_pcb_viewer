import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parsePcb, type Pcb, type Pad, type Footprint } from "../../kicad_pcb_viewer/src/parser/pcb.js";
import { initRuppert } from "../../pcb_mesh/src/mesh/ruppert.js";
import { sheetResistance, viaBarrelResistance, CORNER_SQUARES } from "../../analytic_models/src/index.js";
import { solveNetResistance } from "../src/solve.js";

beforeAll(async () => {
  const wasm = readFileSync(fileURLToPath(new URL("../../geometry_core/pkg/geometry_core_bg.wasm", import.meta.url)));
  await initRuppert({ module_or_path: wasm });
});

const T = 35e-6; // 1 oz copper, m
const RS = sheetResistance(T); // Ω/sq at 20 °C

function pad(ref: string, x: number, y: number, w: number, h: number): Pad {
  return {
    ref, number: "1", shape: "rect", thruHole: false, pos: { x, y }, size: { w, h },
    angle: 0, rratio: 0.25, layers: ["F.Cu"], net: "N1",
  };
}
function fp(pads: Pad[]): Footprint {
  return { ref: pads[0]!.ref, symbolUuid: "", value: "", pos: { x: 0, y: 0 }, angle: 0, layer: "F.Cu", pads, graphics: [], refPos: { x: 0, y: 0 }, refLayer: "F.SilkS" };
}
function zonePcb(pts: Array<[number, number]>, pads: Pad[]): Pcb {
  return {
    footprints: pads.map((p) => fp([p])),
    tracks: [], vias: [],
    zones: [{ layer: "F.Cu", net: "N1", pts: pts.map(([x, y]) => ({ x, y })) }],
    graphics: [], texts: [], nets: ["N1"], layers: ["F.Cu"], copperStack: ["F.Cu"],
    bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  };
}

// 10×1 mm strip; full-width terminal pads (0.2×1) centered on the ends → the field
// between the terminal faces is exactly 1-D, so R is analytic up to the terminal inset
const strip = () =>
  zonePcb([[0, 0], [10, 0], [10, 1], [0, 1]], [pad("A", 0.1, 0.5, 0.2, 1), pad("B", 9.9, 0.5, 0.2, 1)]);

const OPTS = { refinement: "ruppert" as const, copperThicknessM: T };

let poweramp: Pcb | undefined;
function pcbFixture(): Pcb {
  poweramp ??= parsePcb(
    readFileSync(fileURLToPath(new URL("../../kicad_pcb_viewer/test/fixtures/poweramp.kicad_pcb", import.meta.url)), "utf8"),
  );
  return poweramp;
}

describe("M4 acceptance vs the M0 oracle", () => {
  it("straight strip: R = ρ·L/(W·t) within 0.5% (spec test)", () => {
    const r = solveNetResistance(strip(), "N1", "A.1", "B.1", { ...OPTS, maxEdgeLength: 0.2 });
    // terminal rings are the pads uniformly inset 0.02 → facing edges at x = 0.18 / 9.82
    const expected = RS * (9.82 - 0.18);
    expect(r.relResidual).toBeLessThan(1e-10);
    expect(r.conservationError).toBeLessThan(1e-8);
    expect(Math.abs(r.resistance - expected) / expected).toBeLessThan(0.005);
  });

  it("L-bend: the corner is worth 0.56 squares (Jaeger) — the loop closes", () => {
    // legs 1 mm wide: horizontal x∈[0,10],y∈[0,1]; corner square x∈[9,10],y∈[0,1];
    // vertical x∈[9,10],y∈[1,10]
    const bend = zonePcb(
      [[0, 0], [10, 0], [10, 10], [9, 10], [9, 1], [0, 1]],
      [pad("A", 0.1, 0.5, 0.2, 1), pad("B", 9.5, 9.9, 1, 0.2)],
    );
    const r = solveNetResistance(bend, "N1", "A.1", "B.1", { ...OPTS, maxEdgeLength: 0.15 });
    // straight squares: (9 − 0.18) horizontal + (9.82 − 1) vertical, + the corner
    const squares = (9 - 0.18) + (9.82 - 1) + CORNER_SQUARES;
    expect(Math.abs(r.resistance / RS - squares)).toBeLessThan(0.15); // ±0.15 sq on ~18.2
  });

  it("mesh refinement changes the answer by <1% (stability, pre-Richardson)", () => {
    const bend = zonePcb(
      [[0, 0], [10, 0], [10, 10], [9, 10], [9, 1], [0, 1]],
      [pad("A", 0.1, 0.5, 0.2, 1), pad("B", 9.5, 9.9, 1, 0.2)],
    );
    const coarse = solveNetResistance(bend, "N1", "A.1", "B.1", { ...OPTS, maxEdgeLength: 0.4 });
    const fine = solveNetResistance(bend, "N1", "A.1", "B.1", { ...OPTS, maxEdgeLength: 0.2 });
    expect(Math.abs(coarse.resistance - fine.resistance) / fine.resistance).toBeLessThan(0.01);
  });

  it("reciprocity: R(A→B) == R(B→A)", () => {
    const a = solveNetResistance(strip(), "N1", "A.1", "B.1", { ...OPTS, maxEdgeLength: 0.3 });
    const b = solveNetResistance(strip(), "N1", "B.1", "A.1", { ...OPTS, maxEdgeLength: 0.3 });
    expect(Math.abs(a.resistance - b.resistance) / a.resistance).toBeLessThan(1e-9);
  });

  it("temperature scaling propagates from M0", () => {
    const r20 = solveNetResistance(strip(), "N1", "A.1", "B.1", { ...OPTS, maxEdgeLength: 0.3 });
    const r70 = solveNetResistance(strip(), "N1", "A.1", "B.1", { ...OPTS, maxEdgeLength: 0.3, tempC: 70 });
    expect(r70.resistance / r20.resistance).toBeCloseTo(1 + 0.00393 * 50, 6);
  });

  it("errors clearly on disconnected terminals", () => {
    const twoIslands = zonePcb(
      [[0, 0], [4, 0], [4, 1], [0, 1]],
      [pad("A", 0.1, 0.5, 0.2, 1), pad("B", 9.9, 0.5, 0.2, 1)], // B off the copper
    );
    expect(() => solveNetResistance(twoIslands, "N1", "A.1", "B.1", { ...OPTS, maxEdgeLength: 0.3 })).toThrow(
      /not found|not connected/,
    );
  });
});

describe("real board (poweramp)", () => {
  const pcb = parsePcb(
    readFileSync(fileURLToPath(new URL("../../kicad_pcb_viewer/test/fixtures/poweramp.kicad_pcb", import.meta.url)), "utf8"),
  );

  it("/POW1: plausible R and clean solve quality", () => {
    const r = solveNetResistance(pcb, "/POW1", "R2.1", "R9.1", { ...OPTS, maxEdgeLength: 0.5 });
    expect(r.layers).toContain("B.Cu");
    expect(r.layers).toContain("F.Cu");
    expect(r.relResidual).toBeLessThan(1e-10);
    expect(r.conservationError).toBeLessThan(1e-6);
    // measured 3.8 mΩ ≈ counting-squares for the ~9 mm / 1.2 mm subpath (3.7 mΩ) —
    // band is a regression guard, not an oracle
    expect(r.resistance).toBeGreaterThan(1e-3);
    expect(r.resistance).toBeLessThan(0.05);
  });

  it("cross-layer stitching: a pair disconnected on B.Cu alone solves through F.Cu", () => {
    const pads = ["C14.1", "R2.1", "R26.2", "R9.1"];
    // find a pair that B.Cu-only CANNOT connect (the net has 2 islands there)
    let pair: [string, string] | null = null;
    outer: for (let i = 0; i < pads.length; i++)
      for (let j = i + 1; j < pads.length; j++) {
        try {
          solveNetResistance(pcb, "/POW1", pads[i]!, pads[j]!, { ...OPTS, maxEdgeLength: 0.7, layers: ["B.Cu"] });
        } catch {
          pair = [pads[i]!, pads[j]!];
          break outer;
        }
      }
    expect(pair, "expected at least one pad pair split across B.Cu islands").not.toBeNull();
    // the full stack (THT pads + vias shorting layers) must connect it
    const r = solveNetResistance(pcb, "/POW1", pair![0], pair![1], { ...OPTS, maxEdgeLength: 0.5 });
    expect(Number.isFinite(r.resistance)).toBe(true);
    expect(r.resistance).toBeGreaterThan(1e-4);
    expect(r.resistance).toBeLessThan(0.1);
    expect(r.relResidual).toBeLessThan(1e-10);
  });

  it("via-in-pad: a B.Cu pad stacked on a through via reaches F.Cu copper (jetson J18.D21 case)", () => {
    // On B.Cu the via merges into the pad terminal ("A.1+via@…"); on F.Cu it is plain
    // "via@…". Cross-layer stitching must match by MEMBER id — matching the merged
    // display id reported these terminals "not connected".
    const viaInPad: Pcb = {
      footprints: [
        fp([{ ...pad("A", 1, 0.5, 0.8, 0.8), layers: ["B.Cu"] }]),
        fp([{ ...pad("B", 9, 0.5, 0.8, 0.8) }]),
      ],
      tracks: [{ start: { x: 1, y: 0.5 }, end: { x: 9, y: 0.5 }, width: 0.5, layer: "F.Cu", net: "N1" }],
      vias: [{ pos: { x: 1, y: 0.5 }, size: 0.45, drill: 0.2, layers: ["F.Cu", "B.Cu"], net: "N1" }],
      zones: [], graphics: [], texts: [], nets: ["N1"],
      layers: ["F.Cu", "B.Cu"], copperStack: ["F.Cu", "B.Cu"],
      bbox: { minX: 0, minY: 0, maxX: 10, maxY: 1 },
    };
    const r = solveNetResistance(viaInPad, "N1", "A.1", "B.1", { ...OPTS, maxEdgeLength: 0.2 });
    // ~8 mm of 0.5 mm F.Cu trace ≈ 16 squares plus the lumped via barrel (~3 RS
    // at the default 1.6 mm board) — loose band
    expect(r.resistance).toBeGreaterThan(10 * RS);
    expect(r.resistance).toBeLessThan(24 * RS);
    expect(r.relResidual).toBeLessThan(1e-10);
    expect(r.conservationError).toBeLessThan(1e-8);
    expect(r.layers).toEqual(["F.Cu", "B.Cu"]);
  });
});

describe("lumped via barrels", () => {
  // pad A stacked on a through via on B.Cu; all current crosses exactly one barrel
  // and continues on the F.Cu trace to pad B — pure series composition
  const twoLayer = (): Pcb => ({
    footprints: [
      fp([{ ...pad("A", 1, 0.5, 0.8, 0.8), layers: ["B.Cu"] }]),
      fp([{ ...pad("B", 9, 0.5, 0.8, 0.8) }]),
    ],
    tracks: [{ start: { x: 1, y: 0.5 }, end: { x: 9, y: 0.5 }, width: 0.5, layer: "F.Cu", net: "N1" }],
    vias: [{ pos: { x: 1, y: 0.5 }, size: 0.45, drill: 0.2, layers: ["F.Cu", "B.Cu"], net: "N1" }],
    zones: [], graphics: [], texts: [], nets: ["N1"],
    layers: ["F.Cu", "B.Cu"], copperStack: ["F.Cu", "B.Cu"],
    bbox: { minX: 0, minY: 0, maxX: 10, maxY: 1 },
  });

  it("adds exactly one analytic barrel in series (default 1.6 mm board)", () => {
    const shorted = solveNetResistance(twoLayer(), "N1", "A.1", "B.1", { ...OPTS, maxEdgeLength: 0.2, lumpedVias: false });
    const lumped = solveNetResistance(twoLayer(), "N1", "A.1", "B.1", { ...OPTS, maxEdgeLength: 0.2 });
    const barrel = viaBarrelResistance({ finishedHoleDiameter: 0.2e-3, platingThickness: 25e-6, length: 1.6e-3 });
    expect(lumped.resistance - shorted.resistance).toBeCloseTo(barrel, 9);
    expect(shorted.viaCurrents).toBeUndefined();
    // the single via carries 100% of the current
    expect(lumped.viaCurrents!).toHaveLength(1);
    const vc = lumped.viaCurrents![0]!;
    expect(vc.id).toBe("via@1,0.5");
    expect([vc.fromLayer, vc.toLayer].sort()).toEqual(["B.Cu", "F.Cu"]);
    expect(Math.abs(vc.current) * lumped.resistance).toBeCloseTo(1, 6);
  });

  it("takes the barrel length from the stackup dielectric span", () => {
    const stackup: Pcb["stackup"] = [
      { name: "F.Cu", type: "copper", thicknessMm: 0.035 },
      { name: "dielectric 1", type: "core", thicknessMm: 0.51 },
      { name: "B.Cu", type: "copper", thicknessMm: 0.035 },
    ];
    const shorted = solveNetResistance({ ...twoLayer(), stackup }, "N1", "A.1", "B.1", { ...OPTS, maxEdgeLength: 0.2, lumpedVias: false });
    const lumped = solveNetResistance({ ...twoLayer(), stackup }, "N1", "A.1", "B.1", { ...OPTS, maxEdgeLength: 0.2 });
    const barrel = viaBarrelResistance({ finishedHoleDiameter: 0.2e-3, platingThickness: 25e-6, length: 0.51e-3 });
    expect(lumped.resistance - shorted.resistance).toBeCloseTo(barrel, 9);
  });
});

describe("stackup-driven copper thickness", () => {
  const stripStackup = (tMm: number): Pcb => ({
    ...strip(),
    stackup: [
      { name: "F.Cu", type: "copper", thicknessMm: tMm },
      { name: "dielectric 1", type: "core", thicknessMm: 1.51, epsilonR: 4.5, lossTangent: 0.02, material: "FR4" },
      { name: "B.Cu", type: "copper", thicknessMm: tMm },
    ],
  });
  const NO_T = { refinement: "ruppert" as const, maxEdgeLength: 0.2 }; // no copperThicknessM

  it("solver reads per-layer thickness from the stackup (2 oz halves R vs 1 oz)", () => {
    const r35 = solveNetResistance(stripStackup(0.035), "N1", "A.1", "B.1", NO_T);
    const r70 = solveNetResistance(stripStackup(0.07), "N1", "A.1", "B.1", NO_T);
    expect(r35.resistance / r70.resistance).toBeCloseTo(2, 3);
    expect(Math.abs(r35.resistance - RS * (9.82 - 0.18)) / (RS * (9.82 - 0.18))).toBeLessThan(0.005);
  });

  it("falls back to 35 µm without a stackup; explicit option overrides everything", () => {
    const noStackup = solveNetResistance(strip(), "N1", "A.1", "B.1", NO_T);
    const r35 = solveNetResistance(stripStackup(0.035), "N1", "A.1", "B.1", NO_T);
    expect(noStackup.resistance).toBeCloseTo(r35.resistance, 12);
    const forced = solveNetResistance(stripStackup(0.07), "N1", "A.1", "B.1", { ...NO_T, copperThicknessM: 35e-6 });
    expect(forced.resistance).toBeCloseTo(r35.resistance, 12);
  });
});

describe("M0 estimate vs FEM (double-check role)", () => {
  it("straight strip: estimate has no track path (zone-only) → null, FEM stands alone", async () => {
    const { estimateResistance } = await import("../src/estimate.js");
    expect(estimateResistance(strip(), "N1", "A.1", "B.1")).toBeNull();
  });

  it("poweramp /POW1: estimate within 30% of FEM on a routed path", async () => {
    const { estimateResistance } = await import("../src/estimate.js");
    const est = estimateResistance(pcbFixture(), "/POW1", "R2.1", "R9.1")!;
    expect(est).not.toBeNull();
    const fem = solveNetResistance(pcbFixture(), "/POW1", "R2.1", "R9.1", { ...OPTS, maxEdgeLength: 0.5 });
    // single-path counting squares ignores spreading/parallel copper — expect
    // same order, estimate ≥ FEM-ish
    expect(est.resistance).toBeGreaterThan(fem.resistance * 0.7);
    expect(est.resistance).toBeLessThan(fem.resistance * 1.6);
  });

  it("solver returns the field when asked and it is consistent", () => {
    const r = solveNetResistance(strip(), "N1", "A.1", "B.1", { ...OPTS, maxEdgeLength: 0.3, returnField: true });
    expect(r.field!.length).toBeGreaterThan(0);
    const f = r.field![0]!;
    expect(f.potential.length).toBe(f.vertices.length / 2);
    expect(f.currentDensity.length).toBe(f.triangles.length / 3);
    // 1-D strip: |J| is uniform → median · width == total current I = V/R
    const mid = [...f.currentDensity].filter((j) => j > 0).sort((a, b) => a - b);
    const median = mid[Math.floor(mid.length / 2)]!;
    expect(Math.abs(median * 1 - 1 / r.resistance) / (1 / r.resistance)).toBeLessThan(0.02);
  });
});
