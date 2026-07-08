/**
 * Two-mesh error estimate (spec: "every number ships with an error estimate").
 *
 * Solve at the requested mesh size h and again at h/2; report the FINE result with
 * a CONSERVATIVE error bound |R(h) − R(h/2)| — deliberately not the Richardson
 * asymptotic |Δ|/3: Ruppert meshes are not exactly h-parameterized, so we do not
 * assume the O(h²) constant. Tests verify the bound actually brackets the analytic
 * truth. `converged: false` (relError > 5%) means the number should be shown as
 * unconverged — the tool knows when it doesn't know.
 */

import type { Pcb } from "../../kicad_pcb_viewer/src/parser/pcb.js";
import { solveNetResistance, type SolveOptions, type SolveResult } from "./solve.js";

export interface ErrorEstimateResult extends SolveResult {
  /** conservative error bound |R(h) − R(h/2)|, Ω */
  errorEstimate: number;
  /** errorEstimate / resistance */
  relError: number;
  /** relError ≤ 5% — render anything else as unconverged */
  converged: boolean;
  /** the coarse-mesh resistance (the reported `resistance` is the fine one) */
  coarseResistance: number;
}

export function solveWithErrorEstimate(
  pcb: Pcb,
  net: string,
  terminalA: string,
  terminalB: string,
  options: SolveOptions & { maxEdgeLength: number },
): ErrorEstimateResult {
  const h = options.maxEdgeLength;
  if (!Number.isFinite(h) || !(h > 0)) throw new Error("solveWithErrorEstimate needs a finite maxEdgeLength");
  const coarse = solveNetResistance(pcb, net, terminalA, terminalB, { ...options, returnField: false });
  const fine = solveNetResistance(pcb, net, terminalA, terminalB, { ...options, maxEdgeLength: h / 2 });
  const errorEstimate = Math.abs(fine.resistance - coarse.resistance);
  const relError = errorEstimate / Math.abs(fine.resistance);
  return { ...fine, errorEstimate, relError, converged: relError <= 0.05, coarseResistance: coarse.resistance };
}
