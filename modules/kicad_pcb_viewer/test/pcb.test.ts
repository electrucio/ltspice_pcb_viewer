import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parsePcb } from "../src/parser/pcb.js";

const text = readFileSync(fileURLToPath(new URL("./fixtures/poweramp.kicad_pcb", import.meta.url)), "utf8");
const pcb = parsePcb(text);

describe("kicad_pcb parser", () => {
  it("parses the board structure", () => {
    expect(pcb.footprints.length).toBe(47);
    expect(pcb.tracks.length).toBe(180);
    expect(pcb.vias.length).toBe(18);
    expect(pcb.bbox.maxX - pcb.bbox.minX).toBeGreaterThan(80); // ~85mm board
  });

  it("assigns nets by name and resolves pad positions onto same-net tracks", () => {
    // most through-hole pads sit on the end of one of their net's tracks
    const endpoints = new Map<string, Set<string>>();
    const k = (p: { x: number; y: number }) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;
    const add = (n: string, key: string) => (endpoints.get(n) ?? endpoints.set(n, new Set()).get(n)!).add(key);
    for (const t of pcb.tracks) { add(t.net, k(t.start)); add(t.net, k(t.end)); }
    for (const v of pcb.vias) add(v.net, k(v.pos));
    let hit = 0, total = 0;
    for (const f of pcb.footprints) for (const p of f.pads) { if (!p.net) continue; total++; if (endpoints.get(p.net)?.has(k(p.pos))) hit++; }
    expect(hit / total).toBeGreaterThan(0.8);
  });

  it("knows about both copper layers and the board outline", () => {
    expect(pcb.layers).toContain("F.Cu");
    expect(pcb.layers).toContain("B.Cu");
    expect(pcb.graphics.some((g) => g.layer === "Edge.Cuts")).toBe(true);
  });
});
