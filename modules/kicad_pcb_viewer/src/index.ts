/**
 * kicad_pcb_viewer — visualize a KiCad PCB (.kicad_pcb) as a framework-agnostic web
 * component: all layers in one view, layer toggles, net/component highlight, mirror,
 * pan/zoom.
 *
 *   import "kicad_pcb_viewer"; // auto-registers <kicad-pcb>
 */

import { defineKicadPcb } from "./component/kicad-pcb.js";

if (typeof customElements !== "undefined") defineKicadPcb();

export { KicadPcbElement, defineKicadPcb } from "./component/kicad-pcb.js";
export type { PcbComponentInfo } from "./component/kicad-pcb.js";
export { parsePcb } from "./parser/pcb.js";
export type * from "./parser/pcb.js";
export { renderPcb } from "./render/svg.js";
export type { RenderResult } from "./render/svg.js";
export { PcbController } from "./interaction/controller.js";
export type { PcbEvents } from "./interaction/controller.js";
