import { describe, it, expect } from "vitest";
import { parseRawHeader } from "../src/sim/raw.js";
import { buildSimSummary, resolveFundamental } from "../src/sim/build.js";
import type { RawFile } from "../src/sim/raw.js";

/** Build a synthetic LTspice transient .raw (UTF-16LE header) in memory. */
function synthRaw(opts: {
  f0: number; T: number; N: number;
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
    const hdr = parseRawHeader(new Uint8Array(synthRaw({ f0: 1000, T: 0.02, N: 10, sig: () => 0, dc: 1 })));
    expect(hdr.encoding).toBe("utf-16le");
    expect(hdr.nVars).toBe(3);
    expect(hdr.nPoints).toBe(10);
    expect(hdr.axisDouble).toBe(false);
    expect(hdr.pointSize).toBe(16);
    expect(hdr.vars.map((v) => v.name)).toEqual(["time", "V(sig)", "V(dc)"]);
  });
});

describe("resolveFundamental", () => {
  it("resolves {in_freq} from .param via .four", () => {
    expect(resolveFundamental([".param in_freq=1000", ".four {in_freq} 9 V(sig)"])).toEqual({ f0: 1000, nHarm: 9 });
  });
  it("returns null f0 when no .four", () => {
    expect(resolveFundamental([".tran 1m"]).f0).toBeNull();
  });
});

describe("buildSimSummary", () => {
  const f0 = 1000, T = 0.02, N = 4000; // 20 periods, uniform

  it("computes V stats, DC, and THD for a fundamental + 2nd harmonic", async () => {
    const A = 1, h2 = 0.05;
    const buf = synthRaw({ f0, T, N, dc: 3.3, sig: (t) => A * Math.sin(2 * Math.PI * f0 * t) + h2 * Math.sin(2 * Math.PI * 2 * f0 * t) });
    const ctx = { nets: [{ name: "sig" }, { name: "dc" }], comps: [], directives: [".four 1000 9 V(sig)"] };
    const sum = await buildSimSummary(memFile(buf), null, ctx, "synth.raw", {});

    expect(sum.f0).toBe(1000);
    // sig: zero-mean, rms ≈ sqrt((A^2+h2^2)/2), THD ≈ h2/A = 5%
    const sig = sum.nets["sig"]!;
    expect(Math.abs(sig.v.avg)).toBeLessThan(0.02);
    expect(sig.v.rms).toBeCloseTo(Math.sqrt((A * A + h2 * h2) / 2), 2);
    expect(sig.a1!).toBeCloseTo(1, 1);
    expect(sig.thdPct!).toBeCloseTo(5, 0); // within ~0.5%
    // dc net: flat ⇒ no fundamental ⇒ THD omitted
    const dc = sum.nets["dc"]!;
    expect(dc.v.avg).toBeCloseTo(3.3, 3);
    expect(dc.v.pp).toBeLessThan(1e-3);
    expect(dc.thdPct).toBeUndefined();
  });

  it("a pure sine has ~0 THD", async () => {
    const buf = synthRaw({ f0, T, N, dc: 0, sig: (t) => Math.sin(2 * Math.PI * f0 * t) });
    const ctx = { nets: [{ name: "sig" }], comps: [], directives: [".four 1000 9 V(sig)"] };
    const sum = await buildSimSummary(memFile(buf), null, ctx, "synth.raw", {});
    expect(sum.nets["sig"]!.thdPct!).toBeLessThan(0.5);
  });
});
