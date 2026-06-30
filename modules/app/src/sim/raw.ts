/**
 * LTspice `.raw` / `.op.raw` reader.
 *
 * Format (verified): UTF-16LE (or ASCII) header ending in `Binary:\n`, then binary points.
 * For real, non-`double` files each point is: axis as float64 (8 B) + (nVars-1) × float32
 * (4 B). With the `double` flag every value is float64. The file is read in point-aligned
 * **slices** so the whole (often >100 MB) waveform never sits in RAM at once.
 *
 * Structurally typed over a minimal Blob/File so it also runs in a Node test harness.
 */

export interface RawVar {
  index: number;
  name: string; // e.g. "V(pre_speaker)", "I(R16)", "Ic(Q3)"
  kind: string; // voltage | device_current | …
}

export interface RawHeader {
  encoding: "utf-16le" | "latin1";
  plotname: string;
  flags: string;
  vars: RawVar[];
  nVars: number;
  nPoints: number;
  binOffset: number; // byte offset of the first data point
  axisDouble: boolean; // true ⇒ all values float64; false ⇒ axis f64 + rest f32
  pointSize: number; // bytes per point
  offset: number; // `Offset:` header (added to the stored axis to get absolute time)
}

export interface RawFile {
  size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

const BIN_MARKER = "Binary:\n";

export function parseRawHeader(head: Uint8Array): RawHeader {
  const encoding: RawHeader["encoding"] = head.length > 1 && head[1] === 0 ? "utf-16le" : "latin1";
  const text = new TextDecoder(encoding).decode(head);
  const mark = text.indexOf(BIN_MARKER);
  if (mark < 0) throw new Error("Not an LTspice .raw file (no Binary: marker in header)");
  const bytesPerChar = encoding === "utf-16le" ? 2 : 1;
  const binOffset = (mark + BIN_MARKER.length) * bytesPerChar;
  const hdr = text.slice(0, mark);

  const field = (re: RegExp): string => (hdr.match(re)?.[1] ?? "").trim();
  const flags = field(/Flags:\s*(.*)/);
  const nVars = parseInt(field(/No\. Variables:\s*(\d+)/), 10);
  const nPoints = parseInt(field(/No\. Points:\s*(\d+)/), 10);
  const offset = parseFloat(field(/Offset:\s*([-+0-9.eE]+)/) || "0");
  const plotname = field(/Plotname:\s*(.*)/);

  const vars: RawVar[] = [];
  const varSection = hdr.slice(hdr.indexOf("Variables:") + "Variables:".length);
  for (const line of varSection.split("\n")) {
    const m = line.match(/^\s*(\d+)\t([^\t]+)\t(\S+)/);
    if (m) vars.push({ index: parseInt(m[1]!, 10), name: m[2]!.trim(), kind: m[3]!.trim() });
  }

  const axisDouble = /\bdouble\b/.test(flags);
  const pointSize = axisDouble ? nVars * 8 : 8 + (nVars - 1) * 4;
  return { encoding, plotname, flags, vars, nVars, nPoints, binOffset, axisDouble, pointSize, offset };
}

/** Byte offset of variable `i` within a point, given the layout. */
export function varByteOffset(hdr: RawHeader, i: number): number {
  if (hdr.axisDouble) return i * 8;
  return i === 0 ? 0 : 8 + (i - 1) * 4;
}

/** Read variable `i` from a point at `base` in `dv`. */
export function readVar(hdr: RawHeader, dv: DataView, base: number, i: number): number {
  const off = base + varByteOffset(hdr, i);
  return hdr.axisDouble || i === 0 ? dv.getFloat64(off, true) : dv.getFloat32(off, true);
}

export async function readHeader(file: RawFile): Promise<RawHeader> {
  const head = new Uint8Array(await file.slice(0, Math.min(file.size, 1 << 16)).arrayBuffer());
  return parseRawHeader(head);
}

/**
 * Stream every point, calling `onPoint(t, dv, base)` with the point's axis value and a
 * DataView positioned so individual vars can be read via `readVar(hdr, dv, base, i)`.
 */
export async function streamPoints(
  file: RawFile,
  hdr: RawHeader,
  onPoint: (t: number, dv: DataView, base: number) => void,
  onProgress?: (frac: number) => void,
  pointsPerChunk = 20000,
): Promise<void> {
  const chunkBytes = pointsPerChunk * hdr.pointSize;
  const dataEnd = hdr.binOffset + hdr.nPoints * hdr.pointSize;
  let done = 0;
  for (let start = hdr.binOffset; start < dataEnd; ) {
    const end = Math.min(start + chunkBytes, dataEnd);
    const buf = await file.slice(start, end).arrayBuffer();
    const dv = new DataView(buf);
    const n = Math.floor(buf.byteLength / hdr.pointSize);
    for (let k = 0; k < n; k++) {
      const base = k * hdr.pointSize;
      onPoint(dv.getFloat64(base, true), dv, base); // axis (var0) is always float64
    }
    done += n;
    start = end;
    if (onProgress) onProgress(done / hdr.nPoints);
  }
}

/** Read a single-point file (e.g. `.op.raw`) into a name→value map. */
export async function readSinglePoint(file: RawFile): Promise<Map<string, number>> {
  const hdr = await readHeader(file);
  const buf = await file.slice(hdr.binOffset, hdr.binOffset + hdr.pointSize).arrayBuffer();
  const dv = new DataView(buf);
  const out = new Map<string, number>();
  for (const v of hdr.vars) out.set(v.name.toLowerCase(), readVar(hdr, dv, 0, v.index));
  return out;
}
