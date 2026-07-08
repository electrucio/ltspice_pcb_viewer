import type { Footprint, Pad, Pcb } from "../../kicad_pcb_viewer/src/parser/pcb.js";

export function makePcb(partial: Partial<Pcb>): Pcb {
  return {
    footprints: [],
    tracks: [],
    vias: [],
    zones: [],
    graphics: [],
    texts: [],
    nets: [],
    layers: [],
    copperStack: ["F.Cu", "B.Cu"],
    bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    ...partial,
  };
}

export function makePad(partial: Partial<Pad>): Pad {
  return {
    ref: "U1",
    number: "1",
    shape: "circle",
    thruHole: false,
    pos: { x: 0, y: 0 },
    size: { w: 1, h: 1 },
    angle: 0,
    rratio: 0.25,
    layers: ["*.Cu"],
    net: "N1",
    ...partial,
  };
}

export function makeFootprint(pads: Pad[]): Footprint {
  return {
    ref: "U1",
    symbolUuid: "",
    value: "",
    pos: { x: 0, y: 0 },
    angle: 0,
    layer: "F.Cu",
    pads,
    graphics: [],
    refPos: { x: 0, y: 0 },
    refLayer: "F.SilkS",
  };
}
