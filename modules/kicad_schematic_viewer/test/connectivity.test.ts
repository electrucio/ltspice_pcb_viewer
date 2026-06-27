import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSchematic } from "../src/parser/schematic.js";
import { buildNetlist, type Netlist } from "../src/netlist/connectivity.js";

const text = readFileSync(fileURLToPath(new URL("./fixtures/poweramp.kicad_sch", import.meta.url)), "utf8");
const sch = parseSchematic(text);
const nl: Netlist = buildNetlist(sch);

/** net id for a `${ref}.${pinNumber}` pin */
const netOf = (pin: string) => nl.pinToNet.get(pin);

/** assert every pin in the group resolves to the same (defined) net */
function assertSameNet(pins: string[]): number {
  const ids = pins.map((p) => {
    const id = netOf(p);
    expect(id, `pin ${p} should belong to a net`).toBeDefined();
    return id!;
  });
  for (const id of ids) expect(id).toBe(ids[0]);
  return ids[0]!;
}

describe("parser", () => {
  it("parses placed instances, wires, junctions and labels", () => {
    expect(sch.instances.length).toBe(55);
    expect(sch.wires.length).toBe(119);
    expect(sch.junctions.length).toBe(35);
    expect(sch.labels.map((l) => l.text).sort()).toEqual(["POW", "POW1", "POW2"]);
  });
});

describe("net engine — validated against poweramp_net_mapping.md oracle", () => {
  it("merges every ground symbol and all connector pin-2s into net '0'", () => {
    const gnd = nl.byName.get("0");
    expect(gnd, "ground net '0' must exist").toBeDefined();
    expect(gnd!.isPower).toBe(true);
    // all 8 GND power symbols collapse to one net
    const gndSymbols = gnd!.pins.filter((p) => p.ref.startsWith("#GND"));
    expect(gndSymbols.length).toBe(8);
    // oracle: "All connector pin 2s = ground"
    for (const p of ["PREAMP1.2", "SPEAKER1.2", "VCC1.2"]) expect(netOf(p)).toBe(gnd!.id);
  });

  it("names supply nets from labels with the oracle's membership", () => {
    // POW  = main supply rail (VCC1 / Q6 collector / Q4 collector / R26)
    expect(assertSameNet(["VCC1.1", "Q6.2", "Q4.2", "R26.1"])).toBe(nl.byName.get("POW")!.id);
    // POW1 = after R26 (47Ω), filtered by C14
    expect(assertSameNet(["C14.1", "R2.1", "R26.2", "R9.1"])).toBe(nl.byName.get("POW1")!.id);
    // POW2 = after R2 (1k), filtered by C3 — front-end supply
    expect(assertSameNet(["C12.1", "C3.1", "R2.2", "R3.1"])).toBe(nl.byName.get("POW2")!.id);
  });

  it("reconstructs anonymous-net connectivity (names may differ from KiCad)", () => {
    // OUT: output node before coupling cap C10 (emitter Rs, bootstrap, zobel)
    assertSameNet(["C10.1", "C8.2", "C9.1", "R14.2", "R16.2", "R17.1", "R5.1"]);
    // FEEDBACK: C4 / R4 / R19 / RV1
    assertSameNet(["C4.2", "R4.1", "R19.2"]);
    // D10 anode = Q7 collector = R17 ; D10 cathode = Q5 emitter
    assertSameNet(["D10.2", "Q7.2", "R17.2"]);
    assertSameNet(["D10.1", "Q5.1"]);
  });

  it("assigns each pin to exactly one net", () => {
    const seen = new Map<string, number>();
    for (const net of nl.nets) {
      for (const p of net.pins) {
        const k = `${p.ref}.${p.number}`;
        expect(seen.has(k), `pin ${k} appears in two nets`).toBe(false);
        seen.set(k, net.id);
      }
    }
    expect(seen.size).toBeGreaterThan(100);
  });
});
