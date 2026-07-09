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
import { buildSimSummary, compType } from "./sim/build.js";
import { decodeNetlist, parseNetlistRefs, buildNetNodeAlias } from "./sim/netlist.js";
import { decodeLog, parseLog, mergeLog, type ParsedLog } from "./sim/logfile.js";
import { initAnalysis } from "./analysis/drawer.js";

const mapper = document.getElementById("m") as LtspiceKicadMapperElement;
const msgEl = document.getElementById("msg")!;
const setMsg = (s: string): void => { msgEl.textContent = s; };

// ⚡ Analysis drawer (PCB parasitics) — hidden until toggled
const analysisAside = document.getElementById("analysis")!;
document.getElementById("analysis-btn")!.addEventListener("click", () => {
  analysisAside.hidden = !analysisAside.hidden;
});

let simulation: SimSummary | null = null;
let builtSummary: SimSummary | null = null; // from the .raw (V stats + component metrics), pre-.log
let rawFile: File | null = null;
let opFile: File | null = null;
let netFile: File | null = null;
let netAlias: Map<string, string> | undefined; // viewerNet → LTspice node (from the .net)
let qNodes: Map<string, string[]> | undefined; // ref → SPICE-order nodes, for transistors (from the .net)
let logData: ParsedLog | null = null;
let logName = "";

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
  initAnalysis(mapper as unknown as Parameters<typeof initAnalysis>[0], analysisAside);
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

/** Rebuild the base summary from the `.raw` (+ `.op`/`.net`), then apply any `.log`. */
async function rebuild(): Promise<void> {
  if (!rawFile) return;
  const comps = mapper.getLtspiceComponents();
  netAlias = undefined;
  qNodes = undefined;
  if (netFile) {
    try {
      const refTokens = parseNetlistRefs(decodeNetlist(await netFile.arrayBuffer()));
      netAlias = buildNetNodeAlias(refTokens, comps);
      // SPICE-order nodes for transistors: robust against symbols whose PIN order doesn't
      // (or can't be trusted to) match the model's collector/base/emitter argument order.
      qNodes = new Map();
      for (const c of comps) {
        if (compType(c.ref) !== "Q") continue;
        const nodes = refTokens.get(c.ref);
        if (nodes) qNodes.set(c.ref, nodes.slice(0, 3));
      }
    } catch { /* fall back to name-based lookup / viewer pin order */ }
  }
  const ctx = { nets: mapper.getLtspiceNets(), comps, directives: mapper.getLtspiceDirectives(), netAlias, qNodes };
  setMsg(`processing ${rawFile.name}…`);
  try {
    builtSummary = await buildSimSummary(rawFile, opFile, ctx, rawFile.name, {
      onProgress: (f) => setMsg(`processing ${rawFile!.name}… ${Math.round(f * 100)}%`),
    });
    applySummary();
  } catch (e) {
    setMsg(`sim failed: ${(e as Error).message}`);
  }
}

/** Clone the base summary and merge the `.log` (so re-loading a `.log` never re-reads the .raw). */
function applySummary(): void {
  if (!builtSummary) return;
  const s: SimSummary = structuredClone(builtSummary);
  let logInfo = "";
  if (logData) {
    const r = mergeLog(s, logData, netAlias, logName);
    logInfo = ` · .log: ${r.four} .four, ${r.meas} .meas`;
  }
  simulation = s;
  mapper.setSimulation(simulation);
  const nN = Object.keys(s.nets).length, nC = Object.keys(s.comps).length;
  const aliased = netAlias?.size ? ` · ${netAlias.size} via netlist` : "";
  setMsg(`sim ✓ ${nN} nets · ${nC} parts${aliased}${logInfo} — hover to inspect`);
}

function pick(inputId: string, onFile: (f: File) => void): void {
  const input = document.getElementById(inputId) as HTMLInputElement;
  input.onchange = () => { const f = input.files?.[0]; if (f) onFile(f); input.value = ""; };
  input.click();
}

document.getElementById("load-raw")!.addEventListener("click", () =>
  pick("raw-in", (f) => { rawFile = f; void rebuild(); }));
document.getElementById("load-op")!.addEventListener("click", () =>
  pick("op-in", (f) => { opFile = f; if (rawFile) void rebuild(); else setMsg("loaded .op.raw — now load the transient .raw"); }));
document.getElementById("load-net")!.addEventListener("click", () =>
  pick("net-in", (f) => { netFile = f; if (rawFile) void rebuild(); else setMsg("loaded netlist — now load the transient .raw"); }));
document.getElementById("load-log")!.addEventListener("click", () =>
  pick("log-in", (f) => {
    logName = f.name;
    void f.arrayBuffer().then((buf) => {
      try { logData = parseLog(decodeLog(buf)); }
      catch { setMsg("failed to parse .log"); return; }
      if (builtSummary) applySummary();
      else if (rawFile) void rebuild();
      else setMsg(`loaded ${f.name} — now load the transient .raw`);
    });
  }));

// ---- SPICE directives panel --------------------------------------------

const dirPanel = document.getElementById("dir-panel")!;
document.getElementById("directives")!.addEventListener("click", () => {
  const dirs = simulation?.directives.length ? simulation.directives : mapper.getLtspiceDirectives();
  dirPanel.textContent = dirs.length ? dirs.join("\n") : "(no SPICE directives found in the .asc)";
  dirPanel.classList.toggle("show");
});

void boot();
