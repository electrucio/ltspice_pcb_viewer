import type { MappingFile } from "../../ltspice_kicad_mapper/src/mapping/format.js";

/**
 * Self-contained data baked into a downloaded read-only export. Written by the app
 * (src/main.ts) into the `__LK_DATA__` slot of the viewer template, read back by
 * viewer/viewer.ts.
 */
export interface ExportPayload {
  version: 1;
  /** base64 of the original `.asc` bytes (UTF-16; the viewer auto-decodes) */
  ltspice: string;
  /** `.kicad_sch` text */
  kicadSch: string;
  /** `.kicad_pcb` text ("" if none was loaded) */
  kicadPcb: string;
  /** registered LTspice `.asy` symbols: name -> text */
  symbols: Record<string, string>;
  /** the LTspice↔KiCad mapping (keyed on schematic net/ref names) */
  mapping: MappingFile;
  ltspiceSource: string;
  kicadSource: string;
  /** reserved for future LTspice simulation results linked to nets/components */
  simulation: null;
}
