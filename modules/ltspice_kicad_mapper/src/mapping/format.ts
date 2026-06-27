/**
 * On-disk format for an LTspice↔KiCad mapping. A small, explicit JSON schema that
 * round-trips through the MappingStore and is easy for other tools to read.
 */

export type Kind = "net" | "component";
export type Side = "ltspice" | "kicad";

export interface Pair {
  ltspice: string;
  kicad: string;
}

export interface MappingFile {
  version: 1;
  ltspiceSource?: string;
  kicadSource?: string;
  createdAt?: string;
  nets: Pair[];
  components: Pair[];
}

export function serialize(file: MappingFile): string {
  return JSON.stringify(file, null, 2) + "\n";
}

function isPairArray(v: unknown): v is Pair[] {
  return Array.isArray(v) && v.every((p) => p && typeof p === "object" && typeof (p as Pair).ltspice === "string" && typeof (p as Pair).kicad === "string");
}

/** Parse + validate a mapping file. Throws on a malformed document. */
export function deserialize(text: string | object): MappingFile {
  const obj = typeof text === "string" ? JSON.parse(text) : text;
  if (!obj || typeof obj !== "object") throw new Error("Mapping file must be a JSON object");
  const o = obj as Partial<MappingFile>;
  if (o.version !== 1) throw new Error(`Unsupported mapping version: ${String(o.version)}`);
  const nets = o.nets ?? [];
  const components = o.components ?? [];
  if (!isPairArray(nets) || !isPairArray(components)) throw new Error("nets/components must be arrays of {ltspice, kicad}");
  return {
    version: 1,
    ltspiceSource: o.ltspiceSource,
    kicadSource: o.kicadSource,
    createdAt: o.createdAt,
    nets,
    components,
  };
}
