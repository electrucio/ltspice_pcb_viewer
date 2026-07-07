import { readFileSync } from "node:fs";
import { parsePcb } from "../../kicad_pcb_viewer/src/parser/pcb.js";
import { extractCopperRegions } from "../src/outline/copper.js";
import { triangulateQuality, } from "../src/mesh/delaunay.js";
import { dropDegenerate, refineToEdgeLength, meshArea } from "../src/mesh/triangulate.js";
import cdt2d from "cdt2d";

const pcb = parsePcb(readFileSync(new URL("../../kicad_pcb_viewer/test/fixtures/poweramp.kicad_pcb", import.meta.url), "utf8"));
const gnd = extractCopperRegions(pcb, { layers: ["B.Cu"], nets: ["0"], arcSegments: 24 })[0]!;

for (const h of [1, 0.5]) {
  let t0 = performance.now();
  const raw = triangulateQuality(gnd.polygons, h);
  const tQ = performance.now() - t0;
  t0 = performance.now();
  const refined = refineToEdgeLength(dropDegenerate(raw), h);
  const tR = performance.now() - t0;
  console.log(`h=${h}: quality ${tQ.toFixed(0)}ms (${raw.triangles.length / 3} tris) + straggler-bisect ${tR.toFixed(0)}ms (${refined.triangles.length / 3} tris), area ${meshArea(refined).toFixed(1)}`);
}

// isolate cdt2d cost: rebuild the point set for h=0.5 and time cdt2d alone
const h = 0.5;
const poly = gnd.polygons[0]!;
const pts: number[][] = [];
const edges: number[][] = [];
for (const ring of poly) {
  const start = pts.length;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [ax, ay] = ring[i]!, [bx, by] = ring[(i + 1) % n]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / h));
    for (let s = 0; s < steps; s++) pts.push([ax + (s / steps) * (bx - ax), ay + (s / steps) * (by - ay)]);
  }
  for (let i = start; i < pts.length; i++) edges.push([i, i + 1 === pts.length ? start : i + 1]);
}
console.log(`boundary points: ${pts.length}`);
const t0 = performance.now();
cdt2d(pts, edges, { delaunay: true, exterior: false });
console.log(`cdt2d boundary-only: ${(performance.now() - t0).toFixed(0)}ms`);

// ---- ruppert benchmark (appended) ----
import { initRuppert } from "../src/mesh/ruppert.js";
import { buildBoardMesh } from "../src/build.js";
import { readFileSync as rf } from "node:fs";
await initRuppert({ module_or_path: rf(new URL("../../geometry_core/pkg/geometry_core_bg.wasm", import.meta.url)) });
for (const refinement of ["delaunay", "ruppert"] as const) {
  for (const maxEdgeLength of [1, 0.5]) {
    const t0 = performance.now();
    const mesh = buildBoardMesh(pcb, { layers: ["B.Cu"], maxEdgeLength, refinement });
    const ms = performance.now() - t0;
    const tris = mesh.regions.reduce((s, r) => s + r.quality.triangleCount, 0);
    const slivers = mesh.regions.reduce((s, r) => s + r.quality.sliverCount, 0);
    const minAng = Math.min(...mesh.regions.map((r) => r.quality.minAngleDeg));
    console.log(`B.Cu ${refinement} h=${maxEdgeLength}: ${tris.toLocaleString("en")} tris, ${ms.toFixed(0)} ms, min∠ ${minAng.toFixed(1)}°, slivers ${slivers} (${((100 * slivers) / tris).toFixed(2)}%)`);
  }
}
