"""A fresh Studio can sample validated bundled weights without an import action."""

import json
import zipfile

import pytest
from test_atlas_joint_integration import ROOT, TEMPLATE, write_archive
from test_atlas_joint_integration import isolated_store as _isolated_store
from viscera_core.atlas_disease_scene import DiseaseAtlasSpec

from services.api import atlas_joint_model as joint
from services.api import atlas_joint_registry as history
from services.api import atlas_model_registry as registry

isolated_store = _isolated_store


def test_bundled_default_samples_without_import_and_restores_after_override(
    isolated_store, monkeypatch
):
    default = write_archive(isolated_store / "default")
    monkeypatch.setenv("VISCERA_JOINT_DEFAULT_WEIGHTS", str(default))
    store = registry.store_root(ROOT)
    status = registry.model_status(ROOT)
    identifier = registry.digest(default)
    assert status["joint_bundle_sha256"] == identifier
    assert status["joint_generation"] == 1
    assert status["lanes"]["joint"]["source"] == "bundled_default"
    assert status["lanes"]["joint"]["status"] == "active"
    assert not (store / "active-joint.json").exists()
    assert not (store / "joint-selection.json").exists()
    request = DiseaseAtlasSpec(template_id=TEMPLATE)
    first = joint.sample_model(ROOT, request, 42, 1)
    assert first == joint.sample_model(ROOT, request, 42, 1)
    assert first["spec"]["controls"] != joint.sample_model(ROOT, request, 43, 1)["spec"]["controls"]
    assert first["summary"]["joint_model"]["bundle_sha256"] == identifier

    override = write_archive(
        isolated_store / "override", change=lambda meta: meta.update(scope="explicit override")
    )
    imported = registry.import_weights(ROOT, override)
    assert imported["joint_bundle_sha256"] == registry.digest(override)
    assert imported["lanes"]["joint"]["source"] == "imported"
    restored = registry.restore_defaults(ROOT)
    assert restored["joint_bundle_sha256"] == identifier
    assert restored["lanes"]["joint"]["source"] == "bundled_default"
    assert {row["bundle_sha256"] for row in history.history(ROOT)["versions"]} == {
        identifier, registry.digest(override)
    }


def test_default_rejects_failed_audit_without_writing_selection(isolated_store, monkeypatch):
    invalid = write_archive(
        isolated_store / "invalid", audit_change=lambda audit: audit.update(passed=False)
    )
    monkeypatch.setenv("VISCERA_JOINT_DEFAULT_WEIGHTS", str(invalid))
    with pytest.raises(ValueError, match="exact-renderer audit"):
        history.status(ROOT)
    assert not (registry.store_root(ROOT) / "active-joint.json").exists()
    assert not (registry.store_root(ROOT) / "joint-selection.json").exists()
    assert not list(registry.store_root(ROOT).glob(".joint-staging-*"))


@pytest.mark.parametrize("file", ["manifest.json", "model.npz"])
def test_default_cache_rechecks_retained_artifacts(isolated_store, monkeypatch, file):
    default = write_archive(isolated_store / "default")
    monkeypatch.setenv("VISCERA_JOINT_DEFAULT_WEIGHTS", str(default))
    status = history.status(ROOT)
    retained = registry.store_root(ROOT) / "joint-bundles" / status["bundle_sha256"]
    (retained / file).write_bytes(b"tampered")
    with pytest.raises(ValueError):
        history.status(ROOT)


def test_explicit_import_wins_even_if_default_is_unavailable(isolated_store, monkeypatch):
    imported = registry.import_weights(ROOT, write_archive(isolated_store / "explicit"))
    monkeypatch.setenv("VISCERA_JOINT_DEFAULT_WEIGHTS", str(isolated_store / "missing.zip"))
    assert registry.model_status(ROOT) == imported


def test_shipped_default_archive_is_exact_validated_release():
    archive = ROOT / history.DEFAULT_VAE_WEIGHTS
    assert registry.digest(archive) == history.DEFAULT_VAE_SHA256
    with zipfile.ZipFile(archive) as stream:
        manifest = json.loads(stream.read(joint.PREFIX + "manifest.json"))
        metadata = json.loads(stream.read(joint.PREFIX + "model.json"))
        audit = json.loads(stream.read(joint.PREFIX + "exact-renderer-audit.json"))
        assert manifest["format"] == joint.FORMAT
        assert manifest["smoke_only"] is False
        assert metadata["completed_steps"] == 4000
        assert len(metadata["conditions"]) == 74
        assert audit["passed"] is True
        assert audit["model_sha256"] == metadata["artifact_sha256"]


def test_shipped_default_archive_tampering_is_rejected(isolated_store, monkeypatch):
    archive = write_archive(isolated_store / "different-default")
    monkeypatch.setattr(history, "DEFAULT_VAE_WEIGHTS", str(archive))
    with pytest.raises(ValueError, match="checksum changed"):
        history.status(ROOT)
