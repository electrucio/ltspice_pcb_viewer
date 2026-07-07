/**
 * Sweep the two triangle-count knobs for Ruppert meshing on the poweramp B.Cu layer:
 *   - simplifyTolerance (DP outline simplification, mm deviation bound)
 *   - min-area refinement floor (fraction of maxArea)
 * Reports triangle count, time, sliver stats, and the copper-area drift introduced by
 * simplification (vs the unsimplified outline).
 */
import { readFileSync } from "node:fs";
import { parsePcb } from "../../kicad_pcb_viewer/src/parser/pcb.js";
import { buildBoardMesh } from "../src/build.js";
import { initRuppert } from "../src/mesh/ruppert.js";

await initRuppert({
  module_or_path: readFileSync(new URL("../../geometry_core/pkg/geometry_core_bg.wasm", import.meta.url)),
});
const pcb = parsePcb(
  readFileSync(new URL("../../kicad_pcb_viewer/test/fixtures/poweramp.kicad_pcb", import.meta.url), "utf8"),
);

const exactArea = buildBoardMesh(pcb, { layers: ["B.Cu"], simplifyTolerance: 0 }).regions.reduce(
  (s, r) => s + r.outlineArea,
  0,
);
console.log(`unsimplified copper: ${exactArea.toFixed(3)} mm²  (h = 1 mm, refinement = ruppert)\n`);

for (const simplifyTolerance of [0, 0.005, 0.01, 0.02, 0.05]) {
  const t0 = performance.now();
  const mesh = buildBoardMesh(pcb, { layers: ["B.Cu"], maxEdgeLength: 1, refinement: "ruppert", simplifyTolerance });
  const ms = performance.now() - t0;
  const tris = mesh.regions.reduce((s, r) => s + r.quality.triangleCount, 0);
  const slivers = mesh.regions.reduce((s, r) => s + r.quality.sliverCount, 0);
  const area = mesh.regions.reduce((s, r) => s + r.meshArea, 0);
  const drift = ((area - exactArea) / exactArea) * 100;
  console.log(
    `simplify=${String(simplifyTolerance).padEnd(5)}  ${tris.toLocaleString("en").padStart(9)} tris  ${ms.toFixed(0).padStart(5)} ms  ` +
      `slivers ${String(slivers).padStart(4)}  removed ${mesh.report.simplifiedVertices.toLocaleString("en").padStart(6)} verts  ` +
      `area drift ${drift.toExponential(2)}%`,
  );
}
