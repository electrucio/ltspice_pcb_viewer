import { readFileSync } from "node:fs";
import { parseSchematic } from "../src/parser/schematic.js";
import { buildNetlist } from "../src/netlist/connectivity.js";

const text = readFileSync(new URL("../test/fixtures/poweramp.kicad_sch", import.meta.url), "utf8");
const sch = parseSchematic(text);
const nl = buildNetlist(sch);

console.log(`Components: ${sch.instances.length}, Wires: ${sch.wires.length}, Nets: ${nl.nets.length}\n`);
const named = nl.nets.filter((n) => n.pins.length > 0).sort((a, b) => b.pins.length - a.pins.length);
for (const n of named) {
  const pins = n.pins.map((p) => `${p.ref}.${p.number}`).sort().join(" ");
  console.log(`${n.name.padEnd(26)} [${n.pins.length}p${n.isPower ? " PWR" : ""}] ${pins}`);
}

// helper to look up a pin's net
function netOf(pin: string) {
  const id = nl.pinToNet.get(pin);
  return id == null ? "(none)" : nl.nets[id]!.name;
}
console.log("\n-- spot checks --");
for (const p of ["Q1.2", "Q2.1", "D10.1", "Q7.2", "C10.1"]) console.log(`${p} -> ${netOf(p)}`);
console.log(`GND net pins: ${nl.byName.get("0")?.pins.length ?? "NO '0' NET"}`);
