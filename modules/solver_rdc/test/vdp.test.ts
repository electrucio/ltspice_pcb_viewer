/**
 * van der Pauw property test — a shape-independent, parameter-free FEM oracle.
 *
 * For ANY simply-connected homogeneous sheet with four (small) contacts 1,2,3,4 in
 * cyclic order on its boundary:
 *
 *     exp(−π·R_12,34 / Rs) + exp(−π·R_23,41 / Rs) = 1
 *
 * where R_12,34 = (V4 − V3)/I_12 (current driven 1→2, voltage read at the passive
 * pair). This catches assembly/mesh/solver errors on arbitrary geometry, where
 * closed-form fixtures can't reach. Finite contacts perturb the identity by
 * ~(contact/sample)², so contacts here are ~0.4 mm on ~10 mm shapes.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Pcb, Pad, Footprint } from "../../kicad_pcb_viewer/src/parser/pcb.js";
import { initRuppert } from "../../pcb_mesh/src/mesh/ruppert.js";
import { sheetResistance } from "../../analytic_models/src/index.js";
import { solveNetResistance } from "../src/solve.js";

beforeAll(async () => {
  const wasm = readFileSync(fileURLToPath(new URL("../../geometry_core/pkg/geometry_core_bg.wasm", import.meta.url)));
  await initRuppert({ module_or_path: wasm });
});

const T = 35e-6;
const RS = sheetResistance(T);
const OPTS = { refinement: "ruppert" as const, copperThicknessM: T, maxEdgeLength: 0.35 };

function pad(ref: string, x: number, y: number): Pad {
  return { ref, number: "1", shape: "rect", thruHole: false, pos: { x, y }, size: { w: 0.4, h: 0.4 }, angle: 0, rratio: 0.25, layers: ["F.Cu"], net: "N1" };
}
function fp(p: Pad): Footprint {
  return { ref: p.ref, symbolUuid: "", value: "", pos: { x: 0, y: 0 }, angle: 0, layer: "F.Cu", pads: [p], graphics: [], refPos: { x: 0, y: 0 }, refLayer: "F.SilkS" };
}
function sheet(outline: Array<[number, number]>, contacts: Array<[string, number, number]>): Pcb {
  return {
    footprints: contacts.map(([ref, x, y]) => fp(pad(ref, x, y))),
    tracks: [], vias: [],
    zones: [{ layer: "F.Cu", net: "N1", pts: outline.map(([x, y]) => ({ x, y })) }],
    graphics: [], texts: [], nets: ["N1"], layers: ["F.Cu"], copperStack: ["F.Cu"], copperLayerTypes: {},
    bbox: { minX: 0, minY: 0, maxX: 12, maxY: 12 },
  };
}

/** R_(ab),(cd) = (V_d − V_c)/I with 1 V driven a→b. */
function fourPoint(pcb: Pcb, a: string, b: string, c: string, d: string): number {
  const r = solveNetResistance(pcb, "N1", `${a}.1`, `${b}.1`, OPTS);
  expect(r.relResidual).toBeLessThan(1e-10);
  const pot = (ref: string): number => {
    const t = r.terminalPotentials.find((t) => t.id === `${ref}.1`);
    expect(t, `terminal ${ref}`).toBeDefined();
    return t!.potential;
  };
  const i = 1 / r.resistance; // 1 V drive
  return (pot(d) - pot(c)) / i;
}

function vdpSum(pcb: Pcb, order: [string, string, string, string]): number {
  const [c1, c2, c3, c4] = order;
  const r1 = Math.abs(fourPoint(pcb, c1, c2, c3, c4));
  const r2 = Math.abs(fourPoint(pcb, c2, c3, c4, c1));
  return Math.exp((-Math.PI * r1) / RS) + Math.exp((-Math.PI * r2) / RS);
}

describe("van der Pauw identity", () => {
  it("square with corner contacts: identity holds AND R matches Rs·ln2/π", () => {
    const s = sheet(
      [[0, 0], [10, 0], [10, 10], [0, 10]],
      [["P1", 0.3, 0.3], ["P2", 9.7, 0.3], ["P3", 9.7, 9.7], ["P4", 0.3, 9.7]],
    );
    const r1 = Math.abs(fourPoint(s, "P1", "P2", "P3", "P4"));
    // symmetric square: R_12,34 = Rs·ln2/π exactly (point contacts)
    expect(Math.abs(r1 - (RS * Math.LN2) / Math.PI) / ((RS * Math.LN2) / Math.PI)).toBeLessThan(0.03);
    expect(Math.abs(vdpSum(s, ["P1", "P2", "P3", "P4"]) - 1)).toBeLessThan(0.02);
  });

  it("asymmetric blob with uneven contacts: the identity still holds", () => {
    const s = sheet(
      [[0, 2], [4, 0], [11, 1], [12, 6], [8, 11], [2, 9]],
      [["P1", 2.1, 1.2], ["P2", 10.6, 1.4], ["P3", 10.9, 6.1], ["P4", 2.6, 8.5]],
    );
    expect(Math.abs(vdpSum(s, ["P1", "P2", "P3", "P4"]) - 1)).toBeLessThan(0.02);
  });
});
