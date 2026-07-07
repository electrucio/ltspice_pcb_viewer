declare module "cdt2d" {
  interface Cdt2dOptions {
    delaunay?: boolean;
    interior?: boolean;
    exterior?: boolean;
    infinity?: boolean;
  }
  /** Constrained Delaunay triangulation: points + constraint edges → triangles (index triples). */
  export default function cdt2d(
    points: ArrayLike<ArrayLike<number>>,
    edges?: ArrayLike<ArrayLike<number>>,
    options?: Cdt2dOptions,
  ): [number, number, number][];
}
