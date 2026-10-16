"""Immutable atlas-derived recipe datasets with measured labels and grouped splits."""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import shutil
from pathlib import Path
from typing import Any, cast

import numpy as np
import numpy.typing as npt
from scipy.stats import qmc

from .atlas import (
    CONTROL_NAMES,
    DEFORMER_VERSION,
    TEMPLATE_VERSION,
    AtlasSample,
    generate,
    list_templates,
    load_template,
)
from .atlas_appearance import APPEARANCE_VERSION
from .dataset import _deterministic_npz, _json_write

DATASET_VERSION = "atlas-recipe-dataset-1.0.0"
CONDITION_NAMES = (
    "extent_x_mm",
    "extent_y_mm",
    "extent_z_mm",
    "surface_area_mm2",
    "volume_ml",
    "compactness",
)
SPLITS = ("train", "val", "audit")


def digest(path: Path) -> str:
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def content_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()


def sub_seed(seed: int, *parts: str) -> int:
    return int(content_hash([seed, *parts])[:8], 16)


def split_assignments(count: int, seed: int) -> list[str]:
    if type(count) is not int or count < 8:
        raise ValueError(
            "At least eight instances per template are needed for three declared splits"
        )
    n_val = max(1, round(count * 0.15))
    n_audit = max(1, round(count * 0.15))
    roles = np.full(count, "train", dtype="<U5")
    order = np.random.default_rng(seed).permutation(count)
    roles[order[:n_val]] = "val"
    roles[order[n_val : n_val + n_audit]] = "audit"
    return roles.tolist()


def surface_points(
    sample: AtlasSample, count: int, seed: int
) -> tuple[npt.NDArray[np.float32], npt.NDArray[np.float32]]:
    v, f = sample.vertices_mm, sample.faces
    tri = v[f]
    cross = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    area2 = np.linalg.norm(cross, axis=1)
    if not np.isfinite(area2).all() or area2.sum() <= 0:
        raise ValueError("Cannot sample a surface without positive finite area")
    rng = np.random.default_rng(seed)
    ids = rng.choice(len(f), size=count, p=area2 / area2.sum())
    uv = rng.random((count, 2))
    s = np.sqrt(uv[:, 0])
    bary = np.stack([1 - s, s * (1 - uv[:, 1]), s * uv[:, 1]], axis=1)
    points = np.einsum("ni,nij->nj", bary, tri[ids])
    normals = cross[ids] / area2[ids, None]
    return points.astype(np.float32), normals.astype(np.float32)


def condition_vector(measurements: dict[str, Any]) -> tuple[list[float], list[bool]]:
    values = [measurements.get(k) for k in CONDITION_NAMES]
    mask = [v is not None and np.isfinite(v) for v in values]
    return [
        float(v) if valid and v is not None else float("nan")
        for v, valid in zip(values, mask, strict=True)
    ], mask


def verify_release(root: str | Path, *, verify_templates: bool = True) -> dict[str, Any]:
    root = Path(root)
    release = json.loads((root / "release.json").read_text())
    if release.get("dataset_version") != DATASET_VERSION:
        raise ValueError("Unsupported atlas dataset version")
    if release.get("release_id") != content_hash(release["recipe"])[:20]:
        raise ValueError("Atlas release identity mismatch")
    required = {
        "train.npz",
        "val.npz",
        "audit.npz",
        "manifest.jsonl",
        "dataset_card.json",
        "split_manifest.json",
        "stress_report.json",
        "language.jsonl",
        "review_queue.json",
        "rejections.jsonl",
    }
    if not required.issubset(release["artifact_hashes"]):
        raise ValueError("Incomplete atlas artifact manifest")
    if release["template_hashes"] != release["recipe"]["template_hashes"]:
        raise ValueError("Template manifest does not match the frozen recipe")
    for name, sha in release["artifact_hashes"].items():
        p = root / name
        if (
            p.is_symlink()
            or not p.resolve().is_relative_to(root.resolve())
            or not p.is_file()
            or digest(p) != sha
        ):
            raise ValueError(f"Atlas artifact integrity failure: {name}")
    if verify_templates:
        troot = root / "templates"
        for name, sha in release["template_hashes"].items():
            p = troot / name
            if (
                p.is_symlink()
                or not p.resolve().is_relative_to(troot.resolve())
                or digest(p) != sha
            ):
                raise ValueError(f"Atlas template integrity failure: {name}")
    return cast(dict[str, Any], release)


def create_dataset(
    template_root: str | Path,
    output: str | Path,
    *,
    count_per_template: int = 64,
    seed: int = 20261006,
    point_count: int = 1024,
) -> dict[str, Any]:
    if type(seed) is not int or not 0 <= seed < 2**32:
        raise ValueError("Dataset seed must be uint32")
    if type(count_per_template) is not int or not 8 <= count_per_template <= 2048:
        raise ValueError("count_per_template must lie in [8,2048]")
    if type(point_count) is not int or not 32 <= point_count <= 8192:
        raise ValueError("point_count must lie in [32,8192]")
    source = Path(template_root)
    out = Path(output)
    catalog = sorted(list_templates(source), key=lambda x: x["template_id"])
    if not catalog:
        raise ValueError("No atlas templates")
    if any(not t.get("cohort_eligible", False) for t in catalog):
        raise ValueError("Templates must pass the source ingestion eligibility checks")
    if any(p.is_symlink() for p in source.rglob("*")):
        raise ValueError("Template release must not contain symlinks")
    template_hashes = {
        f.relative_to(source).as_posix(): digest(f)
        for f in sorted(source.rglob("*"))
        if f.is_file()
    }
    recipe = {
        "dataset_version": DATASET_VERSION,
        "generator_version": DEFORMER_VERSION,
        "template_version": TEMPLATE_VERSION,
        "appearance_version": APPEARANCE_VERSION,
        "template_hashes": template_hashes,
        "generator_source_hashes": {
            name: digest(Path(__file__).parent / name)
            for name in ("atlas.py", "atlas_appearance.py", "atlas_dataset.py")
        },
        "count_per_template": count_per_template,
        "seed": seed,
        "point_count": point_count,
        "sampling_policy": "per-template Latin hypercube [-1,1], roles assigned before realization, fixed seeds",
        "split_track": "within_generator",
        "split_policy": "per-template 70/15/15 parent groups; no derivative view splitting",
        "condition_names": list(CONDITION_NAMES),
        "control_names": list(CONTROL_NAMES),
    }
    if (out / "release.json").exists():
        r = verify_release(out)
        if r["recipe"] != recipe:
            raise ValueError("Existing dataset has a different recipe; choose a new output")
        return r
    if out.exists() and any(out.iterdir()):
        raise ValueError("Output is nonempty/incomplete; choose a fresh release directory")
    out.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, out / "templates")
    release_id = content_hash(recipe)[:20]
    organs = sorted({t["organ"] for t in catalog})
    grouped: dict[str, list[dict[str, Any]]] = {s: [] for s in SPLITS}
    records = []
    rejections = []
    stress = []
    summary = []
    language = []
    for item in catalog:
        tid = item["template_id"]
        template = load_template(out / "templates", tid)
        roles = split_assignments(count_per_template, sub_seed(seed, tid, "split"))
        candidates = (
            qmc.LatinHypercube(d=7, seed=sub_seed(seed, tid, "controls")).random(count_per_template)
            * 2
            - 1
        )
        # Stress is a development fixture, separate from the release audit set.
        endpoints = [np.zeros(7), np.ones(7), -np.ones(7)]
        for axis in range(7):
            for sign in (-1, 1):
                control = np.zeros(7)
                control[axis] = sign
                endpoints.append(control)
        for i, ctrl in enumerate(endpoints):
            sample = generate(template, ctrl, sub_seed(seed, tid, "stress", str(i)))
            stress.append(
                {"template_id": tid, "fixture": i, "controls": ctrl.tolist(), "qa": sample.qa}
            )
        accepted = 0
        mins = []
        maxs = []
        for i, (ctrl, split) in enumerate(zip(candidates, roles, strict=True)):
            sample_seed = sub_seed(seed, tid, "instance", str(i))
            sample = generate(template, ctrl, sample_seed)
            group = content_hash(
                {
                    "template": item["geometry_sha256"],
                    "controls": ctrl.tolist(),
                    "deformer": DEFORMER_VERSION,
                }
            )
            sid = "atlas-" + content_hash([release_id, tid, i])[:20]
            row = {
                "sample_id": sid,
                "group_id": group,
                "template_id": tid,
                "organ": item["organ"],
                "organ_id": organs.index(item["organ"]),
                "source_group_id": item["source_group_id"],
                "split": split,
                "split_track": "within_generator",
                "spec": {
                    "template_id": tid,
                    "seed": sample_seed,
                    "controls": sample.controls,
                    "appearance": "tissue",
                },
                "geometry_sha256": sample.metadata["geometry_sha256"],
                "source_geometry_sha256": item["geometry_sha256"],
                "measurements": sample.measurements,
                "qa": sample.qa,
                "status": "accepted_development_preview" if sample.qa["passed"] else "rejected",
                "source": {
                    "collection": item["source_collection"],
                    "url": item["source_url"],
                    "license": item["license"],
                    "sha256": item["source_sha256"],
                },
            }
            records.append(row)
            if not sample.qa["passed"]:
                rejections.append(row)
                continue
            cond, mask = condition_vector(sample.measurements)
            points, normals = surface_points(
                sample, point_count, sub_seed(sample_seed, "point-sampling")
            )
            grouped[split].append(
                {
                    "controls": ctrl,
                    "conditions": cond,
                    "condition_mask": mask,
                    "points_mm": points,
                    "point_normals": normals,
                    "organ_ids": row["organ_id"],
                    "template_ids": tid,
                    "sample_ids": sid,
                    "group_ids": group,
                    "source_group_ids": row["source_group_id"],
                }
            )
            # Exact numerical captions are grounded in measurements. Render and material
            # descendants always inherit this parent role; no independent language claim.
            text = (
                f"{item['organ'].replace('-', ' ')}; atlas reference {tid}; "
                f"width {cond[0]:.2f} mm, height {cond[1]:.2f} mm, depth {cond[2]:.2f} mm."
            )
            language.append(
                {
                    "sample_id": sid,
                    "group_id": group,
                    "split": split,
                    "text": text,
                    "target_spec": row["spec"],
                    "language_family": "measured-dimensions-template-v1",
                    "claim": "synthetic grounded captions, not independent language evaluation",
                }
            )
            accepted += 1
            mins.append(sample.qa["min_jacobian"])
            maxs.append(sample.qa["edge_ratio_max"])
        if accepted != count_per_template:
            # No silent rejection-conditioned distribution changes.
            print(
                f"{tid}: {accepted}/{count_per_template} accepted; all rejections retained",
                flush=True,
            )
        else:
            print(f"{tid}: {accepted} accepted, minJ={min(mins):.4f}", flush=True)
        summary.append(
            {
                "template_id": tid,
                "organ": item["organ"],
                "attempted": count_per_template,
                "accepted": accepted,
                "min_jacobian": min(mins) if mins else None,
                "max_edge_ratio": max(maxs) if maxs else None,
            }
        )
    for split, rows in grouped.items():
        if not rows:
            raise ValueError(f"No accepted rows in {split}")
        arrays = {k: np.asarray([r[k] for r in rows]) for k in rows[0]}
        arrays.update(
            control_names=np.array(CONTROL_NAMES),
            condition_names=np.array(CONDITION_NAMES),
            organ_names=np.array(organs),
        )
        _deterministic_npz(out / f"{split}.npz", **arrays)
    for name, rows in [
        ("manifest.jsonl", records),
        ("rejections.jsonl", rejections),
        ("language.jsonl", language),
    ]:
        (out / name).write_text(
            "".join(json.dumps(r, sort_keys=True, allow_nan=False) + "\n" for r in rows)
        )
    _json_write(
        out / "stress_report.json",
        {
            "fixtures": stress,
            "passed": sum(s["qa"]["passed"] for s in stress),
            "total": len(stress),
            "role": "development-only stress fixtures; not reserved audit",
        },
    )
    _json_write(
        out / "split_manifest.json",
        {
            "track": "within_generator",
            "roles": {s: len(r) for s, r in grouped.items()},
            "forbidden_overlap": "realized parent group_id and all render/material/text descendants",
            "permitted_overlap": "same source template in all splits, explicitly measures procedural interpolation",
            "independent_reference_evaluation": "unavailable; finite shared atlas ancestries, no claim of unseen-donor performance",
        },
    )
    _json_write(
        out / "dataset_card.json",
        {
            "title": "VISCERA atlas-derived organ design cohort",
            "release_id": release_id,
            "profile": "development_preview",
            "review_status": "unreviewed",
            "source_template_count": len(catalog),
            "organ_groups": organs,
            "source_ancestries": sorted({t["source_group_id"] for t in catalog}),
            "representation": "full-resolution templates + explicit recipe per realized object; sampled points are auxiliary",
            "variation": "bounded, invertible authored morphological design; not measured normal population variation",
            "source_attribution": "See bundled templates/*.json. Source geometry remains CC BY 4.0 with modifications recorded.",
            "condition_gaps": "Volume and compactness masked when display surfaces do not define an organ envelope",
            "physical_validation": "not performed; positive design-map Jacobian is not tissue mechanics validation",
            "appearance": "physically scaled rest-coordinate noise with explicitly heuristic per-organ material profiles",
            "per_template": summary,
        },
    )
    _json_write(
        out / "review_queue.json",
        {
            "release_id": release_id,
            "review_status": "unreviewed",
            "items": [
                {
                    "sample_id": r["sample_id"],
                    "template_id": r["template_id"],
                    "status": "unreviewed",
                }
                for r in records
                if r["status"].startswith("accepted")
            ],
        },
    )
    hashes = {f.name: digest(f) for f in sorted(out.iterdir()) if f.is_file()}
    release = {
        "dataset_version": DATASET_VERSION,
        "release_id": release_id,
        "recipe": recipe,
        "artifact_hashes": hashes,
        "template_hashes": template_hashes,
        "attempted": len(records),
        "accepted": len(records) - len(rejections),
        "rejected": len(rejections),
        "runtime": {"python": platform.python_version(), "numpy": np.__version__},
        "geometry_replay": "exact in the recorded CPU/runtime stack; cross-runtime bitwise identity not guaranteed",
    }
    _json_write(out / "release.json", release)
    return cast(dict[str, Any], release)


def replay_record(root: str | Path, record: dict[str, Any]) -> AtlasSample:
    root = Path(root)
    spec = record["spec"]
    template = load_template(root / "templates", spec["template_id"])
    sample = generate(template, spec["controls"], spec["seed"])
    if sample.metadata["geometry_sha256"] != record["geometry_sha256"]:
        raise ValueError("Replayed geometry does not match realized dataset object")
    return sample


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build")
    build.add_argument("--templates", required=True)
    build.add_argument("--out", required=True)
    build.add_argument("--per-template", type=int, default=64)
    build.add_argument("--seed", type=int, default=20261006)
    build.add_argument("--points", type=int, default=1024)
    verify = sub.add_parser("verify")
    verify.add_argument("--data", required=True)
    args = p.parse_args()
    result = (
        create_dataset(
            args.templates,
            args.out,
            count_per_template=args.per_template,
            seed=args.seed,
            point_count=args.points,
        )
        if args.command == "build"
        else verify_release(args.data)
    )
    print(
        json.dumps(
            {
                k: v
                for k, v in result.items()
                if k not in ("artifact_hashes", "template_hashes", "recipe")
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
