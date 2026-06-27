/**
 * Parser for LTspice `.asc` schematics.
 *
 * `.asc` files store geometry only — wires, flags (net labels), and placed symbol
 * instances — never a netlist; nets are derived (see netlist/connectivity.ts).
 * LTspice writes these files as UTF-16 (often LE without BOM), so we sniff the
 * encoding when given raw bytes.
 */

export type Wire = [x1: number, y1: number, x2: number, y2: number];

export interface Flag {
  x: number;
  y: number;
  net: string; // "0" == ground
}

export interface IoPin {
  x: number;
  y: number;
  dir: string;
}

export interface AscText {
  x: number;
  y: number;
  just: string;
  size: number;
  str: string;
}

export interface SymbolInstance {
  name: string; // symbol name, e.g. "res", "npn", "lin_pot"
  x: number;
  y: number;
  rot: string; // R0/R90/R180/R270 or M0/M90/... (mirrored)
  attrs: Record<string, string>; // InstName, Value, ...
  windows: Record<string, WindowOverride>;
}

export interface WindowOverride {
  x: number;
  y: number;
  just: string;
  size: number;
}

export interface AscSchematic {
  wires: Wire[];
  flags: Flag[];
  iopins: IoPin[];
  texts: AscText[];
  symbols: SymbolInstance[];
  // sheet-level free graphics
  lines: [number, number, number, number, number][];
  rects: [number, number, number, number, number][];
  circles: [number, number, number, number, number][];
  arcs: number[][];
}

/** Decode raw file bytes, sniffing UTF-16 LE/BE vs UTF-8. */
export function decodeAsc(buf: ArrayBuffer | Uint8Array): string {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u[0] === 0xff && u[1] === 0xfe) return new TextDecoder("utf-16le").decode(u.subarray(2));
  if (u[0] === 0xfe && u[1] === 0xff) return new TextDecoder("utf-16be").decode(u.subarray(2));
  // no BOM: count zero bytes in odd positions -> likely UTF-16LE
  let zeros = 0;
  const n = Math.min(u.length, 512);
  for (let i = 1; i < n; i += 2) if (u[i] === 0) zeros++;
  if (zeros > n / 8) return new TextDecoder("utf-16le").decode(u);
  return new TextDecoder("utf-8").decode(u);
}

export function parseAsc(text: string): AscSchematic {
  const sch: AscSchematic = { wires: [], flags: [], iopins: [], texts: [], symbols: [], lines: [], rects: [], circles: [], arcs: [] };
  let cur: SymbolInstance | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const t = line.trim().split(/\s+/);
    if (!t[0]) continue;
    const num = (i: number) => parseInt(t[i]!, 10);
    switch (t[0]) {
      case "WIRE":
        sch.wires.push([num(1), num(2), num(3), num(4)]);
        break;
      case "FLAG":
        sch.flags.push({ x: num(1), y: num(2), net: t.slice(3).join(" ") });
        break;
      case "IOPIN":
        sch.iopins.push({ x: num(1), y: num(2), dir: t[3] ?? "" });
        break;
      case "DATAFLAG": {
        const m = line.trim().match(/^DATAFLAG\s+(-?\d+)\s+(-?\d+)\s+(.*)$/);
        if (m) sch.texts.push({ x: +m[1]!, y: +m[2]!, just: "Left", size: 1, str: ";" + m[3]!.replace(/^"|"$/g, "") });
        break;
      }
      case "SYMBOL":
        cur = { name: t[1]!, x: num(2), y: num(3), rot: t[4] || "R0", attrs: {}, windows: {} };
        sch.symbols.push(cur);
        break;
      case "WINDOW":
        if (cur) cur.windows[t[1]!] = { x: num(2), y: num(3), just: t[4] ?? "Left", size: parseInt(t[5]!, 10) || 2 };
        break;
      case "SYMATTR":
        if (cur) cur.attrs[t[1]!] = t.slice(2).join(" ");
        break;
      case "TEXT": {
        const m = line.trim().match(/^TEXT\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(\d+)\s+(.*)$/);
        if (m) sch.texts.push({ x: +m[1]!, y: +m[2]!, just: m[3]!, size: +m[4]!, str: m[5]! });
        break;
      }
      case "LINE":
        sch.lines.push([num(2), num(3), num(4), num(5), num(6) || 0]);
        break;
      case "RECTANGLE":
        sch.rects.push([num(2), num(3), num(4), num(5), num(6) || 0]);
        break;
      case "CIRCLE":
        sch.circles.push([num(2), num(3), num(4), num(5), num(6) || 0]);
        break;
      case "ARC":
        sch.arcs.push([num(2), num(3), num(4), num(5), num(6), num(7), num(8), num(9), num(10) || 0]);
        break;
    }
  }
  return sch;
}
