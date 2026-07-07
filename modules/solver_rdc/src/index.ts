/**
 * solver_rdc — M4 of the parasitic-extraction engine: DC resistance of real board
 * copper. Linear-triangle FEM on pcb_mesh's terminal-tagged quality meshes; pads and
 * vias are equipotential terminals; THT pads/vias short layers together (lumped
 * via-barrel R from analytic_models is the flagged v2 refinement).
 *
 *   await initRuppert();                       // once (pcb_mesh WASM mesher)
 *   const r = solveNetResistance(pcb, "/POW1", "R2.1", "C14.1", { maxEdgeLength: 0.5 });
 *   // r.resistance [Ω], r.relResidual (check it), r.conservationError
 */

export { solveNetResistance } from "./solve.js";
export type { SolveOptions, SolveResult } from "./solve.js";
export { assembleStiffness, conjugateGradient, UnionFind } from "./fem.js";
export type { SparseRows, CgResult } from "./fem.js";
