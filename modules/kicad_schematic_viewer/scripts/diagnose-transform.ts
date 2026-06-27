/**
 * Brute-force the correct TransformConfig: for each (flipY, rotSign) combination,
 * count how many transformed pin connection points coincide with wire endpoints
 * or junctions. The right transform maximizes coincidence.
 */
import { readFileSync } from "node:fs";
import { parseSchematic } from "../src/parser/schematic.js";
import { instanceMatrix, pinWorldPos, pinWorldFarEnd, quantize, type TransformConfig } from "../src/geometry/transform.js";

const text = readFileSync(new URL("../test/fixtures/poweramp.kicad_sch", import.meta.url), "utf8");
const sch = parseSchematic(text);

// Reference set: all wire endpoints + junctions (places pins SHOULD land on).
const targets = new Set<string>();
for (const w of sch.wires) for (const p of w.pts) targets.add(quantize(p));
for (const j of sch.junctions) targets.add(quantize(j.at));

const configs: Array<[string, TransformConfig, "at" | "far"]> = [];
for (const flipY of [true, false])
  for (const rotSign of [1, -1] as const)
    for (const endpoint of ["at", "far"] as const)
      configs.push([`flipY=${flipY} rotSign=${rotSign} pin=${endpoint}`, { flipY, rotSign }, endpoint]);

let totalPins = 0;
for (const inst of sch.instances) {
  const lib = sch.libSymbols.get(inst.libId);
  if (!lib) continue;
  totalPins += lib.pins.filter((p) => p.unit === 0 || p.unit === inst.unit).length;
}

for (const [label, cfg, endpoint] of configs) {
  let hit = 0;
  let count = 0;
  for (const inst of sch.instances) {
    const lib = sch.libSymbols.get(inst.libId);
    if (!lib) continue;
    const m = instanceMatrix(inst.placement, inst.mirror, cfg);
    for (const pin of lib.pins) {
      if (pin.unit !== 0 && pin.unit !== inst.unit) continue;
      count++;
      const wp = endpoint === "at" ? pinWorldPos(m, pin.at) : pinWorldFarEnd(m, pin.at, pin.length);
      if (targets.has(quantize(wp))) hit++;
    }
  }
  console.log(`${label.padEnd(34)} -> ${hit}/${count} pins on a wire/junction`);
}
console.log(`\nTotal pins considered: ${totalPins}; wire endpoints+junctions: ${targets.size}`);
