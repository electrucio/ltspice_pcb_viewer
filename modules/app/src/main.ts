/**
 * Application shell (modern browsers only).
 *
 * Embeds <ltspice-kicad-mapper> (which carries the upload buttons, the two panes with
 * the KiCad schematic/PCB toggle, the mapping UI and synchronized highlighting) and adds
 * a "Download read-only HTML" button that bakes the current designs + mapping into the
 * pre-built, iOS-Safari-12-compatible viewer template.
 */

import "../../ltspice_kicad_mapper/src/index.js"; // registers <ltspice-kicad-mapper> + all viewers
import type { LtspiceKicadMapperElement, SimSummary } from "../../ltspice_kicad_mapper/src/index.js";
import viewerTemplate from "./generated/viewer.html?raw";
import type { ExportPayload } from "../viewer/payload.js";
import { buildSimSummary } from "./sim/build.js";
import { decodeNetlist, parseNetlistRefs, buildNetNodeAlias } from "./sim/netlist.js";

const mapper = document.getElementById("m") as LtspiceKicadMapperElement;
const msgEl = document.getElementById("msg")!;
const setMsg = (s: string): void => { msgEl.textContent = s; };

let simulation: SimSummary | null = null;
let rawFile: File | null = null;
let opFile: File | null = null;
let netFile: File | null = null;

async function boot(): Promise<void> {
  // register the project's custom potentiometer symbols on the LTspice side first
  for (const name of ["lin_pot", "log_pot", "revlog_pot"]) {
    const asy = await fetch(`./${name}.asy`).then((r) => (r.ok ? r.text() : ""));
    if (asy) mapper.registerLtspiceSymbol(name, asy);
  }
  await Promise.all([
    mapper.loadLtspiceUrl("./AudioAmpCompl-40W.asc"),
    mapper.loadKicadUrl("./poweramp.kicad_sch"),
    mapper.loadKicadPcbUrl("./poweramp.kicad_pcb"),
  ]);
  setMsg("");
}

function downloadReadOnly(): void {
  const src = mapper.getSources();
  if (!src.ltspice || !src.kicadSch) {
    setMsg("Load an LTspice .asc and a KiCad .kicad_sch first");
    return;
  }
  const payload: ExportPayload = {
    version: 1,
    ltspice: src.ltspice,
    kicadSch: src.kicadSch,
    kicadPcb: src.kicadPcb,
    symbols: src.symbols,
    mapping: mapper.exportMapping(),
    ltspiceSource: src.ltspiceSource,
    kicadSource: src.kicadSource,
    simulation,
  };
  // escape `<` so a stray "</script>" in the data can't close the inline <script> block;
  // `<` is still valid JSON. Use a replacer function so `$` in the data isn't
  // interpreted as a String.replace special pattern.
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  const html = viewerTemplate.replace("__LK_DATA__", () => json);

  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "ltspice-kicad-crossprobe.html";
  a.click();
  URL.revokeObjectURL(url);
  setMsg("Downloaded ✓");
}

document.getElementById("download")!.addEventListener("click", downloadReadOnly);

// ---- simulation (.raw) upload + processing -----------------------------

async function processSim(): Promise<void> {
  if (!rawFile) return;
  const comps = mapper.getLtspiceComponents();
  let netAlias: Map<string, string> | undefined;
  if (netFile) {
    try {
      netAlias = buildNetNodeAlias(parseNetlistRefs(decodeNetlist(await netFile.arrayBuffer())), comps);
    } catch { /* fall back to name-based lookup */ }
  }
  const ctx = {
    nets: mapper.getLtspiceNets(),
    comps,
    directives: mapper.getLtspiceDirectives(),
    netAlias,
  };
  setMsg(`processing ${rawFile.name}…`);
  try {
    simulation = await buildSimSummary(rawFile, opFile, ctx, rawFile.name, {
      onProgress: (f) => setMsg(`processing ${rawFile!.name}… ${Math.round(f * 100)}%`),
    });
    mapper.setSimulation(simulation);
    const nN = Object.keys(simulation.nets).length, nC = Object.keys(simulation.comps).length;
    const aliased = netAlias?.size ? ` · ${netAlias.size} via netlist` : "";
    setMsg(`sim ✓ ${nN} nets · ${nC} parts${simulation.f0 ? ` · f₀ ${simulation.f0} Hz` : ""}${aliased} — hover to inspect`);
  } catch (e) {
    setMsg(`sim failed: ${(e as Error).message}`);
  }
}

function pick(inputId: string, onFile: (f: File) => void): void {
  const input = document.getElementById(inputId) as HTMLInputElement;
  input.onchange = () => { const f = input.files?.[0]; if (f) onFile(f); input.value = ""; };
  input.click();
}
document.getElementById("load-raw")!.addEventListener("click", () =>
  pick("raw-in", (f) => { rawFile = f; void processSim(); }));
document.getElementById("load-op")!.addEventListener("click", () =>
  pick("op-in", (f) => { opFile = f; if (rawFile) void processSim(); else setMsg("loaded .op.raw — now load the transient .raw"); }));
document.getElementById("load-net")!.addEventListener("click", () =>
  pick("net-in", (f) => { netFile = f; if (rawFile) void processSim(); else setMsg("loaded netlist — now load the transient .raw"); }));

// ---- SPICE directives panel --------------------------------------------

const dirPanel = document.getElementById("dir-panel")!;
document.getElementById("directives")!.addEventListener("click", () => {
  const dirs = simulation?.directives.length ? simulation.directives : mapper.getLtspiceDirectives();
  dirPanel.textContent = dirs.length ? dirs.join("\n") : "(no SPICE directives found in the .asc)";
  dirPanel.classList.toggle("show");
});

void boot();
