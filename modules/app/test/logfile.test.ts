import { describe, it, expect } from "vitest";
import { parseLog, mergeLog, decodeLog } from "../src/sim/logfile.js";
import type { SimSummary } from "../../ltspice_kicad_mapper/src/sim/summary.js";

// A trimmed slice of a real LTspice .log: one signal .four, one 50 Hz .four, and a few .meas.
const LOG = [
  "Circuit: * test",
  "",
  "N-Period=10",
  "Fourier components of V(preamp_out)",
  "DC component:-2.49291e-05",
  "",
  "Harmonic\tFrequency\t Fourier \tNormalized\t Phase  \tNormalized",
  " Number \t  [Hz]   \tComponent\t Component\t[degree]\tPhase [deg]",
  "    1   \t 1.000e+3\t 9.876e-2\t 1.000e+0\t   55.13°\t    0.00°",
  "    2   \t 2.000e+3\t 8.249e-6\t 8.353e-5\t   -1.57°\t  -56.71°",
  "    3   \t 3.000e+3\t 2.244e-6\t 2.272e-5\t  109.58°\t   54.45°",
  "Total Harmonic Distortion: 0.012662%",
  "",
  "Fourier components of V(n002)",
  "    1   \t 5.000e+1\t 5.708e-5\t 1.000e+0\t    0.00°\t    0.00°",
  "    2   \t 1.000e+2\t 1.287e-2\t 2.254e+2\t    0.00°\t    0.00°",
  "Total Harmonic Distortion: 25717.186534%",
  "",
  "vq12b_mean: AVG(v(q12b))=27.6933 FROM 0 TO 0.2",
  "vq12b_max: MAX(v(q12b))=27.9 FROM 0 TO 0.2",
  "iq6_bias: AVG(i(r16))=0.0412 FROM 0 TO 0.2",
  "vraw_ripple: (vraw_max-vraw_min)=0.0375595",
].join("\n");

describe("parseLog", () => {
  const parsed = parseLog(LOG);

  it("parses signal + mains .four blocks with THD and harmonics", () => {
    const sig = parsed.four.find((f) => f.node === "preamp_out")!;
    expect(sig.mains).toBe(false);
    expect(sig.block.f0).toBe(1000);
    expect(sig.block.nPeriods).toBe(10);
    expect(sig.block.thdPct).toBeCloseTo(0.012662, 5);
    expect(sig.block.harmonics).toHaveLength(3);
    expect(sig.block.harmonics[1]).toMatchObject({ n: 2, freq: 2000, amp: 8.249e-6, norm: 8.353e-5 });

    const mains = parsed.four.find((f) => f.node === "n002")!;
    expect(mains.mains).toBe(true);
    expect(mains.block.f0).toBe(50);
    expect(mains.block.harmonics[1]!.amp).toBeCloseTo(1.287e-2, 6); // 100 Hz ripple
  });

  it("parses .meas results and derives node/ref + unit from the expression", () => {
    const byName = Object.fromEntries(parsed.meas.map((m) => [m.name, m]));
    expect(byName.vq12b_mean).toMatchObject({ value: 27.6933, node: "q12b", unit: "V" });
    expect(byName.iq6_bias).toMatchObject({ value: 0.0412, ref: "r16", unit: "A" });
    expect(byName.vraw_ripple).toMatchObject({ value: 0.0375595, unit: "" }); // PARAM → no node/ref
    expect(byName.vraw_ripple!.node).toBeUndefined();
  });
});

describe("mergeLog", () => {
  const base = (): SimSummary => ({
    window: 0.2, nPoints: 10, source: "x.raw", directives: [],
    nets: {
      PREAMP_OUT: { v: { min: 0, max: 0, avg: 0, rms: 0, pp: 0 }, dc: null },
      "Net-(C7.1)": { v: { min: 0, max: 0, avg: 0, rms: 0, pp: 0 }, dc: null }, // anonymous → aliased to n002
    },
    comps: { R16: { type: "R" } },
  });

  it("attaches .four (signal & mains) and .meas to nets/comps, case-insensitively + via alias", () => {
    const s = base();
    const alias = new Map([["Net-(C7.1)", "N002"]]); // viewerNet → LTspice node
    const r = mergeLog(s, parseLog(LOG), alias, "x.log");

    expect(r.four).toBe(2);
    expect(s.nets["PREAMP_OUT"]!.log!.four!.thdPct).toBeCloseTo(0.012662, 5); // "preamp_out" → PREAMP_OUT
    expect(s.nets["Net-(C7.1)"]!.log!.mains!.f0).toBe(50); // "n002" → alias → Net-(C7.1)
    expect(s.nets["PREAMP_OUT"]!.log!.meas).toBeUndefined(); // no q12b net here
    expect(s.comps["R16"]!.log!.meas!.map((m) => m.name)).toContain("iq6_bias"); // i(r16) → R16
    expect(s.logSource).toBe("x.log");
    // q12b has no matching net, vraw_ripple has no node → both land in globals
    expect(s.logGlobals!.map((m) => m.name)).toEqual(expect.arrayContaining(["vq12b_mean", "vraw_ripple"]));
  });
});

describe("decodeLog", () => {
  it("decodes UTF-16LE (BOM) and UTF-8", () => {
    const u16 = (s: string): ArrayBuffer => {
      const u = new Uint8Array(2 + s.length * 2); u[0] = 0xff; u[1] = 0xfe;
      for (let i = 0; i < s.length; i++) { u[2 + i * 2] = s.charCodeAt(i) & 0xff; u[3 + i * 2] = s.charCodeAt(i) >> 8; }
      return u.buffer;
    };
    expect(decodeLog(u16("Total Harmonic Distortion: 0.01%"))).toContain("Total Harmonic Distortion");
    expect(decodeLog(new TextEncoder().encode("iq6_bias: AVG(i(r16))=0.04").buffer)).toContain("iq6_bias");
  });
});
