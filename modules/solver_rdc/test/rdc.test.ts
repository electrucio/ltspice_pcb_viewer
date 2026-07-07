import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parsePcb, type Pcb, type Pad, type Footprint } from "../../kicad_pcb_viewer/src/parser/pcb.js";
import { initRuppert } from "../../pcb_mesh/src/mesh/ruppert.js";
import { sheetResistance, CORNER_SQUARES } from "../../analytic_models/src/index.js";
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
    graphics: [], nets: ["N1"], layers: ["F.Cu"],
    bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  };
}

// 10×1 mm strip; full-width terminal pads (0.2×1) centered on the ends → the field
// between the terminal faces is exactly 1-D, so R is analytic up to the terminal inset
const strip = () =>
  zonePcb([[0, 0], [10, 0], [10, 1], [0, 1]], [pad("A", 0.1, 0.5, 0.2, 1), pad("B", 9.9, 0.5, 0.2, 1)]);

const OPTS = { refinement: "ruppert" as const, copperThicknessM: T };

describe("M4 acceptance vs the M0 oracle", () => {
  it("straight strip: R = ρ·L/(W·t) within 0.5% (spec test)", () => {
    const r = solveNetResistance(strip(), "N1", "A.1", "B.1", { ...OPTS, maxEdgeLength: 0.2 });
    // terminal rings are the pads inset ~0.02 → facing edges at x ≈ 0.196 / 9.804
    const expected = RS * (9.804 - 0.196);
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
    // straight squares: (9 − 0.196) horizontal + (9.804 − 1) vertical, + the corner
    const squares = (9 - 0.196) + (9.804 - 1) + CORNER_SQUARES;
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
});
