"""Actual surface labels must replay, preserve parent splits and keep metric units."""

from __future__ import annotations

import hashlib
import json
from types import SimpleNamespace

import numpy as np
import pytest
import trimesh
from viscera_core import atlas_disease_geometry_dataset as geometry
from viscera_core import atlas_disease_recipe_dataset as recipes
from viscera_core.atlas import _ingest_one
from viscera_core.dataset import _deterministic_npz


def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


@pytest.fixture(scope="module")
def sources(tmp_path_factory):
    base = tmp_path_factory.mktemp("geometry-inputs")
    library = base / "templates"
    library.mkdir()
    entries = []
    for i, sex in enumerate(("female", "male")):
        scene = trimesh.Scene()
        scene.add_geometry(
            trimesh.creation.icosphere(subdivisions=1, radius=0.075 + i * 0.01),
            node_name="liver_capsule",
        )
        glb = base / f"{sex}.glb"
        glb.write_bytes(scene.export(file_type="glb"))
        metadata = {
            "template_id": f"fixture-liver-{sex}",
            "organ": "liver",
            "source_sha256": hashlib.sha256(glb.read_bytes()).hexdigest(),
            "source_collection": "Authored fixture",
            "sex_label": sex,
            "laterality": None,
            "source_group_id": f"authored-fixture-{sex}",
            "source_url": "https://example.org/fixture",
            "license": "CC-BY-4.0",
            "attribution": "Original test fixture, not clinical anatomy",
            "source_to_authoring_rotation": np.eye(3).tolist(),
        }
        entry = _ingest_one(library, glb, metadata, 1000)
        entry["attribution"] = metadata["attribution"]
        entries.append(entry)
    dump(library / "catalog.json", {"templates": entries})
    (library / "attribution").mkdir()
    (library / "attribution" / "license.txt").write_text("Authored test geometry CC BY 4.0")
    parent = base / "recipes"
    recipes.build_release(parent, per_profile=(4, 2, 2), seed=271)
    return parent, library


@pytest.fixture()
def release(sources, tmp_path):
    parent, library = sources
    out = tmp_path / "cohort"
    geometry.build_release(
        parent, library, out, per_profile=(2, 1, 1), point_count=64, profile_ids=["liver-cirrhosis"]
    )
    return out


def test_materialized_surface_replays_full_resolution_and_point_correspondence(release):
    r = geometry.verify_release(release)
    assert r["sample_count"] == 4 and r["patient_count"] == 0
    assert r["split_track"] == "within_generator" and r["shared_reference_lineages_across_splits"]
    assert r["split_counts"] == {"train": 2, "val": 1, "audit": 1}
    selected_templates = set()
    for split in geometry.SPLITS:
        data = geometry.read_split(release, split)
        assert data["features"].shape == (len(data["sample_ids"]), 6)
        assert data["recipe_features"].shape == (len(data["sample_ids"]), 9)
        for i, sample in enumerate(data["sample_ids"]):
            result = geometry.replay_record(release, str(sample))
            item = result["scene"]["organs"][0]
            vertices = np.asarray(item["positions"]).reshape(-1, 3)
            faces = np.asarray(item["indices"]).reshape(-1, 3)
            expected = np.einsum(
                "ni,nij->nj",
                data["barycentric_coordinates"][i],
                vertices[faces[data["surface_face_ids"][i]]],
            )
            np.testing.assert_allclose(expected, data["points_mm"][i], atol=5e-6)
            np.testing.assert_allclose(
                data["features"][i, :3], np.ptp(vertices, axis=0), rtol=0, atol=1e-12
            )
            assert result["summary"]["disease"]["max_displacement_mm"] > 0
            selected_templates.add(result["spec"]["template_id"])
    assert selected_templates == {"fixture-liver-female", "fixture-liver-male"}
    assert "templates/attribution/license.txt" in r["artifact_hashes"]


def test_points_colors_use_same_linear_interpolation_as_editor():
    p = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
    f = np.array([[0, 1, 2]])
    item = {
        "positions": p.ravel().tolist(),
        "indices": f.ravel().tolist(),
        "normals": [0.0, 0.0, 1.0] * 3,
        "colors": np.eye(3).ravel().tolist(),
        "metadata": {"disease_field": {"fields": []}},
    }
    data = geometry._samples(
        {"scene": {"organs": [item]}}, SimpleNamespace(vertices_mm=p, faces=f), 64, 7
    )
    linear = data["barycentric_coordinates"]
    expected = np.where(linear <= 0.0031308, linear * 12.92, 1.055 * linear ** (1 / 2.4) - 0.055)
    np.testing.assert_allclose(data["colors_srgb"], expected, atol=1e-7)
    assert not np.allclose(data["colors_srgb"], linear)


def test_release_is_deterministic_and_does_not_replace_a_frozen_cohort(release, sources, tmp_path):
    parent, library = sources
    original = geometry.verify_release(release)
    again = geometry.build_release(
        parent,
        library,
        tmp_path / "again",
        per_profile=(2, 1, 1),
        point_count=64,
        profile_ids=["liver-cirrhosis"],
    )
    assert original == again
    assert (
        geometry.build_release(
            parent,
            library,
            release,
            per_profile=(2, 1, 1),
            point_count=64,
            profile_ids=["liver-cirrhosis"],
        )
        == original
    )
    with pytest.raises(ValueError, match="Frozen geometry cohort differs"):
        geometry.build_release(
            parent,
            library,
            release,
            per_profile=(2, 1, 1),
            point_count=128,
            profile_ids=["liver-cirrhosis"],
        )


def test_geometry_hash_tampering_and_replay_decoder_drift_fail(release, monkeypatch):
    original = geometry.decoder_hashes()
    monkeypatch.setattr(
        geometry, "decoder_hashes", lambda: {**original, "atlas_disease.py": "0" * 64}
    )
    with pytest.raises(ValueError, match="Active disease geometry decoder differs"):
        geometry.verify_release(release)
    # Data can still be inspected without executing a changed decoder.
    geometry.verify_release(release, verify_decoder=False)
    with (release / "train.npz").open("ab") as stream:
        stream.write(b"tamper")
    with pytest.raises(ValueError, match="integrity"):
        geometry.verify_release(release, verify_decoder=False)


def test_relabeling_recipe_or_parent_split_fails_even_with_updated_tensor_checksum(release):
    data = geometry.read_split(release, "train")
    data["recipe_features"][0, 0] = 1 - data["recipe_features"][0, 0]
    _deterministic_npz(release / "train.npz", **data)
    r = json.loads((release / "release.json").read_text())
    r["artifact_hashes"]["train.npz"] = geometry.digest(release / "train.npz")
    dump(release / "release.json", r)
    with pytest.raises(ValueError, match="recipe features differ from parent"):
        geometry.verify_release(release)


def test_parent_group_cannot_leak_across_surface_splits(release):
    rows = [json.loads(x) for x in (release / "manifest.jsonl").read_text().splitlines()]
    train = next(r for r in rows if r["split"] == "train")
    val = next(r for r in rows if r["split"] == "val")
    val["group_id"] = train["group_id"]
    dump(release / val["path"], val)
    (release / "manifest.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    arrays = geometry.read_split(release, "val", verify=False)
    arrays["group_ids"][0] = train["group_id"]
    _deterministic_npz(release / "val.npz", **arrays)
    r = json.loads((release / "release.json").read_text())
    for path in ("manifest.jsonl", "val.npz", val["path"]):
        r["artifact_hashes"][path] = geometry.digest(release / path)
    dump(release / "release.json", r)
    with pytest.raises(ValueError, match="group leakage"):
        geometry.verify_release(release)
