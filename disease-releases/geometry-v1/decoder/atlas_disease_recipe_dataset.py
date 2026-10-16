"""Split-safe synthetic disease design recipes, separate from clinical cases.

Recipes describe an authored visual design space. Their range is not a clinical
grade, disease prevalence, biomechanical measurement, or patient distribution.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from pathlib import Path
from typing import Any, cast

import numpy as np

FORMAT = "viscera-disease-recipes-v1"
FEATURE_NAMES = [
    "severity",
    "size",
    "spread",
    "irregularity",
    "contrast",
    "count_normalized",
    "location_x_normalized",
    "location_y_normalized",
    "location_z_normalized",
]


def digest(path: Path) -> str:
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w") as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temp.replace(path)


def encode_recipe(recipe: dict[str, Any]) -> np.ndarray:
    values = [float(recipe[k]) for k in FEATURE_NAMES[:5]]
    count = recipe["count"]
    if isinstance(count, bool) or int(count) != count or not 1 <= count <= 8:
        raise ValueError("Recipe count must be an integer in [1,8]")
    location = np.asarray(recipe["location"], dtype=float)
    if location.shape != (3,) or not np.isfinite(location).all() or np.any(abs(location) > 1):
        raise ValueError("Recipe location requires three finite values in [-1,1]")
    values.extend([(int(count) - 1) / 7, *((location + 1) / 2)])
    out = np.asarray(values, dtype=np.float32)
    if not np.isfinite(out).all() or np.any((out < 0) | (out > 1)):
        raise ValueError("Disease recipe controls must lie within [0,1]")
    return cast(np.ndarray, out)


def decode_recipe(profile_id: str, values: np.ndarray, seed: int) -> dict[str, Any]:
    x = np.asarray(values, dtype=float)
    if x.shape != (9,) or not np.isfinite(x).all() or np.any((x < 0) | (x > 1)):
        raise ValueError("Expected nine finite normalized recipe controls")
    if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed < 2**32:
        raise ValueError("Seed must be uint32")
    return {
        "profile_id": profile_id,
        "seed": seed,
        **{key: float(x[i]) for i, key in enumerate(FEATURE_NAMES[:5])},
        "count": int(np.rint(x[5] * 7)) + 1,
        "location": (x[6:] * 2 - 1).tolist(),
    }


def validate_split(data: dict[str, np.ndarray]) -> None:
    required = {
        "features",
        "feature_names",
        "profile_ids",
        "organ_names",
        "sample_ids",
        "group_ids",
        "seeds",
    }
    if not required <= data.keys():
        raise ValueError("Missing disease recipe arrays")
    x = data["features"]
    if x.ndim != 2 or x.shape[1] != 9 or not len(x):
        raise ValueError("Disease recipes require a nonempty N x 9 matrix")
    if not np.isfinite(x).all() or np.any((x < 0) | (x > 1)):
        raise ValueError("Recipe features must be finite within [0,1]")
    if not np.allclose(x[:, 5] * 7, np.rint(x[:, 5] * 7), atol=1e-6):
        raise ValueError("Recipe counts must remain integral")
    if data["feature_names"].tolist() != FEATURE_NAMES:
        raise ValueError("Disease recipe feature schema mismatch")
    for key in ("profile_ids", "organ_names", "sample_ids", "group_ids"):
        a = data[key]
        if a.shape != (len(x),) or a.dtype.kind not in "US" or not all(a):
            raise ValueError(f"Invalid disease recipe {key}")
    if len(set(data["sample_ids"].tolist())) != len(x):
        raise ValueError("Repeated disease recipe sample IDs")
    if data["seeds"].shape != (len(x),) or data["seeds"].dtype.kind not in "ui":
        raise ValueError("Recipe seeds require one unsigned/integer value per row")
    if np.any(data["seeds"] < 0) or np.any(data["seeds"] >= 2**32):
        raise ValueError("Recipe seeds are outside uint32")
    for profile in np.unique(data["profile_ids"]):
        if len(set(data["organ_names"][data["profile_ids"] == profile])) != 1:
            raise ValueError("A disease profile must map to one organ")


def ensure_groups(a: dict[str, np.ndarray], b: dict[str, np.ndarray]) -> None:
    validate_split(a)
    validate_split(b)
    for key in ("sample_ids", "group_ids"):
        if set(a[key].tolist()) & set(b[key].tolist()):
            raise ValueError(f"Disease recipe split leakage: {key}")
    if set(b["profile_ids"].tolist()) - set(a["profile_ids"].tolist()):
        raise ValueError("Holdout contains profiles absent from training")
    for profile in np.unique(b["profile_ids"]):
        if set(a["organ_names"][a["profile_ids"] == profile]) != set(
            b["organ_names"][b["profile_ids"] == profile]
        ):
            raise ValueError("A disease profile changed organ across splits")


def verify_release(root: Path) -> dict[str, Any]:
    root = Path(root)
    release = json.loads((root / "release.json").read_text())
    if release.get("format") != FORMAT:
        raise ValueError("Unsupported disease recipe release")
    for relative, expected in release.get("artifact_hashes", {}).items():
        path = root / relative
        if not path.resolve().is_relative_to(root.resolve()) or digest(path) != expected:
            raise ValueError(f"Disease recipe hash mismatch: {relative}")
    for required in ("train.npz", "val.npz", "audit.npz", "catalog.json"):
        if required not in release.get("artifact_hashes", {}):
            raise ValueError(f"Release is missing integrity coverage: {required}")
    return cast(dict[str, Any], release)


def read_split(root: Path, split: str) -> dict[str, np.ndarray]:
    if split not in ("train", "val", "audit"):
        raise ValueError("Unknown recipe split")
    root = Path(root)
    release = json.loads((root / "release.json").read_text())
    if release.get("format") != FORMAT or release["artifact_hashes"].get(split + ".npz") != digest(
        root / (split + ".npz")
    ):
        raise ValueError("Disease recipe split checksum mismatch")
    with np.load(root / (split + ".npz"), allow_pickle=False) as archive:
        data = {key: archive[key].copy() for key in archive.files}
    validate_split(data)
    return data


def build_release(
    out: Path, *, per_profile: tuple[int, int, int] = (96, 24, 24), seed: int = 7102026
) -> dict[str, Any]:
    """Freeze recipes from the actual editor sampler; no images become 3D labels."""
    from viscera_core import atlas_disease as renderer

    if any(n < 2 for n in per_profile) or len(per_profile) != 3:
        raise ValueError("Each profile needs at least two recipes in each split")
    out = Path(out)
    if (out / "release.json").exists():
        raise ValueError("Refusing to replace an existing recipe release")
    catalog = renderer.disease_catalog()
    profiles = [p for p in catalog["profiles"] if p.get("supported", False)]
    if not profiles:
        raise ValueError("No profiles support disease generation")
    if len({p["id"] for p in profiles}) != len(profiles):
        raise ValueError("Duplicate disease profiles")
    out.mkdir(parents=True, exist_ok=True)
    (out / "provenance").mkdir(exist_ok=True)
    for source, name in (
        (Path(renderer.__file__), "atlas_disease.py"),
        (Path(__file__), "atlas_disease_recipe_dataset.py"),
        (renderer.PROFILE_PATH, "disease_profiles.json"),
    ):
        shutil.copyfile(source, out / "provenance" / name)
    write_json(out / "catalog.json", catalog)
    rng = np.random.default_rng(seed)
    used_seeds: set[int] = set()
    splits: dict[str, dict[str, np.ndarray]] = {}
    for split, rows_per_profile in zip(("train", "val", "audit"), per_profile, strict=True):
        rows, ids, organs, samples, seeds = [], [], [], [], []
        for profile in profiles:
            profile_id = profile["id"]
            for _ in range(rows_per_profile):
                sample_seed = int(rng.integers(0, 2**32, dtype=np.uint64))
                while sample_seed in used_seeds:
                    sample_seed = int(rng.integers(0, 2**32, dtype=np.uint64))
                used_seeds.add(sample_seed)
                spec = renderer.sample_disease(profile_id, sample_seed)
                recipe = spec.model_dump() if hasattr(spec, "model_dump") else dict(spec)
                rows.append(encode_recipe(recipe))
                ids.append(profile_id)
                organs.append(profile["organ"])
                samples.append(f"{profile_id}:{sample_seed:010d}")
                seeds.append(sample_seed)
        data = {
            "features": np.asarray(rows, dtype=np.float32),
            "feature_names": np.asarray(FEATURE_NAMES),
            "profile_ids": np.asarray(ids),
            "organ_names": np.asarray(organs),
            "sample_ids": np.asarray(samples),
            "group_ids": np.asarray(samples),
            "seeds": np.asarray(seeds, dtype=np.uint32),
        }
        validate_split(data)
        np.savez_compressed(out / f"{split}.npz", **data)
        splits[split] = data
    ensure_groups(splits["train"], splits["val"])
    ensure_groups(splits["train"], splits["audit"])
    ensure_groups(splits["val"], splits["audit"])
    release = {
        "format": FORMAT,
        "release_id": out.name,
        "seed": seed,
        "feature_names": FEATURE_NAMES,
        "scope": "synthetic_source_referenced_visual_design_recipes",
        "patient_count": 0,
        "profile_count": len(profiles),
        "reference_only_profile_ids": [
            p["id"] for p in catalog["profiles"] if not p.get("supported", False)
        ],
        "organ_count": len({p["organ"] for p in profiles}),
        "split_counts": {k: len(v["features"]) for k, v in splits.items()},
        "split_unit": "whole_recipe_and_all_derived_views_meshes_augmentations",
        "shared_reference_lineages_across_splits": True,
        "recipe": {
            "per_profile": list(per_profile),
            "source_sha256": digest(Path(renderer.__file__)),
            "dataset_builder_sha256": digest(Path(__file__)),
        },
        "artifact_hashes": {
            name: digest(out / name)
            for name in (
                "train.npz",
                "val.npz",
                "audit.npz",
                "catalog.json",
                "provenance/atlas_disease.py",
                "provenance/atlas_disease_recipe_dataset.py",
                "provenance/disease_profiles.json",
            )
        },
        "limitations": [
            "Visual references are not paired volumetric disease labels.",
            "Recipe holdouts test authored-generator coverage, not unseen patient generalization.",
            "Control strength is not a measured clinical severity grade.",
            "Materials, mechanics, invasion and microscopic pathology are not validated by this release.",
        ],
    }
    write_json(out / "release.json", release)
    return release
