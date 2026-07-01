import { describe, it, expect } from "vitest";
import { parseRawHeader } from "../src/sim/raw.js";
import { buildSimSummary } from "../src/sim/build.js";
import type { RawFile } from "../src/sim/raw.js";

/** Build a synthetic LTspice transient .raw (UTF-16LE header) in memory. */
function synthRaw(opts: {
  T: number; N: number;
  sig: (t: number) => number; dc: number;
}): ArrayBuffer {
  const header =
    "Title: synthetic\nDate: now\nPlotname: Transient Analysis\nFlags: real\n" +
    "No. Variables: 3\nNo. Points: " + opts.N + "\nOffset: 0\nVariables:\n" +
    "\t0\ttime\ttime\n\t1\tV(sig)\tvoltage\n\t2\tV(dc)\tvoltage\nBinary:\n";
  const head = Buffer.from(header, "utf16le");
  const pointSize = 8 + 2 * 4;
  const body = Buffer.alloc(opts.N * pointSize);
  for (let i = 0; i < opts.N; i++) {
    const t = (opts.T * i) / (opts.N - 1);
    const off = i * pointSize;
    body.writeDoubleLE(t, off);
    body.writeFloatLE(opts.sig(t), off + 8);
    body.writeFloatLE(opts.dc, off + 12);
  }
  const out = Buffer.concat([head, body]);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength); // standalone ArrayBuffer (avoid Node's shared pool)
}

function memFile(buf: ArrayBuffer): RawFile {
  return { size: buf.byteLength, slice: (a, b) => ({ arrayBuffer: async () => buf.slice(a, b) }) };
}

/** Build a synthetic .raw with constant-valued variables (for DC-style power tests). */
function synthRawConst(names: string[], values: number[], N = 5, T = 0.01): ArrayBuffer {
  // names[0] must be "time"; values[0] is ignored (time runs 0..T).
  const varLines = names.map((v, i) => `\t${i}\t${v}\t${i === 0 ? "time" : "voltage"}`).join("\n");
  const header =
    "Title: synthetic\nDate: now\nPlotname: Transient Analysis\nFlags: real\n" +
    `No. Variables: ${names.length}\nNo. Points: ${N}\nOffset: 0\nVariables:\n${varLines}\nBinary:\n`;
  const head = Buffer.from(header, "utf16le");
  const pointSize = 8 + (names.length - 1) * 4;
  const body = Buffer.alloc(N * pointSize);
  for (let i = 0; i < N; i++) {
    const t = (T * i) / (N - 1);
    const off = i * pointSize;
    body.writeDoubleLE(t, off);
    for (let k = 1; k < names.length; k++) body.writeFloatLE(values[k]!, off + 8 + (k - 1) * 4);
  }
  const out = Buffer.concat([head, body]);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

/** Build a synthetic `.op.raw`-style single point where var0 is a real value (not time). */
function synthOpRaw(names: string[], values: number[]): ArrayBuffer {
  const varLines = names.map((v, i) => `\t${i}\t${v}\tvoltage`).join("\n");
  const header =
    "Title: synthetic\nDate: now\nPlotname: Operating Point\nFlags: real\n" +
    `No. Variables: ${names.length}\nNo. Points: 1\nOffset: 0\nVariables:\n${varLines}\nBinary:\n`;
  const head = Buffer.from(header, "utf16le");
  const pointSize = 8 + (names.length - 1) * 4;
  const body = Buffer.alloc(pointSize);
  body.writeDoubleLE(values[0]!, 0);
  for (let k = 1; k < names.length; k++) body.writeFloatLE(values[k]!, 8 + (k - 1) * 4);
  const out = Buffer.concat([head, body]);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

describe("parseRawHeader", () => {
  it("parses a UTF-16LE header (layout: f64 axis + f32 rest)", () => {
    const hdr = parseRawHeader(new Uint8Array(synthRaw({ T: 0.02, N: 10, sig: () => 0, dc: 1 })));
    expect(hdr.encoding).toBe("utf-16le");
    expect(hdr.nVars).toBe(3);
    expect(hdr.nPoints).toBe(10);
    expect(hdr.axisDouble).toBe(false);
    expect(hdr.pointSize).toBe(16);
    expect(hdr.vars.map((v) => v.name)).toEqual(["time", "V(sig)", "V(dc)"]);
  });
});

describe("buildSimSummary — time-weighted V stats", () => {
  const f0 = 1000, T = 0.02, N = 4000; // 20 periods, uniform

  it("computes min/avg/rms/pp for an AC net and a flat DC net (no harmonics/THD — those come from the .log)", async () => {
    const A = 1;
    const buf = synthRaw({ T, N, dc: 3.3, sig: (t) => A * Math.sin(2 * Math.PI * f0 * t) });
    const ctx = { nets: [{ name: "sig" }, { name: "dc" }], comps: [], directives: [] };
    const sum = await buildSimSummary(memFile(buf), null, ctx, "synth.raw", {});

    const sig = sum.nets["sig"]!;
    expect(Math.abs(sig.v.avg)).toBeLessThan(0.02);
    expect(sig.v.rms).toBeCloseTo(A / Math.SQRT2, 2);
    expect(sig.v.pp).toBeCloseTo(2 * A, 1);
    expect(sig.v.min).toBeCloseTo(-A, 1);
    expect(sig.v.max).toBeCloseTo(A, 1);

    const dc = sum.nets["dc"]!;
    expect(dc.v.avg).toBeCloseTo(3.3, 3);
    expect(dc.v.pp).toBeLessThan(1e-3);

    // the summary no longer carries any harmonic/THD/ripple fields
    expect((sig as unknown as { thdPct?: number }).thdPct).toBeUndefined();
    expect((sig as unknown as { harm?: number[] }).harm).toBeUndefined();
    expect(sig.log).toBeUndefined();
  });
});

describe("buildSimSummary — transistor dissipated power", () => {
  // Constant Vc=10, Vb=5, Ve=4.3 (Vce=5.7, Vbe=0.7), Ic=10mA, Ib=0.1mA.
  const buf = synthRawConst(
    ["time", "V(vc)", "V(vb)", "V(ve)", "Ic(Q1)", "Ib(Q1)"],
    [0, 10, 5, 4.3, 0.01, 0.0001],
  );
  const expectedP = 5.7 * 0.01 + 0.7 * 0.0001; // Vce·Ic + Vbe·Ib = 0.05707

  it("computes Pdiss = Vce·Ic + Vbe·Ib from the viewer's pin order when no netlist is loaded", async () => {
    const ctx = { nets: [], comps: [{ ref: "Q1", value: "", nets: ["vc", "vb", "ve"] }], directives: [] };
    const sum = await buildSimSummary(memFile(buf), null, ctx, "s.raw", {});
    expect(sum.comps["Q1"]!.pAvg).toBeCloseTo(expectedP, 5);
  });

  it("uses the SPICE netlist's node order (qNodes) rather than trusting a possibly-wrong symbol pin order", async () => {
    // The viewer reports the pins in the WRONG order (E, B, C instead of C, B, E) — as could
    // happen with a custom/third-party symbol. Without netlist grounding this would silently
    // compute the wrong (even wrong-signed) power; qNodes must override it with the correct order.
    const comps = [{ ref: "Q1", value: "", nets: ["ve", "vb", "vc"] }]; // viewer: E, B, C (wrong!)
    const ctxWrong = { nets: [], comps, directives: [] };
    const wrong = await buildSimSummary(memFile(buf), null, ctxWrong, "s.raw", {});
    expect(wrong.comps["Q1"]!.pAvg).not.toBeCloseTo(expectedP, 2); // fallback misfires, as expected

    const qNodes = new Map([["Q1", ["vc", "vb", "ve"]]]); // netlist: correct C, B, E
    const ctxFixed = { nets: [], comps, directives: [], qNodes };
    const fixed = await buildSimSummary(memFile(buf), null, ctxFixed, "s.raw", {});
    expect(fixed.comps["Q1"]!.pAvg).toBeCloseTo(expectedP, 5); // qNodes rescues it
  });

  it("falls back to Vce·Ic alone when Ib isn't available (graceful degradation)", async () => {
    const buf2 = synthRawConst(["time", "V(vc)", "V(vb)", "V(ve)", "Ic(Q1)"], [0, 10, 5, 4.3, 0.01]);
    const ctx = { nets: [], comps: [{ ref: "Q1", value: "", nets: ["vc", "vb", "ve"] }], directives: [] };
    const sum = await buildSimSummary(memFile(buf2), null, ctx, "s.raw", {});
    expect(sum.comps["Q1"]!.pAvg).toBeCloseTo(5.7 * 0.01, 5);
  });

  it("also computes the DC operating-point power (dcP) from a .op.raw single point", async () => {
    const op = synthOpRaw(["V(vc)", "V(vb)", "V(ve)", "Ic(Q1)", "Ib(Q1)"], [10, 5, 4.3, 0.01, 0.0001]);
    const ctx = { nets: [], comps: [{ ref: "Q1", value: "", nets: ["vc", "vb", "ve"] }], directives: [] };
    const sum = await buildSimSummary(memFile(buf), memFile(op), ctx, "s.raw", {});
    expect(sum.comps["Q1"]!.dcP).toBeCloseTo(expectedP, 5);
  });
});
