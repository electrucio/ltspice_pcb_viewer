import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parsePcb } from "../../kicad_pcb_viewer/src/parser/pcb.js";
import { buildBoardMesh } from "../src/build.js";
import { extractCopperRegions } from "../src/outline/copper.js";

const text = readFileSync(
  fileURLToPath(new URL("../../kicad_pcb_viewer/test/fixtures/poweramp.kicad_pcb", import.meta.url)),
  "utf8",
);
const pcb = parsePcb(text);

describe("poweramp board end-to-end", () => {
  const mesh = buildBoardMesh(pcb, { arcSegments: 16 });

  it("meshes both copper layers", () => {
    expect(mesh.layers).toEqual(["F.Cu", "B.Cu"]);
    expect(mesh.regions.some((r) => r.layer === "F.Cu")).toBe(true);
    expect(mesh.regions.some((r) => r.layer === "B.Cu")).toBe(true);
  });

  it("covers every net that has tracks", () => {
    const meshed = new Set(mesh.regions.map((r) => `${r.layer}/${r.net}`));
    for (const t of pcb.tracks) {
      if (!t.net) continue;
      expect(meshed.has(`${t.layer}/${t.net}`), `missing ${t.layer}/${t.net}`).toBe(true);
    }
  });

  it("conserves area: mesh area == outline area for every region", () => {
    for (const r of mesh.regions) {
      expect(Math.abs(r.meshArea - r.outlineArea) / r.outlineArea, `${r.layer}/${r.net}`).toBeLessThan(1e-6);
    }
  });

  it("total copper stays below board area and vias leave holes", () => {
    const bboxArea = (pcb.bbox.maxX - pcb.bbox.minX) * (pcb.bbox.maxY - pcb.bbox.minY);
    for (const layer of mesh.layers) {
      const copper = mesh.regions.filter((r) => r.layer === layer).reduce((s, r) => s + r.meshArea, 0);
      expect(copper).toBeGreaterThan(0);
      expect(copper).toBeLessThan(bboxArea);
    }
    // this board has 18 vias → at least one region with a hole ring
    const withDrills = extractCopperRegions(pcb, { arcSegments: 16 });
    expect(withDrills.some((r) => r.polygons.some((poly) => poly.length > 1))).toBe(true);
    // subtracting drills strictly reduces copper
    const noDrills = extractCopperRegions(pcb, { arcSegments: 16, subtractDrills: false });
    const sum = (rs: typeof noDrills) => rs.reduce((s, r) => s + r.area, 0);
    expect(sum(withDrills)).toBeLessThan(sum(noDrills));
  });

  it("refinement produces a bounded, area-preserving mesh on a real net", () => {
    const netWithTracks = pcb.tracks.find((t) => t.net)!.net;
    const coarse = buildBoardMesh(pcb, { arcSegments: 16, nets: [netWithTracks] });
    const fine = buildBoardMesh(pcb, { arcSegments: 16, nets: [netWithTracks], maxEdgeLength: 0.5 });
    expect(fine.regions.length).toBe(coarse.regions.length);
    for (let i = 0; i < fine.regions.length; i++) {
      expect(fine.regions[i]!.quality.maxEdgeLength).toBeLessThanOrEqual(0.5);
      expect(Math.abs(fine.regions[i]!.meshArea - coarse.regions[i]!.meshArea)).toBeLessThan(1e-9 * coarse.regions[i]!.meshArea + 1e-12);
      expect(fine.regions[i]!.quality.triangleCount).toBeGreaterThan(coarse.regions[i]!.quality.triangleCount);
    }
  });

  it("every mesh is structurally valid", () => {
    for (const r of mesh.regions) {
      expect(r.triangles.length % 3).toBe(0);
      expect(r.quality.triangleCount).toBeGreaterThan(0);
      for (const i of r.triangles) expect(i).toBeLessThan(r.vertices.length / 2);
      // ear clipping can emit slivers (minAngle → 0 on the big zone outlines);
      // that's what quality.minAngleDeg is for — it must be reported, not hidden
      expect(r.quality.minAngleDeg).toBeGreaterThanOrEqual(0);
      expect(r.outlineArea).toBeGreaterThan(0);
    }
  });
});

describe("net-assigned copper graphics on the real board", () => {
  it("Net-(Q4-E): the B.Cu gr_poly patch heals the split (2 islands → 1)", () => {
    const [r] = extractCopperRegions(pcb, { layers: ["B.Cu"], nets: ["Net-(Q4-E)"], arcSegments: 16 });
    expect(r!.polygons.length).toBe(1);
  });
});

describe("preamp board (second golden fixture — polygon-clipping robustness)", () => {
  // regression: at arcSegments 24 this board triggered Martinez–Rueda's
  // "unable to complete output ring" before coordinate snapping (1 nm grid)
  const preamp = parsePcb(
    readFileSync(fileURLToPath(new URL("../../kicad_pcb_viewer/test/fixtures/preamp.kicad_pcb", import.meta.url)), "utf8"),
  );

  it("meshes at the demo's exact options without boolean failures", () => {
    const mesh = buildBoardMesh(preamp, { arcSegments: 24 });
    expect(mesh.regions.length).toBeGreaterThan(50);
    expect(mesh.report.droppedPrimitives).toBe(0);
    for (const r of mesh.regions) {
      expect(Math.abs(r.meshArea - r.outlineArea) / r.outlineArea, `${r.layer}/${r.net}`).toBeLessThan(1e-6);
    }
  });
});
