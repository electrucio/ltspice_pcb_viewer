import { readFileSync } from "node:fs";
import { parseAsc } from "../src/parser/asc.js";
import { buildModel } from "../src/netlist/connectivity.js";
import { SymbolLibrary } from "../src/symbols/builtin.js";

const dir = new URL("../", import.meta.url);
const text = readFileSync(new URL("test/fixtures/AudioAmpCompl-40W.asc", dir), "utf8");
const lib = new SymbolLibrary();
for (const p of ["lin_pot", "log_pot", "revlog_pot"]) {
  try { lib.register(p, readFileSync(new URL(`demo/${p}.asy`, dir), "utf8")); } catch { /* optional */ }
}
const sch = parseAsc(text);
const model = buildModel(sch, lib);
const nl = model.netlist;

console.log(`symbols=${sch.symbols.length} wires=${sch.wires.length} flags=${sch.flags.length} nets=${nl.nets.length} junctions=${model.junctions.length}`);
const missing = model.placed.filter((p) => !p.def).map((p) => p.name);
console.log("missing symbols:", [...new Set(missing)]);
console.log("\nnamed nets (flag-named) with pin counts:");
for (const n of nl.nets.filter((n) => n.pins.length && !/^Net-|^N\d/.test(n.name)).sort((a, b) => b.pins.length - a.pins.length)) {
  console.log(`  ${n.name.padEnd(14)} ${n.isPower ? "PWR " : "    "}${n.pins.length}p  ${n.pins.map((p) => `${p.ref}.${p.number}`).slice(0, 12).join(" ")}`);
}
console.log("\nsample components:", model.placed.slice(0, 8).map((p) => `${p.ref}(${p.name})`).join(" "));
const q = nl.componentToNets.get("Q1");
console.log("Q1 nets:", q ? [...q].map((i) => nl.nets[i]!.name) : "none");
