import { describe, it, expect } from "vitest";
import { extractCopperRegions } from "../src/outline/copper.js";
import { makeFootprint, makePad, makePcb } from "./helpers.js";

const SEGS = 64;

describe("copper region extraction (union + drills)", () => {
  it("merges overlapping same-net tracks without double-counting area", () => {
    const pcb = makePcb({
      tracks: [
        { start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, width: 1, layer: "F.Cu", net: "N1" },
        { start: { x: 5, y: 0 }, end: { x: 15, y: 0 }, width: 1, layer: "F.Cu", net: "N1" },
      ],
    });
    const regions = extractCopperRegions(pcb, { arcSegments: SEGS });
    expect(regions).toHaveLength(1);
    const exact = 15 * 1 + Math.PI * 0.25; // one 15 mm stadium
    expect(Math.abs(regions[0]!.area - exact) / exact).toBeLessThan(0.005);
    expect(regions[0]!.polygons).toHaveLength(1); // single connected blob
  });

  it("keeps different nets and different layers apart", () => {
    const pcb = makePcb({
      tracks: [
        { start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, width: 1, layer: "F.Cu", net: "A" },
        { start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, width: 1, layer: "F.Cu", net: "B" }, // overlap, other net
        { start: { x: 0, y: 5 }, end: { x: 10, y: 5 }, width: 1, layer: "B.Cu", net: "A" },
      ],
    });
    const regions = extractCopperRegions(pcb, { arcSegments: SEGS });
    const keys = regions.map((r) => `${r.layer}/${r.net}`).sort();
    expect(keys).toEqual(["B.Cu/A", "F.Cu/A", "F.Cu/B"]);
  });

  it("thru-hole pad becomes an annulus: π(R²−r²)", () => {
    const pad = makePad({ shape: "circle", thruHole: true, size: { w: 2, h: 2 }, drill: { w: 1, h: 1 } });
    const pcb = makePcb({ footprints: [makeFootprint([pad])] });
    const regions = extractCopperRegions(pcb, { layers: ["F.Cu"], arcSegments: SEGS });
    expect(regions).toHaveLength(1);
    const exact = Math.PI * (1 * 1 - 0.5 * 0.5);
    expect(Math.abs(regions[0]!.area - exact) / exact).toBeLessThan(0.01);
    // the drill is a hole ring, not a smaller outer ring
    expect(regions[0]!.polygons[0]!.length).toBe(2);
  });

  it("via drill punches a hole through same-net track copper", () => {
    const pcb = makePcb({
      tracks: [{ start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, width: 2, layer: "F.Cu", net: "N1" }],
      vias: [{ pos: { x: 5, y: 0 }, size: 2, drill: 1, layers: ["F.Cu", "B.Cu"], net: "N1" }],
    });
    const regions = extractCopperRegions(pcb, { layers: ["F.Cu"], arcSegments: SEGS });
    expect(regions).toHaveLength(1);
    const stadium = 10 * 2 + Math.PI * 1; // via outer Ø == track width, adds nothing
    const exact = stadium - Math.PI * 0.25;
    expect(Math.abs(regions[0]!.area - exact) / exact).toBeLessThan(0.005);
    expect(regions[0]!.polygons.some((poly) => poly.length > 1)).toBe(true);
  });

  it("NPTH pad (drill == pad size) leaves no copper", () => {
    const pad = makePad({ shape: "circle", thruHole: true, size: { w: 3, h: 3 }, drill: { w: 3, h: 3 }, net: "" });
    const pcb = makePcb({ footprints: [makeFootprint([pad])] });
    const regions = extractCopperRegions(pcb, { layers: ["F.Cu"], arcSegments: SEGS });
    expect(regions).toHaveLength(0);
  });

  it("zone fills participate in the union", () => {
    const pcb = makePcb({
      zones: [{ layer: "F.Cu", net: "GND", pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }],
      tracks: [{ start: { x: 5, y: 5 }, end: { x: 20, y: 5 }, width: 1, layer: "F.Cu", net: "GND" }],
    });
    const regions = extractCopperRegions(pcb, { arcSegments: SEGS });
    expect(regions).toHaveLength(1);
    // zone + the part of the track sticking out of it
    expect(regions[0]!.area).toBeGreaterThan(100);
    expect(regions[0]!.area).toBeLessThan(100 + 10 * 1 + Math.PI * 0.25 + 0.1);
  });

  it("net filter restricts output", () => {
    const pcb = makePcb({
      tracks: [
        { start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, width: 1, layer: "F.Cu", net: "A" },
        { start: { x: 0, y: 5 }, end: { x: 10, y: 5 }, width: 1, layer: "F.Cu", net: "B" },
      ],
    });
    const regions = extractCopperRegions(pcb, { nets: ["B"], arcSegments: SEGS });
    expect(regions.map((r) => r.net)).toEqual(["B"]);
  });
});

describe("net-assigned copper graphics (KiCad 9/10)", () => {
  it("a filled gr_poly with a net joins the union like any copper", () => {
    const pcb = makePcb({
      tracks: [
        { start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, width: 1, layer: "B.Cu", net: "A" },
        { start: { x: 8, y: 0 }, end: { x: 12, y: 0 }, width: 1, layer: "B.Cu", net: "A" },
      ],
      graphics: [
        { kind: "poly", layer: "B.Cu", net: "A", fill: true, width: 0.2, pts: [{ x: 3.5, y: -0.3 }, { x: 8.5, y: -0.3 }, { x: 8.5, y: 0.3 }, { x: 3.5, y: 0.3 }] },
      ],
    });
    const regions = extractCopperRegions(pcb, { arcSegments: SEGS });
    expect(regions).toHaveLength(1);
    expect(regions[0]!.polygons).toHaveLength(1); // bridged into ONE island
  });

  it("netless graphics stay decoration (not copper)", () => {
    const pcb = makePcb({
      tracks: [{ start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, width: 1, layer: "B.Cu", net: "A" }],
      graphics: [{ kind: "poly", layer: "B.Cu", fill: true, width: 0.2, pts: [{ x: 10, y: 0 }, { x: 12, y: 0 }, { x: 11, y: 2 }] }],
    });
    const regions = extractCopperRegions(pcb, { arcSegments: SEGS });
    expect(regions).toHaveLength(1);
    expect(regions[0]!.area).toBeLessThan(5); // just the track
  });
});
