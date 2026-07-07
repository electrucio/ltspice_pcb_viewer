import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parsePcb } from "../../kicad_pcb_viewer/src/parser/pcb.js";
import { initRuppert, triangulateRuppert } from "../src/mesh/ruppert.js";
import { dropDegenerate, meshArea, measureQuality } from "../src/mesh/triangulate.js";
import { buildBoardMesh } from "../src/build.js";
import type { MultiPolygon } from "../src/types.js";

beforeAll(async () => {
  const wasm = readFileSync(fileURLToPath(new URL("../../geometry_core/pkg/geometry_core_bg.wasm", import.meta.url)));
  await initRuppert({ module_or_path: wasm });
});

const squareWithHole: MultiPolygon = [
  [
    [[0, 0], [4, 0], [4, 4], [0, 4]],
    [[1.5, 1.5], [2.5, 1.5], [2.5, 2.5], [1.5, 2.5]],
  ],
];

describe("ruppert refinement (Rust/WASM, spade)", () => {
  it("conserves area and honors the ≥20° angle bound (holes included)", () => {
    const m = dropDegenerate(triangulateRuppert(squareWithHole, 0.4));
    expect(meshArea(m)).toBeCloseTo(15, 9);
    const q = measureQuality(m);
    expect(q.minAngleDeg).toBeGreaterThanOrEqual(20);
    expect(q.sliverCount).toBe(0);
  });

  it("bounds triangle area (≈ target edge) without over-refining a long strip", () => {
    const strip: MultiPolygon = [[[[0, 0], [100, 0], [100, 1], [0, 1]]]];
    const m = dropDegenerate(triangulateRuppert(strip, 1));
    expect(meshArea(m)).toBeCloseTo(100, 9);
    const q = measureQuality(m);
    expect(q.minAngleDeg).toBeGreaterThanOrEqual(20);
    expect(q.triangleCount).toBeLessThan(1500);
  });

  it("angle-only mode (no target edge) still cleans up slivers", () => {
    const m = dropDegenerate(triangulateRuppert(squareWithHole, Infinity));
    expect(meshArea(m)).toBeCloseTo(15, 9);
    expect(measureQuality(m).minAngleDeg).toBeGreaterThanOrEqual(20);
  });

  it("is deterministic", () => {
    const a = triangulateRuppert(squareWithHole, 0.5);
    const b = triangulateRuppert(squareWithHole, 0.5);
    expect(a.vertices).toEqual(b.vertices);
    expect(a.triangles).toEqual(b.triangles);
  });
});

describe("ruppert on the real board", () => {
  const text = readFileSync(
    fileURLToPath(new URL("../../kicad_pcb_viewer/test/fixtures/poweramp.kicad_pcb", import.meta.url)),
    "utf8",
  );
  const pcb = parsePcb(text);

  it("meshes B.Cu at 1 mm with conserved areas and the full angle guarantee", () => {
    const mesh = buildBoardMesh(pcb, { layers: ["B.Cu"], maxEdgeLength: 1, refinement: "ruppert" });
    let tris = 0, slivers = 0;
    for (const r of mesh.regions) {
      expect(Math.abs(r.meshArea - r.outlineArea) / r.outlineArea, `${r.net}`).toBeLessThan(1e-9);
      expect(r.quality.minAngleDeg, `${r.net}`).toBeGreaterThanOrEqual(20);
      tris += r.quality.triangleCount;
      slivers += r.quality.sliverCount;
    }
    expect(slivers).toBe(0);
    expect(tris).toBeGreaterThan(5_000);
    // with default outline simplification (0.01 mm) the pour's dense fill vertices no
    // longer seed needless refinement: ~52k observed (212k unsimplified)
    expect(tris).toBeLessThan(150_000);
  });

  it("outline simplification stays within its deviation bound and barely moves area", () => {
    const exact = buildBoardMesh(pcb, { layers: ["B.Cu"], simplifyTolerance: 0 });
    const simplified = buildBoardMesh(pcb, { layers: ["B.Cu"] }); // default 0.01 mm
    const sum = (m: typeof exact) => m.regions.reduce((s, r) => s + r.outlineArea, 0);
    expect(simplified.report.simplifiedVertices).toBeGreaterThan(1000);
    expect(Math.abs(sum(simplified) - sum(exact)) / sum(exact)).toBeLessThan(2e-4);
  });

  it("beats the cdt2d path on worst-case quality at similar size", () => {
    const net = pcb.tracks.find((t) => t.net)!.net;
    const ruppert = buildBoardMesh(pcb, { layers: ["B.Cu"], nets: [net], maxEdgeLength: 1, refinement: "ruppert" });
    const delaunay = buildBoardMesh(pcb, { layers: ["B.Cu"], nets: [net], maxEdgeLength: 1, refinement: "delaunay" });
    const rq = ruppert.regions[0]!.quality, dq = delaunay.regions[0]!.quality;
    expect(rq.minAngleDeg).toBeGreaterThan(dq.minAngleDeg);
    expect(rq.sliverCount).toBeLessThanOrEqual(dq.sliverCount);
  });
});
