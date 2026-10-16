"""Independent synthetic material recipes on frozen atlas surface coordinates.

This release learns an authored appearance design space. It is not a sample of
measured tissue optics, pathology, patients, or population appearance frequency.
"""

from __future__ import annotations

import argparse
import json
import math
import platform
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt

from .atlas import generate, list_templates, load_template
from .atlas_dataset import content_hash, digest, sub_seed, surface_points, verify_release

VERSION = "atlas-material-dataset-1.0.0"
CONTROL_NAMES = (
    "tint",
    "pigment_contrast",
    "mottle_scale_mm",
    "wetness",
    "fine_detail",
    "structure_strength",
)
CONDITION_NAMES = (
    "mean_red_linear",
    "mean_green_linear",
    "mean_blue_linear",
    "luminance_std",
    "roughness_mean",
    "roughness_std",
    "height_rms_mm",
    "gradient_rms",
)
FIELD_NAMES = (
    "red_linear",
    "green_linear",
    "blue_linear",
    "roughness",
    "height_mm",
    "height_dx",
    "height_dy",
    "height_dz",
)
PRESETS = ("balanced", "soft", "rich", "moist")
FloatArray = npt.NDArray[np.float64]


def code_hashes() -> dict[str, str]:
    return {
        name: digest(Path(__file__).parent / name)
        for name in ("atlas_material_dataset.py", "atlas_materials.py")
    }


def recipe_controls(recipe: Any) -> FloatArray:
    values = recipe.model_dump() if hasattr(recipe, "model_dump") else recipe
    output = []
    for name in CONTROL_NAMES:
        value = float(values[name])
        if name == "tint":
            output.append(value)
        elif name == "mottle_scale_mm":
            output.append(2 * math.log(value / 2) / math.log(20) - 1)
        else:
            output.append(2 * value - 1)
    result = np.asarray(output, dtype=np.float64)
    if not np.isfinite(result).all() or (np.abs(result) > 1 + 1e-10).any():
        raise ValueError("Material controls exceed normalized bounds")
    return np.clip(result, -1, 1)


def controls_recipe(organ: str, preset: str, seed: int, controls: Any) -> Any:
    from .atlas_materials import make_recipe

    if type(seed) is not int or not 0 <= seed < 2**32:
        raise ValueError("Material seed must be uint32")

    c = np.asarray(controls, dtype=np.float64)
    if c.shape != (len(CONTROL_NAMES),) or not np.isfinite(c).all() or (np.abs(c) > 1).any():
        raise ValueError("Expected six finite material controls within [-1,1]")
    overrides = {
        name: float(
            c[i]
            if name == "tint"
            else 2 * 20 ** ((c[i] + 1) / 2)
            if name == "mottle_scale_mm"
            else (c[i] + 1) / 2
        )
        for i, name in enumerate(CONTROL_NAMES)
    }
    return make_recipe(organ, preset, int(seed), **overrides)


def field_arrays(sample: Any) -> FloatArray:
    values = np.column_stack(
        (sample.rgb_linear, sample.roughness, sample.height_mm, sample.height_gradient_drest_mm)
    ).astype(np.float64)
    if values.ndim != 2 or values.shape[1] != len(FIELD_NAMES) or not np.isfinite(values).all():
        raise ValueError("Material decoder produced invalid field arrays")
    if ((values[:, :4] < 0) | (values[:, :4] > 1)).any():
        raise ValueError("Linear color/roughness fields exceed [0,1]")
    return values


def field_summary(values: FloatArray) -> FloatArray:
    if (
        values.ndim != 2
        or values.shape[1] != len(FIELD_NAMES)
        or not np.isfinite(values).all()
        or len(values) < 2
    ):
        raise ValueError("Invalid material field summary input")
    luminance = values[:, :3] @ np.array([0.2126, 0.7152, 0.0722])
    centered_height = values[:, 4] - values[:, 4].mean()
    return np.asarray(
        [
            *values[:, :3].mean(axis=0),
            luminance.std(),
            values[:, 3].mean(),
            values[:, 3].std(),
            np.sqrt(np.mean(centered_height**2)),
            np.sqrt(np.mean(np.sum(values[:, 5:8] ** 2, axis=1))),
        ],
        dtype=np.float64,
    )


def evaluate_controls(
    organ: str, preset: str, seed: int, controls: Any, points: Any
) -> tuple[FloatArray, FloatArray]:
    from .atlas_materials import sample_material

    coordinates = np.asarray(points, dtype=np.float64)
    before = coordinates.copy()
    fields = field_arrays(
        sample_material(controls_recipe(organ, preset, seed, controls), coordinates)
    )
    if not np.array_equal(coordinates, before):
        raise ValueError("Appearance decoder mutated frozen geometry coordinates")
    return field_summary(fields), fields


def verify_material_release(
    root: Path, parent: Path | None = None, *, split: str | None = None
) -> dict[str, Any]:
    release = json.loads((root / "release.json").read_text())
    if (
        release.get("version") != VERSION
        or release.get("release_id") != content_hash(release["recipe"])[:20]
    ):
        raise ValueError("Invalid material release identity")
    if release["recipe"]["code_hashes"] != code_hashes():
        raise ValueError("Material generator source drift")
    if parent is not None and release["recipe"]["parent_release_sha256"] != digest(
        parent / "release.json"
    ):
        raise ValueError("Material parent release mismatch")
    names = (f"{split}.npz", "surface_anchors.npz") if split else tuple(release["artifact_hashes"])
    for name in names:
        path = root / name
        if (
            name not in release["artifact_hashes"]
            or path.is_symlink()
            or not path.resolve().is_relative_to(root.resolve())
            or digest(path) != release["artifact_hashes"][name]
        ):
            raise ValueError(f"Material artifact integrity failure: {name}")
    return dict(release)


def read_split(root: Path, split: str) -> dict[str, Any]:
    if split not in {"train", "val", "audit"}:
        raise ValueError("Unknown material split")
    verify_material_release(root, split=split)
    with np.load(root / f"{split}.npz", allow_pickle=False) as archive:
        data = {name: archive[name] for name in archive.files}
    n = len(data["controls"])
    if (
        n < 1
        or data["controls"].shape != (n, len(CONTROL_NAMES))
        or data["conditions"].shape != (n, len(CONDITION_NAMES))
    ):
        raise ValueError("Invalid material matrix shapes")
    if (
        tuple(data["control_names"]) != CONTROL_NAMES
        or tuple(data["condition_names"]) != CONDITION_NAMES
    ):
        raise ValueError("Material feature schema changed")
    if (
        not np.isfinite(data["controls"]).all()
        or (np.abs(data["controls"]) > 1).any()
        or not np.isfinite(data["conditions"]).all()
    ):
        raise ValueError("Material values must be finite and bounded")
    for key in ("sample_ids", "group_ids", "organ_names", "presets", "template_ids", "seeds"):
        if data[key].shape != (n,):
            raise ValueError(f"Invalid material row identities: {key}")
    if len(set(data["sample_ids"])) != n or len(set(data["group_ids"])) != n:
        raise ValueError("Duplicate material recipe groups")
    if not set(data["presets"]).issubset(PRESETS):
        raise ValueError("Unsupported material presets")
    fields = data["field_values"]
    if (
        fields.ndim != 3
        or fields.shape[0] != n
        or fields.shape[1] < 2
        or fields.shape[2] != len(FIELD_NAMES)
        or tuple(data["field_names"]) != FIELD_NAMES
        or not np.isfinite(fields).all()
        or ((fields[:, :, :4] < 0) | (fields[:, :, :4] > 1)).any()
    ):
        raise ValueError("Invalid material field supervision")
    if (
        data["seeds"].dtype.kind not in "iu"
        or (data["seeds"] < 0).any()
        or (data["seeds"] >= 2**32).any()
    ):
        raise ValueError("Material seed array must contain uint32 values")
    return data


def create_material_dataset(
    parent: Path, out: Path, per_group: int = 16, point_count: int = 1024, seed: int = 17017
) -> dict[str, Any]:
    from .atlas_materials import make_recipe

    if per_group < 12 or point_count < 64:
        raise ValueError("At least 12 recipes/group and 64 surface points are required")
    parent_release = verify_release(parent)
    for name, expected in parent_release["recipe"]["generator_source_hashes"].items():
        if digest(Path(__file__).parent / name) != expected:
            raise ValueError("Frozen geometry generator source drift")
    recipe = {
        "version": VERSION,
        "parent_release_sha256": digest(parent / "release.json"),
        "parent_release_id": parent_release["release_id"],
        "code_hashes": code_hashes(),
        "seed": seed,
        "per_organ_preset": per_group,
        "surface_points": point_count,
        "environment": {
            "python": platform.python_version(),
            "numpy": np.__version__,
            "machine": platform.machine(),
        },
        "controls": list(CONTROL_NAMES),
        "conditions": list(CONDITION_NAMES),
        "split_policy": "whole material recipes and every descendant view/patch; shared geometry lineages, not patient-independent",
    }
    if (out / "release.json").exists():
        existing = verify_material_release(out, parent)
        if existing["recipe"] != recipe:
            raise ValueError("Existing material release uses a different recipe")
        return existing
    out.mkdir(parents=True, exist_ok=True)
    catalog = list_templates(parent / "templates")
    organs: dict[str, list[str]] = defaultdict(list)
    points, normals, template_ids, ancestry = [], [], [], {}
    for meta in catalog:
        tid = meta["template_id"]
        organs[meta["organ"]].append(tid)
        template = load_template(parent / "templates", tid)
        before = template.vertices_mm.copy()
        surface = generate(template, np.zeros(7), seed=0)
        p, n = surface_points(surface, point_count, sub_seed(seed, tid, "material-anchors"))
        if not np.array_equal(template.vertices_mm, before):
            raise ValueError("Template mutated while creating appearance anchors")
        template_ids.append(tid)
        points.append(p)
        normals.append(n)
        ancestry[tid] = {
            key: meta[key]
            for key in (
                "organ",
                "source_group_id",
                "geometry_sha256",
                "artifact_sha256",
                "source_url",
                "license",
                "attribution",
            )
        }
    point_map = dict(zip(template_ids, points, strict=True))
    np.savez_compressed(
        out / "surface_anchors.npz",
        template_ids=np.asarray(template_ids),
        points_mm=np.stack(points),
        normals=np.stack(normals),
    )
    records: list[dict[str, Any]] = []
    split_rows: dict[str, list[tuple[dict[str, Any], FloatArray, FloatArray, Any]]] = {
        s: [] for s in ("train", "val", "audit")
    }
    for organ in sorted(organs):
        for preset in PRESETS:
            rng = np.random.default_rng(sub_seed(seed, organ, preset))
            center = recipe_controls(make_recipe(organ, preset, seed))
            order = rng.permutation(per_group)
            train_n, val_n = int(per_group * 0.625), max(2, int(per_group * 0.1875))
            split_lookup = {
                int(i): "train" if j < train_n else "val" if j < train_n + val_n else "audit"
                for j, i in enumerate(order)
            }
            for i in range(per_group):
                # Bounded authored design-space proposals; no empirical prevalence.
                controls = center + rng.normal(0, 0.30, len(CONTROL_NAMES))
                for _ in range(10000):
                    invalid = np.abs(controls) > 1
                    if not invalid.any():
                        break
                    controls[invalid] = center[invalid] + rng.normal(0, 0.30, int(invalid.sum()))
                if (np.abs(controls) > 1).any():
                    raise ValueError("Bounded material design sampling failed")
                appearance_seed = sub_seed(seed, organ, preset, str(i)) % 2**32
                tid = sorted(organs[organ])[i % len(organs[organ])]
                conditions, fields = evaluate_controls(
                    organ, preset, appearance_seed, controls, point_map[tid]
                )
                material_recipe = controls_recipe(
                    organ, preset, appearance_seed, controls
                ).model_dump()
                sid = "material-" + content_hash([recipe, tid, material_recipe])[:24]
                split = split_lookup[i]
                row = {
                    "sample_id": sid,
                    "group_id": sid,
                    "split": split,
                    "organ": organ,
                    "preset": preset,
                    "template_id": tid,
                    "source_group_id": ancestry[tid]["source_group_id"],
                    "geometry_sha256": ancestry[tid]["geometry_sha256"],
                    "material_recipe": material_recipe,
                    "conditions": conditions.tolist(),
                    "geometry_modified": False,
                    "evidence": "authored_synthetic_design_space",
                }
                records.append(row)
                split_rows[split].append((row, controls, conditions, fields.astype(np.float32)))
    for split, rows in split_rows.items():
        np.savez_compressed(
            out / f"{split}.npz",
            controls=np.stack([r[1] for r in rows]),
            conditions=np.stack([r[2] for r in rows]),
            field_values=np.stack([r[3] for r in rows]),
            sample_ids=np.asarray([r[0]["sample_id"] for r in rows]),
            group_ids=np.asarray([r[0]["group_id"] for r in rows]),
            organ_names=np.asarray([r[0]["organ"] for r in rows]),
            presets=np.asarray([r[0]["preset"] for r in rows]),
            template_ids=np.asarray([r[0]["template_id"] for r in rows]),
            seeds=np.asarray([r[0]["material_recipe"]["seed"] for r in rows], dtype=np.uint32),
            control_names=np.asarray(CONTROL_NAMES),
            condition_names=np.asarray(CONDITION_NAMES),
            field_names=np.asarray(FIELD_NAMES),
        )
    (out / "manifest.jsonl").write_text(
        "\n".join(json.dumps(row, sort_keys=True, allow_nan=False) for row in records) + "\n"
    )
    card = {
        "version": VERSION,
        "samples": len(records),
        "organs": len(organs),
        "presets": list(PRESETS),
        "split_counts": {s: len(r) for s, r in split_rows.items()},
        "units": "RGB linear reflectance design values; roughness unitless; height in mm; gradients mm/mm",
        "geometry": "Frozen source display surfaces, unchanged by appearance",
        "source_templates": ancestry,
        "optical_measurement_validation": "NOT_RUN",
        "independent_patient_generalization": "NOT_RUN",
        "tissue_photograph_supervision": "NONE",
        "training_scope": "Authored material control prior and measured procedural-field conditions",
        "lineage": "Every map/patch/render derivative must retain the complete appearance recipe group and split",
    }
    (out / "dataset_card.json").write_text(json.dumps(card, indent=2, sort_keys=True) + "\n")
    files = [
        "surface_anchors.npz",
        "train.npz",
        "val.npz",
        "audit.npz",
        "manifest.jsonl",
        "dataset_card.json",
    ]
    release = {
        "version": VERSION,
        "release_id": content_hash(recipe)[:20],
        "recipe": recipe,
        "artifact_hashes": {name: digest(out / name) for name in files},
    }
    (out / "release.json").write_text(json.dumps(release, indent=2, sort_keys=True) + "\n")
    verify_material_release(out, parent)
    return release


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parent", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--per-group", type=int, default=16)
    parser.add_argument("--points", type=int, default=1024)
    args = parser.parse_args()
    print(
        json.dumps(
            create_material_dataset(args.parent, args.out, args.per_group, args.points), indent=2
        )
    )


if __name__ == "__main__":
    main()
