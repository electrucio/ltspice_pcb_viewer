/**
 * solver_rdc — M4 of the parasitic-extraction engine: DC resistance of real board
 * copper. Linear-triangle FEM on pcb_mesh's terminal-tagged quality meshes; pads and
 * vias are equipotential terminals; THT pads short layers, vias couple them through
 * lumped analytic barrel resistances (stackup-derived lengths).
 *
 *   await initRuppert();                       // once (pcb_mesh WASM mesher)
 *   const r = solveWithErrorEstimate(pcb, "/POW1", "R2.1", "C14.1", { maxEdgeLength: 0.5 });
 *   // r.resistance ± r.errorEstimate [Ω], r.converged, r.relResidual, r.viaCurrents
 */

export { solveNetResistance } from "./solve.js";
export type { SolveOptions, SolveResult, LayerField, ViaCurrent } from "./solve.js";
export { solveWithErrorEstimate } from "./richardson.js";
export type { ErrorEstimateResult } from "./richardson.js";
export { estimateResistance } from "./estimate.js";
export type { EstimateOptions, EstimateResult } from "./estimate.js";
export { analyzeNetRlgc } from "./rlgc.js";
export type { RlgcOptions, RlgcSegment, RlgcResult } from "./rlgc.js";
export { assembleStiffness, conjugateGradient, UnionFind } from "./fem.js";
export type { SparseRows, CgResult } from "./fem.js";
