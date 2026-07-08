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

  it("keeps pad angles absolute (KiCad file convention), not footprint-relative", () => {
    // Q7 (TO-3P) is placed at 90°; its pads are stored as (at … 90) — absolute, i.e.
    // relative rotation 0. Adding the footprint angle again (the old bug) gave 180°
    // and drew the 2.5×4.5 ovals tall instead of wide.
    const q7 = pcb.footprints.find((f) => f.ref === "Q7")!;
    expect(q7.angle).toBe(90);
    for (const p of q7.pads) expect(p.angle).toBe(90);
  });

  it("reads net-assigned copper graphics (KiCad 9/10 gr_poly on B.Cu)", () => {
    // the board patches Net-(Q4-E) with a filled graphic polygon on copper —
    // real connected copper, not decoration
    const g = pcb.graphics.find((x) => x.net === "Net-(Q4-E)")!;
    expect(g).toBeDefined();
    expect(g.kind).toBe("poly");
    expect(g.layer).toBe("B.Cu");
    if (g.kind === "poly") {
      expect(g.fill).toBe(true);
      expect(g.pts.length).toBe(3);
      expect(g.width).toBeCloseTo(0.2, 9);
    }
  });

  it("knows about both copper layers and the board outline", () => {
    expect(pcb.layers).toContain("F.Cu");
    expect(pcb.layers).toContain("B.Cu");
    expect(pcb.graphics.some((g) => g.layer === "Edge.Cuts")).toBe(true);
  });
});

describe("board text (gr_text)", () => {
  it("reads copper text (real copper on B.Cu) and silk text", () => {
    const cu = pcb.texts.find((t) => t.layer === "B.Cu")!;
    expect(cu.text).toBe("v1.0");
    expect(cu.size).toBeGreaterThan(0);
    expect(pcb.texts.some((t) => t.layer === "F.SilkS")).toBe(true);
  });

  it("declares the copper stack in physical order", () => {
    expect(pcb.copperStack).toEqual(["F.Cu", "B.Cu"]);
  });
});

describe("copper stack order (multilayer)", () => {
  it("uses the declaration's textual order, not the legacy numeric ids", () => {
    // KiCad ids are stable, not ordered: B.Cu is always 2, inner layers 4, 6, …
    const text = `(kicad_pcb (version 20241229) (generator "pcbnew")
      (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
    )`;
    expect(parsePcb(text).copperStack).toEqual(["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"]);
  });
});
