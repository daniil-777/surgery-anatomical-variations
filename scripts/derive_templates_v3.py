"""Derive an explicitly logged float32 precision repair without changing v1/v2 sources."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
from pathlib import Path

import numpy as np
from viscera_core.atlas import _geometry_hash, load_template


def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def write_json(p, value):
    tmp = p.with_suffix(".new")
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n")
    tmp.replace(p)


def derive(source: Path, output: Path):
    source = source.resolve()
    output = output.resolve()
    if output.exists():
        raise FileExistsError(output)
    catalog = json.loads((source / "catalog.json").read_text())
    tid = "hra-heart-male"
    t = load_template(source, tid)
    v = t.vertices_mm.copy()
    f = t.faces
    face_id = 117638
    corner = 1
    vertex_id = int(f[face_id, corner])
    if (
        t.metadata["artifact_sha256"]
        != "ac3825959ab0398f61610ccfefbdecf55840b4392a856647a993034baba8d774"
    ):
        raise ValueError("Precision repair only applies to the audited immutable male-heart source")
    before = v[vertex_id].copy()
    a = v[f[face_id, (corner + 1) % 3]]
    b = v[f[face_id, (corner + 2) % 3]]
    line = a + ((before - a) @ (b - a) / ((b - a) @ (b - a))) * (b - a)
    away = before - line
    away /= np.linalg.norm(away)
    v[vertex_id] = line + away * 4e-5
    oldtri = t.vertices_mm[f]
    oldcross = np.cross(oldtri[:, 1] - oldtri[:, 0], oldtri[:, 2] - oldtri[:, 0])
    oldnorm = oldcross / np.linalg.norm(oldcross, axis=1)[:, None]
    checks = {}
    for name, q in [
        ("float64_mm", v),
        ("studio_float32_mm", v.astype("f4").astype("f8")),
        ("gltf_float32_m", (v / 1000).astype("f4").astype("f8") * 1000),
    ]:
        tri = q[f]
        cross = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        area = np.linalg.norm(cross, axis=1)
        dots = (cross * oldnorm).sum(1) / area
        checks[name] = {
            "minimum_original_normal_alignment": float(dots.min()),
            "opposed_faces": int((dots <= 0.001).sum()),
            "degenerate_faces": int((area <= 2e-12).sum()),
        }
        if checks[name]["opposed_faces"] or checks[name]["degenerate_faces"]:
            raise ValueError(checks)
    receipt = {
        "policy": "single-source-vertex in-plane sliver altitude increased to40nm; same faces/components, no smoothing or recovered anatomy",
        "release": "atlas-display-precision-1.2.0",
        "template_id": tid,
        "parent_archive_sha256": digest(source / (tid + ".npz")),
        "parent_metadata_sha256": digest(source / (tid + ".json")),
        "parent_release_lock_sha256": digest(source / "release-lock.json"),
        "face_id": face_id,
        "vertex_id": vertex_id,
        "before_mm": before.tolist(),
        "after_mm": v[vertex_id].tolist(),
        "delta_mm": (v[vertex_id] - before).tolist(),
        "delta_norm_mm": float(np.linalg.norm(v[vertex_id] - before)),
        "incident_face_ids": np.flatnonzero(np.any(f == vertex_id, axis=1)).tolist(),
        "checks": checks,
        "limitations": "Numerical float32 conditioning only; not an anatomical correction, collision repair or mechanical validation.",
    }
    shutil.copytree(source, output, copy_function=os.link)
    with np.load(source / (tid + ".npz"), allow_pickle=False) as z:
        arrays = {k: z[k] for k in z.files}
    arrays["parent_vertices_mm"] = arrays["vertices_mm"].copy()
    arrays["vertices_mm"] = v
    tmp = output / (tid + ".new.npz")
    np.savez_compressed(tmp, **arrays)
    tmp.replace(output / (tid + ".npz"))
    meta = dict(t.metadata)
    meta["precision_repair"] = receipt
    meta["derived_release_version"] = receipt["release"]
    meta["parent_precision_archive_sha256"] = receipt["parent_archive_sha256"]
    meta["artifact_sha256"] = digest(output / (tid + ".npz"))
    meta["geometry_sha256"] = _geometry_hash(v, f)
    write_json(output / (tid + ".json"), meta)
    for entry in catalog["templates"]:
        if entry["template_id"] == tid:
            entry.update(
                artifact_sha256=meta["artifact_sha256"],
                geometry_sha256=meta["geometry_sha256"],
                metadata_sha256=digest(output / (tid + ".json")),
                precision_repair=receipt,
                derived_release_version=receipt["release"],
            )
    catalog["derived_release_version"] = receipt["release"]
    catalog["limitations"].append(
        "Male-heart one source vertex moved by a recorded submicron amount for float32 triangle orientation; immutable parent templates-v2 remains unchanged."
    )
    write_json(output / "catalog.json", catalog)
    write_json(output / "precision-repair.json", receipt)
    # Two bladder slivers share one near-coincident source vertex. Condition
    # that vertex only, in the original triangle plane, to32 float32 ULPs.
    bid = "hra-urinary-bladder-male"
    bt = load_template(source, bid)
    if (
        bt.metadata["artifact_sha256"]
        != "4870b9af312358bf033da927c0bce9e30caebb7844f6f6e60283c5cd7e532d24"
    ):
        raise ValueError(
            "Precision repair only applies to the audited immutable male-bladder source"
        )
    bv = bt.vertices_mm.copy()
    bf = bt.faces
    bfi, bvi = 4881, 2634
    corner = bf[bfi].tolist().index(bvi)
    before = bv[bvi].copy()
    a, b = bv[bf[bfi, (corner + 1) % 3]], bv[bf[bfi, (corner + 2) % 3]]
    line = a + ((before - a) @ (b - a) / ((b - a) @ (b - a))) * (b - a)
    away = before - line
    away /= np.linalg.norm(away)
    height = max(4e-5, float(np.spacing(np.abs(bv[bf[bfi]]).astype("f4")).max()) * 32)
    bv[bvi] = line + away * height
    tri = bt.vertices_mm[bf]
    oldcross = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    oldnorm = oldcross / np.linalg.norm(oldcross, axis=1)[:, None]
    bchecks = {}
    for name, q in [
        ("float64_mm", bv),
        ("studio_float32_mm", bv.astype("f4").astype("f8")),
        ("gltf_float32_m", (bv / 1000).astype("f4").astype("f8") * 1000),
    ]:
        tri = q[bf]
        cross = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        area = np.linalg.norm(cross, axis=1)
        dots = (cross * oldnorm).sum(1) / area
        bchecks[name] = {
            "minimum_original_normal_alignment": float(dots.min()),
            "opposed_faces": int((dots <= 0.001).sum()),
            "degenerate_faces": int((area <= 2e-12).sum()),
        }
        if bchecks[name]["opposed_faces"] or bchecks[name]["degenerate_faces"]:
            raise ValueError(bchecks)
    breceipt = {
        "policy": "single-source-vertex in-plane altitude increased to32 float32 coordinate ULPs; same faces/components",
        "release": receipt["release"],
        "template_id": bid,
        "parent_archive_sha256": digest(source / (bid + ".npz")),
        "parent_metadata_sha256": digest(source / (bid + ".json")),
        "parent_release_lock_sha256": receipt["parent_release_lock_sha256"],
        "face_ids": [4881, 4882],
        "vertex_id": bvi,
        "before_mm": before.tolist(),
        "after_mm": bv[bvi].tolist(),
        "delta_mm": (bv[bvi] - before).tolist(),
        "delta_norm_mm": float(np.linalg.norm(bv[bvi] - before)),
        "incident_face_ids": np.flatnonzero(np.any(bf == bvi, axis=1)).tolist(),
        "checks": bchecks,
        "limitations": receipt["limitations"],
    }
    with np.load(source / (bid + ".npz"), allow_pickle=False) as z:
        ba = {k: z[k] for k in z.files}
    ba["parent_vertices_mm"] = ba["vertices_mm"].copy()
    ba["vertices_mm"] = bv
    tmp = output / (bid + ".new.npz")
    np.savez_compressed(tmp, **ba)
    tmp.replace(output / (bid + ".npz"))
    bm = dict(bt.metadata)
    bm.update(
        precision_repair=breceipt,
        derived_release_version=receipt["release"],
        parent_precision_archive_sha256=breceipt["parent_archive_sha256"],
        artifact_sha256=digest(output / (bid + ".npz")),
        geometry_sha256=_geometry_hash(bv, bf),
    )
    write_json(output / (bid + ".json"), bm)
    for entry in catalog["templates"]:
        if entry["template_id"] == bid:
            entry.update(
                artifact_sha256=bm["artifact_sha256"],
                geometry_sha256=bm["geometry_sha256"],
                metadata_sha256=digest(output / (bid + ".json")),
                precision_repair=breceipt,
                derived_release_version=receipt["release"],
            )
    catalog["limitations"].append(
        "Male-bladder one source vertex moved119.3nm to condition two float32-sensitive sliver triangles; exact parent and delta retained."
    )
    write_json(output / "catalog.json", catalog)
    write_json(
        output / "precision-repair.json",
        {
            "release": receipt["release"],
            "repairs": [receipt, breceipt],
            "changed_templates": 2,
            "changed_vertices": 2,
            "unchanged_connectivity": True,
        },
    )
    for entry in catalog["templates"]:
        load_template(output, entry["template_id"])
    lock = {
        "schema_version": "1.0.0",
        "template_version": catalog["template_version"],
        "derived_release_version": receipt["release"],
        "templates": len(catalog["templates"]),
        "parent_release_lock_sha256": receipt["parent_release_lock_sha256"],
        "files": {
            str(p.relative_to(output)): digest(p)
            for p in sorted(output.rglob("*"))
            if p.is_file() and p.name != "release-lock.json"
        },
    }
    write_json(output / "release-lock.json", lock)
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--source", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    derive(a.source, a.out)
