import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runSolve, type SolveStage } from "../src/analysis/solve-core.js";

const wasm = readFileSync(fileURLToPath(new URL("../../geometry_core/pkg/geometry_core_bg.wasm", import.meta.url)));
const board = readFileSync(fileURLToPath(new URL("../../kicad_pcb_viewer/test/fixtures/poweramp.kicad_pcb", import.meta.url)), "utf8");

describe("solve worker core (headless — the physics path the worker runs)", () => {
  it("solves poweramp /POW1 R2.1↔R9.1 with staged progress and a field", async () => {
    const stages: SolveStage[] = [];
    const r = await runSolve(
      { id: 1, pcbText: board, net: "/POW1", padA: "R2.1", padB: "R9.1", wantField: true },
      (s) => stages.push(s),
      { module_or_path: wasm },
    );
    // known value: 3.807 mΩ ± ~0.3 % (P2.3 measurement)
    expect(r.resistance).toBeGreaterThan(3e-3);
    expect(r.resistance).toBeLessThan(5e-3);
    expect(r.converged).toBe(true);
    expect(r.relError).toBeLessThan(0.02);
    expect(r.layers).toContain("F.Cu");
    expect(r.field?.length).toBeGreaterThan(0);
    expect(r.estimate).not.toBeNull();
    // both mesh passes reported, in order
    const coarse = stages.indexOf("solving (coarse mesh)");
    const fine = stages.indexOf("solving (fine mesh)");
    expect(coarse).toBeGreaterThanOrEqual(0);
    expect(fine).toBeGreaterThan(coarse);
    expect(stages).toContain("parsing board");
  });

  it("caches the parsed board across calls (no re-parse stage)", async () => {
    const stages: SolveStage[] = [];
    const r = await runSolve(
      { id: 2, pcbText: board, net: "/POW1", padA: "R2.1", padB: "R26.2" },
      (s) => stages.push(s),
      { module_or_path: wasm },
    );
    expect(Number.isFinite(r.resistance)).toBe(true);
    expect(stages).not.toContain("parsing board");
    expect(stages).not.toContain("initializing mesher");
    expect(r.field).toBeUndefined(); // wantField not set
  });
});
