/**
 * Web Worker shell around solve-core: keeps the (up to ~40 s on ground pours) FEM
 * solve off the main thread. Cancel = terminate the worker; the host recreates it
 * lazily. All physics lives in solve-core.ts (tested headless).
 */

import { runSolve, type SolveRequest, type SolveSuccess, type SolveStage } from "./solve-core.js";

export type WorkerReply =
  | { id: number; kind: "progress"; stage: SolveStage }
  | SolveSuccess
  | { id: number; kind: "error"; message: string };

self.onmessage = async (e: MessageEvent<SolveRequest>) => {
  const req = e.data;
  try {
    const result = await runSolve(req, (stage) => {
      self.postMessage({ id: req.id, kind: "progress", stage } satisfies WorkerReply);
    });
    // transfer the big field buffers instead of copying them
    const transfer: Transferable[] = [];
    for (const f of result.field ?? []) {
      transfer.push(f.vertices.buffer, f.triangles.buffer, f.potential.buffer, f.currentDensity.buffer);
    }
    self.postMessage(result satisfies WorkerReply, { transfer });
  } catch (err) {
    self.postMessage({ id: req.id, kind: "error", message: err instanceof Error ? err.message : String(err) } satisfies WorkerReply);
  }
};
