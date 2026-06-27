import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MappingStore, type AvailableIds } from "../src/mapping/store.js";
import { serialize, deserialize } from "../src/mapping/format.js";
import { Pairing } from "../src/interaction/pairing.js";

const sampleText = readFileSync(fileURLToPath(new URL("./fixtures/sample-mapping.json", import.meta.url)), "utf8");

function avail(): AvailableIds {
  return {
    ltspice: { nets: new Set(["0", "VCC", "PRE_SPEAKER", "FEEDBACK", "BOOTSTRAP"]), components: new Set(["R1", "Q1", "R99"]) },
    kicad: { nets: new Set(["0", "POW", "Net-(C8-Pad2)", "Net-(C4-Pad2)", "Net-(C8-Pad1)"]), components: new Set(["R1", "Q1"]) },
  };
}

describe("format", () => {
  it("round-trips serialize/deserialize", () => {
    const file = deserialize(sampleText);
    expect(deserialize(serialize(file))).toEqual(file);
  });
  it("rejects bad documents", () => {
    expect(() => deserialize('{"version":2}')).toThrow();
    expect(() => deserialize('{"version":1,"nets":[{"ltspice":1}]}')).toThrow();
  });
});

describe("MappingStore — 1:1 invariants", () => {
  it("links and queries both directions", () => {
    const s = new MappingStore();
    s.map("net", "VCC", "POW");
    expect(s.counterpart("net", "ltspice", "VCC")).toBe("POW");
    expect(s.counterpart("net", "kicad", "POW")).toBe("VCC");
    expect(s.isMapped("net", "ltspice", "VCC")).toBe(true);
  });
  it("re-linking a side drops the previous pairing (stays 1:1)", () => {
    const s = new MappingStore();
    s.map("net", "VCC", "POW");
    s.map("net", "VCC", "POW2"); // remap ltspice VCC
    expect(s.counterpart("net", "ltspice", "VCC")).toBe("POW2");
    expect(s.isMapped("net", "kicad", "POW")).toBe(false);
    s.map("net", "OTHER", "POW2"); // steal kicad POW2
    expect(s.isMapped("net", "ltspice", "VCC")).toBe(false);
    expect(s.counterpart("net", "kicad", "POW2")).toBe("OTHER");
  });
  it("unmaps from either side", () => {
    const s = new MappingStore();
    s.map("component", "R1", "R1");
    s.unmap("component", "kicad", "R1");
    expect(s.isMapped("component", "ltspice", "R1")).toBe(false);
    expect(s.counts().components).toBe(0);
  });
  it("keeps nets and components independent", () => {
    const s = new MappingStore();
    s.map("net", "0", "0");
    s.map("component", "R1", "R1");
    expect(s.counts()).toEqual({ nets: 1, components: 1 });
  });
});

describe("MappingStore — suggestions", () => {
  it("suggests exact and case-insensitive matches that are still free", () => {
    const s = new MappingStore();
    const a = avail();
    expect(s.suggest("net", "ltspice", "0", a)).toEqual(["0"]);
    expect(s.suggest("component", "ltspice", "r1", a)).toEqual(["R1"]); // case-insensitive
    expect(s.suggest("net", "ltspice", "VCC", a)).toEqual([]); // no name match (different naming)
    s.map("net", "FOO", "0"); // 0 now taken on kicad side
    expect(s.suggest("net", "ltspice", "0", a)).toEqual([]);
  });
});

describe("MappingStore — import/export", () => {
  it("loads a file and round-trips through toFile", () => {
    const s = new MappingStore();
    const res = s.fromFile(sampleText);
    expect(res).toEqual({ loaded: 7, dropped: 0 });
    expect(s.counts()).toEqual({ nets: 5, components: 2 });
    const out = s.toFile({ ltspiceSource: "AudioAmpCompl-40W.asc", kicadSource: "poweramp.kicad_sch" });
    expect(deserialize(serialize(out))).toEqual(deserialize(sampleText));
  });
  it("drops entries whose ids are absent from the loaded schematics", () => {
    const s = new MappingStore();
    const a = avail();
    a.kicad.nets.delete("Net-(C8-Pad1)"); // BOOTSTRAP target gone
    const res = s.fromFile(sampleText, a);
    expect(res.dropped).toBe(1);
    expect(s.isMapped("net", "ltspice", "BOOTSTRAP")).toBe(false);
    expect(s.isMapped("net", "ltspice", "VCC")).toBe(true);
  });
});

describe("Pairing state machine", () => {
  it("pends on one side then maps on the other", () => {
    const s = new MappingStore();
    const p = new Pairing(s, avail);
    const r1 = p.select("ltspice", "net", "VCC");
    expect(r1.type).toBe("pending");
    const r2 = p.select("kicad", "net", "POW");
    expect(r2).toMatchObject({ type: "created", ltspice: "VCC", kicad: "POW" });
    expect(s.counterpart("net", "ltspice", "VCC")).toBe("POW");
  });
  it("selecting a mapped item reports the pair without remapping", () => {
    const s = new MappingStore();
    s.map("net", "VCC", "POW");
    const p = new Pairing(s, avail);
    expect(p.select("kicad", "net", "POW")).toMatchObject({ type: "mapped", ltspice: "VCC", kicad: "POW" });
  });
  it("two selects on the same side just move the pending (no mapping)", () => {
    const s = new MappingStore();
    const p = new Pairing(s, avail);
    p.select("ltspice", "net", "VCC");
    const r = p.select("ltspice", "net", "FEEDBACK");
    expect(r.type).toBe("pending");
    expect(s.counts().nets).toBe(0);
  });
  it("does not cross-map different kinds", () => {
    const s = new MappingStore();
    const p = new Pairing(s, avail);
    p.select("ltspice", "net", "VCC");
    const r = p.select("kicad", "component", "R1");
    expect(r.type).toBe("pending"); // component pending, net still pending-less map not made
    expect(s.counts()).toEqual({ nets: 0, components: 0 });
  });
  it("unmaps the active pair", () => {
    const s = new MappingStore();
    s.map("net", "VCC", "POW");
    const p = new Pairing(s, avail);
    p.select("ltspice", "net", "VCC");
    expect(p.unmapActive()).toMatchObject({ kind: "net", ltspice: "VCC", kicad: "POW" });
    expect(s.counts().nets).toBe(0);
  });
});
