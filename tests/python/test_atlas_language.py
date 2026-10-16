"""Real geometry/grammar fixtures for language lineage and atomic supervision."""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
import trimesh
from viscera_core.atlas import _ingest_one
from viscera_core.atlas_dataset import create_dataset
from viscera_core.atlas_language import create_language, replay_pairs, verify_language


@pytest.fixture
def parent(tmp_path: Path) -> Path:
    templates = tmp_path / "templates"
    templates.mkdir()
    catalog = []
    for sex, radius in (("male", 0.08), ("female", 0.07)):
        scene = trimesh.Scene()
        scene.add_geometry(
            trimesh.creation.icosphere(subdivisions=1, radius=radius), node_name="liver_capsule"
        )
        source = tmp_path / f"{sex}.glb"
        source.write_bytes(scene.export(file_type="glb"))
        metadata = {
            "template_id": f"fixture-liver-{sex}",
            "organ": "liver",
            "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "source_collection": "HRA",
            "sex_label": sex,
            "laterality": None,
            "source_group_id": f"fixture-{sex}",
            "source_url": "https://example.org/fixture",
            "license": "fixture",
            "attribution": "Synthetic test fixture, not clinical anatomy",
            "source_to_authoring_rotation": np.eye(3).tolist(),
        }
        catalog.append(_ingest_one(templates, source, metadata, 1000))
    (templates / "catalog.json").write_text(json.dumps({"templates": catalog}))
    root = tmp_path / "parent"
    create_dataset(templates, root, count_per_template=8, point_count=32)
    return root


def test_language_replays_real_geometry_and_preserves_groups(parent: Path, tmp_path: Path) -> None:
    output = tmp_path / "language"
    release = create_language(parent, output)
    assert release["parent_count"] == 16 and release["pair_count"] == 96
    assert release["status_counts"] == {"accepted": 80, "unsupported": 16}
    assert verify_language(output, parent, replay=True) == release
    assert create_language(parent, output) == release
    pairs = [json.loads(line) for line in (output / "pairs.jsonl").read_text().splitlines()]
    parents = [json.loads(line) for line in (parent / "manifest.jsonl").read_text().splitlines()]
    by_id = {row["sample_id"]: row for row in parents}
    for split in ("train", "val", "audit"):
        split_path = output / f"{split}.jsonl"
        assert split_path.name in release["artifact_hashes"]
        split_rows = [json.loads(line) for line in split_path.read_text().splitlines()]
        assert split_rows == [row for row in pairs if row["split"] == split]
    for pair in pairs:
        assert pair["group_id"] == by_id[pair["parent_sample_id"]]["group_id"]
        assert pair["split"] == by_id[pair["parent_sample_id"]]["split"]
        if pair["expected_status"] == "unsupported":
            assert pair["target_spec"] is None and pair["target_geometry_sha256"] is None
        else:
            assert pair["target_qa"]["finite"] and pair["target_qa"]["min_jacobian"] > 0
    switches = [row for row in pairs if row["category"] == "reference_selector"]
    assert all(row["context_spec"]["template_id"] != row["target_template_id"] for row in switches)
    altered = copy.deepcopy(pairs)
    altered[0]["split"] = "audit" if altered[0]["split"] != "audit" else "train"
    with pytest.raises(ValueError, match="lineage"):
        replay_pairs(parent / "templates", parents, altered)
    altered = copy.deepcopy(pairs)
    altered[0]["target_spec"]["controls"]["bend"] += 0.01
    with pytest.raises(ValueError, match="replay mismatch"):
        replay_pairs(parent / "templates", parents, altered)


def test_language_detects_corpus_and_parent_tampering(parent: Path, tmp_path: Path) -> None:
    output = tmp_path / "language"
    create_language(parent, output)
    pair_path = output / "pairs.jsonl"
    original = pair_path.read_bytes()
    pair_path.write_bytes(original + b"\n")
    with pytest.raises(ValueError, match="integrity"):
        verify_language(output, parent)
    pair_path.write_bytes(original)
    (parent / "manifest.jsonl").write_text("corrupted")
    with pytest.raises(ValueError, match="integrity"):
        verify_language(output, parent)
