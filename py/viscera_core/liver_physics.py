"""SI finite-strain liver mechanics experiment, separate from the shape generator.

The simulation domain is an enclosing convex polyhedron, not a conforming liver
tetrahedralization. Its one-branch Green-strain Maxwell material is an engineering
model. Scripted cutting severs a premeshed cohesive seam; it is not free-form
incision, bleeding, calibrated human tissue, or a surgical decision model.
"""

from __future__ import annotations

import hashlib
import itertools
import time
from dataclasses import asdict, dataclass
from typing import Any

import numpy as np
from scipy.optimize import linprog, minimize
from scipy.spatial import ConvexHull, Delaunay, HalfspaceIntersection, cKDTree

from .mechanics import cofactor


@dataclass(frozen=True)
class LiverParameters:
    young_pa: float = 6000.0
    poisson: float = 0.45
    relaxation_fraction: float = 0.4
    relaxation_time_s: float = 0.7
    density_kg_m3: float = 1060.0
    contact_stiffness_n_m: float = 300.0
    fracture_energy_j_m2: float = 150.0
    indentation_stiffness_n_m: float = 20000.0

    def __post_init__(self) -> None:
        bounds = {
            "young_pa": (50, 200000),
            "poisson": (0.0, 0.49),
            "relaxation_fraction": (0.0, 0.95),
            "relaxation_time_s": (0.01, 30.0),
            "density_kg_m3": (500, 2000),
            "contact_stiffness_n_m": (10, 100000),
            "fracture_energy_j_m2": (0.01, 10000),
            "indentation_stiffness_n_m": (1000, 100000),
        }
        for name, (low, high) in bounds.items():
            value = getattr(self, name)
            if isinstance(value, bool) or not np.isfinite(value) or not low <= value <= high:
                raise ValueError(f"{name} must be finite in [{low}, {high}]")

    @property
    def shear(self) -> float:
        return self.young_pa / (2 * (1 + self.poisson))

    @property
    def bulk(self) -> float:
        return self.young_pa / (3 * (1 - 2 * self.poisson))

    @property
    def relaxed_shear(self) -> float:
        """Match the learned long-time uniaxial modulus while keeping K fixed."""
        relaxed_young = self.young_pa * (1 - self.relaxation_fraction)
        return 3 * self.bulk * relaxed_young / (9 * self.bulk - relaxed_young)

    @property
    def shear_relaxation_time_s(self) -> float:
        """Uniaxial-to-shear Maxwell mapping for constant bulk modulus."""
        return (
            self.relaxation_time_s
            * (3 * self.bulk + self.relaxed_shear)
            / (3 * self.bulk + self.shear)
        )


def deviatoric_green(f: np.ndarray) -> np.ndarray:
    e = 0.5 * (np.swapaxes(f, -1, -2) @ f - np.eye(3))
    return e - np.trace(e, axis1=-2, axis2=-1)[..., None, None] * np.eye(3) / 3


def constitutive_response(
    f: np.ndarray,
    parameters: LiverParameters,
    dt: float,
    previous_strain: np.ndarray | None = None,
    memory: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Incremental potential, Piola stress, and new Maxwell strain memory.

    A rest-stable polynomial NH equilibrium branch retains the specified bulk
    modulus. The relaxing branch uses objective deviatoric Green strain. Its
    exact exponential update assumes a linear strain ramp within each step;
    fixed deformation gives exponential stress relaxation without resetting the
    geometry. The returned potential is an incremental solve potential, not
    accumulated physical energy or a dissipation measurement.
    """
    f = np.asarray(f, dtype=np.float64)
    if f.shape[-2:] != (3, 3) or not np.isfinite(f).all() or not np.isfinite(dt) or dt <= 0:
        raise ValueError("Finite 3x3 deformation gradients and positive dt required")
    strain = deviatoric_green(f)
    old = np.zeros_like(strain) if previous_strain is None else np.asarray(previous_strain)
    q = np.zeros_like(strain) if memory is None else np.asarray(memory)
    if old.shape != strain.shape or q.shape != strain.shape:
        raise ValueError("Viscoelastic state shape differs from deformation gradients")
    mu_eq = parameters.relaxed_shear
    lam = parameters.bulk + mu_eq / 3
    alpha = 1 + mu_eq / lam
    j = np.linalg.det(f)
    density = mu_eq / 2 * (np.sum(f * f, axis=(-2, -1)) - 3) + lam / 2 * (
        (j - alpha) ** 2 - (1 - alpha) ** 2
    )
    piola = mu_eq * f + (lam * (j - alpha))[..., None, None] * cofactor(f)
    shear_time = parameters.shear_relaxation_time_s
    decay = np.exp(-dt / shear_time)
    ramp = -np.expm1(-dt / shear_time) * shear_time / dt
    shifted = strain - old + decay / ramp * q
    mu_branch = parameters.shear - mu_eq
    density += mu_branch * ramp * np.sum(shifted * shifted, axis=(-2, -1))
    piola += 2 * mu_branch * ramp * (f @ shifted)
    return density, piola, ramp * shifted


class ViscoelasticTet:
    """Linear tetrahedron assembly with committed, objective material memory."""

    def __init__(self, reference: np.ndarray, tets: np.ndarray, parameters: LiverParameters):
        self.reference = np.asarray(reference, dtype=np.float64)
        self.tets = np.asarray(tets, dtype=np.int64)
        self.parameters = parameters
        edges = np.swapaxes(
            self.reference[self.tets[:, 1:]] - self.reference[self.tets[:, :1]], 1, 2
        )
        self.volumes = np.linalg.det(edges) / 6
        if (
            not len(self.volumes)
            or not np.isfinite(self.volumes).all()
            or np.any(self.volumes <= 0)
        ):
            raise ValueError("Reference tetrahedra require positive finite volume")
        self.inverse = np.linalg.inv(edges)
        self.previous_strain = np.zeros((len(tets), 3, 3))
        self.memory = np.zeros_like(self.previous_strain)

    def gradients(self, current: np.ndarray) -> np.ndarray:
        return (
            np.swapaxes(current[self.tets[:, 1:]] - current[self.tets[:, :1]], 1, 2) @ self.inverse
        )

    def evaluate(self, current: np.ndarray, dt: float) -> tuple[float, np.ndarray, np.ndarray]:
        f = self.gradients(current)
        energy, stress, _ = constitutive_response(
            f, self.parameters, dt, self.previous_strain, self.memory
        )
        # A C1 line-search guard has zero contribution in the supported range.
        # Unlike an infinite objective with zero gradient, this lets Wolfe
        # backtracking recover from an over-large trial without false success.
        # Accepted steps still require J > .08; guard activity is reported.
        jacobians = np.linalg.det(f)
        barrier = np.maximum(0.15 - jacobians, 0.0)
        barrier_stiffness = self.parameters.bulk * 1000
        energy += 0.5 * barrier_stiffness * barrier**2
        stress -= (barrier_stiffness * barrier)[..., None, None] * cofactor(f)
        corners = np.swapaxes(
            self.volumes[:, None, None] * (stress @ np.swapaxes(self.inverse, 1, 2)), 1, 2
        )
        gradient = np.zeros_like(current)
        np.add.at(gradient, self.tets[:, 0], -corners.sum(axis=1))
        for i in range(3):
            np.add.at(gradient, self.tets[:, i + 1], corners[:, i])
        return float(np.sum(energy * self.volumes)), gradient, jacobians

    def commit(self, current: np.ndarray, dt: float) -> None:
        f = self.gradients(current)
        _, _, self.memory = constitutive_response(
            f, self.parameters, dt, self.previous_strain, self.memory
        )
        self.previous_strain = deviatoric_green(f)


def _boundary_faces(tets: np.ndarray, vertices: np.ndarray) -> np.ndarray:
    faces = tets[:, [[1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]]].reshape(-1, 3)
    _, inverse, count = np.unique(
        np.sort(faces, axis=1), axis=0, return_inverse=True, return_counts=True
    )
    faces = faces[count[inverse] == 1]
    # Positive tetrahedra and the local face pattern above imply outward normals.
    return faces


def _bounded_enclosure(vertices: np.ndarray) -> tuple[np.ndarray, dict[str, Any]]:
    """Greedily refine outer support planes from the *actual* source hull.

    Uniform direction sets waste planes on gentle curvature while missing the
    narrow liver tips. At each iteration this method adds the true hull facet
    most violated by the current enclosure. All source points remain inside;
    measured enclosure volume, rather than a fixed plane count, stops refinement.
    Normalized coordinates prevent the long axis dominating plane selection.
    """
    extent = np.ptp(vertices, axis=0)
    origin = (vertices.max(0) + vertices.min(0)) / 2
    normalized = (vertices - origin) / extent
    source_hull = ConvexHull(normalized)
    interior = normalized.mean(0)
    candidates = source_hull.equations.copy()
    directions = np.vstack((np.eye(3), -np.eye(3)))
    margin = 1e-7
    planes = np.column_stack((directions, -(normalized @ directions.T).max(0) - margin))
    excess = float("inf")
    for _ in range(123):
        boundary = HalfspaceIntersection(planes, interior).intersections
        excess = float(ConvexHull(boundary).volume / source_hull.volume - 1)
        if excess <= 0.05:
            break
        if not len(candidates):
            break
        outside = boundary @ candidates[:, :3].T + candidates[:, 3]
        selected = np.unravel_index(np.argmax(outside), outside.shape)[1]
        planes = np.vstack((planes, candidates[selected] - np.array([0, 0, 0, margin])))
        candidates = np.delete(candidates, selected, axis=0)
    # Refuse a materially inflated domain instead of merely displaying a warning.
    if not np.isfinite(excess) or excess > 0.10:
        raise ValueError("Convex simulation enclosure exceeds the 10% volume-error gate")
    physical_normals = planes[:, :3] / extent
    halfspaces = np.column_stack((physical_normals, planes[:, 3] - physical_normals @ origin))
    halfspaces /= np.linalg.norm(physical_normals, axis=1)[:, None]
    return halfspaces, {
        "algorithm": "adaptive_source_hull_support_planes_v2",
        "support_plane_count": len(planes),
        "target_excess_pct": 5.0,
        "maximum_allowed_excess_pct": 10.0,
        "measured_enclosure_excess_pct": excess * 100,
        "source_convex_volume_m3": float(source_hull.volume * np.prod(extent)),
        "axis_padding_m": margin * extent,
    }


def _tetrahedralize(
    halfspaces: np.ndarray, resolution: int, surface_anchor: np.ndarray
) -> tuple[np.ndarray, np.ndarray, Delaunay]:
    normals, offsets = halfspaces[:, :3], halfspaces[:, 3]
    result = linprog(
        [0, 0, 0, -1],
        A_ub=np.column_stack((normals, np.linalg.norm(normals, axis=1))),
        b_ub=-offsets,
        bounds=[(None, None)] * 4,
        method="highs",
    )
    if not result.success or result.x[3] < 1e-7:
        raise ValueError("Surface cannot define a nondegenerate 3D simulation cage")
    boundary = HalfspaceIntersection(halfspaces, result.x[:3]).intersections
    low, high = boundary.min(0), boundary.max(0)
    grid = np.array(
        list(
            itertools.product(
                *(np.linspace(a, b, resolution + 1) for a, b in zip(low, high, strict=True))
            )
        )
    )
    grid = grid[np.all(grid @ normals.T + offsets < -1e-6, axis=1)]
    extras = [boundary, grid, result.x[:3]]
    if np.all(surface_anchor @ normals.T + offsets <= 1e-9):
        extras.append(surface_anchor)
    points = np.unique(np.round(np.vstack(extras), 11), axis=0)
    triangulation = Delaunay(points)
    tets = triangulation.simplices.copy()
    signed = np.linalg.det(np.swapaxes(points[tets[:, 1:]] - points[tets[:, :1]], 1, 2))
    # Qhull can emit effectively coplanar cells at planar polygon boundaries;
    # do not turn roundoff-thick cells into immense stiffness contributions.
    keep = np.abs(signed) > 1e-7 * float(np.prod(high - low))
    tets = tets[keep]
    signed = signed[keep]
    negative = signed < 0
    tets[negative, 1], tets[negative, 2] = tets[negative, 2].copy(), tets[negative, 1].copy()
    return points, tets, triangulation


def build_liver_cage(
    positions_mm: Any, faces: Any, resolution: int = 4, cut: bool = False
) -> dict[str, Any]:
    """Enclose the actual generated surface; do not substitute an authored liver.

    Adaptively selected source-hull planes target <=5% excess volume and reject
    >10% excess relative to the actual source convex hull. Concavities are lost.
    Full source vertices are embedded exactly in the resulting positive tets.
    Cutting uses two independently meshed halves, with coincident seam nodes.
    """
    raw = np.asarray(positions_mm, dtype=np.float64)
    raw_faces = np.asarray(faces)
    if raw.size % 3 or raw_faces.size % 3 or raw_faces.dtype.kind not in "iu":
        raise ValueError("Expected xyz vertices and integer triangular face indices")
    vertices = raw.reshape(-1, 3) * 0.001
    source_faces = raw_faces.reshape(-1, 3).astype(np.int64)
    if len(vertices) < 4 or not len(source_faces) or not np.isfinite(vertices).all():
        raise ValueError("Expected finite nonempty 3D surface")
    if np.any(source_faces < 0) or np.any(source_faces >= len(vertices)):
        raise ValueError("Source face index outside vertex array")
    if isinstance(resolution, bool) or not isinstance(resolution, int) or not 2 <= resolution <= 7:
        raise ValueError("resolution must be an integer in [2,7]")
    extent = np.ptp(vertices, axis=0)
    if np.any(extent < 0.005) or np.any(extent > 1.0):
        raise ValueError("Surface extents must lie between 5 and 1000 mm; check units")
    halfspaces, enclosure = _bounded_enclosure(vertices)
    source_apex = vertices[np.argmax(vertices[:, 1])].copy()
    surface_anchor = source_apex + np.array([0.0, enclosure["axis_padding_m"][1], 0.0])
    split_x = float((vertices[:, 0].min() + vertices[:, 0].max()) / 2)
    domains = (
        [halfspaces]
        if not cut
        else [
            np.vstack((halfspaces, [1, 0, 0, -split_x])),
            np.vstack((halfspaces, [-1, 0, 0, split_x])),
        ]
    )
    all_points, all_tets, point_offsets, triangulations = [], [], [], []
    offset = 0
    for domain in domains:
        points, tets, tri = _tetrahedralize(domain, resolution, surface_anchor)
        all_points.append(points)
        all_tets.append(tets + offset)
        point_offsets.append(offset)
        triangulations.append(tri)
        offset += len(points)
    points = np.vstack(all_points)
    tets = np.vstack(all_tets)
    embedding_tets = np.empty(len(vertices), dtype=np.int64)
    embedding_weights = np.empty((len(vertices), 4))
    tet_lookup = {tuple(sorted(t)): i for i, t in enumerate(tets)}
    for side, tri in enumerate(triangulations):
        selection = (
            np.ones(len(vertices), dtype=bool)
            if not cut
            else (vertices[:, 0] <= split_x if side == 0 else vertices[:, 0] > split_x)
        )
        query = vertices[selection]
        simplex = tri.find_simplex(query, tol=1e-7)
        if np.any(simplex < 0):
            raise ValueError("Generated surface is outside simulation cage")
        found = np.array(
            [tet_lookup[tuple(sorted(t + point_offsets[side]))] for t in tri.simplices[simplex]]
        )
        cells = points[tets[found]]
        weights123 = np.linalg.solve(
            np.swapaxes(cells[:, 1:] - cells[:, :1], 1, 2), (query - cells[:, 0])[..., None]
        )[..., 0]
        embedding_tets[selection] = found
        embedding_weights[selection] = np.column_stack((1 - weights123.sum(1), weights123))
    reconstructed = np.einsum("ni,nij->nj", embedding_weights, points[tets[embedding_tets]])
    seam_pairs: list[list[int]] = []
    seam_faces = np.empty((0, 3), dtype=np.int64)
    boundary = _boundary_faces(tets, points)
    if cut:
        left_ids = np.flatnonzero(np.isclose(points[: point_offsets[1], 0], split_x, atol=1e-9))
        right_ids = (
            np.flatnonzero(np.isclose(points[point_offsets[1] :, 0], split_x, atol=1e-9))
            + point_offsets[1]
        )
        # Matching duplicated vertices carry cohesive bonds. Different internal
        # triangulations are allowed; the same seam polygon corners always match.
        for left in left_ids:
            distances = np.linalg.norm(points[right_ids] - points[left], axis=1)
            right = right_ids[np.argmin(distances)]
            if distances.min() < 1e-8:
                seam_pairs.append([int(left), int(right)])
        if len(seam_pairs) < 3:
            raise ValueError("Cut seam has insufficient paired interface nodes")
        on_seam = np.all(np.isclose(points[boundary, 0], split_x, atol=1e-9), axis=1)
        seam_faces, boundary = boundary[on_seam], boundary[~on_seam]
    return {
        "reference": points,
        "tets": tets,
        "surface_faces": boundary,
        "seam_faces": seam_faces,
        "seam_pairs": np.asarray(seam_pairs, dtype=np.int64).reshape(-1, 2),
        "embedding_tets": embedding_tets,
        "embedding_weights": embedding_weights,
        "split_x": split_x,
        "source_apex": source_apex,
        "enclosure": {key: value for key, value in enclosure.items() if key != "axis_padding_m"},
        "source_vertices": vertices,
        "source_faces": source_faces,
        "embedding_max_error_mm": float(
            np.linalg.norm(reconstructed - vertices, axis=1).max() * 1000
        ),
        "source_convex_volume_m3": enclosure["source_convex_volume_m3"],
        "reference_geometry_sha256": hashlib.sha256(
            np.asarray(vertices * 1000, dtype="<f8").tobytes()
            + np.asarray(source_faces, dtype="<i8").tobytes()
        ).hexdigest(),
    }


def embed_surface(cage: dict[str, Any], current: np.ndarray) -> np.ndarray:
    return np.einsum(
        "ni,nij->nj", cage["embedding_weights"], current[cage["tets"][cage["embedding_tets"]]]
    )


def surface_contact_quadrature(
    reference: np.ndarray,
    boundary_faces: np.ndarray,
    contact_origin: np.ndarray,
    radius_m: float,
    capture_radius_m: float = 0.064,
    spacing_fraction: float = 1 / 3,
) -> dict[str, Any]:
    """Fixed rest-area contact quadrature over boundary triangles near a probe.

    A conservative triangle bounding sphere filters the region. Retained faces
    are uniformly subdivided at maximum edge spacing radius/3 by default, with
    one centroid and its fixed reference area per subtriangle. This resolves
    contact between sparse cage vertices without claiming continuous collision.
    """
    if not np.isfinite(radius_m) or radius_m <= 0 or not 0 < spacing_fraction <= 1 / 3:
        raise ValueError("Contact radius and spacing must be positive; spacing <= radius/3")
    triangles = reference[boundary_faces]
    centers = triangles.mean(axis=1)
    bounding_radii = np.linalg.norm(triangles - centers[:, None, :], axis=2).max(axis=1)
    selected = np.linalg.norm(centers - contact_origin, axis=1) - bounding_radii <= capture_radius_m
    sample_nodes, sample_weights, sample_areas = [], [], []
    spacing = radius_m * spacing_fraction
    for face, triangle in zip(boundary_faces[selected], triangles[selected], strict=True):
        edge = np.roll(triangle, -1, axis=0) - triangle
        divisions = max(1, int(np.ceil(np.linalg.norm(edge, axis=1).max() / spacing)))
        barycentric = []
        for i in range(divisions):
            for j in range(divisions - i):
                u, v = (i + 1 / 3) / divisions, (j + 1 / 3) / divisions
                barycentric.append((1 - u - v, u, v))
                if i + j < divisions - 1:
                    u, v = (i + 2 / 3) / divisions, (j + 2 / 3) / divisions
                    barycentric.append((1 - u - v, u, v))
        area = np.linalg.norm(np.cross(edge[0], -edge[2])) / 2
        sample_nodes.append(np.tile(face, (len(barycentric), 1)))
        sample_weights.append(np.asarray(barycentric))
        sample_areas.append(np.full(len(barycentric), area / divisions**2))
    if not sample_nodes:
        raise ValueError("No simulation boundary triangles near contact origin")
    result = {
        "nodes": np.vstack(sample_nodes),
        "weights": np.vstack(sample_weights),
        "areas_m2": np.concatenate(sample_areas),
        "maximum_spacing_m": spacing,
        "capture_radius_m": capture_radius_m,
        "selected_triangles": int(np.count_nonzero(selected)),
    }
    result["reference"] = reference.copy()
    result["rest_positions"] = np.einsum(
        "ni,nij->nj", result["weights"], reference[result["nodes"]]
    )
    result["tree"] = cKDTree(result["rest_positions"])
    return result


def _near_contact_samples(
    current: np.ndarray, quadrature: dict[str, Any], center: np.ndarray, radius: float
) -> tuple[np.ndarray, np.ndarray]:
    # Barycentric weights are nonnegative and sum to one, so every sample moves
    # at most the maximum nodal displacement. This exact conservative bound
    # culls inactive samples without altering the contact energy or derivative.
    maximum_motion = float(np.linalg.norm(current - quadrature["reference"], axis=1).max())
    ids = np.asarray(
        quadrature["tree"].query_ball_point(center, radius + maximum_motion + 1e-12), dtype=np.int64
    )
    samples = np.einsum("ni,nij->nj", quadrature["weights"][ids], current[quadrature["nodes"][ids]])
    return ids, samples


def sphere_contact_energy_gradient(
    current: np.ndarray,
    quadrature: dict[str, Any],
    tool_center: np.ndarray,
    radius_m: float,
    stiffness_n_m: float,
) -> tuple[float, np.ndarray, np.ndarray]:
    """Area-weighted sphere penalty with exact barycentric nodal derivative.

    Stiffness uses the nominal tool disk area, never moving active-sample count.
    Fixed reference areas/barycentrics make this energy-gradient pair consistent.
    Returned force is the tissue reaction on the prescribed tool.
    """
    ids, samples = _near_contact_samples(current, quadrature, tool_center, radius_m)
    delta = samples - tool_center
    distances = np.linalg.norm(delta, axis=1)
    active = distances < radius_m
    gradient = np.zeros_like(current)
    if not np.any(active):
        return 0.0, gradient, np.zeros(3)
    penetration = radius_m - distances[active]
    active_ids = ids[active]
    stiffness = stiffness_n_m * quadrature["areas_m2"][active_ids] / (np.pi * radius_m**2)
    sample_gradient = (
        -stiffness[:, None]
        * penetration[:, None]
        * delta[active]
        / np.maximum(distances[active, None], 1e-12)
    )
    for corner in range(3):
        np.add.at(
            gradient,
            quadrature["nodes"][active_ids, corner],
            quadrature["weights"][active_ids, corner, None] * sample_gradient,
        )
    return float(0.5 * np.sum(stiffness * penetration**2)), gradient, sample_gradient.sum(axis=0)


def run_liver_experiment(
    positions_mm: Any,
    faces: Any,
    parameters: dict[str, float] | None = None,
    protocol: str = "grasp",
    amplitude_mm: float = 6.0,
    resolution: int = 4,
    steps: int = 48,
) -> dict[str, Any]:
    """Run reproducible ramp/hold/release or irreversible scripted seam cutting.

    Positions in JSON are mm; internal positions, force, mass, time are SI.
    A penalty sphere supplies indentation contact; grasper attachment is a
    finite compliant patch without slip/friction or resolved surgical jaws.
    Backward-Euler inertia regularizes the nonlinear solve. Invalid steps are
    rejected and retained in metrics, never hidden by resetting the organ.
    """
    material = LiverParameters(**(parameters or {}))
    if protocol not in ("indent", "grasp", "cut"):
        raise ValueError("protocol must be indent, grasp, or cut")
    if isinstance(steps, bool) or not isinstance(steps, int) or not 12 <= steps <= 160:
        raise ValueError("steps must be an integer in [12,160]")
    if (
        isinstance(amplitude_mm, bool)
        or not np.isfinite(amplitude_mm)
        or not 0 < amplitude_mm <= 15
    ):
        raise ValueError("amplitude_mm must lie in (0,15]")
    cage = build_liver_cage(positions_mm, faces, resolution, cut=protocol == "cut")
    reference, tets = cage["reference"], cage["tets"]
    fem = ViscoelasticTet(reference, tets, material)
    mass = np.zeros(len(reference))
    elastic_diagonal = np.zeros_like(reference)
    shape_gradients = np.concatenate((-fem.inverse.sum(axis=1)[:, None, :], fem.inverse), axis=1)
    for k in range(4):
        np.add.at(mass, tets[:, k], fem.volumes * material.density_kg_m3 / 4)
        direction = shape_gradients[:, k]
        diagonal = fem.volumes[:, None] * (
            material.shear * np.sum(direction**2, axis=1)[:, None]
            + (material.bulk + material.shear / 3) * direction**2
        )
        np.add.at(elastic_diagonal, tets[:, k], diagonal)
    if np.any(mass <= 0):
        raise ValueError("Simulation cage contains unconnected nodes")
    lower, upper = reference.min(0), reference.max(0)
    extents = upper - lower
    pinned = reference[:, 1] <= lower[1] + 0.08 * extents[1]
    if not pinned.any():
        pinned[np.argmin(reference[:, 1])] = True
    free = ~np.repeat(pinned[:, None], 3, axis=1)
    surface_nodes = np.unique(cage["surface_faces"])
    # Pick a real cage apex, avoiding an empty top-of-bounding-box center.
    top = surface_nodes[
        np.argmin(np.linalg.norm(reference[surface_nodes] - cage["source_apex"], axis=1))
    ]
    origin = reference[top].copy()
    patch_distances = np.linalg.norm(reference - origin, axis=1)
    grasp_nodes = np.flatnonzero((patch_distances <= max(0.016, 0.14 * extents.max())) & ~pinned)
    if not len(grasp_nodes):
        grasp_nodes = np.array([top])
    tool_radius = 0.008
    sphere_origin = origin + np.array([0.0, tool_radius, 0.0])
    contact_quadrature = (
        surface_contact_quadrature(reference, cage["surface_faces"], origin, tool_radius)
        if protocol == "indent"
        else None
    )
    seam_pairs = cage["seam_pairs"]
    active_bonds = np.ones(len(seam_pairs), dtype=bool)
    seam_points = reference[seam_pairs[:, 0]] if len(seam_pairs) else np.empty((0, 3))
    seam_area = 0.0
    if len(cage["seam_faces"]):
        triangles = reference[cage["seam_faces"]]
        seam_area = float(
            np.linalg.norm(
                np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]),
                axis=1,
            ).sum()
            / 4
        )
    cohesive_k = material.contact_stiffness_n_m * 2 / max(len(seam_pairs), 1)
    fracture_dissipation = 0.0
    x, velocity = reference.copy(), np.zeros_like(reference)
    dt, duration = 4.0 / steps, 4.0
    frames: list[dict[str, Any]] = []
    step_times, min_j, max_volume, peak_force, peak_displacement = [], 1.0, 0.0, 0.0, 0.0
    rejected, unconverged, maximum_residual, solver_retries = 0, 0, 0.0, 0
    accepted_guard_active_steps = 0
    maximum_contact_penetration, maximum_mean_contact_penetration = 0.0, 0.0
    loaded_contact_gaps = 0
    force_series, phases = [], []
    tool_work = 0.0
    energy_scale = max(material.young_pa * fem.volumes.sum(), 1e-6)
    damping_per_second = 4.0  # numerical damping; not a learned tissue viscosity
    last_force = np.zeros(3)
    previous_tool = sphere_origin if protocol == "indent" else origin
    if protocol == "cut":
        previous_tool = np.array([cage["split_x"], upper[1] + 1e-6, (lower[2] + upper[2]) / 2])
    cut_opening_nodes = np.flatnonzero((reference[:, 0] > lower[0] + 0.82 * extents[0]) & ~pinned)
    iteration_info: dict[str, Any] = {"solver_converged": True, "stationarity_residual_n": 0.0}

    def capture(t: float, phase: str, tool_position: np.ndarray, force: np.ndarray) -> None:
        frame: dict[str, Any] = {
            "time_s": float(t),
            "positions_mm": (x * 1000).reshape(-1).tolist(),
            "tool_position_mm": (tool_position * 1000).tolist(),
            "tool_force_n": force.tolist(),
            "phase": phase,
            "severed_bonds": int((~active_bonds).sum()),
            **iteration_info,
        }
        if protocol == "cut":
            visible = cage["surface_faces"]
            if np.any(~active_bonds):
                released_nodes = np.zeros(len(reference), dtype=bool)
                released_nodes[seam_pairs[~active_bonds].reshape(-1)] = True
                released_faces = cage["seam_faces"][
                    np.all(released_nodes[cage["seam_faces"]], axis=1)
                ]
                visible = np.vstack((visible, released_faces))
            frame["active_surface_indices"] = visible.reshape(-1).tolist()
        frames.append(frame)

    capture(0.0, "rest", previous_tool, last_force)
    for step in range(1, steps + 1):
        started = time.perf_counter()
        t = step * dt
        fraction = t / duration
        if fraction <= 0.25:
            amplitude = amplitude_mm * 0.001 * fraction / 0.25
            phase = "loading"
        elif fraction <= 0.55:
            amplitude = amplitude_mm * 0.001
            phase = "hold"
        elif fraction <= 0.72:
            amplitude = amplitude_mm * 0.001 * (0.72 - fraction) / 0.17
            phase = "unloading"
        else:
            amplitude, phase = 0.0, "recovery"
        direction = np.array([0.18, 1.0, 0.0])
        target = reference[grasp_nodes] + amplitude * direction
        tool_position = (
            sphere_origin - np.array([0, amplitude, 0])
            if protocol == "indent"
            else origin + amplitude * direction
        )
        attachment_enabled = phase != "recovery"
        if protocol == "cut":
            phase = "cutting" if fraction <= 0.7 else "cut_open"
            blade_y = upper[1] + 1e-6 - min(fraction / 0.7, 1.0) * (extents[1] + 2e-6)
            tool_position = np.array([cage["split_x"], blade_y, (lower[2] + upper[2]) / 2])
            sever = active_bonds & (seam_points[:, 1] >= blade_y)
            fracture_increment = (
                float(sever.sum())
                / max(len(seam_pairs), 1)
                * seam_area
                * material.fracture_energy_j_m2
            )
            fracture_dissipation += fracture_increment
            active_bonds[sever] = False
            amplitude = amplitude_mm * 0.001 * min(fraction / 0.25, 1.0)
            target = reference[cut_opening_nodes] + np.array([amplitude, 0, 0])
        predicted = x + dt * velocity
        old_x = x.copy()
        diagonal = elastic_diagonal + mass[:, None] * (1 / dt**2 + damping_per_second / dt)
        if protocol == "grasp" and attachment_enabled:
            diagonal[grasp_nodes] += material.contact_stiffness_n_m / len(grasp_nodes)
        elif protocol == "cut":
            if len(cut_opening_nodes):
                diagonal[cut_opening_nodes] += material.contact_stiffness_n_m / len(
                    cut_opening_nodes
                )
            np.add.at(diagonal, seam_pairs[active_bonds].reshape(-1), cohesive_k)
        elif protocol == "indent" and attachment_enabled:
            assert contact_quadrature is not None
            q = contact_quadrature
            sample_ids, samples = _near_contact_samples(x, q, tool_position, tool_radius * 1.1)
            nearby = np.linalg.norm(samples - tool_position, axis=1) < tool_radius * 1.1
            nearby_ids = sample_ids[nearby]
            stiffness = (
                material.indentation_stiffness_n_m
                * q["areas_m2"][nearby_ids]
                / (np.pi * tool_radius**2)
            )
            for corner in range(3):
                np.add.at(
                    diagonal,
                    q["nodes"][nearby_ids, corner],
                    (stiffness * q["weights"][nearby_ids, corner] ** 2)[:, None],
                )
        # Reference elastic Hessian diagonal is a mesh-aware unit conversion for
        # the optimizer, not an extra energy or an alteration of the material.
        variable_scale = (0.001 * np.sqrt(np.median(diagonal[free]) / np.maximum(diagonal, 1e-6)))[
            free
        ]

        def tools_energy_gradient(candidate: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
            energy, gradient, force = 0.0, np.zeros_like(candidate), np.zeros(3)
            if protocol == "indent" and attachment_enabled:
                assert contact_quadrature is not None
                energy, gradient, force = sphere_contact_energy_gradient(
                    candidate,
                    contact_quadrature,
                    tool_position,
                    tool_radius,
                    material.indentation_stiffness_n_m,
                )
            elif (protocol == "grasp" and attachment_enabled) or protocol == "cut":
                ids = grasp_nodes if protocol == "grasp" else cut_opening_nodes
                if len(ids):
                    difference = candidate[ids] - target
                    stiffness = material.contact_stiffness_n_m / len(ids)
                    energy += float(0.5 * stiffness * np.sum(difference**2))
                    gradient[ids] += stiffness * difference
                    force = (stiffness * difference).sum(0)
            if len(seam_pairs):
                pairs = seam_pairs[active_bonds]
                opening = candidate[pairs[:, 1]] - candidate[pairs[:, 0]]
                energy += float(0.5 * cohesive_k * np.sum(opening**2))
                np.add.at(gradient, pairs[:, 1], cohesive_k * opening)
                np.add.at(gradient, pairs[:, 0], -cohesive_k * opening)
            return energy, gradient, force

        def objective(values: np.ndarray) -> tuple[float, np.ndarray]:
            candidate = old_x.copy()
            candidate[free] = old_x[free] + values * variable_scale
            energy, gradient, jacobians = fem.evaluate(candidate, dt)
            if not np.isfinite(energy):
                # Retain the physical directional derivative so backtracking
                # does not mistake a forbidden zero-gradient trial for a root.
                return float("inf"), gradient[free] * variable_scale / energy_scale
            movement = candidate - predicted
            damping = candidate - old_x
            energy += float(
                0.5
                * np.sum(
                    mass[:, None] * (movement**2 / dt**2 + damping_per_second * damping**2 / dt)
                )
            )
            gradient += mass[:, None] * (movement / dt**2 + damping_per_second * damping / dt)
            tool_energy, tool_gradient, _ = tools_energy_gradient(candidate)
            energy += tool_energy
            gradient += tool_gradient
            return energy / energy_scale, gradient[free] * variable_scale / energy_scale

        result = minimize(
            objective,
            np.zeros(np.count_nonzero(free)),
            jac=True,
            method="L-BFGS-B",
            options={"maxiter": 240, "ftol": 1e-14, "gtol": 2e-9, "maxls": 35, "maxcor": 15},
        )
        candidate = old_x.copy()
        candidate[free] = old_x[free] + result.x * variable_scale
        _, _, jacobians = fem.evaluate(candidate, dt)
        residual = float(np.max(np.abs(result.jac) * energy_scale / variable_scale))
        candidate_force = tools_energy_gradient(candidate)[2]
        if residual > 1e-3 + 1e-2 * float(np.linalg.norm(candidate_force)):
            solver_retries += 1
            result = minimize(
                objective,
                result.x,
                jac=True,
                method="L-BFGS-B",
                options={"maxiter": 960, "ftol": 1e-15, "gtol": 1e-10, "maxls": 50, "maxcor": 25},
            )
            candidate[free] = old_x[free] + result.x * variable_scale
            _, _, jacobians = fem.evaluate(candidate, dt)
            residual = float(np.max(np.abs(result.jac) * energy_scale / variable_scale))
        maximum_residual = max(maximum_residual, residual)
        if (
            not np.isfinite(candidate).all()
            or np.min(jacobians) <= 0.08
            or not np.isfinite(result.fun)
            or result.fun >= 1e29
        ):
            rejected += 1
            velocity.fill(0)
        else:
            velocity = (candidate - x) / dt
            x = candidate
            fem.commit(x, dt)
        _, _, reaction_force = tools_energy_gradient(x)
        stationarity_pass = residual <= 1e-3 + 1e-2 * float(np.linalg.norm(reaction_force))
        if not stationarity_pass:
            unconverged += 1
        iteration_info = {
            "solver_converged": bool(stationarity_pass),
            "stationarity_residual_n": residual,
            "solver_iterations": int(result.nit),
            "solver_message": str(result.message),
        }
        if contact_quadrature is not None:
            ids, contact_samples = _near_contact_samples(
                x, contact_quadrature, tool_position, tool_radius
            )
            penetration = np.maximum(
                tool_radius - np.linalg.norm(contact_samples - tool_position, axis=1), 0.0
            )
            active = penetration > 0
            maximum = float(penetration.max()) if len(penetration) else 0.0
            weights = contact_quadrature["areas_m2"][ids[active]]
            mean = (
                float(np.average(penetration[active], weights=weights)) if np.any(active) else 0.0
            )
            maximum_contact_penetration = max(maximum_contact_penetration, maximum)
            maximum_mean_contact_penetration = max(maximum_mean_contact_penetration, mean)
            loaded_contact_gaps += int(
                phase in ("loading", "hold") and amplitude >= 0.001 and not np.any(active)
            )
            iteration_info.update(
                {
                    "maximum_contact_penetration_mm": maximum * 1000,
                    "mean_contact_penetration_mm": mean * 1000,
                    "active_contact_samples": int(np.count_nonzero(active)),
                }
            )
        if protocol == "cut":
            # Piecewise constant frame force opposes prescribed blade motion;
            # force times blade travel equals this exact fracture-work increment.
            travel = float(np.linalg.norm(tool_position - previous_tool))
            blade_force = fracture_increment / travel if travel > 1e-12 else 0.0
            reaction_force = np.array([0.0, blade_force, 0.0])
            tool_work += float(-np.dot(reaction_force, tool_position - previous_tool))
        else:
            tool_work += float(
                -np.dot(0.5 * (last_force + reaction_force), tool_position - previous_tool)
            )
        last_force, previous_tool = reaction_force, tool_position.copy()
        current_j = np.linalg.det(fem.gradients(x))
        accepted_guard_active_steps += int(np.min(current_j) < 0.15)
        min_j = min(min_j, float(current_j.min()))
        volume_drift = abs(float(np.dot(fem.volumes, current_j) / fem.volumes.sum() - 1))
        max_volume = max(max_volume, volume_drift)
        displacement = float(np.linalg.norm(x - reference, axis=1).max())
        peak_displacement = max(peak_displacement, displacement)
        peak_force = max(peak_force, float(np.linalg.norm(last_force)))
        force_series.append(float(np.linalg.norm(last_force)))
        phases.append(phase)
        step_times.append((time.perf_counter() - started) * 1000)
        capture(t, phase, tool_position, last_force)
    hold_forces = [
        force for force, phase in zip(force_series, phases, strict=True) if phase == "hold"
    ]
    residual_mm = float(np.linalg.norm(x - reference, axis=1).max() * 1000)
    cage_volume = float(fem.volumes.sum())
    return {
        "schema_version": "liver-physics-experiment-1.0.0",
        "evidence": "numerical_synthetic_prototype_not_human_tissue_validation",
        "protocol": protocol,
        "parameters": asdict(material),
        "constitutive_model": "rest_stable_NH_equilibrium_plus_deviatoric_Green_strain_Maxwell_branch",
        "constitutive_mapping": {
            "learned_parameter_domain": "small_strain_uniaxial_standard_linear_solid",
            "bulk_modulus_pa": material.bulk,
            "instantaneous_shear_pa": material.shear,
            "relaxed_shear_pa": material.relaxed_shear,
            "shear_relaxation_time_s": material.shear_relaxation_time_s,
            "relation": "E_inf=E0(1-g); mu_inf=3K E_inf/(9K-E_inf); tau_mu=tau_E(3K+mu_inf)/(3K+mu0)",
        },
        "units": {"geometry": "mm", "force": "N", "time": "s", "internal": "m-kg-s"},
        "tool": {
            "kind": {"indent": "sphere", "grasp": "grasper", "cut": "blade"}[protocol],
            "radius_mm": tool_radius * 1000,
            "contact": {
                "method": "fixed_rest_area_barycentric_surface_quadrature",
                "samples": len(contact_quadrature["areas_m2"]),
                "triangles": contact_quadrature["selected_triangles"],
                "maximum_spacing_mm": contact_quadrature["maximum_spacing_m"] * 1000,
                "capture_radius_mm": contact_quadrature["capture_radius_m"] * 1000,
                "stiffness_normalization": "fixed nominal tool disk area pi*r^2; no active-count rescaling",
            }
            if contact_quadrature is not None
            else None,
        },
        "mesh": {
            "reference_positions_mm": (reference * 1000).reshape(-1).tolist(),
            "tets": tets.reshape(-1).tolist(),
            "surface_indices": cage["surface_faces"].reshape(-1).tolist(),
            "embedding": {
                "tet_indices": cage["embedding_tets"].tolist(),
                "weights": cage["embedding_weights"].reshape(-1).tolist(),
            },
            "source_vertex_count": len(cage["source_vertices"]),
            "source_face_count": len(cage["source_faces"]),
            "reference_geometry_sha256": cage["reference_geometry_sha256"],
            "seam_pairs": seam_pairs.tolist(),
            "pinned_nodes": np.flatnonzero(pinned).tolist(),
            "tool_reference_gap_mm": float(np.linalg.norm(origin - cage["source_apex"]) * 1000),
            "source_tool_anchor_mm": (cage["source_apex"] * 1000).tolist(),
            "embedding_max_error_mm": cage["embedding_max_error_mm"],
            "cage_volume_ml": cage_volume * 1e6,
            "enclosure_over_convex_hull_pct": (cage_volume / cage["source_convex_volume_m3"] - 1)
            * 100,
            "domain": "support_plane_convex_enclosure_of_input_surface",
            "enclosure": cage["enclosure"],
        },
        "frames": frames,
        "metrics": {
            "minimum_jacobian": min_j,
            "maximum_volume_error_pct": 100 * max_volume,
            "inverted_elements": int(np.count_nonzero(np.linalg.det(fem.gradients(x)) <= 0)),
            "peak_tool_force_n": peak_force,
            "peak_displacement_mm": peak_displacement * 1000,
            "residual_displacement_mm": residual_mm,
            "recovery_fraction": 1 - residual_mm / max(peak_displacement * 1000, 1e-12),
            "rejected_steps": rejected,
            "unconverged_steps": unconverged,
            "solver_retries": solver_retries,
            "accepted_inversion_guard_active_steps": accepted_guard_active_steps,
            "maximum_contact_penetration_mm": maximum_contact_penetration * 1000,
            "maximum_mean_contact_penetration_mm": maximum_mean_contact_penetration * 1000,
            "loaded_contact_gap_frames": loaded_contact_gaps,
            "maximum_stationarity_residual_n": maximum_residual,
            "mean_step_ms": float(np.mean(step_times)),
            "p95_step_ms": float(np.quantile(step_times, 0.95)),
            "severed_bonds": int((~active_bonds).sum()),
            "total_seam_bonds": len(seam_pairs),
            "fracture_dissipation_j": fracture_dissipation,
            "hold_force_ratio": hold_forces[-1] / hold_forces[0]
            if hold_forces and hold_forces[0] > 1e-10
            else None,
            "force_displacement_work_j": tool_work,
            "numerical_status": "PASS" if not (rejected or unconverged) else "NEEDS_REFINEMENT",
            "maximum_seam_opening_mm": float(
                np.linalg.norm(x[seam_pairs[:, 1]] - x[seam_pairs[:, 0]], axis=1).max() * 1000
            )
            if len(seam_pairs)
            else 0.0,
            "finite_state": bool(np.isfinite(x).all()),
        },
        "solver": {
            "method": "implicit_backward_Euler_LBFGS",
            "dt_s": dt,
            "steps": steps,
            "duration_s": duration,
            "numerical_damping_per_s": damping_per_second,
            "preconditioner": "reference_elastic_diagonal_plus_inertia_and_tool",
            "force_convention": "tissue reaction on prescribed tool; external work = -reaction dot tool displacement; cut force is interval-constant fracture budget resistance",
            "inversion_rejection_j": 0.08,
            "inversion_search_guard_j": 0.15,
        },
        "limitations": [
            "Convex enclosure loses liver concavities and internal anatomy; exact surface embedding does not certify a conforming FEM domain.",
            "Linear tetrahedra, penalty contact and fixed lower supports require mesh/time convergence and measured boundary calibration.",
            "Parameters learned from small-strain synthetic traces do not validate this finite-strain material or human liver mechanics.",
            "No capsule, vessels, prestress, gravity, self-contact, friction, blood flow, or resolved surgical jaws.",
            "Cutting follows a premeshed plane with scripted irreversible cohesive-bond release; toughness supplies an assumed fracture-work budget, not calibrated fracture prediction.",
            "Numerical damping is fixed solver stabilization, separate from learned material relaxation.",
        ],
    }
