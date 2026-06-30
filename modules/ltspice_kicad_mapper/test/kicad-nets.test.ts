import { describe, it, expect } from "vitest";
import { normalizeNetName, reconcileKicadNets, reconcileKicadComponents, type SchNet } from "../src/mapping/kicad-nets.js";

describe("normalizeNetName", () => {
  it("strips a leading slash", () => {
    expect(normalizeNetName("/POW")).toBe("POW");
  });
  it("strips sheet-path segments", () => {
    expect(normalizeNetName("/sheet1/POW")).toBe("POW");
  });
  it("leaves plain and auto names untouched", () => {
    expect(normalizeNetName("POW")).toBe("POW");
    expect(normalizeNetName("Net-(C10-Pad1)")).toBe("Net-(C10-Pad1)");
  });
});

describe("reconcileKicadNets", () => {
  it("matches exact, slash-prefixed, and structural nets", () => {
    const schNets: SchNet[] = [
      { name: "Net-(C10-Pad1)", refs: ["C10", "R5"] }, // exact
      { name: "POW", refs: ["Q1", "Q2"] },             // -> /POW (normalized)
      { name: "FEEDBACK", refs: ["R7", "C4"] },        // no name match -> structural by ref-set
    ];
    const pcbNets = ["Net-(C10-Pad1)", "/POW", "/Net-(weird-name)"];
    const pcbNetRefs = new Map<string, string[]>([
      ["Net-(C10-Pad1)", ["C10", "R5"]],
      ["/POW", ["Q1", "Q2"]],
      ["/Net-(weird-name)", ["C4", "R7"]],
    ]);

    const alias = reconcileKicadNets(schNets, pcbNets, pcbNetRefs);

    expect(alias.schToPcb.get("Net-(C10-Pad1)")).toBe("Net-(C10-Pad1)");
    expect(alias.schToPcb.get("POW")).toBe("/POW");
    expect(alias.schToPcb.get("FEEDBACK")).toBe("/Net-(weird-name)");
    // reverse direction
    expect(alias.pcbToSch.get("/POW")).toBe("POW");
    expect(alias.pcbToSch.get("/Net-(weird-name)")).toBe("FEEDBACK");
  });

  it("does not match structurally when the ref-set is ambiguous", () => {
    const schNets: SchNet[] = [{ name: "A", refs: ["R1", "R2"] }];
    const pcbNets = ["/x", "/y"];
    const pcbNetRefs = new Map<string, string[]>([
      ["/x", ["R1", "R2"]],
      ["/y", ["R1", "R2"]],
    ]);
    const alias = reconcileKicadNets(schNets, pcbNets, pcbNetRefs);
    expect(alias.schToPcb.has("A")).toBe(false);
  });

  it("does not reuse a PCB net for two schematic nets", () => {
    const schNets: SchNet[] = [
      { name: "POW", refs: ["Q1"] },
      { name: "POWER", refs: ["Q2"] },
    ];
    // both normalize-collide onto a single /POW; neither should bind ambiguously
    const alias = reconcileKicadNets(schNets, ["/POW"], new Map([["/POW", ["Q1"]]]));
    // exact fails; normalized: "POW"->/POW unique, "POWER"->(none). Structural: /POW already used.
    expect(alias.schToPcb.get("POW")).toBe("/POW");
    expect(alias.schToPcb.has("POWER")).toBe(false);
  });
});

describe("reconcileKicadComponents", () => {
  it("matches by symbol UUID even when the reference designator differs (Q3 vs Q3*)", () => {
    const sch = [
      { ref: "Q3", uuid: "u-q3" },
      { ref: "R1", uuid: "u-r1" },
    ];
    const pcb = [
      { ref: "Q3*", symbolUuid: "u-q3" }, // renamed/annotated on the board
      { ref: "R1", symbolUuid: "u-r1" },
    ];
    const a = reconcileKicadComponents(sch, pcb);
    expect(a.schToPcb.get("Q3")).toBe("Q3*");
    expect(a.pcbToSch.get("Q3*")).toBe("Q3");
    expect(a.schToPcb.get("R1")).toBe("R1");
  });

  it("omits footprints with no UUID match (caller falls back to identity)", () => {
    const a = reconcileKicadComponents(
      [{ ref: "Q3", uuid: "u-q3" }],
      [{ ref: "H1", symbolUuid: "" }, { ref: "X9", symbolUuid: "unknown" }],
    );
    expect(a.schToPcb.size).toBe(0);
    expect(a.pcbToSch.size).toBe(0);
  });
});
