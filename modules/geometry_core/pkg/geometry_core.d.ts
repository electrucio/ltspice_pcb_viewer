/* tslint:disable */
/* eslint-disable */

/**
 * Result buffers of a refinement run (flattened, copy-out on access).
 */
export class RefinedMesh {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * false if the refinement hit the additional-vertex budget before meeting the bounds
     */
    readonly complete: boolean;
    /**
     * vertex index triples
     */
    readonly triangles: Uint32Array;
    /**
     * interleaved x0,y0,x1,y1,…
     */
    readonly vertices: Float64Array;
}

/**
 * Mesh one or more polygons-with-holes.
 *
 * * `coords` — flattened x,y pairs of ALL rings, concatenated
 * * `ring_lens` — vertex count of each ring (outer rings and holes alike; winding is
 *   irrelevant — faces are kept by odd winding number)
 * * `min_angle_deg` — Ruppert angle bound (≤ 30 guarantees termination; 25 is a safe target)
 * * `max_area` — maximum triangle area in mm² (0 = no area constraint)
 * * `min_area` — refinement floor in mm² (0 = none): faces already smaller than this
 *   are never subdivided further, capping the blow-up around tiny boundary features
 *   (the angle guarantee is waived only on those already-tiny faces)
 * * `max_additional_vertices` — safety budget (0 = derived from the area constraint)
 */
export function refine_region(coords: Float64Array, ring_lens: Uint32Array, min_angle_deg: number, max_area: number, min_area: number, max_additional_vertices: number): RefinedMesh;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_refinedmesh_free: (a: number, b: number) => void;
    readonly refine_region: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
    readonly refinedmesh_complete: (a: number) => number;
    readonly refinedmesh_triangles: (a: number) => [number, number];
    readonly refinedmesh_vertices: (a: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
