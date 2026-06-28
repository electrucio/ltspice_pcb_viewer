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
export {
  bestComponentMatch,
  bestNetMatch,
  mutualComponentMatch,
  mutualNetMatch,
  chooseNextComponentPair,
  chooseNextNetPair,
  contextualComponentScore,
  netContextualScore,
  simpleSimilarity,
  valueSimilarity,
  parseValue,
  componentType,
  COMPONENT_THRESHOLD,
  NET_THRESHOLD,
} from "./suggest/chain.js";
export type { SuggestComp, SuggestNet, SuggestInput, CompMatch, NetMatch, PairMatch } from "./suggest/chain.js";
