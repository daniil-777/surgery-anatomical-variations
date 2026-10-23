"""Conforming, volume-preserving planar subdivision for a cutting fixture.

This changes connectivity only. Both sides receive the same interface triangles;
no elements are deleted and no gap or retraction is introduced. The input cage
remains an enclosing approximation, not a patient-specific liver volume.
"""
from __future__ import annotations

import numpy as np
from scipy.spatial import cKDTree


def _triangles(polygon: list[int]) -> list[list[int]]:
    polygon = list(dict.fromkeys(polygon))
    if len(polygon) < 3:
        return []
    pivot = polygon.index(min(polygon))
    polygon = polygon[pivot:] + polygon[:pivot]
    return [[polygon[0], polygon[i], polygon[i + 1]] for i in range(1, len(polygon) - 1)]


def split_tetrahedra(reference: np.ndarray, tetrahedra: np.ndarray, plane_x: float) -> dict:
    x = np.asarray(reference, dtype=np.float64)
    tets = np.asarray(tetrahedra, dtype=np.int64)
    if x.ndim != 2 or x.shape[1] != 3 or not np.isfinite(x).all() or not np.isfinite(plane_x):
        raise ValueError("Finite xyz reference geometry and plane required")
    if tets.ndim != 2 or tets.shape[1] != 4 or np.any(tets < 0) or np.any(tets >= len(x)):
        raise ValueError("Invalid tetrahedra")
    original_volumes = np.linalg.det(np.swapaxes(x[tets[:, 1:]] - x[tets[:, :1]], 1, 2)) / 6
    if np.any(original_volumes <= 0):
        raise ValueError("Positive original tetrahedra required")
    if np.any(np.abs(x[:, 0] - plane_x) < 1e-10):
        raise ValueError("Choose a plane separated from existing nodes by at least 0.1 nm")
    # Shared geometric vertices are identified before creating side-specific IDs.
    vertices = x.tolist()
    intersections: dict[tuple[int, int], int] = {}
    seam_ids: set[int] = set()

    def intersection(a: int, b: int) -> int:
        key = tuple(sorted((a, b)))
        if key not in intersections:
            ratio = (plane_x - x[a, 0]) / (x[b, 0] - x[a, 0])
            p = x[a] + ratio * (x[b] - x[a])
            p[0] = plane_x
            intersections[key] = len(vertices)
            seam_ids.add(len(vertices))
            vertices.append(p.tolist())
        return intersections[key]

    def clip(face: list[int], side: int) -> list[int]:
        polygon: list[int] = []
        for a, b in zip(face, face[1:] + face[:1], strict=True):
            inside_a = side * (x[a, 0] - plane_x) > 0
            inside_b = side * (x[b, 0] - plane_x) > 0
            if inside_a:
                polygon.append(a)
            if inside_a != inside_b:
                polygon.append(intersection(a, b))
        return polygon

    points: list[list[float]] = []
    ids: dict[tuple[int, int], int] = {}
    result: list[list[int]] = []
    parent: list[int] = []
    seam_faces: list[list[int]] = []

    def node(geometric: int, side: int) -> int:
        key = (geometric, side if geometric in seam_ids else 0)
        if key not in ids:
            ids[key] = len(points)
            points.append(vertices[geometric])
        return ids[key]

    for parent_id, tet in enumerate(tets.tolist()):
        signs = x[tet, 0] - plane_x
        if np.all(signs > 0) or np.all(signs < 0):
            result.append([node(i, 1 if signs[0] > 0 else -1) for i in tet])
            parent.append(parent_id)
            continue
        cut = [intersection(tet[a], tet[b]) for a in range(4) for b in range(a + 1, 4)
               if signs[a] * signs[b] < 0]
        center = np.mean([vertices[i] for i in cut], axis=0)
        cut.sort(key=lambda i: np.arctan2(vertices[i][2] - center[2], vertices[i][1] - center[1]))
        seam_faces.extend(_triangles(cut))
        faces = [[tet[i] for i in face] for face in ((1, 2, 3), (0, 3, 2), (0, 1, 3), (0, 2, 1))]
        for side in (-1, 1):
            polygons = [clip(face, side) for face in faces] + [cut]
            used = sorted({i for polygon in polygons for i in polygon})
            c = np.mean([vertices[i] for i in used], axis=0)
            center_id = len(points)
            points.append(c.tolist())
            for polygon in polygons:
                for triangle in _triangles(polygon):
                    cell = [center_id] + [node(i, side) for i in triangle]
                    p = np.asarray([points[i] for i in cell])
                    det = float(np.linalg.det((p[1:] - p[0]).T))
                    if abs(det) < 1e-19:
                        raise ValueError("Cut creates an unresolved sliver; choose a different plane")
                    if det < 0:
                        cell[2], cell[3] = cell[3], cell[2]
                    result.append(cell)
                    parent.append(parent_id)
    p = np.asarray(points)
    cells = np.asarray(result, dtype=np.int64)
    volumes = np.linalg.det(np.swapaxes(p[cells[:, 1:]] - p[cells[:, :1]], 1, 2)) / 6
    area: dict[int, float] = {i: 0.0 for i in seam_ids}
    left, right = [], []
    for triangle in seam_faces:
        positions = np.asarray([vertices[i] for i in triangle])
        normal = np.cross(positions[1] - positions[0], positions[2] - positions[0])
        if normal[0] < 0:
            triangle = triangle[::-1]
        a = float(np.linalg.norm(normal)) / 2
        for i in triangle:
            area[i] += a / 3
        left.extend(node(i, -1) for i in triangle)
        right.extend(node(i, 1) for i in triangle[::-1])
    all_faces = cells[:, [[1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]]].reshape(-1, 3)
    _, inverse, counts = np.unique(np.sort(all_faces, axis=1), axis=0, return_inverse=True, return_counts=True)
    if np.any(counts > 2):
        raise ValueError("Non-manifold tetrahedral adjacency")
    boundary = all_faces[counts[inverse] == 1]
    if abs(volumes.sum() - original_volumes.sum()) > original_volumes.sum() * 2e-12:
        raise ValueError("Cut subdivision changed physical volume")
    return dict(reference=p, tets=cells, parent=np.asarray(parent), boundary=boundary,
                seam_left=np.asarray(left), seam_right=np.asarray(right),
                pairs=[dict(left=node(i, -1), right=node(i, 1), areaM2=area[i]) for i in sorted(seam_ids)],
                volume=float(volumes.sum()), original_volume=float(original_volumes.sum()),
                minimum_volume=float(volumes.min()), seam_area=sum(area.values()))


def split_skin(positions: np.ndarray, triangles: np.ndarray, colors: np.ndarray, plane_x: float) -> dict:
    """Split every intersected source face; keep duplicated interface vertices."""
    source = np.asarray(positions)
    palette = np.asarray(colors)
    p, c, f, side_ids = [], [], [], []
    lookup = {}

    def store(key: tuple, position: np.ndarray, color: np.ndarray, side: int) -> int:
        signed = (*key, side)
        if signed not in lookup:
            lookup[signed] = len(p)
            p.append(position.tolist()); c.append(color.tolist()); side_ids.append(side)
        return lookup[signed]

    for triangle in triangles.tolist():
        for side in (-1, 1):
            polygon = []
            for a, b in zip(triangle, triangle[1:] + triangle[:1], strict=True):
                da, db = side * (source[a, 0] - plane_x), side * (source[b, 0] - plane_x)
                if da >= 0:
                    polygon.append(store((a,), source[a], palette[a], side))
                if (da < 0 < db) or (db < 0 < da):
                    t = da / (da - db)
                    position = source[a] + t * (source[b] - source[a]); position[0] = plane_x
                    polygon.append(store(tuple(sorted((a, b))), position, palette[a] + t * (palette[b] - palette[a]), side))
            f.extend(_triangles(polygon))
    return dict(positions=np.asarray(p), colors=np.asarray(c), triangles=np.asarray(f, dtype=np.int64), sides=np.asarray(side_ids))


def embed_skin(points: np.ndarray, sides: np.ndarray, mesh: dict, plane_x: float) -> tuple[np.ndarray, np.ndarray]:
    """Locate containing split tets; nearest centres only accelerate candidates."""
    cells = mesh["reference"][mesh["tets"]]
    centers = cells.mean(axis=1)
    inverse = np.linalg.inv(np.swapaxes(cells[:, 1:] - cells[:, :1], 1, 2))
    found = np.empty(len(points), dtype=np.int64)
    weights = np.empty((len(points), 4))
    for side in (-1, 1):
        candidates = np.flatnonzero(side * (centers[:, 0] - plane_x) > 0)
        tree = cKDTree(centers[candidates])
        selection = np.flatnonzero(sides == side)
        _, near = tree.query(points[selection], k=min(48, len(candidates)))
        for local, point_id in enumerate(selection):
            ids = candidates[np.atleast_1d(near[local])]
            for attempt in range(2):
                w3 = np.einsum("nij,nj->ni", inverse[ids], points[point_id] - cells[ids, 0])
                w = np.column_stack((1 - w3.sum(axis=1), w3))
                valid = np.flatnonzero(w.min(axis=1) >= -1e-7)
                if len(valid):
                    best = valid[np.argmax(w[valid].min(axis=1))]
                    found[point_id], weights[point_id] = ids[best], w[best]
                    break
                ids = candidates
            else:
                raise ValueError("Source skin outside its declared cut half")
    return found, weights


def plane_contours(positions: np.ndarray, triangles: np.ndarray, plane_x: float) -> list[np.ndarray]:
    """Exact triangle/plane loops in yz; reject open or branching source sections.

    No chord, convex hull or guessed hole fill repairs an open display assembly.
    The prepared plane must avoid source vertices so the edge graph is unique.
    """
    p = np.asarray(positions, float)
    faces = np.asarray(triangles, np.int64)
    if np.min(abs(p[:, 0] - plane_x)) < 1e-12:
        raise ValueError("Section plane intersects a source vertex")
    edge_points: dict[tuple[int, int], np.ndarray] = {}
    graph: dict[tuple[int, int], list[tuple[int, int]]] = {}
    crossed = (p[faces, 0].min(1) < plane_x) & (p[faces, 0].max(1) > plane_x)
    for face in faces[crossed]:
        keys = []
        for a, b in zip(face, np.roll(face, -1), strict=True):
            if (p[a, 0] - plane_x) * (p[b, 0] - plane_x) < 0:
                key = tuple(sorted((int(a), int(b))))
                edge_points[key] = p[a, 1:] + (plane_x - p[a, 0]) / (p[b, 0] - p[a, 0]) * (p[b, 1:] - p[a, 1:])
                keys.append(key)
        if len(keys) != 2:
            raise ValueError("Ambiguous source section intersection")
        a, b = keys
        graph.setdefault(a, []).append(b); graph.setdefault(b, []).append(a)
    if not graph or any(len(neighbors) != 2 for neighbors in graph.values()):
        raise ValueError("Source section is open or branching; no automatic hole fill")
    seen: set[tuple[int, int]] = set()
    loops = []
    for start in graph:
        if start in seen:
            continue
        previous = None; current = start; ids = []
        while current not in seen:
            seen.add(current); ids.append(current)
            following = [node for node in graph[current] if node != previous]
            previous, current = current, following[0]
        if current != start or len(ids) < 3:
            raise ValueError("Invalid source section loop")
        loop = np.asarray([edge_points[key] for key in ids])
        if signed_polygon_area(loop) < 0:
            loop = loop[::-1]
        loops.append(loop)
    # Nested loops require a multiply-connected domain triangulator. Do not fill
    # a lumen or a cavity merely because this prototype handles simple caps.
    if any(point_in_polygon(loop[0], other) for i, loop in enumerate(loops) for j, other in enumerate(loops) if i != j):
        raise ValueError("Nested source contours require explicit hole triangulation")
    return loops


def signed_polygon_area(p: np.ndarray) -> float:
    p = np.asarray(p, float)
    return float(np.sum(p[:, 0] * np.roll(p[:, 1], -1) - p[:, 1] * np.roll(p[:, 0], -1)) / 2)


def point_in_polygon(point: np.ndarray, polygon: np.ndarray) -> bool:
    x, y = point
    inside = False
    for a, b in zip(polygon, np.roll(polygon, -1, axis=0), strict=True):
        if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
            inside = not inside
    return inside


def triangulate_polygon(polygon: np.ndarray) -> np.ndarray:
    """Ear-clip a simple nonconvex counterclockwise polygon without a hull fill."""
    p = np.asarray(polygon, float)
    if len(p) < 3 or not np.isfinite(p).all() or signed_polygon_area(p) <= 0:
        raise ValueError("Positive oriented simple section polygon required")
    cross = lambda a, b: a[0] * b[1] - a[1] * b[0]
    remaining = list(range(len(p))); triangles = []
    while len(remaining) > 3:
        for k, i in enumerate(remaining):
            a, c = remaining[k - 1], remaining[(k + 1) % len(remaining)]
            if cross(p[i] - p[a], p[c] - p[i]) <= 1e-17:
                continue
            others = np.asarray([j for j in remaining if j not in (a, i, c)])
            q = p[others]
            aa, bb, cc = p[a], p[i], p[c]
            def edge(u, v): return (v[0] - u[0]) * (q[:, 1] - u[1]) - (v[1] - u[1]) * (q[:, 0] - u[0])
            if np.any((edge(aa, bb) >= -1e-17) & (edge(bb, cc) >= -1e-17) & (edge(cc, aa) >= -1e-17)):
                continue
            triangles.append([a, i, c]); remaining.pop(k); break
        else:
            raise ValueError("Section polygon is self-intersecting or numerically unresolved")
    triangles.append(remaining)
    # Improve interior diagonals without changing any boundary edge. A fan of
    # long ears is valid but intersects thousands of mechanical facets; local
    # constrained-Delaunay flips produce a compact overlay for contact/rendering.
    for _ in range(4 * len(p) ** 2):
        adjacency: dict[tuple[int, int], list[tuple[int, int]]] = {}
        for index, tri in enumerate(triangles):
            for j in range(3):
                a, b, c = tri[j], tri[(j + 1) % 3], tri[(j + 2) % 3]
                adjacency.setdefault(tuple(sorted((a, b))), []).append((index, c))
        for (a, b), owners in adjacency.items():
            if len(owners) != 2:
                continue
            (first, c), (second, d) = owners
            if cross(p[d] - p[c], p[a] - p[c]) * cross(p[d] - p[c], p[b] - p[c]) >= 0:
                continue  # Concave quadrilateral: the alternative is outside.
            if cross(p[b] - p[a], p[c] - p[a]) < 0:
                a, b = b, a
            aa, bb, cc = p[a] - p[d], p[b] - p[d], p[c] - p[d]
            determinant = np.dot(aa, aa) * cross(bb, cc) - np.dot(bb, bb) * cross(aa, cc) + np.dot(cc, cc) * cross(aa, bb)
            scale = max(np.dot(aa, aa), np.dot(bb, bb), np.dot(cc, cc)) ** 2
            if determinant <= max(1e-30, 1e-12 * scale):
                continue
            replacements = [[c, d, b], [d, c, a]]
            for tri in replacements:
                if cross(p[tri[1]] - p[tri[0]], p[tri[2]] - p[tri[0]]) < 0:
                    tri[1], tri[2] = tri[2], tri[1]
            triangles[first], triangles[second] = replacements
            break
        else:
            break
    else:
        raise ValueError("Section diagonal improvement did not converge")
    result = p[np.asarray(triangles)]
    if abs(sum(signed_polygon_area(tri) for tri in result) - signed_polygon_area(p)) > signed_polygon_area(p) * 1e-10:
        raise ValueError("Section triangulation changed physical area")
    return result


def clip_convex_polygon(subject: np.ndarray, clip_triangle: np.ndarray) -> np.ndarray:
    """Intersection with a CCW triangle; all coordinates are metres in yz."""
    result = [np.asarray(point, float) for point in subject]
    triangle = np.asarray(clip_triangle, float)
    if signed_polygon_area(triangle) < 0:
        triangle = triangle[::-1]
    for a, b in zip(triangle, np.roll(triangle, -1, axis=0), strict=True):
        old = result; result = []
        if not old:
            break
        distance = lambda q: (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0])
        for p, q in zip(old, old[1:] + old[:1], strict=True):
            dp, dq = distance(p), distance(q)
            if dp >= -1e-18:
                result.append(p)
            if (dp < 0 < dq) or (dq < 0 < dp):
                result.append(p + dp / (dp - dq) * (q - p))
    return np.asarray(result).reshape(-1, 2)


def build_section_cap(contours: list[np.ndarray], mesh: dict, plane_x: float) -> dict:
    """Visible source section overlaid with the mechanical seam triangulation.

    Every cap triangle lies within one mechanical facet, so its embedding is
    exactly piecewise linear rather than spanning several bending tetrahedra.
    Left side is +x outward; right side is -x outward. Area is counted once.
    """
    seam = mesh["reference"][mesh["seam_left"].reshape(-1, 3)][:, :, 1:]
    low, high = seam.min(1), seam.max(1)
    triangles = []
    supports = []
    source_area = sum(signed_polygon_area(loop) for loop in contours)
    for loop in contours:
        for triangle in triangulate_polygon(loop):
            candidates = np.flatnonzero(np.all(high >= triangle.min(0) - 1e-12, axis=1) & np.all(low <= triangle.max(0) + 1e-12, axis=1))
            for index in candidates:
                clipped = clip_convex_polygon(triangle, seam[index])
                for i in range(1, len(clipped) - 1):
                    cell = clipped[[0, i, i + 1]]
                    if signed_polygon_area(cell) > 1e-18:
                        triangles.append(cell)
                        supports.append(int(index))
    triangles = np.asarray(triangles)
    area = sum(signed_polygon_area(tri) for tri in triangles)
    if not len(triangles) or abs(area - source_area) > source_area * 1e-8:
        raise ValueError("Mechanical seam does not cover the complete source section")
    yz = triangles.reshape(-1, 2)
    one_side = np.column_stack((np.full(len(yz), plane_x), yz))
    points = np.vstack((one_side, one_side))
    # Bind all three cap corners to the same boundary tetrahedron. Vertices on
    # shared facet edges admit multiple valid embeddings, but recording one
    # common support makes exact barycentric contact quadrature explicit.
    tet_faces: dict[tuple[int, int, int], list[int]] = {}
    for tet_id, tet in enumerate(mesh["tets"]):
        for face in ((1, 2, 3), (0, 3, 2), (0, 1, 3), (0, 2, 1)):
            key = tuple(sorted(int(tet[j]) for j in face))
            tet_faces.setdefault(key, []).append(tet_id)
    ids = []
    for side_faces in (mesh["seam_left"].reshape(-1, 3), mesh["seam_right"].reshape(-1, 3)):
        for support in supports:
            adjacent = tet_faces[tuple(sorted(int(i) for i in side_faces[support]))]
            if len(adjacent) != 1:
                raise ValueError("Cap support is not a one-sided mechanical boundary")
            ids.extend([adjacent[0]] * 3)
    ids = np.asarray(ids, dtype=np.int64)
    cells = mesh["reference"][mesh["tets"][ids]]
    inverse = np.linalg.inv(np.swapaxes(cells[:, 1:] - cells[:, :1], 1, 2))
    w3 = np.einsum("nij,nj->ni", inverse, points - cells[:, 0])
    weights = np.column_stack((1 - w3.sum(1), w3))
    if weights.min() < -1e-7 or weights.max() > 1 + 1e-7:
        raise ValueError("Cap triangle lies outside its declared supporting tetrahedron")
    left = np.arange(len(yz)).reshape(-1, 3)
    right = (left + len(yz))[:, ::-1]
    return dict(positions=points, triangles=np.vstack((left, right)), tet_ids=ids, weights=weights,
                area=area, source_area=source_area, contour_count=len(contours), contour_vertex_count=sum(map(len, contours)))
