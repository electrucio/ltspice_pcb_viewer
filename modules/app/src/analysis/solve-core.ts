/**
 * The FEM solve as a plain async function — the worker is a thin onmessage shell
 * around this, so the physics path is testable headless (vitest, no browser).
 *
 * Implements the two-mesh Richardson estimate inline (coarse h, fine h/2,
 * CONSERVATIVE |ΔR| bound — same contract as solver_rdc's solveWithErrorEstimate)
 * so a stage callback can report progress between the passes.
 */

import { parsePcb, type Pcb } from "../../../kicad_pcb_viewer/src/parser/pcb.js";
import { initRuppert } from "../../../pcb_mesh/src/mesh/ruppert.js";
import { solveNetResistance, type LayerField, type ViaCurrent } from "../../../solver_rdc/src/solve.js";
import { estimateResistance } from "../../../solver_rdc/src/estimate.js";

export interface SolveRequest {
  id: number;
  pcbText: string;
  net: string;
  padA: string;
  padB: string;
  /** coarse mesh size, mm; the fine pass runs at half (default 0.8) */
  maxEdgeLength?: number;
  /** include the per-layer field (for the current-density overlay) */
  wantField?: boolean;
}

export type SolveStage = "parsing board" | "initializing mesher" | "solving (coarse mesh)" | "solving (fine mesh)";

export interface SolveSuccess {
  id: number;
  kind: "done";
  resistance: number;
  errorEstimate: number;
  relError: number;
  converged: boolean;
  coarseResistance: number;
  viaCurrents?: ViaCurrent[];
  layers: string[];
  dofs: number;
  ms: number;
  /** M0 shortest-track-path estimate, null when the net connects through pours */
  estimate: { resistance: number; pathLengthMm: number; viaHops: number } | null;
  field?: LayerField[];
}

// parse cache: board texts are multi-MB and reused across solves
let cachedText: string | null = null;
let cachedPcb: Pcb | null = null;
let mesherReady = false;

export async function runSolve(
  req: SolveRequest,
  onStage: (stage: SolveStage) => void,
  /** test hook: pass the wasm bytes in node (browser fetches next to the pkg JS) */
  wasmInit?: Parameters<typeof initRuppert>[0],
): Promise<SolveSuccess> {
  if (!mesherReady) {
    onStage("initializing mesher");
    await initRuppert(wasmInit);
    mesherReady = true;
  }
  if (cachedText !== req.pcbText) {
    onStage("parsing board");
    cachedPcb = parsePcb(req.pcbText);
    cachedText = req.pcbText;
  }
  const pcb = cachedPcb!;
  const h = req.maxEdgeLength ?? 0.8;
  const t0 = performance.now();

  onStage("solving (coarse mesh)");
  const coarse = solveNetResistance(pcb, req.net, req.padA, req.padB, { maxEdgeLength: h, refinement: "ruppert" });
  onStage("solving (fine mesh)");
  const fine = solveNetResistance(pcb, req.net, req.padA, req.padB, {
    maxEdgeLength: h / 2,
    refinement: "ruppert",
    returnField: req.wantField ?? false,
  });

  const errorEstimate = Math.abs(fine.resistance - coarse.resistance);
  const relError = errorEstimate / Math.abs(fine.resistance);
  const est = estimateResistance(pcb, req.net, req.padA, req.padB);
  return {
    id: req.id,
    kind: "done",
    resistance: fine.resistance,
    errorEstimate,
    relError,
    converged: relError <= 0.05,
    coarseResistance: coarse.resistance,
    viaCurrents: fine.viaCurrents,
    layers: fine.layers,
    dofs: fine.dofs,
    ms: performance.now() - t0,
    estimate: est ? { resistance: est.resistance, pathLengthMm: est.pathLengthMm, viaHops: est.viaHops } : null,
    field: fine.field,
  };
}
