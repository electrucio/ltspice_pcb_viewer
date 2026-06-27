/**
 * Parser for LTspice `.asy` symbol definitions.
 *
 * `.asy` files (and the embedded built-in library) describe a symbol's drawable
 * primitives in LOCAL coordinates (Y points down, same as the schematic) plus its
 * connection PINs and attribute WINDOW slots. Geometry is later transformed by the
 * placed instance's orientation (see geometry/transform.ts).
 */

export type Line = [x1: number, y1: number, x2: number, y2: number, style: number];
export type Rect = [x1: number, y1: number, x2: number, y2: number, style: number];
export type Circle = [x1: number, y1: number, x2: number, y2: number, style: number];
/** ellipse bbox (x1,y1,x2,y2) + arc start point (sx,sy) + end point (ex,ey) */
export type Arc = [x1: number, y1: number, x2: number, y2: number, sx: number, sy: number, ex: number, ey: number, style: number];

export interface SymText {
  x: number;
  y: number;
  just: string;
  size: number;
  str: string;
}

export interface SymPin {
  x: number;
  y: number;
  name: string; // PinName if given, else "" (built-ins are unnamed)
  order: number; // SpiceOrder (1-based); falls back to file order
}

export interface WindowSlot {
  x: number;
  y: number;
  just: string;
  size: number;
}

export interface SymbolDef {
  lines: Line[];
  rects: Rect[];
  circles: Circle[];
  arcs: Arc[];
  texts: SymText[];
  pins: SymPin[];
  windows: Record<string, WindowSlot>;
  value: string | null;
  prefix: string | null;
}

export function parseAsy(text: string): SymbolDef {
  const s: SymbolDef = { lines: [], rects: [], circles: [], arcs: [], texts: [], pins: [], windows: {}, value: null, prefix: null };
  let pinOrder = 0;
  let curPin: SymPin | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim().split(/\s+/);
    if (!t[0]) continue;
    const num = (i: number) => parseInt(t[i]!, 10);
    switch (t[0]) {
      case "LINE":
        s.lines.push([num(2), num(3), num(4), num(5), num(6) || 0]);
        break;
      case "RECTANGLE":
        s.rects.push([num(2), num(3), num(4), num(5), num(6) || 0]);
        break;
      case "CIRCLE":
        s.circles.push([num(2), num(3), num(4), num(5), num(6) || 0]);
        break;
      case "ARC":
        s.arcs.push([num(2), num(3), num(4), num(5), num(6), num(7), num(8), num(9), num(10) || 0]);
        break;
      case "PIN":
        curPin = { x: num(1), y: num(2), name: "", order: ++pinOrder };
        s.pins.push(curPin);
        break;
      case "PINATTR":
        if (curPin) {
          if (t[1] === "PinName") curPin.name = t.slice(2).join(" ");
          if (t[1] === "SpiceOrder") curPin.order = num(2) || curPin.order;
        }
        break;
      case "WINDOW":
        s.windows[t[1]!] = { x: num(2), y: num(3), just: t[4] ?? "Left", size: num(5) || 2 };
        break;
      case "TEXT": {
        const m = raw.trim().match(/^TEXT\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(\d+)\s+(.*)$/);
        if (m) s.texts.push({ x: +m[1]!, y: +m[2]!, just: m[3]!, size: +m[4]!, str: m[5]! });
        break;
      }
      case "SYMATTR":
        if (t[1] === "Value") s.value = t.slice(2).join(" ");
        if (t[1] === "Prefix") s.prefix = t.slice(2).join(" ");
        break;
    }
  }
  // honor SpiceOrder so pin index matches LTspice's pin numbering
  s.pins.sort((a, b) => a.order - b.order);
  return s;
}
