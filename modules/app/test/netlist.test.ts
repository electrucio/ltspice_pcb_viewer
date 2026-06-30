import { describe, it, expect } from "vitest";
import { parseNetlistRefs, buildNetNodeAlias, decodeNetlist } from "../src/sim/netlist.js";

// A slice of the AudioAmpCompl-40W topology around the anonymous node N008.
const NETLIST = [
  "* /path/to/AudioAmpCompl-40W.asc",
  "R9 N008 BOOTSTRAP 1k",
  "R2 N009 N008 1k",
  "R26 Q6C N008 47",
  "C14 N008 0 1000u",
  "Q6 Q6C Q6B Q6E 0 2SD896", // 4th node (substrate) ignored via viewer pin count
  "XRV2 N010 N011 Q3B linear_pot Rtot=1K wiper=.037", // subckt: X prefix stripped
  ".model NPN NPN",
  "+ continuation line should be skipped",
  ".end",
].join("\n");

const COMPS = [
  { ref: "R9", nets: ["Net-(C14.1)", "BOOTSTRAP"] },
  { ref: "R2", nets: ["N009-ish", "Net-(C14.1)"] },
  { ref: "R26", nets: ["Q6C", "Net-(C14.1)"] },
  { ref: "C14", nets: ["Net-(C14.1)", "0"] },
  { ref: "Q6", nets: ["Q6C", "Q6B", "Q6E"] },
  { ref: "RV2", nets: ["N010-ish", "N011-ish", "Q3B"] },
];

describe("netlist bridge", () => {
  it("parses device refs, skips directives/comments/continuations, strips subckt X", () => {
    const refs = parseNetlistRefs(NETLIST);
    expect(refs.get("R9")).toEqual(["N008", "BOOTSTRAP", "1k"]);
    expect(refs.get("Q6")).toEqual(["Q6C", "Q6B", "Q6E", "0", "2SD896"]);
    expect(refs.get("RV2")).toBeDefined(); // X stripped
    expect(refs.has("XRV2")).toBe(false);
    expect(refs.has(".model")).toBe(false);
    expect(refs.has("+")).toBe(false);
  });

  it("aliases an anonymous viewer net to its LTspice node by shared ref-set", () => {
    const alias = buildNetNodeAlias(parseNetlistRefs(NETLIST), COMPS);
    // Net-(C14.1) touches {R9,R2,R26,C14} — exactly what node N008 touches.
    expect(alias.get("Net-(C14.1)")).toBe("N008");
  });

  it("does not alias labeled nets that already match by name", () => {
    const alias = buildNetNodeAlias(parseNetlistRefs(NETLIST), COMPS);
    expect(alias.has("BOOTSTRAP")).toBe(false); // self-match → skipped
    expect(alias.has("Q6C")).toBe(false);
  });

  it("decodes UTF-16LE (BOM and no-BOM) and UTF-8", () => {
    const enc16 = (s: string, bom: boolean): ArrayBuffer => {
      const u = new Uint8Array((bom ? 2 : 0) + s.length * 2);
      let o = 0;
      if (bom) { u[0] = 0xff; u[1] = 0xfe; o = 2; }
      for (let i = 0; i < s.length; i++) { u[o++] = s.charCodeAt(i) & 0xff; u[o++] = s.charCodeAt(i) >> 8; }
      return u.buffer;
    };
    expect(decodeNetlist(enc16("R9 N008 0 1k", true))).toContain("R9 N008 0 1k");
    expect(decodeNetlist(enc16("R9 N008 0 1k", false))).toContain("R9 N008 0 1k");
    expect(decodeNetlist(new TextEncoder().encode("R9 N008 0 1k").buffer)).toContain("R9 N008 0 1k");
  });
});
