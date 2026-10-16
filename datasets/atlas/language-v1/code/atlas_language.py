"""Reproducible, parent-grouped language supervision for the bounded atlas compiler.

This is synthetic compiler distillation/evaluation data, not evidence that a
learned language model understands anatomy or unseen natural language.
"""

from __future__ import annotations

import argparse
import inspect
import json
import platform
from collections import Counter, defaultdict
from importlib.metadata import version
from pathlib import Path
from typing import Any, cast

import numpy as np

from . import atlas_scene
from .atlas import CONTROL_NAMES, generate, list_templates
from .atlas_dataset import content_hash, digest, verify_release
from .atlas_scene import AtlasSpec, get_template
from .atlas_text import POLICY_VERSION, compile_text

LANGUAGE_VERSION = "atlas-compiler-pairs-1.0.0"
CODE_FILES = ("atlas.py", "atlas_text.py", "atlas_language.py")
FAILURES = (
    ("unsupported_pathology", "add a tumor"),
    ("unsupported_multi_organ", "select liver and kidney"),
    ("unsupported_negation", "make it wider without changing height"),
    ("unsupported_volume", "volume 200 mL"),
    ("conflicting_appearance", "clay and tissue appearance"),
    ("out_of_range_control", "twist 2"),
)


def _write(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + "\n")


def _rows(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def _contract_source() -> str:
    return "\n\n".join(
        inspect.getsource(obj) for obj in (AtlasSpec, atlas_scene._cached_template, get_template)
    )


def _code_hashes() -> dict[str, str]:
    root = Path(__file__).parent
    return {
        **{name: digest(root / name) for name in CODE_FILES},
        "atlas_scene_contract.txt": content_hash(_contract_source()),
    }


def utterances(
    parent: dict[str, Any], catalog: list[dict[str, Any]], index: int
) -> list[tuple[str, str]]:
    """Six distinct tasks; all deterministic and grounded in the parent geometry."""
    controls = parent["spec"]["controls"]
    direction = "narrower" if controls["scale_x"] > 0 else "wider"
    qualifier = ("slightly", "a little")[index % 2]
    axis = ("width", "height", "depth")[index % 3]
    measurement = ("extent_x_mm", "extent_y_mm", "extent_z_mm")[index % 3]
    millimetres = parent["measurements"][measurement]
    dimension = (
        f"{axis} {millimetres:.8f} mm" if index % 2 == 0 else f"{axis} {millimetres / 10:.9f} cm"
    )
    numeric = ", ".join(
        f"{key} {controls[key] * 0.5:.12f}" for key in ("twist", "bend", "asymmetry")
    )
    variants = sorted(
        (item for item in catalog if item["organ"] == parent["organ"]),
        key=lambda item: item["template_id"],
    )
    current = next(
        i for i, item in enumerate(variants) if item["template_id"] == parent["template_id"]
    )
    chosen = variants[(current + 1 + index % max(1, len(variants) - 1)) % len(variants)]
    selector = ["select", chosen["organ"].replace("-", " ")]
    if chosen["sex_label"] in ("male", "female"):
        selector.append(chosen["sex_label"])
    if chosen.get("laterality"):
        selector.append(chosen["laterality"])
    selector.append("reference")
    # Preserve each parent's distinctive controls even after a reference switch.
    # Plain reset/reference-only targets would repeat across different splits.
    selector.append(
        "with " + ", ".join(f"{key} {controls[key] * 0.5:.12f}" for key in CONTROL_NAMES)
    )
    qualitative = ("bent", "twisted", "tapered", "asymmetric")[index % 4]
    return [
        ("relative_width", f"make it {qualifier} {direction}"),
        ("absolute_dimension", dimension),
        ("numeric_shape_controls", numeric),
        ("reference_selector", " ".join(selector)),
        ("relative_shape_control", f"make it less {qualitative}"),
        FAILURES[index % len(FAILURES)],
    ]


def make_pair(
    template_root: Path, parent: dict[str, Any], category: str, text: str
) -> dict[str, Any]:
    context = AtlasSpec.model_validate(parent["spec"])
    before = context.model_dump()
    compiled = compile_text(template_root, text, context)
    if context.model_dump() != before:
        raise ValueError("Compiler mutated the context recipe")
    row: dict[str, Any] = {
        "example_id": "atlas-language-" + content_hash([parent["sample_id"], category, text])[:24],
        "parent_sample_id": parent["sample_id"],
        "parent_geometry_sha256": parent["geometry_sha256"],
        "group_id": parent["group_id"],
        "source_group_id": parent["source_group_id"],
        "split": parent["split"],
        "split_track": parent["split_track"],
        "organ": parent["organ"],
        "category": category,
        "text": text,
        "context_spec": before,
        "expected_status": compiled["status"],
        "compiler_policy_version": compiled["policy_version"],
        "target_spec": None,
        "target_geometry_sha256": None,
        "compiler_message": compiled["message"],
    }
    negative = category in {name for name, _ in FAILURES}
    if negative and compiled["status"] != "unsupported":
        raise ValueError(f"Expected unsupported request was accepted: {text}")
    if compiled["status"] == "accepted":
        target = AtlasSpec.model_validate(compiled["spec"])
        template = get_template(template_root, target.template_id)
        sample = generate(template, target.controls, target.seed)
        if not sample.qa["passed"] or not np.isfinite(sample.vertices_mm).all():
            raise ValueError(f"Accepted text produced a failed geometry: {text}")
        row.update(
            target_spec=target.model_dump(),
            target_geometry_sha256=sample.metadata["geometry_sha256"],
            target_measurements=sample.measurements,
            target_qa={
                key: sample.qa[key]
                for key in (
                    "passed",
                    "scope",
                    "finite",
                    "min_jacobian",
                    "min_normal_dot",
                    "new_degenerate_faces",
                )
            },
            requested_extent_mm=compiled["requested_extent_mm"],
            max_dimension_relative_error=compiled["max_dimension_relative_error"],
            target_template_id=target.template_id,
            target_template_sha256=template.metadata["artifact_sha256"],
            target_source_group_id=template.metadata["source_group_id"],
            target_source_geometry_sha256=template.metadata["geometry_sha256"],
        )
    elif "spec" in compiled:
        raise ValueError("Unsupported compiler result exposed an applied target")
    return row


def replay_pairs(
    template_root: Path, parents: list[dict[str, Any]], pairs: list[dict[str, Any]]
) -> dict[str, Any]:
    by_id = {parent["sample_id"]: parent for parent in parents}
    ids: set[str] = set()
    target_splits: dict[str, set[str]] = defaultdict(set)
    statuses: Counter[str] = Counter()
    minimum_jacobian = 1e100
    for pair in pairs:
        if pair["example_id"] in ids:
            raise ValueError("Duplicate language example identity")
        ids.add(pair["example_id"])
        parent = by_id[pair["parent_sample_id"]]
        for key in ("group_id", "source_group_id", "split", "split_track", "organ"):
            if pair[key] != parent[key]:
                raise ValueError(f"Language pair changed parent lineage: {key}")
        if pair["context_spec"] != AtlasSpec.model_validate(parent["spec"]).model_dump():
            raise ValueError("Language pair changed its context recipe")
        replay = make_pair(template_root, parent, pair["category"], pair["text"])
        if replay != pair:
            raise ValueError(f"Language replay mismatch: {pair['example_id']}")
        statuses[pair["expected_status"]] += 1
        if pair["target_geometry_sha256"] is not None:
            target_splits[pair["target_geometry_sha256"]].add(pair["split"])
            minimum_jacobian = min(minimum_jacobian, pair["target_qa"]["min_jacobian"])
    collisions = sum(len(splits) > 1 for splits in target_splits.values())
    if collisions:
        raise ValueError("Identical language target geometry appears across parent splits")
    return {
        "status": "PASS",
        "pairs_replayed": len(pairs),
        "accepted_full_mesh_replays": statuses["accepted"],
        "unsupported_atomic_replays": statuses["unsupported"],
        "cross_split_identical_target_geometry": collisions,
        "all_parent_splits_preserved": True,
        "minimum_target_jacobian": minimum_jacobian if statuses["accepted"] else None,
        "scope": "Exact local compiler replay and bounded mesh QA; not clinical or learned-language validation",
    }


def verify_language(
    output: str | Path, parent_root: str | Path, *, replay: bool = False
) -> dict[str, Any]:
    out, parent_root = Path(output), Path(parent_root)
    parent = verify_release(parent_root)
    release = json.loads((out / "release.json").read_text())
    if release.get("language_version") != LANGUAGE_VERSION:
        raise ValueError("Unsupported atlas language dataset version")
    if release["release_id"] != content_hash(release["recipe"])[:20]:
        raise ValueError("Language release identity mismatch")
    if release["recipe"]["parent_release_sha256"] != digest(parent_root / "release.json"):
        raise ValueError("Language parent release integrity mismatch")
    if release["recipe"]["parent_release_id"] != parent["release_id"]:
        raise ValueError("Language parent release identity mismatch")
    required = {"pairs.jsonl", "dataset_card.json", "split_manifest.json", "replay_report.json"}
    required.update(f"{split}.jsonl" for split in ("train", "val", "audit"))
    required.update("code/" + name for name in (*CODE_FILES, "atlas_scene_contract.txt"))
    if not required.issubset(release["artifact_hashes"]):
        raise ValueError("Incomplete language artifact manifest")
    for name, sha in release["artifact_hashes"].items():
        path = out / name
        if (
            path.is_symlink()
            or not path.resolve().is_relative_to(out.resolve())
            or not path.is_file()
            or digest(path) != sha
        ):
            raise ValueError(f"Language artifact integrity failure: {name}")
    if replay:
        if release["recipe"]["semantic_code_hashes"] != _code_hashes():
            raise ValueError("Language compiler/generator source drift")
        actual = replay_pairs(
            parent_root / "templates",
            _rows(parent_root / "manifest.jsonl"),
            _rows(out / "pairs.jsonl"),
        )
        if actual != json.loads((out / "replay_report.json").read_text()):
            raise ValueError("Language replay report mismatch")
    return cast(dict[str, Any], release)


def create_language(parent_root: str | Path, output: str | Path) -> dict[str, Any]:
    parent_root, out = Path(parent_root), Path(output)
    parent_release = verify_release(parent_root)
    recipe = {
        "language_version": LANGUAGE_VERSION,
        "parent_release_id": parent_release["release_id"],
        "parent_release_sha256": digest(parent_root / "release.json"),
        "parent_manifest_sha256": digest(parent_root / "manifest.jsonl"),
        "compiler_policy_version": POLICY_VERSION,
        "semantic_code_hashes": _code_hashes(),
        "utterances_per_parent": 6,
        "split_policy": "Inherit exact shape parent group, source group and split; no independent language holdout claim",
        "environment": {
            "python": platform.python_version(),
            **{name: version(name) for name in ("numpy", "scipy", "trimesh", "pydantic")},
        },
    }
    if (out / "release.json").exists():
        existing = verify_language(out, parent_root)
        if existing["recipe"] != recipe:
            raise ValueError("Existing language release has a different recipe")
        return existing
    if out.exists() and any(out.iterdir()):
        raise ValueError("Language output is nonempty/incomplete; choose a fresh directory")
    parents = _rows(parent_root / "manifest.jsonl")
    if len({p["sample_id"] for p in parents}) != len(parents):
        raise ValueError("Parent manifest has duplicate identities")
    out.mkdir(parents=True, exist_ok=True)
    (out / "code").mkdir()
    for name in CODE_FILES:
        (out / "code" / name).write_bytes((Path(__file__).parent / name).read_bytes())
    (out / "code/atlas_scene_contract.txt").write_text(_contract_source())
    catalog = list_templates(parent_root / "templates")
    pairs = []
    for index, parent in enumerate(parents):
        for category, text in utterances(parent, catalog, index):
            pairs.append(make_pair(parent_root / "templates", parent, category, text))
        if (index + 1) % 128 == 0:
            print(f"Compiled {index + 1}/{len(parents)} parents", flush=True)
    (out / "pairs.jsonl").write_text(
        "".join(json.dumps(row, sort_keys=True, allow_nan=False) + "\n" for row in pairs)
    )
    for split in ("train", "val", "audit"):
        (out / f"{split}.jsonl").write_text(
            "".join(
                json.dumps(row, sort_keys=True, allow_nan=False) + "\n"
                for row in pairs
                if row["split"] == split
            )
        )
    print(f"Replaying {len(pairs)} text/context pairs and all accepted meshes", flush=True)
    replay = replay_pairs(parent_root / "templates", parents, pairs)
    _write(out / "replay_report.json", replay)
    splits = {
        split: [row["example_id"] for row in pairs if row["split"] == split]
        for split in ("train", "val", "audit")
    }
    _write(out / "split_manifest.json", {"policy": recipe["split_policy"], "examples": splits})
    card = {
        "language_version": LANGUAGE_VERSION,
        "status": "synthetic_compiler_distillation_development_dataset",
        "parent_release_id": parent_release["release_id"],
        "parent_count": len(parents),
        "pair_count": len(pairs),
        "status_counts": dict(Counter(row["expected_status"] for row in pairs)),
        "category_counts": dict(Counter(row["category"] for row in pairs)),
        "split_counts": {key: len(value) for key, value in splits.items()},
        "content": "Context recipe, text instruction, atomic expected status, exact target recipe and generated geometry hash",
        "geometry_coordinates": "atlas-Y-up-centered-mm; width/height/depth are template X/Y/Z extents, not anatomical population measurements",
        "label_authority": "Current bounded rule compiler plus full-resolution source-derived mesh generator",
        "source_licenses": "Inherit each referenced template's attribution and license from the pinned parent dataset",
        "limitations": [
            "Templates and control maps are shared across train/val/audit; these are within-generator parent splits.",
            "Utterances are deterministic grammar templates, not independent expert or patient language.",
            "No learned text-to-3D model was trained by this builder; no unseen phrasing benchmark is claimed.",
            "Clinical anatomy, material mechanics, pathology and self-intersections are not validated by language replay.",
            "Absolute dimensions denote actual source-derived mesh bounds, not physiological normal ranges.",
            "Unsupported rows contain no target recipe and must not be learned as successful edits.",
        ],
    }
    _write(out / "dataset_card.json", card)
    # Refuse a release assembled across semantic code or parent mutations.
    if recipe["semantic_code_hashes"] != _code_hashes():
        raise ValueError("Semantic source changed while building language release")
    verify_release(parent_root)
    if recipe["parent_release_sha256"] != digest(parent_root / "release.json"):
        raise ValueError("Parent release changed while building language release")
    release = {
        "language_version": LANGUAGE_VERSION,
        "release_id": content_hash(recipe)[:20],
        "recipe": recipe,
        "artifact_hashes": {
            p.relative_to(out).as_posix(): digest(p) for p in sorted(out.rglob("*")) if p.is_file()
        },
        "pair_count": len(pairs),
        "parent_count": len(parents),
        "status_counts": card["status_counts"],
    }
    _write(out / "release.json", release)
    return verify_language(out, parent_root)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parent", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    result = (
        verify_language(args.output, args.parent, replay=True)
        if args.verify
        else create_language(args.parent, args.output)
    )
    print(
        json.dumps(
            {
                key: result[key]
                for key in ("release_id", "pair_count", "parent_count", "status_counts")
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
