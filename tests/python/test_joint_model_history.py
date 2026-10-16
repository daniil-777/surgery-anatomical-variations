"""Retained version switching must replay exact weights and preserve other lanes."""

import json
import sys
from types import ModuleType

import pytest
from test_atlas_joint_integration import ROOT, write_archive
from test_atlas_joint_integration import isolated_store as _isolated_store

from services.api import atlas_joint_registry as history
from services.api import atlas_model_registry as registry

isolated_store = _isolated_store


def test_old_joint_versions_remain_selectable_and_corruption_cannot_activate(isolated_store):
    first = write_archive(isolated_store / "first")
    second = write_archive(isolated_store / "second", change=lambda meta: meta.update(scope="second fixture"))
    one = registry.import_weights(ROOT, first)["joint_bundle_sha256"]
    two = registry.import_weights(ROOT, second)["joint_bundle_sha256"]
    assert one != two
    versions = history.history(ROOT)["versions"]
    assert {row["bundle_sha256"] for row in versions} == {one, two}
    assert [row["bundle_sha256"] for row in versions if row["active"]] == [two]
    assert history.activate_retained(ROOT, 1, one)["joint_bundle_sha256"] == one
    assert (registry.store_root(ROOT) / "joint-bundles" / two).is_dir()
    damaged = registry.store_root(ROOT) / "joint-bundles" / two / "model.npz"
    damaged.write_bytes(b"changed")
    with pytest.raises(ValueError):
        history.activate_retained(ROOT, 1, two)
    assert history.status(ROOT)["bundle_sha256"] == one
    assert next(row for row in history.history(ROOT)["versions"] if row["bundle_sha256"] == two)["integrity"] == "invalid"


def test_selection_rejects_path_traversal_and_unknown_generation(isolated_store):
    registry.import_weights(ROOT, write_archive(isolated_store / "valid"))
    before = history.status(ROOT)
    for generation, identifier in ((3, "a" * 64), (True, "a" * 64), (1, "../active"), (1, "b" * 64)):
        with pytest.raises(ValueError):
            history.activate_retained(ROOT, generation, identifier)
    assert history.status(ROOT) == before
    assert json.loads((registry.store_root(ROOT) / "joint-selection.json").read_text())["generation"] == 1


@pytest.mark.parametrize("valid_report", [True, False])
def test_joint_activation_preserves_independent_physics_readiness(
    isolated_store, monkeypatch, valid_report
):
    physics = ModuleType("viscera_core.physics_learning")
    physics.SCOPE = "independent synthetic mechanics fixture"
    physics.load_model = lambda path: ({}, "a" * 64)
    monkeypatch.setitem(sys.modules, physics.__name__, physics)
    directory = isolated_store / "independent-physics"
    directory.mkdir()
    (directory / "evaluation.json").write_text(json.dumps({
        "model_sha256": ("a" if valid_report else "b") * 64,
        "synthetic_gate_passed": True,
    }))
    monkeypatch.setenv("VISCERA_PHYSICS_MODEL", str(directory))
    archive = write_archive(isolated_store / "joint-with-separate-physics")
    status = registry.import_weights(ROOT, archive)
    assert status["joint_generation"] == 1
    assert status["physics_parameters_learned"] is valid_report
    if valid_report:
        assert status["lanes"]["physics"]["method"] == "separate_inverse_SLS_ensemble"
    else:
        assert status["lanes"].get("physics", {}).get("status") != "active"


def test_optional_physics_module_does_not_break_partial_serving_bundle(isolated_store, monkeypatch):
    monkeypatch.setitem(sys.modules, "viscera_core.physics_learning", None)
    status = registry.model_status(ROOT)
    assert status["physics_parameters_learned"] is False
