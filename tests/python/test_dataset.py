"""Frozen releases must never be silently repaired or regenerated."""

from pathlib import Path
from unittest.mock import patch

import pytest
from viscera_core.dataset import create_dataset


def test_existing_release_is_verified_without_regeneration(tmp_path: Path):
    release = create_dataset(tmp_path, 3, seed=4, resolution="low")
    before = {p.name: p.stat().st_mtime_ns for p in tmp_path.iterdir()}
    with patch(
        "viscera_core.dataset.generate_scene", side_effect=AssertionError("must not regenerate")
    ):
        assert create_dataset(tmp_path, 3, seed=4, resolution="low") == release
    assert before == {p.name: p.stat().st_mtime_ns for p in tmp_path.iterdir()}
    with pytest.raises(ValueError, match="different release"):
        create_dataset(tmp_path, 3, seed=5, resolution="low")


def test_corrupt_release_is_rejected_and_preserved_for_inspection(tmp_path: Path):
    create_dataset(tmp_path, 3, seed=4, resolution="low")
    split = tmp_path / "train.npz"
    split.write_bytes(b"corrupted artifact")
    with pytest.raises(ValueError, match="integrity verification"):
        create_dataset(tmp_path, 3, seed=4, resolution="low")
    assert split.read_bytes() == b"corrupted artifact"


@pytest.mark.parametrize(
    "invalid",
    [{"resolution": "ultra"}, {"count": 3.5}, {"count": True}, {"seed": -1}, {"seed": 2**32}],
)
def test_invalid_recipe_fails_before_creating_output(tmp_path: Path, invalid: dict):
    output = tmp_path / "invalid"
    with pytest.raises(ValueError):
        create_dataset(output, **invalid)
    assert not output.exists()
