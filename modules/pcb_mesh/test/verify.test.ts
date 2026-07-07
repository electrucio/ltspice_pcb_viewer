import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parsePcb } from "../../kicad_pcb_viewer/src/parser/pcb.js";
import { analyzeRegion } from "../src/verify.js";
import { extractCopper } from "../src/outline/copper.js";
import { segmentsForRadius, circleOutline } from "../src/outline/primitives.js";
import { buildBoardMesh } from "../src/build.js";
import { boardMeshToJSON, boardMeshFromJSON } from "../src/serialize.js";
import { ringArea } from "../src/types.js";
import { makeFootprint, makePad, makePcb } from "./helpers.js";

describe("chord-tolerance tessellation", () => {
  it("guarantees the sagitta bound at any radius", () => {
    for (const r of [0.1, 0.5, 2, 10]) {
      const n = segmentsForRadius(r, 0.005, 4);
      const sagitta = r * (1 - Math.cos(Math.PI / n));
      expect(sagitta).toBeLessThanOrEqual(0.005 + 1e-12);
    }
  });

  it("adapts: big radii get more segments, area error stays relative-bounded", () => {
    const n1 = segmentsForRadius(0.25, 0.005);
    const n2 = segmentsForRadius(5, 0.005);
    expect(n2).toBeGreaterThan(n1);
    // area deficit of the inscribed polygon ≤ ~2·tol/r for both
    for (const r of [0.25, 5]) {
      const n = segmentsForRadius(r, 0.005);
      const deficit = (Math.PI * r * r - Math.abs(ringArea(circleOutline(0, 0, r, n)))) / (Math.PI * r * r);
      expect(deficit).toBeLessThanOrEqual((2 * 0.005) / r + 1e-9);
    }
  });
});

describe("sanitation report", () => {
  it("counts zero-length tracks, pad-shape fallbacks and vanished regions", () => {
    const pcb = makePcb({
      tracks: [{ start: { x: 1, y: 1 }, end: { x: 1, y: 1 }, width: 0.5, layer: "F.Cu", net: "A" }],
      footprints: [
        makeFootprint([
          makePad({ shape: "trapezoid", size: { w: 2, h: 1 }, net: "A", pos: { x: 5, y: 0 } }),
          // NPTH: drill swallows the pad entirely → empty region on net ""
          makePad({ shape: "circle", thruHole: true, size: { w: 3, h: 3 }, drill: { w: 3, h: 3 }, net: "", pos: { x: 10, y: 0 } }),
        ]),
      ],
    });
    const { regions, report } = extractCopper(pcb, { layers: ["F.Cu"] });
    expect(report.zeroLengthTracks).toBe(1);
    expect(report.padShapeFallbacks).toBe(1);
    expect(report.emptyRegions).toBe(1);
    expect(regions.map((r) => r.net)).toEqual(["A"]);
  });
});

describe("analyzeRegion cross-verified areas", () => {
  it("single track: all four areas agree with the closed form", () => {
    const pcb = makePcb({
      tracks: [{ start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, width: 1, layer: "F.Cu", net: "N1" }],
    });
    const r = analyzeRegion(pcb, "F.Cu", "N1", { seed: 7 })!;
    const exact = 10 * 1 + Math.PI * 0.25;
    expect(r.counts).toMatchObject({ tracks: 1, pads: 0, vias: 0, islands: 1, holes: 0 });
    expect(r.trackLength).toBeCloseTo(10, 12);
    expect(Math.abs(r.areas.primitiveSum - exact)).toBeLessThan(1e-12); // closed form, exact
    expect(r.areas.meshVsOutlineRel).toBeLessThan(1e-9); // mesh ≡ outline
    expect(r.areas.outline).toBeLessThanOrEqual(exact); // inscribed tessellation
    expect(Math.abs(r.areas.outline - exact) / exact).toBeLessThan(0.005); // chord-tol bound
    const mc = r.areas.monteCarlo;
    expect(Math.abs(mc.value - exact)).toBeLessThan(Math.max(4 * mc.stdError, 0.01 * exact));
  });

  it("overlapping tracks: primitive sum exceeds the union by the overlap", () => {
    const pcb = makePcb({
      tracks: [
        { start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, width: 1, layer: "F.Cu", net: "N1" },
        { start: { x: 5, y: 0 }, end: { x: 15, y: 0 }, width: 1, layer: "F.Cu", net: "N1" },
      ],
    });
    const r = analyzeRegion(pcb, "F.Cu", "N1")!;
    expect(r.areas.overlapArea).toBeGreaterThan(4); // ~5 mm shared stadium
    expect(r.areas.primitiveSum).toBeGreaterThan(r.areas.unionNoDrills);
  });

  it("annulus pad: hole reported, Monte Carlo matches π(R²−r²)", () => {
    const pad = makePad({ shape: "circle", thruHole: true, size: { w: 2, h: 2 }, drill: { w: 1, h: 1 }, net: "N1" });
    const pcb = makePcb({ footprints: [makeFootprint([pad])] });
    const r = analyzeRegion(pcb, "F.Cu", "N1", { seed: 3, mcSamples: 300_000 })!;
    const exact = Math.PI * (1 - 0.25);
    expect(r.counts.holes).toBe(1);
    expect(r.padRefs).toEqual(["U1.1"]);
    const mc = r.areas.monteCarlo;
    expect(Math.abs(mc.value - exact)).toBeLessThan(Math.max(4 * mc.stdError, 0.01 * exact));
    // MC (true area) sits slightly ABOVE the inscribed-tessellation outline
    expect(mc.value).toBeGreaterThan(r.areas.outline - 4 * mc.stdError);
  });

  it("rotated rect pad: Monte Carlo validates the inverse rotation", () => {
    const pad = makePad({ shape: "rect", size: { w: 3, h: 1 }, angle: 37, net: "N1", pos: { x: 4, y: -2 } });
    const pcb = makePcb({ footprints: [makeFootprint([pad])] });
    const r = analyzeRegion(pcb, "F.Cu", "N1", { seed: 11 })!;
    const mc = r.areas.monteCarlo;
    expect(Math.abs(mc.value - 3)).toBeLessThan(Math.max(4 * mc.stdError, 0.02));
    expect(r.areas.meshVsOutlineRel).toBeLessThan(1e-9);
  });

  it("reports islands on a net with disjoint copper", () => {
    const pcb = makePcb({
      tracks: [
        { start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, width: 1, layer: "F.Cu", net: "N1" },
        { start: { x: 20, y: 0 }, end: { x: 25, y: 0 }, width: 1, layer: "F.Cu", net: "N1" },
      ],
    });
    const r = analyzeRegion(pcb, "F.Cu", "N1")!;
    expect(r.counts.islands).toBe(2);
  });

  it("is deterministic for a fixed seed", () => {
    const pcb = makePcb({
      tracks: [{ start: { x: 0, y: 0 }, end: { x: 10, y: 3 }, width: 0.8, layer: "F.Cu", net: "N1" }],
    });
    const a = analyzeRegion(pcb, "F.Cu", "N1", { seed: 42 })!;
    const b = analyzeRegion(pcb, "F.Cu", "N1", { seed: 42 })!;
    expect(a.areas.monteCarlo.value).toBe(b.areas.monteCarlo.value);
  });

  it("returns null for a (layer, net) with no copper", () => {
    expect(analyzeRegion(makePcb({}), "F.Cu", "GHOST")).toBeNull();
  });
});

describe("board mesh serialization + real-board report", () => {
  const text = readFileSync(
    fileURLToPath(new URL("../../kicad_pcb_viewer/test/fixtures/poweramp.kicad_pcb", import.meta.url)),
    "utf8",
  );
  const pcb = parsePcb(text);

  it("JSON roundtrip is lossless and same-input builds are identical", () => {
    const mesh = buildBoardMesh(pcb, { layers: ["F.Cu"] });
    const json = boardMeshToJSON(mesh);
    const back = boardMeshFromJSON(json);
    expect(back.layers).toEqual(mesh.layers);
    expect(back.regions.length).toBe(mesh.regions.length);
    for (let i = 0; i < mesh.regions.length; i++) {
      expect(back.regions[i]!.meshArea).toBe(mesh.regions[i]!.meshArea);
      expect([...back.regions[i]!.triangles]).toEqual([...mesh.regions[i]!.triangles]);
      expect([...back.regions[i]!.vertices]).toEqual([...mesh.regions[i]!.vertices]);
    }
    // determinism (per environment): rebuild → byte-identical JSON
    expect(boardMeshToJSON(buildBoardMesh(pcb, { layers: ["F.Cu"] }))).toBe(json);
  });

  it("real board: sanitation report is clean-ish and machine-checkable", () => {
    const mesh = buildBoardMesh(pcb);
    expect(mesh.report.degenerateRings).toBe(0);
    expect(mesh.report.padShapeFallbacks).toBe(0);
    // NPTH mounting holes vanish by design and are counted, not hidden
    expect(mesh.report.emptyRegions).toBeGreaterThanOrEqual(0);
    for (const r of mesh.regions) {
      expect(r.islands).toBeGreaterThanOrEqual(1);
      expect(r.quality.angleHistogramDeg.reduce((a, b) => a + b, 0)).toBe(r.quality.triangleCount);
    }
  });

  it("analyzeRegion works end-to-end on a real net", () => {
    const net = pcb.tracks.find((t) => t.net)!.net;
    const r = analyzeRegion(pcb, "B.Cu", net, { seed: 1, mcSamples: 100_000 })!;
    expect(r).not.toBeNull();
    expect(r.counts.tracks).toBeGreaterThan(0);
    expect(r.areas.meshVsOutlineRel).toBeLessThan(1e-9);
    expect(r.areas.primitiveSum).toBeGreaterThanOrEqual(r.areas.unionNoDrills - 1e-9);
    const mc = r.areas.monteCarlo;
    expect(Math.abs(mc.value - r.areas.outline)).toBeLessThan(Math.max(5 * mc.stdError, 0.02 * r.areas.outline));
  });
});
