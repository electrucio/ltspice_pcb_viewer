/**
 * kicad-schematic-viewer — visualize, explore, and highlight nets and components
 * from KiCad schematics (.kicad_sch) as a framework-agnostic web component.
 *
 * Default usage (auto-registers <kicad-schematic>):
 *   import "kicad-schematic-viewer";
 *
 * Headless usage (parse + netlist, no DOM):
 *   import { parseSchematic, buildNetlist } from "kicad-schematic-viewer";
 */

import { defineKicadSchematic } from "./component/kicad-schematic.js";

// auto-register on import (no-op if already defined or no customElements, e.g. SSR)
if (typeof customElements !== "undefined") defineKicadSchematic();

// web component
export { KicadSchematicElement, defineKicadSchematic } from "./component/kicad-schematic.js";
export type { NetInfo, ComponentInfo } from "./component/kicad-schematic.js";

// headless core
export { parseSchematic } from "./parser/schematic.js";
export type * from "./parser/schematic.js";
export { buildNetlist, instancePinPositions } from "./netlist/connectivity.js";
export type { Net, NetPin, Netlist } from "./netlist/connectivity.js";
export { renderSchematic } from "./render/svg.js";
export type { RenderResult, BBox } from "./render/svg.js";
export { ViewerController } from "./interaction/controller.js";
export type { ViewerEvents } from "./interaction/controller.js";
export {
  instanceMatrix,
  transformPoint,
  pinWorldPos,
  pinWorldFarEnd,
  DEFAULT_TRANSFORM,
} from "./geometry/transform.js";
