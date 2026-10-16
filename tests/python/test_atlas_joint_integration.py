"""Exercise real NumPy joint weights, atomic imports and existing Studio recipes."""

from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from viscera_core.atlas_disease_scene import DiseaseAtlasSpec
from viscera_core.atlas_joint import CONTROL_NAMES, OBSERVATION_NAMES, RENDERER_PATHS

from services.api import atlas_joint_model as joint
from services.api import atlas_model_registry as registry

ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = "hra-liver-male"


def digest_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def write_archive(directory: Path, *, change=None, audit_change=None, profile="full") -> Path:
    """Small deterministic test tensors; these are never activated in user Studio."""
    directory.mkdir(parents=True, exist_ok=True)
    releases = {lane: json.dumps({"fixture": lane}).encode() for lane in ("baseline", "disease")}
    from viscera_core.atlas_disease import PROFILES

    disease = next(p["id"] for p in PROFILES.values() if p["organ"] == "liver" and p["supported"])
    conditions = [
        {
            "template_id": TEMPLATE,
            "organ": "liver",
            "profile_id": disease_id,
            "material_preset": "balanced",
            "renderer_seed": 17,
        }
        for disease_id in ("baseline", disease)
    ]
    templates = ROOT / "datasets/atlas/cohort-v2/templates"
    metadata = {
        "format": joint.FORMAT,
        "selected_method": "joint_conditional_vae",
        "training_profile": profile,
        "completed_steps": 1000,
        "training_samples": 64,
        "config": {"steps": 1000, "surrogate_steps": 200, "hidden": 8, "latent": 3, "embedding": 4},
        "conditions": conditions,
        "feature_names": list(CONTROL_NAMES),
        "observation_names": list(OBSERVATION_NAMES),
        "observation_shape": [8, 7],
        "renderer_hashes": {name: registry.digest(ROOT / name) for name in RENDERER_PATHS},
        "model_decoder_sha256": registry.digest(ROOT / "py/viscera_core/atlas_joint.py"),
        "template_hashes": {TEMPLATE: registry.digest(templates / f"{TEMPLATE}.npz")},
        "template_metadata_hashes": {TEMPLATE: registry.digest(templates / f"{TEMPLATE}.json")},
        "dataset_hashes": {
            f"{lane}/release.json": digest_bytes(data) for lane, data in releases.items()
        },
        "scope": "test fixture; not a trained model",
    }
    if change:
        change(metadata)
    rng = np.random.default_rng(71)
    shapes = {
        "embedding.weight": (2, 4),
        "prior_mean.weight": (2, 3),
        "prior_logvar.weight": (2, 3),
        "decoder.0.weight": (8, 7),
        "decoder.0.bias": (8,),
        "decoder.2.weight": (8, 8),
        "decoder.2.bias": (8,),
        "shape_head.weight": (7, 8),
        "shape_head.bias": (7,),
        "material_head.weight": (6, 8),
        "material_head.bias": (6,),
        "disease_head.weight": (9, 8),
        "disease_head.bias": (9,),
    }
    arrays = {name: rng.normal(0, 0.3, shape).astype(np.float32) for name, shape in shapes.items()}
    arrays["control_min"] = np.full((2, 22), -0.9, dtype=np.float32)
    arrays["control_max"] = np.full((2, 22), 0.9, dtype=np.float32)
    arrays["control_min"][0, 13:] = arrays["control_max"][0, 13:] = 0
    path = directory / "model.npz"
    np.savez_compressed(path, metadata_json=np.array(json.dumps(metadata)), **arrays)
    files = {
        "model.npz": path.read_bytes(),
        "model.json": json.dumps({**metadata, "artifact_sha256": registry.digest(path)}).encode(),
        **{f"data/{lane}-release.json": data for lane, data in releases.items()},
    }
    audit = {
        "format": "viscera-joint-exact-renderer-audit-v1",
        "model_sha256": registry.digest(path),
        "passed": True,
        "rendered_samples": 6,
        "condition_count": 2,
        "conditions": [{**condition, "passed": True} for condition in conditions],
        "scope": "unit test fixture, not real trained weights or real release audit",
    }
    if audit_change:
        audit_change(audit)
    files["exact-renderer-audit.json"] = json.dumps(audit).encode()
    manifest = {
        "format": joint.FORMAT,
        "smoke_only": profile != "full",
        "profile": profile,
        "dataset_dependencies": {lane: digest_bytes(data) for lane, data in releases.items()},
        "artifact_hashes": {name: digest_bytes(data) for name, data in files.items()},
    }
    archive = directory / "weights.zip"
    with zipfile.ZipFile(archive, "w") as stream:
        for name, data in {**files, "manifest.json": json.dumps(manifest).encode()}.items():
            stream.writestr(joint.PREFIX + name, data)
    return archive


@pytest.fixture
def isolated_store(tmp_path, monkeypatch):
    from services.api import atlas_joint_registry

    monkeypatch.setenv("VISCERA_MODEL_STORE", str(tmp_path / "model-store"))
    monkeypatch.setenv("VISCERA_ATLAS_TEMPLATES", str(ROOT / "datasets/atlas/cohort-v2/templates"))
    # These import-contract tests deliberately model a deployment without a
    # bundled checkpoint; default deployment behavior has separate coverage.
    monkeypatch.delenv("VISCERA_JOINT_DEFAULT_WEIGHTS", raising=False)
    monkeypatch.setattr(atlas_joint_registry, "DEFAULT_VAE_WEIGHTS", "missing-default.zip")
    atlas_joint_registry._install_default_vae.cache_clear()
    joint._load.cache_clear()
    yield tmp_path
    joint._load.cache_clear()
    atlas_joint_registry._install_default_vae.cache_clear()


def test_joint_import_keeps_original_pointer_and_replays_complete_recipes(isolated_store):
    tmp = isolated_store
    old_pointer = {"version": 1, "active_bundle": None, "retained_marker": "original"}
    registry._atomic_json(registry.store_root(ROOT) / "active.json", old_pointer)
    archive = write_archive(tmp / "full")
    status = registry.import_weights(ROOT, archive)
    assert status["source"] == "defaults"
    assert status["joint_bundle_sha256"] == registry.digest(archive)
    assert status["lanes"]["joint"]["method"] == "joint_conditional_vae"
    assert registry._read_json(registry.store_root(ROOT) / "active.json") == old_pointer
    assert registry.import_weights(ROOT, archive) == status
    request = DiseaseAtlasSpec(template_id=TEMPLATE)
    first = joint.sample_model(ROOT, request, 42, 1)
    replay = joint.sample_model(ROOT, request, 42, 1)
    different = joint.sample_model(ROOT, request, 43, 1)
    assert first == replay
    assert first["spec"]["controls"] != different["spec"]["controls"]
    assert first["spec"]["material"] != different["spec"]["material"]
    assert (
        first["scene"]["metadata"]["geometry_sha256"]
        != different["scene"]["metadata"]["geometry_sha256"]
    )
    assert first["spec"].get("disease") is None
    assert first["summary"]["joint_model"]["bundle_sha256"] == status["joint_bundle_sha256"]
    assert first["summary"]["joint_model"]["request_seed"] == 42
    # Inspect validated deployment metadata rather than relying on recipe defaults.
    _, directory = joint._active(ROOT)
    profile = joint._model(directory)["conditions"][1]["profile_id"]
    assert all(not array.flags.writeable for array in joint._model(directory)["arrays"].values())
    diseased = joint.sample_model(
        ROOT, DiseaseAtlasSpec(template_id=TEMPLATE, disease={"profile_id": profile}), 42, 1
    )
    assert diseased["spec"]["disease"]["profile_id"] == profile
    assert diseased["spec"]["material"]["organ"] == "liver"
    assert diseased["spec"]["appearance"] == "tissue"
    assert diseased["scene"]["organs"][0]["metadata"]["disease_field"]
    assert registry.restore_defaults(ROOT)["joint_bundle_sha256"] is None
    assert directory.exists()


@pytest.mark.parametrize(
    "mutation,error",
    [
        (lambda meta: meta.update(completed_steps=0), "completed full-profile"),
        (lambda meta: meta.update(completed_steps=999), "completed full-profile"),
        (lambda meta: meta["config"].update(surrogate_steps=199), "completed full-profile"),
        (lambda meta: meta["renderer_hashes"].pop(RENDERER_PATHS[0]), "every frozen renderer"),
        (lambda meta: meta.update(model_decoder_sha256="0" * 64), "renderer source"),
        (
            lambda meta: meta["template_metadata_hashes"].update({TEMPLATE: "0" * 64}),
            "reference differs",
        ),
        (lambda meta: meta["template_hashes"].update({TEMPLATE: "0" * 64}), "reference differs"),
        (
            lambda meta: meta["dataset_hashes"].update({"baseline/release.json": "0" * 64}),
            "provenance mismatch",
        ),
    ],
)
def test_joint_invalid_import_is_atomic(isolated_store, mutation, error):
    good = write_archive(isolated_store / "good")
    registry.import_weights(ROOT, good)
    pointer = registry.store_root(ROOT) / "active-joint.json"
    before = pointer.read_bytes()
    bad = write_archive(isolated_store / "bad", change=mutation)
    with pytest.raises(ValueError, match=error):
        registry.import_weights(ROOT, bad)
    assert pointer.read_bytes() == before
    assert not list(registry.store_root(ROOT).glob(".joint-staging-*"))


@pytest.mark.parametrize(
    "mutation",
    [
        lambda report: report.update(passed=False),
        lambda report: report.update(model_sha256="0" * 64),
        lambda report: report.update(rendered_samples=2),
        lambda report: report.update(conditions=report["conditions"][:1]),
        lambda report: report["conditions"][0].update(profile_id="other"),
    ],
)
def test_joint_requires_bound_complete_exact_renderer_audit(isolated_store, mutation):
    archive = write_archive(isolated_store / "bad-audit", audit_change=mutation)
    with pytest.raises(ValueError, match="exact-renderer audit"):
        registry.import_weights(ROOT, archive)
    assert joint.joint_status(ROOT)["bundle_sha256"] is None


def test_joint_smoke_unlisted_and_mixed_archives_are_rejected(isolated_store):
    archive = write_archive(isolated_store / "smoke", profile="smoke")
    with pytest.raises(ValueError, match="smoke"):
        registry.import_weights(ROOT, archive)
    archive = write_archive(isolated_store / "unlisted")
    with zipfile.ZipFile(archive, "a") as stream:
        stream.writestr(joint.PREFIX + "unlisted.json", "{}")
    with pytest.raises(ValueError, match="unmanifested"):
        registry.import_weights(ROOT, archive)
    archive = write_archive(isolated_store / "mixed")
    with zipfile.ZipFile(archive, "a") as stream:
        stream.writestr("viscera-weights/report.json", "{}")
    with pytest.raises(ValueError, match="regular"):
        registry.import_weights(ROOT, archive)
    assert joint.joint_status(ROOT)["bundle_sha256"] is None


def test_joint_route_validates_inputs_and_requires_explicit_import(isolated_store, monkeypatch):
    from services.api import atlas

    monkeypatch.setattr(atlas, "ROOT", ROOT)
    app = FastAPI()
    app.include_router(atlas.router)
    client = TestClient(app)
    spec = DiseaseAtlasSpec(template_id=TEMPLATE).model_dump(mode="json")
    assert client.post("/api/atlas/sample-joint", json={"spec": spec}).status_code == 422
    registry.import_weights(ROOT, write_archive(isolated_store / "full"))
    for seed in (True, -1, 1.2, 2**32):
        assert (
            client.post("/api/atlas/sample-joint", json={"spec": spec, "seed": seed}).status_code
            == 422
        )
    for temperature in (True, "1", 0.1, 1.6):
        assert (
            client.post(
                "/api/atlas/sample-joint", json={"spec": spec, "temperature": temperature}
            ).status_code
            == 422
        )
    response = client.post(
        "/api/atlas/sample-joint", json={"spec": spec, "seed": 200, "temperature": 0.7}
    )
    assert response.status_code == 200, response.text
    assert response.json()["summary"]["joint_model"]["request_seed"] == 200
    assert response.json()["summary"]["joint_model"]["temperature"] == 0.7
    pointer = registry._read_json(registry.store_root(ROOT) / "active-joint.json")
    directory = registry.store_root(ROOT) / "joint-bundles" / pointer["active_bundle"]
    (directory / "model.npz").write_bytes(b"tampered")
    assert client.post("/api/atlas/sample-joint", json={"spec": spec}).status_code == 422
