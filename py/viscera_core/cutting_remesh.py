"""Offline constrained remeshing of a prepared, paired cutting reference.

Gmsh is an optional, separately installed GPL tool; no Gmsh code is imported by
normal application paths. The generated coordinates retain their source license.
Geometry quality is reported, not equated with mechanical/clinical validation.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import time
from pathlib import Path

import numpy as np
from scipy.spatial import ConvexHull, HalfspaceIntersection

from .cutting_mesh import build_section_cap, embed_skin


def quality(points: np.ndarray, tets: np.ndarray) -> dict:
    """Conventional mean-ratio quality (regular tetrahedron=1), in input units.

    Coordinates must be mm for dimensioned report labels. Reject degenerate or
    reversed cells rather than hiding orientation with an absolute determinant.
    """
    points, tets = np.asarray(points, dtype=float), np.asarray(tets)
    if (
        points.ndim != 2
        or points.shape[1] != 3
        or not np.isfinite(points).all()
        or tets.ndim != 2
        or tets.shape[1] != 4
        or not len(tets)
        or not np.issubdtype(tets.dtype, np.integer)
        or tets.min() < 0
        or tets.max() >= len(points)
    ):
        raise ValueError("Finite points and valid tetrahedral indices are required")
    p = points[tets]
    volume6 = np.linalg.det(np.swapaxes(p[:, 1:] - p[:, :1], 1, 2))
    if np.any(volume6 <= 0):
        raise ValueError("Positive, nondegenerate tetrahedral orientation is required")
    edges = np.stack(
        [np.linalg.norm(p[:, a] - p[:, b], axis=1) for a in range(4) for b in range(a + 1, 4)],
        axis=1,
    )
    faces = np.stack(
        [
            np.linalg.norm(np.cross(p[:, b] - p[:, a], p[:, c] - p[:, a]), axis=1)
            for a, b, c in [(1, 2, 3), (0, 3, 2), (0, 1, 3), (0, 2, 1)]
        ],
        axis=1,
    )
    mean_ratio = 12 * (volume6 / 2) ** (2 / 3) / np.sum(edges**2, axis=1)
    condition = np.linalg.cond(np.swapaxes(p[:, 1:] - p[:, :1], 1, 2))
    return dict(
        nodes=len(points),
        tets=len(tets),
        volumeMm3=float(np.sum(volume6) / 6),
        minimumVolumeMm3=float(np.min(volume6) / 6),
        meanRatioQuantiles=dict(
            zip(
                ["min", "p01", "p10", "median", "p90", "max"],
                map(float, np.quantile(mean_ratio, [0, 0.01, 0.1, 0.5, 0.9, 1])),
            )
        ),
        minimumAltitudeMm=float(np.min(volume6[:, None] / faces)),
        restDConditionQuantiles=dict(
            zip(
                ["min", "p01", "p10", "median", "p90", "max"],
                map(float, np.quantile(condition, [0, 0.01, 0.1, 0.5, 0.9, 1])),
                strict=True,
            )
        ),
        maximumEdgeRatio=float(np.max(edges.max(1) / edges.min(1))),
        minimumScaledVolume=float(np.min(volume6 / edges.max(1) ** 3)),
    )


def outer_patches(points: np.ndarray) -> tuple[list[np.ndarray], np.ndarray, dict]:
    hull = ConvexHull(points)
    groups: dict[tuple, list[int]] = {}
    for i, equation in enumerate(hull.equations):
        groups.setdefault(tuple(np.round(equation, 4)), []).append(i)
    patches, normals, recovered_planes = [], [], []
    maximum_plane_residual = 0.0
    for faces in groups.values():
        ids = np.unique(hull.simplices[faces])
        positions = points[ids]
        # Largest triangle avoids unstable normals from nearly collinear hull
        # facets created by the reference's coordinate rounding.
        triangles = points[hull.simplices[faces]]
        area2 = np.linalg.norm(
            np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]), axis=1
        )
        equation = hull.equations[faces[int(np.argmax(area2))]]
        n = equation[:3]
        maximum_plane_residual = max(
            maximum_plane_residual, float(np.max(np.abs(positions @ n + equation[3])))
        )
        # Rounded reference corners are not exactly coplanar. Reconstruct the
        # enclosure from recovered supporting halfspaces rather than passing
        # intersecting almost-coplanar BRep edges to a constrained mesher. The
        # support offset retains every original point; discrepancy is measured.
        recovered_planes.append(np.r_[n, -np.max(points @ n)])
    recovered_planes = np.array(recovered_planes)
    corners = HalfspaceIntersection(recovered_planes, points.mean(0)).intersections
    for equation in recovered_planes:
        n = equation[:3]
        positions = corners[abs(corners @ n + equation[3]) < 1e-6]
        axis = np.eye(3)[int(np.argmin(np.abs(n)))]
        u = np.cross(n, axis)
        u /= np.linalg.norm(u)
        v = np.cross(n, u)
        projected = np.column_stack((positions @ u, positions @ v))
        order = ConvexHull(projected).vertices
        polygon = positions[order]
        if np.dot(np.cross(polygon[1] - polygon[0], polygon[2] - polygon[0]), n) < 0:
            polygon = polygon[::-1]
        patches.append(polygon)
        normals.append(n)
    if maximum_plane_residual > 1e-5:
        raise ValueError(f"Recovered enclosure patch deviates by {maximum_plane_residual} mm")
    return (
        patches,
        np.array(normals),
        dict(
            patches=len(patches),
            hullVolumeMm3=float(hull.volume),
            maximumPatchPlanarityResidualMm=maximum_plane_residual,
            hullEquations=hull.equations,
        ),
    )


def clip(polygon: np.ndarray, plane: float, side: int) -> np.ndarray:
    result = []
    for a, b in zip(polygon, np.roll(polygon, -1, axis=0), strict=True):
        da, db = side * (a[0] - plane), side * (b[0] - plane)
        if da >= -1e-10:
            result.append(a.copy())
        if da * db < -1e-18:
            point = a + (plane - a[0]) / (b[0] - a[0]) * (b - a)
            point[0] = plane
            result.append(point)
    return np.array(result).reshape(-1, 3)


def loops_from_split_skin(source: dict) -> list[np.ndarray]:
    p = np.array(source["skin"]["positionsMm"]).reshape(-1, 3)
    faces = np.array(source["skin"]["indices"]).reshape(-1, 3)
    original = np.array(source["positionsMm"]).reshape(-1, 3)
    tets = np.array(source["tets"]).reshape(-1, 4)
    sides = np.sign(original[tets].mean(1)[:, 0] - source["planeXMm"])
    skin_sides = sides[np.array(source["skin"]["tetIndices"])]
    edges = {}
    for face in faces[np.all(skin_sides[faces] < 0, axis=1)]:
        for a, b in zip(face, np.roll(face, -1), strict=True):
            if max(abs(p[a, 0] - source["planeXMm"]), abs(p[b, 0] - source["planeXMm"])) < 1e-7:
                key = tuple(sorted((int(a), int(b))))
                edges[key] = edges.get(key, 0) + 1
    graph = {}
    for (a, b), count in edges.items():
        if count == 1:
            graph.setdefault(a, []).append(b)
            graph.setdefault(b, []).append(a)
    if not graph or any(len(neighbors) != 2 for neighbors in graph.values()):
        raise ValueError("Non-manifold source section")
    seen, contours = set(), []
    for first in graph:
        if first in seen:
            continue
        order, previous, current = [], None, first
        while current not in seen:
            seen.add(current)
            order.append(current)
            previous, current = current, next(v for v in graph[current] if v != previous)
        if current != first:
            raise ValueError("Open source section")
        loop = p[order, 1:] * 0.001
        area = (
            np.sum(loop[:, 0] * np.roll(loop[:, 1], -1) - loop[:, 1] * np.roll(loop[:, 0], -1)) / 2
        )
        contours.append(loop if area > 0 else loop[::-1])
    return contours


def split_conforming_interface(
    points: np.ndarray, cells: np.ndarray, sides: np.ndarray, seam: np.ndarray, plane: float
) -> dict:
    """Duplicate one complete shared interface without changing either volume.

    The input is a conforming two-volume mesh. Every listed interface face must
    have exactly one owner on each side, and every cross-side face must appear.
    All outputs own their arrays; unused mesher points are removed.
    """
    points = np.asarray(points, dtype=float).copy()
    cells, sides, seam = np.asarray(cells).copy(), np.asarray(sides).copy(), np.asarray(seam).copy()
    if (
        points.ndim != 2
        or points.shape[1] != 3
        or not np.isfinite(points).all()
        or not np.isfinite(plane)
        or cells.ndim != 2
        or cells.shape[1] != 4
        or not len(cells)
        or not np.issubdtype(cells.dtype, np.integer)
        or cells.min() < 0
        or cells.max() >= len(points)
        or sides.shape != (len(cells),)
        or not np.all(np.isin(sides, [-1, 1]))
        or seam.ndim != 2
        or seam.shape[1] != 3
        or not len(seam)
        or not np.issubdtype(seam.dtype, np.integer)
        or seam.min() < 0
        or seam.max() >= len(points)
    ):
        raise ValueError("Invalid conforming interface arrays")
    if np.max(abs(points[seam, 0] - plane)) > 1e-7 or np.any(
        sides[:, None] * (points[cells, 0] - plane) < -1e-7
    ):
        raise ValueError("Interface and cell ownership must remain on their declared halfspaces")
    owners = {}
    for cell, side in zip(cells, sides, strict=True):
        for face in cell[[[1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]]]:
            owners.setdefault(tuple(sorted(face)), []).append(int(side))
    if any(len(value) > 2 for value in owners.values()):
        raise ValueError("Non-manifold tetrahedral adjacency")
    interface = {face for face, owner in owners.items() if len(owner) == 2 and owner[0] != owner[1]}
    supplied = [tuple(sorted(face)) for face in seam]
    if len(supplied) != len(set(supplied)) or set(supplied) != interface:
        raise ValueError("Interface must include every shared left/right face exactly once")
    # Unused BRep corners cannot carry solver mass; compact before splitting.
    used = np.unique(cells)
    remap = np.full(len(points), -1, dtype=int)
    remap[used] = np.arange(len(used))
    points = points[used]
    cells = remap[cells]
    seam = remap[seam]
    det = np.linalg.det(np.swapaxes(points[cells[:, 1:]] - points[cells[:, :1]], 1, 2))
    flip = det < 0
    cells[flip, 1], cells[flip, 2] = cells[flip, 2].copy(), cells[flip, 1].copy()
    if np.any(det == 0):
        raise ValueError("Zero-volume generated cell")
    seam_ids = np.unique(seam)
    right_map = {int(v): len(points) + i for i, v in enumerate(seam_ids)}
    points[seam_ids, 0] = plane
    split_points = np.vstack((points, points[seam_ids]))
    split_cells = cells.copy()
    for index in np.flatnonzero(sides > 0):
        split_cells[index] = [right_map.get(int(v), int(v)) for v in cells[index]]
    triangles = points[seam]
    orientation = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])[
        :, 0
    ]
    seam[orientation < 0] = seam[orientation < 0][:, ::-1]
    right_seam = np.array([[right_map[int(v)] for v in triangle[::-1]] for triangle in seam])
    areas = (
        np.linalg.norm(
            np.cross(
                points[seam[:, 1]] - points[seam[:, 0]], points[seam[:, 2]] - points[seam[:, 0]]
            ),
            axis=1,
        )
        / 2
    )
    nodal_area = np.zeros(len(points))
    np.add.at(nodal_area, seam.ravel(), np.repeat(areas / 3, 3))
    all_faces = split_cells[:, [[1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]]].reshape(-1, 3)
    _, inverse, counts = np.unique(
        np.sort(all_faces, axis=1), axis=0, return_inverse=True, return_counts=True
    )
    if counts.max() > 2:
        raise ValueError("Non-manifold tetrahedral adjacency")
    boundary = all_faces[counts[inverse] == 1]
    pairs = [
        dict(left=int(v), right=right_map[int(v)], areaM2=float(nodal_area[v] * 1e-6))
        for v in seam_ids
    ]
    return dict(
        points=split_points,
        tets=split_cells,
        seam=seam,
        right_seam=right_seam,
        areas=areas,
        boundary=boundary,
        pairs=pairs,
    )


def remesh_cutting_reference(
    source_path: Path,
    output: Path,
    *,
    coarse: float = 22,
    fine: float = 3,
    radius: float = 5,
    algorithm: int = 1,
    refine_features: bool = True,
    compact_contact: bool = False,
) -> dict:
    """Write a new candidate and geometry receipt; never publish it automatically.

    The same shared Gmsh plane constrains both volumes before cohesive nodes are
    duplicated. Skin coordinates/colors/connectivity remain unchanged; each new
    cap face has exactly one affine support tetrahedron. An existing result is
    refused so qualification cannot silently refer to overwritten geometry.
    """
    source_path, output = Path(source_path).resolve(), Path(output).resolve()
    if (
        not np.isfinite([coarse, fine, radius]).all()
        or not 0.04 <= fine <= coarse <= 500
        or not 0 <= radius <= 100
        or algorithm not in [1, 10]
    ):
        raise ValueError(
            "Require 0.04 <= fine <= coarse <= 500 mm, radius 0..100 mm and algorithm 1 or 10"
        )
    if any(
        (output / name).exists()
        for name in ["conforming.msh", "liver-reference-remeshed.json", "report.json"]
    ):
        raise ValueError("Output already contains a mesh candidate; choose a fresh directory")
    try:
        gmsh = importlib.import_module("gmsh")
    except ModuleNotFoundError as error:
        raise RuntimeError(
            "Optional offline dependency missing: install gmsh==4.15.2 in an isolated environment; see docs/cutting-remeshing.md"
        ) from error
    if gmsh.__version__ != "4.15.2":
        raise RuntimeError(f"Pinned offline tool gmsh==4.15.2 required; found {gmsh.__version__}")
    if gmsh.isInitialized():
        raise RuntimeError(
            "Run the offline remesher in an isolated process; Gmsh is already initialized"
        )
    started = time.perf_counter()
    source_bytes = source_path.read_bytes()
    source = json.loads(source_bytes)
    if source.get("schema") != "viscera.cutting-reference/v1" or not all(
        source.get("source", {}).get(key)
        for key in ["templateId", "sha256", "attribution", "license"]
    ):
        raise ValueError("A cutting reference with source attribution and license is required")
    old_points = np.array(source["positionsMm"]).reshape(-1, 3)
    old_tets = np.array(source["tets"]).reshape(-1, 4)
    plane = source["planeXMm"]
    patches, normals, hull_report = outer_patches(old_points)
    all_polygons = []
    for polygon, normal in zip(patches, normals, strict=True):
        for side in [-1, 1]:
            part = clip(polygon, plane, side)
            if len(part) >= 3:
                all_polygons.append((part, side, normal))
    seam_points = np.vstack([p[abs(p[:, 0] - plane) < 1e-7] for p, _, _ in all_polygons])
    seam_points = np.unique(np.round(seam_points, 9), axis=0)
    seam_polygon = seam_points[ConvexHull(seam_points[:, 1:]).vertices]
    # One interface surface shared by both volumes guarantees identical facets.
    all_polygons.append((seam_polygon, 0, np.array([1.0, 0.0, 0.0])))
    vertex_map, vertices = {}, []

    def vertex(point):
        key = tuple(np.round(point, 8))
        for existing, previous in enumerate(vertices):
            if np.linalg.norm(point - previous) < 1e-6:
                return existing
        if key not in vertex_map:
            vertex_map[key] = len(vertices)
            vertices.append(np.array(point))
        return vertex_map[key]

    polygons = [
        list(dict.fromkeys(vertex(point) for point in polygon)) for polygon, _, _ in all_polygons
    ]
    vertices = np.array(vertices)
    # Split patch edges at every shared corner lying on that segment. This
    # removes hanging BRep edges without changing the geometric boundary.
    for i, polygon in enumerate(polygons):
        loop = []
        for a, b in zip(polygon, polygon[1:] + polygon[:1], strict=True):
            delta = vertices[b] - vertices[a]
            length2 = float(delta @ delta)
            if length2 < 1e-15:
                continue
            parameters = (vertices - vertices[a]) @ delta / length2
            distance = np.linalg.norm(vertices - vertices[a] - parameters[:, None] * delta, axis=1)
            middle = np.flatnonzero(
                (parameters > 1e-9) & (parameters < 1 - 1e-9) & (distance < 1e-6)
            )
            loop.extend([a] + sorted(middle.tolist(), key=lambda j: parameters[j]))
        polygons[i] = list(dict.fromkeys(loop))
    for side in [-1, 1]:
        counts = {}
        for polygon, (_, owner, _) in zip(polygons, all_polygons, strict=True):
            if owner not in [0, side]:
                continue
            for a, b in zip(polygon, polygon[1:] + polygon[:1], strict=True):
                key = tuple(sorted((a, b)))
                counts[key] = counts.get(key, 0) + 1
        if any(count != 2 for count in counts.values()):
            raise ValueError(
                f"Nonconforming BRep edges on side {side}: {[(key, count) for key, count in counts.items() if count != 2]}"
            )
    gmsh.initialize(["cutting-remesh", "-nopopup"], readConfigFiles=False)
    try:
        gmsh.option.setNumber("General.NumThreads", 1)
        gmsh.option.setNumber("General.Terminal", 1)
        gmsh.option.setNumber("Geometry.Tolerance", 1e-8)
        gmsh.option.setNumber("Mesh.Algorithm3D", algorithm)
        gmsh.option.setNumber("Mesh.RandomSeed", 1)
        gmsh.option.setNumber("Mesh.MeshSizeMin", 0.04 if refine_features else fine)
        gmsh.option.setNumber("Mesh.MeshSizeMax", coarse)
        gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 0)
        gmsh.option.setNumber("Mesh.MeshSizeExtendFromBoundary", 0)
        gmsh.model.add("paired-convex-liver-reference")
        tags = [gmsh.model.geo.addPoint(*point, coarse) for point in vertices]
        lines = {}

        def edge(a, b):
            key = tuple(sorted((a, b)))
            if key not in lines:
                lines[key] = gmsh.model.geo.addLine(tags[key[0]], tags[key[1]])
            return lines[key] if (a, b) == key else -lines[key]

        surfaces = {-1: [], 1: []}
        seam_tag = None
        for polygon, (_, side, _) in zip(polygons, all_polygons, strict=True):
            loop = gmsh.model.geo.addCurveLoop(
                [edge(a, b) for a, b in zip(polygon, polygon[1:] + polygon[:1], strict=True)]
            )
            surface = gmsh.model.geo.addPlaneSurface([loop])
            if side == 0:
                seam_tag = surface
                surfaces[-1].append(surface)
                surfaces[1].append(-surface)
            else:
                surfaces[side].append(surface)
        volumes = {
            side: gmsh.model.geo.addVolume([gmsh.model.geo.addSurfaceLoop(faces)])
            for side, faces in surfaces.items()
        }
        gmsh.model.geo.synchronize()
        cap_positions = np.array(source["cap"]["positionsMm"]).reshape(-1, 3)
        top = cap_positions[np.argmax(cap_positions[:, 1])]
        # A smooth size field focuses only on the declared incision corridor.
        # Every x/y/z value is in mm; the scalpel thickness remains unchanged.
        field = gmsh.model.mesh.field.add("MathEval")
        distance = f"Sqrt((x-({plane}))^2+(y-({top[1] - 5}))^2+Max(0,Abs(z-({top[2] + 12}))-24)^2)"
        expression = f"{fine}+({coarse}-{fine})*Min(1,Max(0,({distance}-{radius})/{coarse}))"
        gmsh.model.mesh.field.setString(field, "F", expression)
        gmsh.model.mesh.field.setAsBackgroundMesh(field)
        if refine_features:
            short_edges = [
                key for key in lines if np.linalg.norm(vertices[key[0]] - vertices[key[1]]) < 1
            ]
            if short_edges:
                feature_points = sorted({node for edge_nodes in short_edges for node in edge_nodes})
                distance_field = gmsh.model.mesh.field.add("Distance")
                gmsh.model.mesh.field.setNumbers(
                    distance_field, "PointsList", [tags[node] for node in feature_points]
                )
                feature_field = gmsh.model.mesh.field.add("MathEval")
                gmsh.model.mesh.field.setString(feature_field, "F", f"0.08+0.7*F{distance_field}")
                minimum_field = gmsh.model.mesh.field.add("Min")
                gmsh.model.mesh.field.setNumbers(
                    minimum_field, "FieldsList", [field, feature_field]
                )
                gmsh.model.mesh.field.setAsBackgroundMesh(minimum_field)
        gmsh.model.mesh.generate(3)
        gmsh.model.mesh.optimize("", niter=5)
        gmsh.model.mesh.optimize("Netgen", niter=5)
        node_tags, coordinates, _ = gmsh.model.mesh.getNodes()
        points = np.array(coordinates).reshape(-1, 3)
        lookup = {int(tag): i for i, tag in enumerate(node_tags)}
        cells, sides = [], []
        for side, volume in volumes.items():
            types, _, nodes = gmsh.model.mesh.getElements(3, volume)
            for kind, values in zip(types, nodes, strict=True):
                if kind != 4:
                    raise ValueError("Only linear tetrahedra supported")
                cells.extend(
                    [[lookup[int(v)] for v in tet] for tet in np.array(values).reshape(-1, 4)]
                )
                sides.extend([side] * (len(values) // 4))
        cells = np.array(cells)
        sides = np.array(sides)
        types, _, triangle_nodes = gmsh.model.mesh.getElements(2, seam_tag)
        if types.tolist() != [2]:
            raise ValueError("Seam requires linear triangles")
        seam = np.array(
            [
                [lookup[int(v)] for v in triangle]
                for triangle in np.array(triangle_nodes[0]).reshape(-1, 3)
            ]
        )
        output.mkdir(parents=True, exist_ok=True)
        gmsh.write(str(output / "conforming.msh"))
    finally:
        gmsh.finalize()
    split = split_conforming_interface(points, cells, sides, seam, plane)
    split_points, split_cells, seam, right_seam = (
        split[key] for key in ["points", "tets", "seam", "right_seam"]
    )
    areas, boundary, pairs = (split[key] for key in ["areas", "boundary", "pairs"])
    mesh = dict(
        reference=split_points * 0.001,
        tets=split_cells,
        seam_left=seam.ravel(),
        seam_right=right_seam.ravel(),
    )
    old_centers = old_points[old_tets].mean(1)
    skin_sides = np.sign(old_centers[np.array(source["skin"]["tetIndices"]), 0] - plane)
    skin_points = np.array(source["skin"]["positionsMm"]).reshape(-1, 3) * 0.001
    skin_tets, skin_weights = embed_skin(skin_points, skin_sides, mesh, plane * 0.001)
    cap = build_section_cap(loops_from_split_skin(source), mesh, plane * 0.001)
    skin_error = float(
        np.max(
            np.linalg.norm(
                np.einsum("ni,nij->nj", skin_weights, mesh["reference"][split_cells[skin_tets]])
                - skin_points,
                axis=1,
            )
        )
        * 1000
    )
    cap_error = float(
        np.max(
            np.linalg.norm(
                np.einsum(
                    "ni,nij->nj", cap["weights"], mesh["reference"][split_cells[cap["tet_ids"]]]
                )
                - cap["positions"],
                axis=1,
            )
        )
        * 1000
    )
    original_quality, new_quality = (
        quality(old_points, old_tets),
        quality(split_points, split_cells),
    )
    hull_equations = hull_report.pop("hullEquations")
    new_outer_faces = boundary[~np.all(abs(split_points[boundary, 0] - plane) < 1e-7, axis=1)]
    new_outer = split_points[np.unique(new_outer_faces)]
    maximum_outside = float(np.max(new_outer @ hull_equations[:, :3].T + hull_equations[:, 3]))
    maximum_boundary_distance = float(
        np.max(np.abs(np.max(new_outer @ hull_equations[:, :3].T + hull_equations[:, 3], axis=1)))
    )
    volume_error = abs(new_quality["volumeMm3"] / original_quality["volumeMm3"] - 1)
    if (
        volume_error > 1e-6
        or maximum_boundary_distance > 1e-5
        or skin_error > 1e-6
        or cap_error > 1e-6
    ):
        raise ValueError("Boundary, volume or embedding preservation gate failed")
    if len(split_points) > 12000:
        raise ValueError("Candidate exceeds the 12,000-node research ceiling")
    result = dict(source)
    # Remeshing invalidates any integration tessellation of the previous tets.
    result.pop("contactCap", None)
    result.update(
        positionsMm=split_points.ravel().tolist(),
        tets=split_cells.ravel().tolist(),
        boundaryIndices=boundary.ravel().tolist(),
        seamPairs=pairs,
        seamLeftIndices=seam.ravel().tolist(),
        seamRightIndices=right_seam.ravel().tolist(),
    )
    result["skin"] = dict(
        source["skin"], tetIndices=skin_tets.tolist(), weights=skin_weights.ravel().tolist()
    )
    result["cap"] = dict(
        positionsMm=(cap["positions"] * 1000).ravel().tolist(),
        indices=cap["triangles"].ravel().tolist(),
        tetIndices=cap["tet_ids"].tolist(),
        weights=cap["weights"].ravel().tolist(),
    )
    result["fixedNodes"] = np.flatnonzero(
        split_points[:, 1] < split_points[:, 1].min() + 0.12 * np.ptp(split_points[:, 1])
    ).tolist()
    provenance = dict(
        algorithm="shared-surface constrained tetrahedral remesh with native and Netgen optimization",
        gmshVersion=gmsh.__version__,
        toolConfiguration=dict(threads=1, randomSeed=1, readUserConfigFiles=False),
        gmshLicense="GPL-2.0-or-later with Gmsh linking exception; optional offline tool only",
        sourceReferenceSha256=hashlib.sha256(source_bytes).hexdigest(),
        builderSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        embeddingBuilderSha256=hashlib.sha256(
            Path(__file__).with_name("cutting_mesh.py").read_bytes()
        ).hexdigest(),
        parameters=dict(
            coarseMm=coarse,
            fineMm=fine,
            corridorRadiusMm=radius,
            algorithm=algorithm,
            refineFeatures=refine_features,
            compactContactCap=compact_contact,
        ),
        changes="Reconstructed convex support enclosure, new interior tetrahedra and paired interface; source capsule coordinates, colors and connectivity unchanged; source section cap re-embedded exactly.",
        mechanicsValidated=False,
    )
    result["diagnostics"] = dict(
        source["diagnostics"],
        splitVolumeM3=new_quality["volumeMm3"] * 1e-9,
        minimumTetVolumeM3=new_quality["minimumVolumeMm3"] * 1e-9,
        minimumScaledVolume=new_quality["minimumScaledVolume"],
        seamAreaM2=float(areas.sum() * 1e-6),
        embeddingErrorMm=skin_error,
        capAreaM2=cap["area"],
        capSourceAreaM2=cap["source_area"],
        capEmbeddingErrorMm=cap_error,
        remeshing=provenance,
    )
    result["diagnostics"].pop("contactCapCompaction", None)
    contact_report = None
    if compact_contact:
        from .cutting_contact_cap import attach_contact_cap

        result, contact_report = attach_contact_cap(result)
    result["limitations"] = list(source["limitations"]) + [
        "Experimental remeshed artifact; corrected continuous blade-contact and trajectory validation remain required."
    ]
    artifact = output / "liver-reference-remeshed.json"
    artifact.write_text(json.dumps(result, separators=(",", ":"), allow_nan=False) + "\n")
    centers = split_points[split_cells].mean(1)
    band = (
        (abs(centers[:, 0] - plane) < 10)
        & (centers[:, 1] > top[1] - 20)
        & (abs(centers[:, 2] - (top[2] + 12)) < 38)
    )
    report = dict(
        status="GEOMETRY_CANDIDATE_ONLY",
        source=str(source_path),
        sourceSha256=hashlib.sha256(source_bytes).hexdigest(),
        output=str(artifact),
        outputSha256=hashlib.sha256(artifact.read_bytes()).hexdigest(),
        prototypeSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        gmshVersion=gmsh.__version__,
        parameters=dict(
            coarseMm=coarse,
            fineMm=fine,
            corridorRadiusMm=radius,
            algorithm=algorithm,
            refineFeatures=refine_features,
            compactContactCap=compact_contact,
        ),
        seconds=time.perf_counter() - started,
        sourceQuality=original_quality,
        candidateQuality=new_quality,
        incisionBandQuality=quality(split_points, split_cells[band]),
        hull=hull_report,
        preservation=dict(
            relativeTetVolumeDifference=volume_error,
            maximumBoundaryDistanceMm=maximum_boundary_distance,
            maximumOutsideMm=maximum_outside,
            skinEmbeddingErrorMm=skin_error,
            capEmbeddingErrorMm=cap_error,
            skinMinimumWeight=float(skin_weights.min()),
            capMinimumWeight=float(cap["weights"].min()),
            sourceCapAreaMm2=source["diagnostics"]["capAreaM2"] * 1e6,
            candidateCapAreaMm2=cap["area"] * 1e6,
            geometricSeamAreaMm2=float(areas.sum()),
            pairs=len(pairs),
        ),
        mechanicsValidated=False,
    )
    report["provenance"] = provenance
    if contact_report is not None:
        report["contactCapCompaction"] = contact_report
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    (output / "NOTICE.txt").write_text(
        f"SOURCE GEOMETRY\n{source['source']['attribution']}\nLicense: {source['source']['license']}\nSource reference SHA-256: {provenance['sourceReferenceSha256']}\n\nCHANGES\n{provenance['changes']}\n\nOFFLINE TOOL\nGmsh {gmsh.__version__}, https://gmsh.info/\nGPL-2.0-or-later with the project's linking exception.\nGmsh binaries and source are not included in this output. Its license applies to the tool; the attributed input geometry retains its source license.\n\nSTATUS\nGeometry candidate only. No mechanical, contact, temporal-convergence, real-time or clinical validation is implied.\n"
    )
    return report
