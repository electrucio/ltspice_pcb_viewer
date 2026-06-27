import { readFileSync } from "node:fs";
import { parseSchematic } from "../src/parser/schematic.js";
import { quantize, GRID } from "../src/geometry/transform.js";

const text = readFileSync(new URL("../test/fixtures/poweramp.kicad_sch", import.meta.url), "utf8");
const sch = parseSchematic(text);

const endpoints = new Set<string>();
for (const w of sch.wires) for (const p of w.pts) endpoints.add(quantize(p));

function ipt(p: { x: number; y: number }) { return [Math.round(p.x * GRID), Math.round(p.y * GRID)] as const; }
function onSeg(ax: number, ay: number, bx: number, by: number, qx: number, qy: number) {
  const cross = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
  if (cross !== 0) return false;
  return qx >= Math.min(ax, bx) && qx <= Math.max(ax, bx) && qy >= Math.min(ay, by) && qy <= Math.max(ay, by);
}

for (const lbl of sch.labels) {
  const k = quantize({ x: lbl.at.x, y: lbl.at.y });
  const onEndpoint = endpoints.has(k);
  const [qx, qy] = ipt(lbl.at);
  let onWire = false;
  for (const w of sch.wires) for (let i = 0; i + 1 < w.pts.length; i++) {
    const [ax, ay] = ipt(w.pts[i]!); const [bx, by] = ipt(w.pts[i + 1]!);
    if (onSeg(ax, ay, bx, by, qx, qy)) onWire = true;
  }
  console.log(`label "${lbl.text}" at (${lbl.at.x},${lbl.at.y}) endpoint=${onEndpoint} onWireInterior=${onWire}`);
}
