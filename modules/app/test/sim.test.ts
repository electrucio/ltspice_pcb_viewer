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
