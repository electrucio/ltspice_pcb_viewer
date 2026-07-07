/** Isolate the two knobs: min-area floor fraction × simplify tolerance (B.Cu, h=1). */
import { readFileSync } from "node:fs";
import { parsePcb } from "../../kicad_pcb_viewer/src/parser/pcb.js";
import { extractCopperRegions } from "../src/outline/copper.js";
import { initRuppert, triangulateRuppert } from "../src/mesh/ruppert.js";
import { dropDegenerate, meshArea, measureQuality } from "../src/mesh/triangulate.js";

await initRuppert({
  module_or_path: readFileSync(new URL("../../geometry_core/pkg/geometry_core_bg.wasm", import.meta.url)),
});
const pcb = parsePcb(
  readFileSync(new URL("../../kicad_pcb_viewer/test/fixtures/poweramp.kicad_pcb", import.meta.url), "utf8"),
);

for (const simplifyTolerance of [0, 0.01, 0.02]) {
  const regions = extractCopperRegions(pcb, { layers: ["B.Cu"], simplifyTolerance });
  for (const floor of [0, 1 / 256, 1 / 64]) {
    const t0 = performance.now();
    let tris = 0, slivers = 0, area = 0, minAng = Infinity;
    for (const r of regions) {
      const m = dropDegenerate(triangulateRuppert(r.polygons, 1, 25, floor));
      const q = measureQuality(m);
      tris += q.triangleCount;
      slivers += q.sliverCount;
      area += meshArea(m);
      minAng = Math.min(minAng, q.minAngleDeg);
    }
    const ms = performance.now() - t0;
    console.log(
      `simplify=${String(simplifyTolerance).padEnd(4)} floor=${floor === 0 ? "off  " : floor === 1 / 256 ? "1/256" : "1/64 "}  ` +
        `${tris.toLocaleString("en").padStart(9)} tris  ${ms.toFixed(0).padStart(5)} ms  slivers ${String(slivers).padStart(4)}  min∠ ${minAng.toFixed(1)}°  area ${area.toFixed(2)}`,
    );
  }
}
