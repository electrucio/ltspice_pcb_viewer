import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parsePcb } from "../../kicad_pcb_viewer/src/parser/pcb.js";
import { buildTerminalMesh } from "../src/mesh/terminals.js";
import { initRuppert } from "../src/mesh/ruppert.js";
import { makeFootprint, makePad, makePcb } from "./helpers.js";

beforeAll(async () => {
  const wasm = readFileSync(fileURLToPath(new URL("../../geometry_core/pkg/geometry_core_bg.wasm", import.meta.url)));
  await initRuppert({ module_or_path: wasm });
});

/** straight 10 mm × 1 mm trace with 1×1 mm square pads centered on each end */
function straightTracePcb() {
  return makePcb({
    tracks: [{ start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, width: 1, layer: "F.Cu", net: "N1" }],
    footprints: [
      makeFootprint([
        makePad({ ref: "P1", number: "1", shape: "rect", size: { w: 1, h: 1 }, pos: { x: 0, y: 0 }, net: "N1" }),
        makePad({ ref: "P2", number: "1", shape: "rect", size: { w: 1, h: 1 }, pos: { x: 10, y: 0 }, net: "N1" }),
      ]),
    ],
  });
}

describe("terminal meshes", () => {
  it("turns pads into tagged, conforming holes with non-empty vertex sets", () => {
    const tm = buildTerminalMesh(straightTracePcb(), "F.Cu", "N1", { maxEdgeLength: 0.3, refinement: "ruppert" })!;
    expect(tm.skipped).toEqual([]);
    expect(tm.terminals.map((t) => t.id).sort()).toEqual(["P1.1", "P2.1"]);
    for (const t of tm.terminals) {
      expect(t.kind).toBe("pad");
      expect(t.vertexIndices.length).toBeGreaterThan(8);
    }
    // two terminal holes present
    expect(tm.mesh.holes).toBe(2);
    // area = copper minus the two inset pad holes; must stay conserved vs its outline
    expect(Math.abs(tm.mesh.meshArea - tm.mesh.outlineArea) / tm.mesh.outlineArea).toBeLessThan(1e-9);
    // terminal vertices actually sit on the pad boundary (inset ~0.02 from pad edge)
    const t1 = tm.terminals.find((t) => t.id === "P1.1")!;
    for (const vi of t1.vertexIndices) {
      const x = tm.mesh.vertices[2 * vi]!, y = tm.mesh.vertices[2 * vi + 1]!;
      expect(Math.max(Math.abs(x - 0), Math.abs(y))).toBeLessThan(0.52);
      expect(Math.max(Math.abs(x - 0), Math.abs(y))).toBeGreaterThan(0.4);
    }
  });

  it("keeps the angle guarantee with terminal holes present", () => {
    const tm = buildTerminalMesh(straightTracePcb(), "F.Cu", "N1", { maxEdgeLength: 0.3, refinement: "ruppert" })!;
    expect(tm.mesh.quality.minAngleDeg).toBeGreaterThanOrEqual(20);
  });

  it("swallows drill holes covered by a THT pad terminal", () => {
    const pcb = makePcb({
      tracks: [{ start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, width: 1, layer: "F.Cu", net: "N1" }],
      footprints: [
        makeFootprint([
          makePad({ ref: "P1", number: "1", shape: "circle", thruHole: true, size: { w: 2, h: 2 }, drill: { w: 1, h: 1 }, pos: { x: 0, y: 0 }, net: "N1" }),
          makePad({ ref: "P2", number: "1", shape: "rect", size: { w: 1, h: 1 }, pos: { x: 5, y: 0 }, net: "N1" }),
        ]),
      ],
    });
    const tm = buildTerminalMesh(pcb, "F.Cu", "N1", { maxEdgeLength: 0.3, refinement: "ruppert" })!;
    expect(tm.skipped).toEqual([]);
    // the drill ring is inside the P1 terminal ring → swallowed: 2 terminal holes only
    expect(tm.mesh.holes).toBe(2);
    expect(tm.terminals.map((t) => t.id).sort()).toEqual(["P1.1", "P2.1"]);
  });

  it("merges overlapping same-net pads into one electrical terminal", () => {
    const pcb = makePcb({
      footprints: [
        makeFootprint([
          makePad({ ref: "A", number: "1", shape: "rect", size: { w: 2, h: 2 }, pos: { x: 0, y: 0 }, net: "N1" }),
          makePad({ ref: "B", number: "1", shape: "rect", size: { w: 2, h: 2 }, pos: { x: 1, y: 0 }, net: "N1" }),
        ]),
      ],
      tracks: [{ start: { x: 0, y: 0 }, end: { x: 6, y: 0 }, width: 1, layer: "F.Cu", net: "N1" }],
    });
    const tm = buildTerminalMesh(pcb, "F.Cu", "N1", { maxEdgeLength: 0.3, refinement: "ruppert" })!;
    const padTerms = tm.terminals.filter((t) => t.kind === "pad");
    expect(padTerms).toHaveLength(1);
    expect(padTerms[0]!.refs.sort()).toEqual(["A.1", "B.1"]);
  });

  it("creates via terminals on a real board net", () => {
    const text = readFileSync(
      fileURLToPath(new URL("../../kicad_pcb_viewer/test/fixtures/poweramp.kicad_pcb", import.meta.url)),
      "utf8",
    );
    const pcb = parsePcb(text);
    const tm = buildTerminalMesh(pcb, "B.Cu", "/POW1", { maxEdgeLength: 0.5, refinement: "ruppert" })!;
    expect(tm.terminals.some((t) => t.kind === "pad")).toBe(true);
    expect(tm.terminals.some((t) => t.kind === "via")).toBe(true);
    expect(Math.abs(tm.mesh.meshArea - tm.mesh.outlineArea) / tm.mesh.outlineArea).toBeLessThan(1e-9);
    for (const t of tm.terminals) expect(t.vertexIndices.length).toBeGreaterThan(3);
  });
});
