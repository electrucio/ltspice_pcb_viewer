/**
 * Application shell (modern browsers only).
 *
 * Embeds <ltspice-kicad-mapper> (which carries the upload buttons, the two panes with
 * the KiCad schematic/PCB toggle, the mapping UI and synchronized highlighting) and adds
 * a "Download read-only HTML" button that bakes the current designs + mapping into the
 * pre-built, iOS-Safari-12-compatible viewer template.
 */

import "../../ltspice_kicad_mapper/src/index.js"; // registers <ltspice-kicad-mapper> + all viewers
import type { LtspiceKicadMapperElement } from "../../ltspice_kicad_mapper/src/index.js";
import viewerTemplate from "./generated/viewer.html?raw";
import type { ExportPayload } from "../viewer/payload.js";

const mapper = document.getElementById("m") as LtspiceKicadMapperElement;
const msgEl = document.getElementById("msg")!;
const setMsg = (s: string): void => { msgEl.textContent = s; };

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
    simulation: null,
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

void boot();
