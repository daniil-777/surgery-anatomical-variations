"""Build the licensed reference-liver cutting fixture; no simulation/training."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np

from viscera_core.cutting_mesh import build_section_cap, embed_skin, plane_contours, split_skin, split_tetrahedra
from viscera_core.liver_physics import build_liver_cage

ROOT = Path(__file__).resolve().parents[1]


def build(resolution: int = 4) -> dict:
    source = ROOT / "public-copy/static/api/atlas/specimens/hra-liver-female.json.gz"
    original = source.read_bytes()
    organ = json.loads(gzip.decompress(original))["scene"]["organs"][0]
    points = np.asarray(organ["positions"]).reshape(-1, 3)
    faces = np.asarray(organ["indices"], dtype=np.int64).reshape(-1, 3)
    colors = np.asarray(organ["colors"]).reshape(-1, 3)
    # The reference also contains detached accessory components. Use the largest
    # connected capsule, preserving the original scan boundaries.
    parent = np.arange(len(points))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = int(parent[i])
        return i

    for a, b, c in faces:
        root = find(int(a))
        parent[find(int(b))] = root
        parent[find(int(c))] = root
    roots = np.asarray([find(i) for i in range(len(points))])
    ids, counts = np.unique(roots, return_counts=True)
    selected = np.flatnonzero(roots == ids[np.argmax(counts)])
    remap = np.full(len(points), -1, dtype=np.int64)
    remap[selected] = np.arange(len(selected))
    faces = remap[faces[np.all(remap[faces] >= 0, axis=1)]]
    points, colors = points[selected], colors[selected]
    cage = build_liver_cage(points, faces, resolution=resolution, cut=False)
    low_x, high_x = points[:, 0].min() * .001, points[:, 0].max() * .001
    # The display assembly has a large open hilum boundary. Choose a closed
    # section in an intact lobe; do not silently bridge that anatomical opening.
    candidates = []
    rejected_sections = 0
    for candidate_plane in np.linspace(low_x + .1 * (high_x - low_x), high_x - .1 * (high_x - low_x), 61):
        try:
            contours = plane_contours(points * .001, faces, float(candidate_plane))
            candidate = split_tetrahedra(cage["reference"], cage["tets"], candidate_plane)
        except ValueError:
            rejected_sections += 1
            continue
        vertices = candidate["reference"][candidate["tets"]]
        longest = np.max([np.linalg.norm(vertices[:, a] - vertices[:, b], axis=1)
                          for a in range(4) for b in range(a + 1, 4)], axis=0)
        volumes = np.linalg.det(np.swapaxes(vertices[:, 1:] - vertices[:, :1], 1, 2)) / 6
        quality = float(np.min(6 * volumes / longest ** 3))
        seam_points = candidate["reference"][[pair["left"] for pair in candidate["pairs"]]]
        mechanical_top = seam_points[np.argmax(seam_points[:, 1])]
        section_points = np.vstack(contours)
        source_top = section_points[np.argmax(section_points[:, 0])]
        distances = []
        for contour in contours:
            a, b = contour, np.roll(contour, -1, axis=0)
            ab = b - a
            parameter = np.clip(np.sum((mechanical_top[1:] - a) * ab, axis=1) / np.sum(ab * ab, axis=1), 0, 1)
            distances.extend(np.linalg.norm(a + parameter[:, None] * ab - mechanical_top[1:], axis=1).tolist())
        top_gap = min(distances)
        candidates.append((quality, top_gap, float(candidate_plane), candidate, contours, mechanical_top, source_top))
    if not candidates:
        raise ValueError("No closed source section with a nondegenerate prepared plane found")
    near_surface = [item for item in candidates if item[1] <= .001]
    if not near_surface:
        best_gap = min(item[1] for item in candidates)
        raise ValueError(f"No prepared lobe plane has mechanical contact within 1 mm of the source surface; best {best_gap * 1000:.3f} mm")
    quality, top_gap, plane, mesh, contours, mechanical_top, source_top = max(near_surface, key=lambda entry: entry[0])
    skin = split_skin(points * .001, faces, colors, plane)
    tet_ids, weights = embed_skin(skin["positions"], skin["sides"], mesh, plane)
    reconstructed = np.einsum("ni,nij->nj", weights, mesh["reference"][mesh["tets"][tet_ids]])
    error = float(np.max(np.linalg.norm(reconstructed - skin["positions"], axis=1)) * 1000)
    if error > 1e-6:
        raise ValueError("Cut skin embedding does not reconstruct reference shape")
    cap = build_section_cap(contours, mesh, plane)
    cap_reconstructed = np.einsum("ni,nij->nj", cap["weights"], mesh["reference"][mesh["tets"][cap["tet_ids"]]])
    cap_error = float(np.max(np.linalg.norm(cap_reconstructed - cap["positions"], axis=1)) * 1000)
    if cap_error > 1e-6:
        raise ValueError("Source section cap embedding is not exact")
    ref = mesh["reference"]
    low, high = ref.min(axis=0), ref.max(axis=0)
    fixture = np.flatnonzero(ref[:, 1] < low[1] + .12 * (high[1] - low[1]))
    return dict(
        schema="viscera.cutting-reference/v1",
        source=dict(templateId="hra-liver-female", sha256=hashlib.sha256(original).hexdigest(),
                    attribution="Browne, Kristen (2024), 3D Reference Organ for Liver, Female v1.2. https://doi.org/10.48539/HBM599.GZLD.639",
                    license="CC-BY-4.0"),
        positionsMm=(ref * 1000).ravel().tolist(), tets=mesh["tets"].ravel().tolist(),
        boundaryIndices=mesh["boundary"].ravel().tolist(), seamPairs=mesh["pairs"],
        seamLeftIndices=mesh["seam_left"].tolist(), seamRightIndices=mesh["seam_right"].tolist(),
        skin=dict(positionsMm=(skin["positions"] * 1000).ravel().tolist(),
                  indices=skin["triangles"].ravel().tolist(), colors=skin["colors"].ravel().tolist(),
                  tetIndices=tet_ids.tolist(), weights=weights.ravel().tolist()),
        cap=dict(positionsMm=(cap["positions"] * 1000).ravel().tolist(), indices=cap["triangles"].ravel().tolist(),
                 tetIndices=cap["tet_ids"].tolist(), weights=cap["weights"].ravel().tolist()),
        planeXMm=plane * 1000, floorYMm=float(low[1] * 1000 - 2), fixedNodes=fixture.tolist(),
        diagnostics=dict(originalCageVolumeM3=mesh["original_volume"], splitVolumeM3=mesh["volume"],
                         seamAreaM2=mesh["seam_area"], embeddingErrorMm=error,
                         minimumTetVolumeM3=mesh["minimum_volume"], enclosure=cage["enclosure"],
                         sourceVertexCount=len(points), sourceFaceCount=len(faces),
                         originalCageTets=len(cage["tets"]), resolution=resolution,
                         minimumScaledVolume=quality,
                         capAreaM2=cap["area"], capSourceAreaM2=cap["source_area"], capEmbeddingErrorMm=cap_error,
                         capContourCount=cap["contour_count"], capContourVertices=cap["contour_vertex_count"],
                         mechanicalTopMm=(mechanical_top * 1000).tolist(), sourceSectionTopMm=[plane * 1000, *(source_top * 1000).tolist()],
                         mechanicalTopToSourceBoundaryMm=top_gap * 1000,
                         closedSectionCandidates=len(candidates), rejectedSectionCandidates=rejected_sections,
                         preparedPlaneSelection="maximum minimum 6V/edge³ among closed source lobe sections with top contact within 1 mm, over 61 planes in central 80% extent"),
        limitations=["Prepared lobe incision on one fixed planar cohesive seam, not arbitrary remeshing or cutting.",
                     "The bulk mesh encloses the convex source hull; it does not reproduce concavities or vascular tissue.",
                     "The visible capsule and interior cap follow the actual closed source section; the cap is overlaid with the mechanical seam triangles for exact piecewise-linear embedding.",
                     "The central hilum section is open in the source assembly. No automatic hole fill is used; this experiment selects a closed lobe section instead.",
                     "Bottom fixture attachments are a declared experimental support, not anatomical ligaments.",
                     "Material and cohesive calibration are synthetic demonstrations, not human-liver validation."],
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--resolution", type=int, default=4)
    parser.add_argument("--output", type=Path, default=ROOT / "apps/studio/public/cutting/liver-reference.json")
    args = parser.parse_args()
    result = build(args.resolution)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, separators=(",", ":"), allow_nan=False) + "\n")
    print(json.dumps(dict(nodes=len(result["positionsMm"]) // 3, tets=len(result["tets"]) // 4,
                          pairs=len(result["seamPairs"]), **result["diagnostics"]), indent=2))
