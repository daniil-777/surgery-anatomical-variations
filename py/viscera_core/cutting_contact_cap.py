"""Deterministic contact tessellation compaction within individual affine tets.

No geometry package is installed or required. A 1e-9 mm weld resolves arithmetic
copies of existing vertices; its actual displacement and geometry errors are
reported. Ambiguous topology, holes, or failed equality checks retain the input
triangles. Render cap, mechanical DOFs, and surface validator are not modified.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

from .cutting_mesh import clip_convex_polygon, triangulate_polygon

WELD_MM = 1e-9


def _signed_area(p: np.ndarray) -> float:
    # Local origin avoids cancellation for small fragments at large world coords.
    q = np.asarray(p) - p[0]
    return float(np.sum(q[:, 0] * np.roll(q[:, 1], -1) - q[:, 1] * np.roll(q[:, 0], -1)) / 2)


def planar_moments(triangles: np.ndarray) -> np.ndarray:
    """Integrals [1,y,z,y²,yz,z²] in caller's coordinates."""
    result = np.zeros(6)
    for triangle in triangles:
        a = abs(_signed_area(triangle))
        sums = triangle.sum(axis=0)
        second = (np.outer(sums, sums) + triangle.T @ triangle) * a / 12
        result += [a, a * sums[0] / 3, a * sums[1] / 3, second[0, 0], second[0, 1], second[1, 1]]
    return result


def compact_planar_triangles(
    triangles: np.ndarray, tolerance: float = WELD_MM
) -> tuple[np.ndarray, dict]:
    original = np.asarray(triangles, dtype=float)
    if (
        original.ndim != 3
        or original.shape[1:] != (3, 2)
        or not len(original)
        or not np.isfinite(original).all()
    ):
        raise ValueError("Finite planar triangles required")
    if not np.isfinite(tolerance) or tolerance <= 0:
        raise ValueError("Positive finite topology tolerance required")
    if any(abs(_signed_area(triangle)) == 0 for triangle in original):
        raise ValueError("Nondegenerate reference triangles required")
    origin = original.reshape(-1, 2).mean(axis=0)
    triangles = original - origin
    points = triangles.reshape(-1, 2)
    parent = np.arange(len(points))

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, j in sorted(cKDTree(points).query_pairs(tolerance)):
        a, b = root(i), root(j)
        parent[max(a, b)] = min(a, b)
    representatives = sorted({root(i) for i in range(len(points))})
    remap = {old: new for new, old in enumerate(representatives)}
    indices = np.array([remap[root(i)] for i in range(len(points))]).reshape(-1, 3)
    vertices = points[representatives]
    displacement = np.linalg.norm(points - vertices[indices.reshape(-1)], axis=1)
    report = {
        "inputTriangles": len(triangles),
        "weldToleranceMm": tolerance,
        "maximumWeldDisplacementMm": float(displacement.max()),
        "retainedReason": None,
    }

    def retain(reason):
        return original.copy(), {
            **report,
            "outputTriangles": len(original),
            "retainedReason": reason,
        }

    # Transitive clusters must not exceed the declared tolerance.
    if displacement.max() > tolerance:
        return retain("transitive-weld-exceeds-tolerance")
    directed = Counter()
    for ids in indices:
        if len(set(ids)) != 3:
            return retain("weld-would-collapse-triangle")
        if _signed_area(vertices[ids]) < 0:
            ids = ids[::-1]
        for a, b in zip(ids, np.roll(ids, -1)):
            start, end = vertices[a], vertices[b]
            edge = end - start
            length2 = float(edge @ edge)
            if length2 <= tolerance * tolerance:
                return retain("edge-below-topology-tolerance")
            fraction = (vertices - start) @ edge / length2
            distance = np.linalg.norm(vertices - start - fraction[:, None] * edge, axis=1)
            on_edge = np.flatnonzero(
                (fraction >= -tolerance / np.sqrt(length2))
                & (fraction <= 1 + tolerance / np.sqrt(length2))
                & (distance <= tolerance)
            )
            order = sorted(on_edge, key=lambda i: (float(fraction[i]), int(i)))
            for u, v in zip(order, order[1:]):
                if np.linalg.norm(vertices[u] - vertices[v]) > tolerance:
                    directed[int(u), int(v)] += 1
    boundary = []
    for a, b in sorted(directed):
        net = directed[a, b] - directed[b, a]
        if net > 1:
            return retain("overlapping-or-nonmanifold-edge")
        if net == 1:
            boundary.append((a, b))
    outgoing, incoming = defaultdict(list), defaultdict(list)
    for a, b in boundary:
        outgoing[a].append(b)
        incoming[b].append(a)
    if (
        not boundary
        or set(outgoing) != set(incoming)
        or any(len(outgoing[v]) != 1 or len(incoming[v]) != 1 for v in outgoing)
    ):
        return retain("open-or-branching-union-boundary")
    remaining = set(boundary)
    loops = []
    while remaining:
        first, second = min(remaining)
        loop = [first]
        a, b = first, second
        while True:
            if (a, b) not in remaining:
                return retain("non-simple-boundary-cycle")
            remaining.remove((a, b))
            if b == first:
                break
            loop.append(b)
            a, b = b, outgoing[b][0]
            if len(loop) > len(boundary):
                return retain("unclosed-boundary-cycle")
        polygon = vertices[loop].copy()
        if _signed_area(polygon) <= 0:
            return retain("hole-preserved-with-original-tessellation")
        # Remove only between-neighbour, numerically collinear boundary points.
        changed = True
        while changed and len(polygon) > 3:
            changed = False
            for i in range(len(polygon)):
                before, here, after = polygon[i - 1], polygon[i], polygon[(i + 1) % len(polygon)]
                edge = after - before
                length = np.linalg.norm(edge)
                if length <= tolerance:
                    continue
                t = float((here - before) @ edge / (length * length))
                if 0 <= t <= 1 and np.linalg.norm(here - before - t * edge) <= tolerance:
                    polygon = np.delete(polygon, i, axis=0)
                    changed = True
                    break
        loops.append(polygon)
    try:
        # Existing ear clipping uses metre-scale geometric epsilon; convert only
        # for this call, keeping the output coordinates and checks in mm.
        compact = np.concatenate([triangulate_polygon(loop * 0.001) * 1000 for loop in loops])
    except ValueError as error:
        return retain(f"triangulation-unresolved: {error}")
    if len(compact) >= len(triangles):
        return retain("no-triangle-reduction")
    old_moments, new_moments = planar_moments(triangles), planar_moments(compact)
    span = max(float(np.ptp(points, axis=0).max()), 1)
    normalized_error = abs(new_moments - old_moments) / (
        old_moments[0] * np.array([1, span, span, span**2, span**2, span**2])
    )
    if normalized_error.max() > 1e-9:
        return retain("area-or-moment-equality-unresolved")
    # Exact convex intersections detect accidental hole fills, gaps or overlap.
    intersection = 0.0
    for old in triangles:
        for new in compact:
            if np.any(old.max(0) < new.min(0)) or np.any(new.max(0) < old.min(0)):
                continue
            clipped = clip_convex_polygon(old * 0.001, new * 0.001) * 1000
            if len(clipped) >= 3:
                intersection += abs(_signed_area(clipped))
    symmetric_difference = max(0.0, old_moments[0] + new_moments[0] - 2 * intersection)
    if symmetric_difference > max(1e-10, old_moments[0] * 1e-9):
        return retain("symmetric-difference-unresolved")
    return compact + origin, {
        **report,
        "outputTriangles": len(compact),
        "components": len(loops),
        "maximumNormalizedMomentError": float(normalized_error.max()),
        "symmetricDifferenceAreaMm2": float(symmetric_difference),
        "areaMm2": float(old_moments[0]),
    }


def build_contact_cap(mesh: dict) -> tuple[dict, dict]:
    """Return a separate compact contact surface and deterministic audit receipt.

    The input is never mutated. Every output vertex remains embedded in the same
    tetrahedron as the domain it replaces. Hole/ambiguous groups retain their
    input partition; no convex hull fill or mechanical-node reduction occurs.
    """
    cap = mesh["cap"]
    p = np.array(cap["positionsMm"]).reshape(-1, 3)
    indices = np.array(cap["indices"]).reshape(-1, 3)
    support = np.array(cap["tetIndices"])
    nodes = np.array(mesh["positionsMm"]).reshape(-1, 3)
    tets = np.array(mesh["tets"]).reshape(-1, 4)
    weights_in = np.array(cap["weights"]).reshape(-1, 4)
    if (
        not len(p)
        or not len(indices)
        or not np.isfinite(p).all()
        or not np.isfinite(nodes).all()
        or not np.isfinite(mesh["planeXMm"])
    ):
        raise ValueError("Finite source cap and mechanical reference required")
    for values, limit in [(indices, len(p)), (support, len(tets)), (tets, len(nodes))]:
        if not np.issubdtype(values.dtype, np.integer) or values.min() < 0 or values.max() >= limit:
            raise ValueError("Valid integer embedding indices required")
    if (
        len(support) != len(p)
        or len(weights_in) != len(p)
        or not np.isfinite(weights_in).all()
        or weights_in.min() < -1e-9
        or np.max(abs(weights_in.sum(1) - 1)) > 1e-8
    ):
        raise ValueError("Valid nonnegative affine weights required")
    source_reconstruction = (nodes[tets[support]] * weights_in[:, :, None]).sum(1)
    if (
        np.max(np.linalg.norm(source_reconstruction - p, axis=1)) > 1e-6
        or np.max(abs(p[:, 0] - mesh["planeXMm"])) > 1e-6
    ):
        raise ValueError("Source cap must reconstruct on the declared cut plane")
    groups = defaultdict(list)
    for tri in indices:
        if np.any(support[tri] != support[tri[0]]):
            raise ValueError("Cap triangle is not affine in one tet")
        groups[int(support[tri[0]])].append(p[tri, 1:])
    output_points = []
    output_ids = []
    reports = []
    for tet, triangles in sorted(groups.items()):
        source = np.array(triangles)
        orientation = 1 if _signed_area(source[0]) > 0 else -1
        if any(_signed_area(triangle) * orientation <= 0 for triangle in source):
            raise ValueError("Inconsistent source cap winding")
        compact, report = compact_planar_triangles(source if orientation > 0 else source[:, ::-1])
        report["supportTet"] = tet
        side = -1 if nodes[tets[tet], 0].mean() < mesh["planeXMm"] else 1
        report["side"] = side
        # Existing cap is oppositely wound per side. Contact energy is invariant
        # under winding, but preserve the original outward orientation contract.
        if orientation < 0:
            compact = compact[:, ::-1]
        xyz = np.column_stack(
            (np.full(compact.size // 2, mesh["planeXMm"]), compact.reshape(-1, 2))
        )
        output_points.extend(xyz)
        output_ids.extend([tet] * len(xyz))
        reports.append(report)
    output_points = np.array(output_points)
    output_ids = np.array(output_ids)
    weights = np.zeros((len(output_points), 4))
    for tet in np.unique(output_ids):
        selected = np.flatnonzero(output_ids == tet)
        reference = nodes[tets[tet]]
        bary = np.linalg.solve(
            (reference[1:] - reference[0]).T, (output_points[selected] - reference[0]).T
        ).T
        weights[selected] = np.column_stack((1 - bary.sum(axis=1), bary))
    if weights.min() < -1e-8:
        raise ValueError("Compacted cap escaped its support tet")
    reconstructed = (nodes[tets[output_ids]] * weights[:, :, None]).sum(axis=1)
    output = {
        "positionsMm": output_points.reshape(-1).tolist(),
        "indices": list(range(len(output_points))),
        "tetIndices": output_ids.tolist(),
        "weights": weights.reshape(-1).tolist(),
    }
    diagnostics = {
        "inputTriangles": len(indices),
        "outputTriangles": len(output_points) // 3,
        "supportTetCount": len(groups),
        "triangleReductionPercent": 100 * (1 - len(output_points) / (3 * len(indices))),
        "maximumEmbeddingErrorMm": float(
            np.linalg.norm(reconstructed - output_points, axis=1).max()
        ),
        "maximumWeldDisplacementMm": max(r["maximumWeldDisplacementMm"] for r in reports),
        "maximumNormalizedMomentError": max(
            r.get("maximumNormalizedMomentError", 0) for r in reports
        ),
        "sumSymmetricDifferenceAreaMm2": sum(
            r.get("symmetricDifferenceAreaMm2", 0) for r in reports
        ),
        "retainedReasons": dict(
            Counter(r["retainedReason"] for r in reports if r["retainedReason"])
        ),
        "groups": reports,
    }
    return output, diagnostics


def attach_contact_cap(reference: dict) -> tuple[dict, dict]:
    """Attach optional integration-only tessellation without altering other geometry."""
    cap, diagnostics = build_contact_cap(reference)

    def digest(value: dict) -> str:
        return hashlib.sha256(
            json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
        ).hexdigest()

    report = {
        "schema": "viscera.contact-cap-compaction/v1",
        "scope": "Contact integration only; original render cap and continuous surface validator remain unchanged. Holes and ambiguous groups retain original triangles.",
        "builderSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "sourceCapSha256": digest(reference["cap"]),
        "contactCapSha256": digest(cap),
        **diagnostics,
    }
    result = dict(reference)
    result["contactCap"] = cap
    result["diagnostics"] = {
        **reference.get("diagnostics", {}),
        "contactCapCompaction": {k: v for k, v in report.items() if k != "groups"},
    }
    return result, report
