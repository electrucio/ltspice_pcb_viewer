//! geometry_core — Rust/WASM geometry kernel for the PCB parasitic-extraction engine.
//!
//! First capability: quality-guaranteed meshing of copper regions. Constrained
//! Delaunay triangulation with Ruppert/Chew-style refinement via `spade`'s `refine()`:
//! a minimum-angle bound plus a maximum-area constraint, with outer faces AND hole
//! faces excluded by odd-winding classification (spade's `exclude_outer_faces`).
//!
//! Boundary Steiner points are inserted ON the constraint edges, so the covered
//! region — and its area — is exactly the input polygon (the TS side asserts this).

use spade::{
    AngleLimit, ConstrainedDelaunayTriangulation, Point2, RefinementParameters, Triangulation,
};
use std::collections::HashSet;
use wasm_bindgen::prelude::*;

/// Result buffers of a refinement run (flattened, copy-out on access).
#[wasm_bindgen]
pub struct RefinedMesh {
    vertices: Vec<f64>,
    triangles: Vec<u32>,
    complete: bool,
}

#[wasm_bindgen]
impl RefinedMesh {
    /// interleaved x0,y0,x1,y1,…
    #[wasm_bindgen(getter)]
    pub fn vertices(&self) -> Vec<f64> {
        self.vertices.clone()
    }
    /// vertex index triples
    #[wasm_bindgen(getter)]
    pub fn triangles(&self) -> Vec<u32> {
        self.triangles.clone()
    }
    /// false if the refinement hit the additional-vertex budget before meeting the bounds
    #[wasm_bindgen(getter)]
    pub fn complete(&self) -> bool {
        self.complete
    }
}

/// Mesh one or more polygons-with-holes.
///
/// * `coords` — flattened x,y pairs of ALL rings, concatenated
/// * `ring_lens` — vertex count of each ring (outer rings and holes alike; winding is
///   irrelevant — faces are kept by odd winding number)
/// * `min_angle_deg` — Ruppert angle bound (≤ 30 guarantees termination; 25 is a safe target)
/// * `max_area` — maximum triangle area in mm² (0 = no area constraint)
/// * `min_area` — refinement floor in mm² (0 = none): faces already smaller than this
///   are never subdivided further, capping the blow-up around tiny boundary features
///   (the angle guarantee is waived only on those already-tiny faces)
/// * `max_additional_vertices` — safety budget (0 = derived from the area constraint)
#[wasm_bindgen]
pub fn refine_region(
    coords: &[f64],
    ring_lens: &[u32],
    min_angle_deg: f64,
    max_area: f64,
    min_area: f64,
    max_additional_vertices: u32,
) -> RefinedMesh {
    let (vertices, triangles, complete) = refine(
        coords,
        ring_lens,
        min_angle_deg,
        max_area,
        min_area,
        max_additional_vertices,
    );
    RefinedMesh {
        vertices,
        triangles,
        complete,
    }
}

type Cdt = ConstrainedDelaunayTriangulation<Point2<f64>>;

pub fn refine(
    coords: &[f64],
    ring_lens: &[u32],
    min_angle_deg: f64,
    max_area: f64,
    min_area: f64,
    max_additional_vertices: u32,
) -> (Vec<f64>, Vec<u32>, bool) {
    let mut cdt = Cdt::new();
    let mut offset = 0usize;
    for &len in ring_lens {
        let len = len as usize;
        let ring: Vec<Point2<f64>> = (0..len)
            .map(|i| Point2::new(coords[2 * (offset + i)], coords[2 * (offset + i) + 1]))
            .collect();
        // InsertionError only for non-finite coordinates; skip such rings
        let _ = cdt.add_constraint_edges(ring, true);
        offset += len;
    }

    let mut params = RefinementParameters::<f64>::new()
        .exclude_outer_faces(true)
        .with_angle_limit(AngleLimit::from_deg(min_angle_deg));
    if max_area > 0.0 {
        params = params.with_max_allowed_area(max_area);
    }
    if min_area > 0.0 {
        params = params.with_min_required_area(min_area);
    }
    // spade's default Steiner budget is only 10× the input vertex count — far too
    // small once max_area demands many triangles. Derive one from the area constraint
    // (≈ area/max_area vertices for ~2·V triangles, doubled for slack) plus a
    // boundary-driven allowance for angle-only refinement.
    let budget = if max_additional_vertices > 0 {
        max_additional_vertices as usize
    } else {
        let mut area_bound = 0.0f64; // Σ |ring shoelace| — upper bound on copper area
        let mut off = 0usize;
        for &len in ring_lens {
            let len = len as usize;
            let mut s = 0.0;
            for i in 0..len {
                let (ax, ay) = (coords[2 * (off + i)], coords[2 * (off + i) + 1]);
                let j = (i + 1) % len;
                let (bx, by) = (coords[2 * (off + j)], coords[2 * (off + j) + 1]);
                s += ax * by - bx * ay;
            }
            area_bound += (s / 2.0).abs();
            off += len;
        }
        let by_area = if max_area > 0.0 { ((area_bound / max_area) as usize) * 2 } else { 0 };
        by_area + 64 * (coords.len() / 2) + 10_000
    };
    params = params.with_max_additional_vertices(budget);
    let result = cdt.refine(params);
    let excluded: HashSet<_> = result.excluded_faces.iter().copied().collect();

    let mut vertices = Vec::with_capacity(cdt.num_vertices() * 2);
    for v in cdt.vertices() {
        let p = v.position();
        vertices.push(p.x);
        vertices.push(p.y);
    }
    let mut triangles = Vec::new();
    for face in cdt.inner_faces() {
        if excluded.contains(&face.fix()) {
            continue;
        }
        let [a, b, c] = face.vertices();
        triangles.push(a.fix().index() as u32);
        triangles.push(b.fix().index() as u32);
        triangles.push(c.fix().index() as u32);
    }
    (vertices, triangles, result.refinement_complete)
}

#[cfg(test)]
mod tests {
    use super::refine;

    fn mesh_area(vs: &[f64], ts: &[u32]) -> f64 {
        let mut s = 0.0;
        for t in ts.chunks(3) {
            let (a, b, c) = (t[0] as usize, t[1] as usize, t[2] as usize);
            s += ((vs[2 * b] - vs[2 * a]) * (vs[2 * c + 1] - vs[2 * a + 1])
                - (vs[2 * c] - vs[2 * a]) * (vs[2 * b + 1] - vs[2 * a + 1]))
                .abs()
                / 2.0;
        }
        s
    }

    fn min_angle_deg(vs: &[f64], ts: &[u32]) -> f64 {
        let mut min = f64::INFINITY;
        for t in ts.chunks(3) {
            for k in 0..3 {
                let p = t[k] as usize;
                let q = t[(k + 1) % 3] as usize;
                let r = t[(k + 2) % 3] as usize;
                let (ux, uy) = (vs[2 * q] - vs[2 * p], vs[2 * q + 1] - vs[2 * p + 1]);
                let (wx, wy) = (vs[2 * r] - vs[2 * p], vs[2 * r + 1] - vs[2 * p + 1]);
                let den = (ux * ux + uy * uy).sqrt() * (wx * wx + wy * wy).sqrt();
                if den > 0.0 {
                    let cos = ((ux * wx + uy * wy) / den).clamp(-1.0, 1.0);
                    min = min.min(cos.acos().to_degrees());
                }
            }
        }
        min
    }

    #[test]
    fn square_with_hole_conserves_area_and_angle_bound() {
        // 4×4 square with centered 1×1 hole → area 15
        let coords = [
            0.0, 0.0, 4.0, 0.0, 4.0, 4.0, 0.0, 4.0, // outer
            1.5, 1.5, 2.5, 1.5, 2.5, 2.5, 1.5, 2.5, // hole
        ];
        let (vs, ts, complete) = refine(&coords, &[4, 4], 25.0, 0.1, 0.0, 0);
        assert!(complete);
        assert!(!ts.is_empty());
        assert!((mesh_area(&vs, &ts) - 15.0).abs() < 1e-9);
        let ma = min_angle_deg(&vs, &ts);
        assert!(ma >= 20.0, "min angle {ma}");
        // area constraint respected
        for t in ts.chunks(3) {
            let sub = [t[0], t[1], t[2]];
            assert!(mesh_area(&vs, &sub) <= 0.1 + 1e-12);
        }
    }

    #[test]
    fn long_strip_is_bounded_and_graded() {
        let coords = [0.0, 0.0, 100.0, 0.0, 100.0, 1.0, 0.0, 1.0];
        let (vs, ts, complete) = refine(&coords, &[4], 25.0, 0.433, 0.0, 0);
        assert!(complete);
        assert!((mesh_area(&vs, &ts) - 100.0).abs() < 1e-9);
        assert!(min_angle_deg(&vs, &ts) >= 20.0);
        let count = ts.len() / 3;
        assert!(count < 2000, "triangle count {count}");
    }

    #[test]
    fn disjoint_outers_mesh_together() {
        let coords = [
            0.0, 0.0, 4.0, 0.0, 4.0, 4.0, 0.0, 4.0, // square, area 16
            10.0, 0.0, 12.0, 0.0, 12.0, 2.0, 10.0, 2.0, // rect, area 4
        ];
        let (vs, ts, _) = refine(&coords, &[4, 4], 25.0, 0.5, 0.0, 0);
        assert!((mesh_area(&vs, &ts) - 20.0).abs() < 1e-9);
    }

    #[test]
    fn angle_only_refinement_without_area_constraint() {
        // sliver-prone flat pentagon: the angle bound alone must clean it up
        let coords = [0.0, 0.0, 10.0, 0.0, 10.0, 0.3, 5.0, 0.31, 0.0, 0.3];
        let (vs, ts, complete) = refine(&coords, &[5], 25.0, 0.0, 0.0, 0);
        assert!(complete);
        assert!(min_angle_deg(&vs, &ts) >= 20.0);
        assert!(mesh_area(&vs, &ts) > 2.9);
    }
}
