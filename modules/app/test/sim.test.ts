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

  it("computes a finite THD when .four requests more harmonics than the display spectrum", async () => {
    // Regression: nHarm=12 > HARM_N(10) must not index past the 10-entry harm[] array (→ NaN).
    const buf = synthRaw({ f0, T, N, dc: 0, sig: (t) => Math.sin(2 * Math.PI * f0 * t) + 0.05 * Math.sin(2 * Math.PI * 2 * f0 * t) });
    const ctx = { nets: [{ name: "sig" }], comps: [], directives: [".four 1000 12 V(sig)"] };
    const sum = await buildSimSummary(memFile(buf), null, ctx, "synth.raw", {});
    const sig = sum.nets["sig"]!;
    expect(Number.isNaN(sig.thdPct!)).toBe(false);
    expect(sig.thdPct!).toBeCloseTo(5, 0);
    expect(sig.harm!.length).toBe(10); // display spectrum still capped at 10
  });

  it("skips THD/harmonics when thdF0 is null, and ripple when mainsF0 is null", async () => {
    const buf = synthRaw({ f0, T, N, dc: 0, sig: (t) => Math.sin(2 * Math.PI * f0 * t) + 0.1 * Math.sin(2 * Math.PI * 50 * t) });
    const ctx = { nets: [{ name: "sig" }], comps: [], directives: [".four 1000 9 V(sig)"] };

    const off = await buildSimSummary(memFile(buf), null, ctx, "s.raw", { thdF0: null, mainsF0: null });
    expect(off.f0).toBeNull();
    expect(off.nets["sig"]!.harm).toBeUndefined();
    expect(off.nets["sig"]!.thdPct).toBeUndefined();
    expect(off.nets["sig"]!.mains).toBeUndefined();
    expect(off.mainsF0).toBeUndefined();

    // explicit overrides: THD at a forced f0, ripple at 60 Hz
    const on = await buildSimSummary(memFile(buf), null, ctx, "s.raw", { thdF0: 1000, mainsF0: 60 });
    expect(on.f0).toBe(1000);
    expect(on.mainsF0).toBe(60);
    expect(on.nets["sig"]!.harm!.length).toBe(10);
    expect(on.nets["sig"]!.mains!.length).toBe(5);
  });

  it("resolves f0 from .param in_freq when no .four is present", async () => {
    const buf = synthRaw({ f0, T, N, dc: 0, sig: (t) => Math.sin(2 * Math.PI * f0 * t) });
    const ctx = { nets: [{ name: "sig" }], comps: [], directives: [".param in_freq=1000", ".tran 1u"] };
    const sum = await buildSimSummary(memFile(buf), null, ctx, "synth.raw", {});
    expect(sum.f0).toBe(1000); // fallback active
    expect(sum.nets["sig"]!.harm!.length).toBe(10);
  });

  it("reports the signal-harmonic spectrum (dBc) and the 50 Hz mains spectrum (abs)", async () => {
    // 1 kHz fundamental + 5% 2nd harmonic (2 kHz) + a 0.2 V 50 Hz and 0.1 V 100 Hz "hum".
    const A = 1, h2 = 0.05, m1 = 0.2, m2 = 0.1;
    const buf = synthRaw({
      f0, T, N, dc: 0,
      sig: (t) =>
        A * Math.sin(2 * Math.PI * f0 * t) + h2 * Math.sin(2 * Math.PI * 2 * f0 * t) +
        m1 * Math.sin(2 * Math.PI * 50 * t) + m2 * Math.sin(2 * Math.PI * 100 * t),
    });
    const ctx = { nets: [{ name: "sig" }], comps: [], directives: [".four 1000 9 V(sig)"] };
    const sum = await buildSimSummary(memFile(buf), null, ctx, "synth.raw", {});
    expect(sum.mainsF0).toBe(50);

    const sig = sum.nets["sig"]!;
    // signal harmonics: peak amplitudes (V); h1≈A, h2≈0.05, rest ≈ 0.
    expect(sig.harm!.length).toBe(10);
    expect(sig.harm![0]).toBeCloseTo(A, 1);
    expect(sig.harm![1]).toBeCloseTo(h2, 2);
    expect(sig.harm![2]).toBeLessThan(1e-2);
    // dBc of the 2nd harmonic ≈ 20·log10(0.05) ≈ -26 dB
    expect(20 * Math.log10(sig.harm![1]! / sig.harm![0]!)).toBeCloseTo(-26, 0);

    // mains spectrum: 50 Hz and 100 Hz recovered; 150/200/250 ≈ 0. THD (1 kHz harmonics) ignores the hum.
    expect(sig.mains!.length).toBe(5);
    expect(sig.mains![0]).toBeCloseTo(m1, 2);
    expect(sig.mains![1]).toBeCloseTo(m2, 2);
    expect(sig.mains![2]).toBeLessThan(1e-2);
    expect(sig.thdPct!).toBeCloseTo(5, 0); // 50/100 Hz are not harmonics of f0 → excluded from THD
  });
});
