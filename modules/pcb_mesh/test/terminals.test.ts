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

  it("places terminals on copper nested inside a zone void (multichannel_mixer GND)", () => {
    // four bars union into a square annulus; the pad's copper is a separate island
    // NESTED inside the annulus hole. Placement must pick the innermost containing
    // island — matching the first (the annulus) puts the pad "inside a void" and
    // skipped the terminal.
    const bar = (pts: Array<[number, number]>) => ({ layer: "F.Cu", net: "N1", pts: pts.map(([x, y]) => ({ x, y })) });
    const pcb = makePcb({
      zones: [
        bar([[0, 0], [10, 0], [10, 1], [0, 1]]),
        bar([[0, 9], [10, 9], [10, 10], [0, 10]]),
        bar([[0, 0], [1, 0], [1, 10], [0, 10]]),
        bar([[9, 0], [10, 0], [10, 10], [9, 10]]),
      ],
      footprints: [
        makeFootprint([
          makePad({ ref: "P1", number: "1", shape: "rect", size: { w: 2, h: 2 }, pos: { x: 5, y: 5 }, net: "N1" }),
          makePad({ ref: "P2", number: "1", shape: "rect", size: { w: 1, h: 1 }, pos: { x: 0.5, y: 0.5 }, net: "N1" }),
        ]),
      ],
    });
    const tm = buildTerminalMesh(pcb, "F.Cu", "N1", { maxEdgeLength: 0.5, refinement: "ruppert" })!;
    expect(tm.skipped).toEqual([]);
    expect(tm.terminals.map((t) => t.id).sort()).toEqual(["P1.1", "P2.1"]);
  });

  it("via-in-pad: merges the via into the pad terminal but keeps both member ids", () => {
    // SMD pad with a through via stacked at its center (jetson-style). The via's
    // midline ring sits strictly INSIDE the pad's inset ring (no edge crossing) —
    // they must still merge, and the members must retain the plain via id so the
    // solver can stitch this terminal to the same via on other layers.
    const pcb = makePcb({
      footprints: [
        makeFootprint([
          makePad({ ref: "J1", number: "D21", shape: "circle", size: { w: 0.8, h: 0.8 }, pos: { x: 0, y: 0 }, layers: ["B.Cu"], net: "N1" }),
        ]),
      ],
      vias: [{ pos: { x: 0, y: 0 }, size: 0.45, drill: 0.2, layers: ["F.Cu", "B.Cu"], net: "N1" }],
      tracks: [{ start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, width: 0.5, layer: "B.Cu", net: "N1" }],
    });
    const tm = buildTerminalMesh(pcb, "B.Cu", "N1", { maxEdgeLength: 0.3, refinement: "ruppert" })!;
    expect(tm.skipped).toEqual([]);
    expect(tm.terminals).toHaveLength(1);
    const t = tm.terminals[0]!;
    expect(t.members.sort()).toEqual(["J1.D21", "via@0,0"]);
    expect(t.refs).toEqual(["J1.D21"]);
    // one merged hole (the via ring and drill are swallowed by the pad ring)
    expect(tm.mesh.holes).toBe(1);
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

describe("via span semantics (through-vias list only outer layers)", () => {
  it("a through-via stitches inner layers it passes through", () => {
    // net routed on In2.Cu only reachable through a via whose file layers are F/B
    const pcb = makePcb({
      layers: ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"],
      copperStack: ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"],
      tracks: [
        { start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, width: 0.3, layer: "F.Cu", net: "N1" },
        { start: { x: 5, y: 0 }, end: { x: 10, y: 0 }, width: 0.3, layer: "In2.Cu", net: "N1" },
        { start: { x: 0, y: 5 }, end: { x: 1, y: 5 }, width: 0.3, layer: "In1.Cu", net: "N1" }, // forces In1 into copperLayers
      ],
      vias: [{ pos: { x: 5, y: 0 }, size: 0.8, drill: 0.4, layers: ["F.Cu", "B.Cu"], net: "N1" }],
    });
    const tmIn2 = buildTerminalMesh(pcb, "In2.Cu", "N1", { refinement: "ruppert", maxEdgeLength: 0.2 })!;
    // the via must exist as a terminal on the inner layer it spans
    expect(tmIn2.terminals.some((t) => t.kind === "via")).toBe(true);
    // and its ring vertices sit on the annulus midline (r = (0.2+0.4)/2 = 0.3)
    const via = tmIn2.terminals.find((t) => t.kind === "via")!;
    for (const vi of via.vertexIndices.slice(0, 5)) {
      const x = tmIn2.mesh.vertices[2 * vi]! - 5, y = tmIn2.mesh.vertices[2 * vi + 1]!;
      expect(Math.hypot(x, y)).toBeCloseTo(0.3, 3);
    }
  });
});
