import { describe, it, expect } from "vitest";
import type { Pcb, Pad, Footprint } from "../../kicad_pcb_viewer/src/parser/pcb.js";
import { microstrip, stripline, microstripLoss } from "../../analytic_models/src/index.js";
import { analyzeNetRlgc, analyzePathRlgc } from "../src/rlgc.js";

const STACKUP_2L: Pcb["stackup"] = [
  { name: "F.Cu", type: "copper", thicknessMm: 0.035 },
  { name: "dielectric 1", type: "core", thicknessMm: 0.5, epsilonR: 4.3, lossTangent: 0.015, material: "FR4" },
  { name: "B.Cu", type: "copper", thicknessMm: 0.035 },
];

function board2L(partial?: Partial<Pcb>): Pcb {
  return {
    footprints: [], vias: [], graphics: [], texts: [],
    tracks: [{ start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, width: 0.3, layer: "F.Cu", net: "SIG" }],
    zones: [{ layer: "B.Cu", net: "GND", pts: [{ x: -1, y: -5 }, { x: 11, y: -5 }, { x: 11, y: 5 }, { x: -1, y: 5 }] }],
    nets: ["SIG", "GND"], layers: ["F.Cu", "B.Cu"],
    copperStack: ["F.Cu", "B.Cu"], copperLayerTypes: { "F.Cu": "signal", "B.Cu": "signal" },
    stackup: STACKUP_2L,
    bbox: { minX: 0, minY: 0, maxX: 10, maxY: 1 },
    ...partial,
  };
}

describe("net RLGC classifier — reference planes are explicit", () => {
  it("zone of a USER-specified reference net makes a microstrip", () => {
    const r = analyzeNetRlgc(board2L(), "SIG", { referenceNets: ["GND"], frequencyHz: 1e9 });
    expect(r.segments).toHaveLength(1);
    const s = r.segments[0]!;
    expect(s.kind).toBe("microstrip");
    expect(s.refBelow).toBe("B.Cu");
    expect(s.refAbove).toBeUndefined();
    // exact agreement with a direct model call using the stackup geometry
    const direct = microstrip({ widthM: 0.3e-3, heightM: 0.5e-3, epsilonR: 4.3, thicknessM: 35e-6, frequencyHz: 1e9 });
    expect(s.z0).toBeCloseTo(direct.z0, 12);
    expect(s.epsEff).toBeCloseTo(direct.epsEff, 12);
    expect(s.cPerM).toBeCloseTo(direct.capacitanceFPerM, 15);
    expect(s.assumed).toEqual([]); // full stackup: nothing assumed
    expect(r.totals.modeledLengthMm).toBeCloseTo(10, 9);
    expect(r.totals.delayS).toBeCloseTo(direct.delaySPerM * 10e-3, 15);
  });

  it("without reference nets (and no power layers) the segment is unmodeled, with the reason", () => {
    const r = analyzeNetRlgc(board2L(), "SIG", { frequencyHz: 1e9 });
    expect(r.segments[0]!.kind).toBe("unmodeled");
    expect(r.segments[0]!.reason).toMatch(/no reference nets specified/);
    expect(r.totals.modeledLengthMm).toBe(0);
  });

  it("a zone that does not cover the segment is not its plane", () => {
    const away = board2L({
      zones: [{ layer: "B.Cu", net: "GND", pts: [{ x: 50, y: 50 }, { x: 60, y: 50 }, { x: 60, y: 60 }, { x: 50, y: 60 }] }],
    });
    const r = analyzeNetRlgc(away, "SIG", { referenceNets: ["GND"] });
    expect(r.segments[0]!.kind).toBe("unmodeled");
    expect(r.segments[0]!.reason).toMatch(/no reference plane covers/);
  });

  it("a declared power-type layer counts as a plane without any zone or referenceNets", () => {
    const declared = board2L({ zones: [], copperLayerTypes: { "F.Cu": "signal", "B.Cu": "power" } });
    const r = analyzeNetRlgc(declared, "SIG", {});
    expect(r.segments[0]!.kind).toBe("microstrip");
  });

  it("planes on both sides make a stripline matching a direct model call", () => {
    const stackup: Pcb["stackup"] = [
      { name: "F.Cu", type: "copper", thicknessMm: 0.035 },
      { name: "d1", type: "prepreg", thicknessMm: 0.2, epsilonR: 4.2, lossTangent: 0.018 },
      { name: "In1.Cu", type: "copper", thicknessMm: 0.018 },
      { name: "d2", type: "core", thicknessMm: 0.4, epsilonR: 4.6, lossTangent: 0.012 },
      { name: "In2.Cu", type: "copper", thicknessMm: 0.018 },
      { name: "d3", type: "prepreg", thicknessMm: 0.2, epsilonR: 4.2 },
      { name: "B.Cu", type: "copper", thicknessMm: 0.035 },
    ];
    const four = board2L({
      tracks: [{ start: { x: 0, y: 0 }, end: { x: 20, y: 0 }, width: 0.15, layer: "In1.Cu", net: "SIG" }],
      zones: [
        { layer: "F.Cu", net: "GND", pts: [{ x: -1, y: -5 }, { x: 21, y: -5 }, { x: 21, y: 5 }, { x: -1, y: 5 }] },
      ],
      copperStack: ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"],
      copperLayerTypes: { "F.Cu": "signal", "In1.Cu": "signal", "In2.Cu": "power", "B.Cu": "signal" },
      stackup,
    });
    const r = analyzeNetRlgc(four, "SIG", { referenceNets: ["GND"], frequencyHz: 1e9 });
    const s = r.segments[0]!;
    expect(s.kind).toBe("stripline");
    expect(s.refAbove).toBe("F.Cu");
    expect(s.refBelow).toBe("In2.Cu");
    // geometry: gaps 0.2 (up) and 0.4 (down), t = 18 µm; εr thickness-weighted
    const er = (4.2 * 0.2 + 4.6 * 0.4) / 0.6;
    const direct = stripline({
      widthM: 0.15e-3, planeSpacingM: 0.6e-3 + 18e-6, thicknessM: 18e-6, offsetM: 0.4e-3, epsilonR: er,
    });
    expect(s.z0).toBeCloseTo(direct.z0, 12);
    expect(s.epsEff).toBeCloseTo(er, 12);
    expect(s.assumed).toEqual([]);
  });

  it("RLGC identities: R = 2·αc·Z0 and G = 2·αd/Z0 (nepers)", () => {
    const r = analyzeNetRlgc(board2L(), "SIG", { referenceNets: ["GND"], frequencyHz: 1e9 });
    const s = r.segments[0]!;
    const loss = microstripLoss({
      widthM: 0.3e-3, heightM: 0.5e-3, epsilonR: 4.3, thicknessM: 35e-6,
      frequencyHz: 1e9, tanDelta: 0.015,
    });
    const np = Math.LN10 / 20;
    expect(s.rPerM).toBeCloseTo(2 * loss.alphaConductorDbPerM * np * s.z0!, 9);
    expect(s.gPerM).toBeCloseTo((2 * loss.alphaDielectricDbPerM * np) / s.z0!, 12);
    expect(s.alphaDbPerM).toBeCloseTo(loss.alphaDbPerM, 9);
  });

  it("no stackup: models with flagged 1.6 mm / 35 µm / εr defaults instead of failing", () => {
    const bare = board2L({ stackup: undefined });
    const r = analyzeNetRlgc(bare, "SIG", { referenceNets: ["GND"] });
    const s = r.segments[0]!;
    expect(s.kind).toBe("microstrip");
    expect(s.assumed.join(" ")).toMatch(/no stackup/);
    expect(s.assumed.join(" ")).toMatch(/εr unknown/);
    const direct = microstrip({ widthM: 0.3e-3, heightM: 1.6e-3, epsilonR: 4.5, thicknessM: 35e-6, frequencyHz: 1e9 });
    expect(s.z0).toBeCloseTo(direct.z0, 12);
  });
});

describe("pad-to-pad profile (analyzePathRlgc)", () => {
  const pad = (ref: string, x: number, y: number, layers: string[] = ["F.Cu"]): Pad => ({
    ref, number: "1", shape: "rect", thruHole: false, pos: { x, y }, size: { w: 0.5, h: 0.5 },
    angle: 0, rratio: 0.25, layers, net: "SIG",
  });
  const fp = (p: Pad): Footprint => ({
    ref: p.ref, symbolUuid: "", value: "", pos: { x: 0, y: 0 }, angle: 0, layer: "F.Cu",
    pads: [p], graphics: [], refPos: { x: 0, y: 0 }, refLayer: "F.SilkS",
  });

  // A(F.Cu 0,0) --10mm F.Cu 0.3--> (10,0) via -> B.Cu --8mm B.Cu 0.2--> B(18,0)
  // plus a 5 mm stub branching at (10,0) on F.Cu
  function pathBoard(): Pcb {
    return {
      ...board2L(),
      footprints: [fp(pad("A", 0, 0)), fp(pad("B", 18, 0, ["B.Cu"]))],
      tracks: [
        { start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, width: 0.3, layer: "F.Cu", net: "SIG" },
        { start: { x: 10, y: 0 }, end: { x: 18, y: 0 }, width: 0.2, layer: "B.Cu", net: "SIG" },
        { start: { x: 10, y: 0 }, end: { x: 10, y: 5 }, width: 0.3, layer: "F.Cu", net: "SIG" }, // stub
      ],
      vias: [{ pos: { x: 10, y: 0 }, size: 0.6, drill: 0.3, layers: ["F.Cu", "B.Cu"], net: "SIG" }],
      zones: [
        { layer: "B.Cu", net: "GND", pts: [{ x: -1, y: -6 }, { x: 19, y: -6 }, { x: 19, y: 6 }, { x: -1, y: 6 }] },
        { layer: "F.Cu", net: "GND", pts: [{ x: 9, y: -6 }, { x: 19, y: -6 }, { x: 19, y: 6 }, { x: 9, y: 6 }] },
      ],
      copperStack: ["F.Cu", "B.Cu"],
      copperLayerTypes: { "F.Cu": "signal", "B.Cu": "signal" },
    };
  }

  it("returns the ordered profile with cumulative positions and the via event", () => {
    const r = analyzePathRlgc(pathBoard(), "SIG", "A.1", "B.1", { referenceNets: ["GND"], frequencyHz: 1e9 })!;
    expect(r).not.toBeNull();
    const kinds = r.steps.map((s) => (s.type === "via" ? "via" : `${s.type}:${(s as { layer: string }).layer}`));
    expect(kinds).toEqual(["segment:F.Cu", "via", "segment:B.Cu"]);
    const [seg1, via, seg2] = r.steps as [Extract<typeof r.steps[number], { type: "segment" }>, Extract<typeof r.steps[number], { type: "via" }>, Extract<typeof r.steps[number], { type: "segment" }>];
    expect(seg1.atMm).toBe(0);
    expect(via.atMm).toBeCloseTo(10, 9);
    expect(seg2.atMm).toBeCloseTo(10, 9);
    expect(via.padBarrel).toBe(false);
    // F.Cu run is microstrip over the B.Cu pour; B.Cu run is microstrip against the F.Cu pour ABOVE it
    expect(seg1.kind).toBe("microstrip");
    expect(seg2.kind).toBe("microstrip");
    expect(seg2.refAbove).toBe("F.Cu");
    expect(r.totals.viaCount).toBe(1);
    expect(r.totals.lengthMm).toBeCloseTo(18, 9);
  });

  it("finds the stub hanging at the via point, excluding path tracks", () => {
    const r = analyzePathRlgc(pathBoard(), "SIG", "A.1", "B.1", { referenceNets: ["GND"] })!;
    expect(r.stubs).toHaveLength(1);
    expect(r.stubs[0]!.atMm).toBeCloseTo(10, 9);
    expect(r.stubs[0]!.lengthMm).toBeCloseTo(5, 9);
  });

  it("segment travel order flips reversed tracks (start of profile = pad A side)", () => {
    // ask for the reverse direction: from B to A — first step is the B.Cu segment,
    // and its reported start must be at pad B's end (x = 18)
    const r = analyzePathRlgc(pathBoard(), "SIG", "B.1", "A.1", { referenceNets: ["GND"] })!;
    const first = r.steps[0]!;
    expect(first.type).toBe("segment");
    if (first.type === "segment") expect(first.start.x).toBeCloseTo(18, 9);
  });

  it("returns null when there is no pure track path", () => {
    const zoneOnly = board2L({ tracks: [], footprints: [fp(pad("A", 0, 0)), fp(pad("B", 18, 0))] });
    expect(analyzePathRlgc(zoneOnly, "SIG", "A.1", "B.1", { referenceNets: ["GND"] })).toBeNull();
  });

  it("profile Z0 matches the whole-net classifier for the same segments", () => {
    const path = analyzePathRlgc(pathBoard(), "SIG", "A.1", "B.1", { referenceNets: ["GND"], frequencyHz: 1e9 })!;
    const net = analyzeNetRlgc(pathBoard(), "SIG", { referenceNets: ["GND"], frequencyHz: 1e9 });
    const pathSeg1 = path.steps.find((s) => s.type === "segment")! as { z0?: number };
    const netSeg1 = net.segments.find((s) => s.layer === "F.Cu" && s.lengthMm > 6)!;
    expect(pathSeg1.z0).toBeCloseTo(netSeg1.z0!, 12);
  });
});
