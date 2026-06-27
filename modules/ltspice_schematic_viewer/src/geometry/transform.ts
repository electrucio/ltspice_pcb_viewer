/**
 * LTspice instance orientation.
 *
 * A placed SYMBOL has an orientation token `R0|R90|R180|R270` or, mirrored,
 * `M0|M90|M180|M270`. The transform is applied to symbol-local coordinates
 * (which are already Y-down, like the schematic) and then translated by the
 * instance position — there is NO library Y-flip (unlike KiCad).
 *
 * LTspice semantics: `Mn` mirrors X first (x -> -x), then applies n/90 quarter
 * turns of (x,y) -> (-y, x).
 */

export interface Point {
  x: number;
  y: number;
}

export interface Xform {
  mirror: boolean;
  quarters: number;
  pt(px: number, py: number): Point;
}

export function makeXform(rot: string): Xform {
  const mirror = rot[0] === "M";
  const quarters = (((parseInt(rot.slice(1), 10) || 0) / 90) | 0) & 3;
  return {
    mirror,
    quarters,
    pt(px: number, py: number): Point {
      if (mirror) px = -px;
      for (let i = 0; i < quarters; i++) {
        const nx = -py;
        py = px;
        px = nx;
      }
      return { x: px, y: py };
    },
  };
}

/** Apply an instance xform then translate by the instance position. */
export function worldPoint(xf: Xform, ox: number, oy: number, px: number, py: number): Point {
  const p = xf.pt(px, py);
  return { x: ox + p.x, y: oy + p.y };
}

/** Integer key for union-find / point matching (LTspice coords are integers). */
export function key(x: number, y: number): string {
  return `${x},${y}`;
}
