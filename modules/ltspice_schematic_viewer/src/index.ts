/**
 * ltspice_schematic_viewer — visualize, explore, and highlight nets and
 * components from LTspice schematics (.asc) as a framework-agnostic web component.
 *
 *   import "ltspice_schematic_viewer";          // auto-registers <ltspice-schematic>
 *   import { parseAsc, buildModel } from "ltspice_schematic_viewer"; // headless
 */

import { defineLtspiceSchematic } from "./component/ltspice-schematic.js";

if (typeof customElements !== "undefined") defineLtspiceSchematic();

export { LtspiceSchematicElement, defineLtspiceSchematic } from "./component/ltspice-schematic.js";
export type { NetInfo, ComponentInfo } from "./component/ltspice-schematic.js";

// headless core
export { parseAsc, decodeAsc } from "./parser/asc.js";
export type * from "./parser/asc.js";
export { parseAsy } from "./parser/asy.js";
export type * from "./parser/asy.js";
export { buildModel, placeSymbols } from "./netlist/connectivity.js";
export type { Model, Netlist, Net, NetPin, PlacedSymbol } from "./netlist/connectivity.js";
export { SymbolLibrary, BUILTIN_ASY } from "./symbols/builtin.js";
export { renderModel } from "./render/svg.js";
export type { RenderResult, BBox } from "./render/svg.js";
export { ViewerController } from "./interaction/controller.js";
export type { ViewerEvents } from "./interaction/controller.js";
export { makeXform } from "./geometry/transform.js";
