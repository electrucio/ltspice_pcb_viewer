/**
 * ltspice_kicad_mapper — map nets and components between an LTspice schematic and a
 * KiCad schematic, as a framework-agnostic web component.
 *
 *   import "ltspice_kicad_mapper"; // auto-registers <ltspice-kicad-mapper>
 *
 * Headless mapping primitives (no DOM) are also exported.
 */

import { defineLtspiceKicadMapper } from "./component/mapper.js";

if (typeof customElements !== "undefined") defineLtspiceKicadMapper();

export { LtspiceKicadMapperElement, defineLtspiceKicadMapper } from "./component/mapper.js";
export { MappingStore, serialize } from "./mapping/store.js";
export type { AvailableIds, MappingCounts } from "./mapping/store.js";
export { deserialize } from "./mapping/format.js";
export type { MappingFile, Pair, Kind, Side } from "./mapping/format.js";
export { Pairing } from "./interaction/pairing.js";
export type { Selection, PairCandidate } from "./interaction/pairing.js";
export { chooseChainSuggestion, parseValue, componentType } from "./suggest/chain.js";
export type { ChainComp, ChainParams, ChainSuggestion } from "./suggest/chain.js";
