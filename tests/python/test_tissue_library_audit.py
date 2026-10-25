"""Audit failure modes independent of the generator's happy-path tests."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image
from viscera_core.tissue_materials import TissueRecipe, export_material

from scripts.audit_tissue_library import audit_library, image_diagnostics, safe_path


@pytest.fixture
def library(tmp_path: Path) -> Path:
    export_material(TissueRecipe(seed=2**64 - 1), tmp_path / "liver/native", resolution=32)
    catalog = {
        "schema": "viscera.tissue-catalog/v1",
        "materials": [{"id": "liver", "manifest": "liver/native/manifest.json"}],
    }
    (tmp_path / "catalog.json").write_text(json.dumps(catalog))
    return tmp_path


def test_complete_small_library_passes_without_losing_uint64_seed(library: Path) -> None:
    result = audit_library(library, resolution=32, expected_count=1)
    assert result["all_complete_and_passed"]
    assert result["gates"]["engineering_integrity"] == "passed"
    assert result["gates"]["photorealism"] == "not_assessed"
    assert result["gates"]["clinical_training_validity"] == "not_assessed"
    assert result["counts"] == {"passed": 1, "failed": 0, "incomplete": 0}
    assert result["materials"][0]["seed_decimal"] == str(2**64 - 1)
    assert len(result["materials"][0]["assets"]) == 14


def test_hash_corruption_is_detected(library: Path) -> None:
    path = library / "liver/native/roughness.png"
    path.write_bytes(path.read_bytes() + b"unexpected appended bytes")
    result = audit_library(library, resolution=32)
    assert not result["all_complete_and_passed"]
    assert any("SHA256 mismatch" in x for x in result["materials"][0]["errors"])


@pytest.mark.parametrize("channel", ["normal", "substrate_normal"])
def test_invalid_normals_fail_even_if_manifest_hash_was_updated(library: Path, channel: str) -> None:
    path = library / f"liver/native/{channel}.png"
    Image.fromarray(np.full((32, 32, 3), 128, dtype=np.uint8)).save(path)
    manifest_path = path.parent / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["channels"][channel]["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    manifest["channels"][channel]["bytes"] = path.stat().st_size
    manifest_path.write_text(json.dumps(manifest))
    result = audit_library(library, resolution=32)
    assert result["counts"]["failed"] == 1
    assert any("nonunit" in error for error in result["materials"][0]["errors"])


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("packing", ["adipose", "vessels", "fascia"]),
        ("decode_scale_mm", [0.035, 45, 0.035]),
        ("decode_offset_mm", [0, -1, 0]),
        ("decode_offset_mm", [False, 0, 0]),
        ("unit", "m"),
    ],
)
def test_packed_relief_semantics_are_validated(library: Path, field: str, value: object) -> None:
    path = library / "liver/native/manifest.json"
    manifest = json.loads(path.read_text())
    manifest["channels"]["layer_relief"][field] = value
    path.write_text(json.dumps(manifest))
    result = audit_library(library, resolution=32)
    assert result["counts"]["failed"] == 1
    assert "layer_relief" in " ".join(result["materials"][0]["errors"])


def test_missing_native_manifest_is_incomplete_not_passed(library: Path) -> None:
    (library / "liver/native/manifest.json").unlink()
    result = audit_library(library, resolution=32)
    assert result["counts"]["incomplete"] == 1
    assert not result["all_complete_and_passed"]


def test_float_rounded_uint64_seed_is_rejected(library: Path) -> None:
    path = library / "liver/native/manifest.json"
    manifest = json.loads(path.read_text())
    manifest["recipe"]["seed"] = float(2**64 - 1)
    path.write_text(json.dumps(manifest))
    result = audit_library(library, resolution=32)
    assert result["counts"]["failed"] == 1
    assert "uint64" in " ".join(result["materials"][0]["errors"])


@pytest.mark.parametrize(
    "relative", ["../outside.png", "/absolute.png", "a/../../b.png", "a\\b.png", "a//b.png"]
)
def test_path_traversal_rejected(tmp_path: Path, relative: str) -> None:
    with pytest.raises(ValueError):
        safe_path(tmp_path, relative)


def test_symlink_escape_rejected(tmp_path: Path) -> None:
    root = tmp_path / "library"
    root.mkdir()
    (root / "escape").symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(ValueError):
        safe_path(root, "escape/file.png")


def test_spatial_diagnostics_have_known_mean_std_and_seam_ratio() -> None:
    image = Image.fromarray(np.tile(np.array([0, 10, 20, 30], dtype=np.uint8), (4, 1)))
    diagnostics = image_diagnostics(image, 8, False)
    np.testing.assert_allclose(diagnostics["normalized_sample_mean"], [15 / 255])
    np.testing.assert_allclose(diagnostics["normalized_sample_std"], [np.sqrt(125) / 255])
    np.testing.assert_allclose(diagnostics["seam_diagnostics"]["u_ratio"], [3])
    assert diagnostics["seam_diagnostics"]["v_ratio"] == [None]
