/**
 * analytic_models — M0 of the parasitic-extraction engine: closed-form/empirical PCB
 * formulas as pure, zero-dependency TypeScript. Three roles (per project plan):
 * (a) test oracle for the field solvers (M4–M7), (b) instant UI estimates,
 * (c) runtime sanity monitor for solver results.
 *
 * Implemented so far: the **DC-resistance slice** (oracle for M4).
 * Future slices land with their consuming solver: Hammerstad–Jensen/Wheeler (M5),
 * parallel-plate + fringing C (M6), Grover / via L / Bessel skin effect (M7).
 *
 * All SI units. No board-mm anywhere in this module.
 */

export { RHO_COPPER_20C, ALPHA_COPPER, COPPER_REF_TEMP_C, CORNER_SQUARES } from "./constants.js";
export {
  copperResistivity,
  sheetResistance,
  traceResistance,
  resistanceFromSquares,
  pathSquares,
  viaBarrelResistance,
} from "./dc.js";
export type { TraceGeometry, ViaBarrelGeometry } from "./dc.js";
