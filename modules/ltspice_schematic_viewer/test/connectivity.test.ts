import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAsc } from "../src/parser/asc.js";
import { buildModel } from "../src/netlist/connectivity.js";
import { SymbolLibrary } from "../src/symbols/builtin.js";

const root = new URL("../", import.meta.url);
const text = readFileSync(fileURLToPath(new URL("test/fixtures/AudioAmpCompl-40W.asc", root)), "utf8");
const lib = new SymbolLibrary();
for (const p of ["lin_pot", "log_pot", "revlog_pot"]) {
  lib.register(p, readFileSync(fileURLToPath(new URL(`demo/${p}.asy`, root)), "utf8"));
}
const sch = parseAsc(text);
const model = buildModel(sch, lib);
const nl = model.netlist;

const netOf = (pin: string) => nl.pinToNet.get(pin);
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
  it("parses the .asc structure", () => {
    expect(sch.symbols.length).toBe(130);
    expect(sch.wires.length).toBe(400);
    expect(sch.flags.length).toBe(65);
  });
  it("resolves every symbol's geometry (built-ins + registered pots)", () => {
    expect(model.placed.filter((p) => !p.def)).toHaveLength(0);
  });
});

describe("net engine — cross-validated with the KiCad poweramp net mapping", () => {
  it("merges all grounds into power net '0'", () => {
    const gnd = nl.byName.get("0")!;
    expect(gnd).toBeDefined();
    expect(gnd.isPower).toBe(true);
    expect(netOf("V2.2")).toBe(gnd.id); // supply return to ground
  });

  it("names nets from flags and groups the documented pins", () => {
    // VCC = main supply (V2 / Q6 / Q4 / R26)
    expect(assertSameNet(["V2.1", "Q6.1", "Q4.1", "R26.1"])).toBe(nl.byName.get("VCC")!.id);
    // FEEDBACK = C4 / R4 / R19 / RV1
    expect(assertSameNet(["C4.2", "R4.1", "R19.2"])).toBe(nl.byName.get("FEEDBACK")!.id);
    // BOOTSTRAP = C8 / R9 / R10
    expect(assertSameNet(["C8.1", "R9.2", "R10.1"])).toBe(nl.byName.get("BOOTSTRAP")!.id);
  });

  it("reconstructs the output node identically to the KiCad viewer's OUT net", () => {
    // KiCad OUT = {C8.2, C9.1, C10(.1 there), R14, R16, R17, R5}; here PRE_SPEAKER
    assertSameNet(["C8.2", "C9.1", "C10.2", "R14.2", "R16.2", "R17.1", "R5.1"]);
  });

  it("assigns each pin to exactly one net", () => {
    const seen = new Set<string>();
    for (const net of nl.nets) for (const p of net.pins) {
      const k = `${p.ref}.${p.number}`;
      expect(seen.has(k), `pin ${k} in two nets`).toBe(false);
      seen.add(k);
    }
    expect(seen.size).toBeGreaterThan(200);
  });
});
