"""Import failure is atomic; untrusted archives never supply executable code."""

from __future__ import annotations

import hashlib
import io
import json
import os
import stat
import zipfile
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services.api import atlas_model_registry as registry


def archive(path: Path, files: dict[str, bytes], *, smoke: bool = False) -> Path:
    manifest = {
        "format": registry.FORMAT,
        "smoke_only": smoke,
        "artifact_hashes": {k: hashlib.sha256(v).hexdigest() for k, v in files.items()},
    }
    with zipfile.ZipFile(path, "w") as stream:
        for name, value in {**files, "manifest.json": json.dumps(manifest).encode()}.items():
            stream.writestr("viscera-weights/" + name, value)
    return path


@pytest.fixture
def model_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("VISCERA_MODEL_STORE", str(tmp_path / "model-store"))
    return tmp_path


def test_validation_failure_does_not_replace_active_weights(model_store, monkeypatch):
    root = model_store
    monkeypatch.setattr(
        registry,
        "_validate_models",
        lambda *args: {"shape": {"status": "active", "scope": "fixture"}},
    )
    good = archive(root / "valid.zip", {"report.json": b"{}"})
    activated = registry.import_weights(root, good)
    before = (registry.store_root(root) / "active.json").read_bytes()
    assert activated["source"] == "imported"
    assert registry.import_weights(root, good) == activated

    def fail(*args):
        raise ValueError("model / dataset mismatch")

    monkeypatch.setattr(registry, "_validate_models", fail)
    bad = archive(root / "invalid.zip", {"report.json": b'{"changed":true}'})
    with pytest.raises(ValueError, match="dataset mismatch"):
        registry.import_weights(root, bad)
    assert (registry.store_root(root) / "active.json").read_bytes() == before
    assert not list(registry.store_root(root).glob(".staging-*"))
    assert registry.restore_defaults(root)["source"] == "defaults"
    assert (registry.store_root(root) / "bundles" / activated["bundle_sha256"]).exists()


@pytest.mark.parametrize(
    "name",
    [
        "../escape.json",
        "/absolute.json",
        "viscera-weights/../escape.json",
        "viscera-weights/a\\b.json",
        "viscera-weights/drive:bad.json",
    ],
)
def test_archive_traversal_is_rejected_before_extraction(model_store, name):
    path = model_store / "bad.zip"
    with zipfile.ZipFile(path, "w") as stream:
        stream.writestr(name, b"{}")
    with pytest.raises(ValueError, match="path"):
        registry.import_weights(model_store, path)
    assert not (registry.store_root(model_store) / "active.json").exists()


def test_symlink_duplicates_unlisted_files_smoke_and_size_fail(model_store, monkeypatch):
    path = model_store / "bad.zip"
    link = zipfile.ZipInfo("viscera-weights/model.json")
    link.external_attr = (stat.S_IFLNK | 0o777) << 16
    with zipfile.ZipFile(path, "w") as stream:
        stream.writestr(link, b"/tmp/target")
    with pytest.raises(ValueError, match="regular"):
        registry.import_weights(model_store, path)
    with zipfile.ZipFile(path, "w") as stream:
        stream.writestr("viscera-weights/a.json", b"{}")
        with pytest.warns(UserWarning):
            stream.writestr("viscera-weights/a.json", b"{}")
    with pytest.raises(ValueError, match="Duplicate"):
        registry.import_weights(model_store, path)
    archive(path, {"a.json": b"{}"})
    with zipfile.ZipFile(path, "a") as stream:
        stream.writestr("viscera-weights/unlisted.json", b"{}")
    with pytest.raises(ValueError, match="unmanifested"):
        registry.import_weights(model_store, path)
    archive(path, {"a.json": b"{}"}, smoke=True)
    with pytest.raises(ValueError, match="smoke"):
        registry.import_weights(model_store, path)
    monkeypatch.setattr(registry, "MAX_EXPANDED_BYTES", 1)
    with pytest.raises(ValueError, match="extraction limits"):
        registry.import_weights(model_store, path)


def test_tensor_pickle_and_inconsistent_numpy_allocations_are_rejected(model_store):
    import numpy as np
    import torch

    from pipelines.train.viscera_train.atlas_shape import atomic_torch, safe_load

    # weights_only refuses callable reconstruction even with a valid sidecar.
    path = model_store / "unsafe.pt"
    atomic_torch(path, {"callback": print})
    with pytest.raises(Exception, match="Weights only|WeightsUnpickler|Unsupported global"):
        safe_load(path)
    # A small NPY member must not advertise a multi-gigabyte allocation.
    buf = io.BytesIO()
    np.lib.format.write_array_header_1_0(
        buf, {"descr": "<f8", "fortran_order": False, "shape": (10**10,)}
    )
    inner = io.BytesIO()
    with zipfile.ZipFile(inner, "w") as stream:
        stream.writestr("large.npy", buf.getvalue())
    outer = archive(model_store / "bad-numpy.zip", {"material/model.npz": inner.getvalue()})
    with pytest.raises(ValueError, match="NumPy weight array"):
        registry.import_weights(model_store, outer)
    assert torch.__version__


def test_tokenizer_jinja_is_inert_and_intermediate_symlinks_are_rejected(model_store):
    root = model_store
    payload = b"{{ deliberately_not_evaluated }}"
    path = archive(root / "adapter.zip", {"language/adapter/chat_template.jinja": payload})
    extracted = root / "extracted"
    extracted.mkdir()
    registry._extract(path, extracted)
    assert (extracted / "language/adapter/chat_template.jinja").read_bytes() == payload
    outside = root / "outside"
    outside.mkdir()
    (outside / "model.json").write_bytes(b"{}")
    (extracted / "external").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="integrity"):
        registry._verify_files(
            extracted, {"external/model.json": hashlib.sha256(b"{}").hexdigest()}
        )


def test_upload_endpoint_is_bounded_and_preserves_registry(model_store, monkeypatch):
    from services.api import atlas_models

    monkeypatch.setattr(atlas_models, "ROOT", model_store)
    app = FastAPI()
    app.include_router(atlas_models.router)
    client = TestClient(app)
    assert client.get("/api/atlas/models").json()["source"] == "defaults"
    assert client.post("/api/atlas/models/import", content=b"bad").status_code == 415
    bad = client.post(
        "/api/atlas/models/import", content=b"bad", headers={"content-type": "application/zip"}
    )
    assert bad.status_code == 422 and "not activated" in bad.json()["detail"]
    monkeypatch.setattr(registry, "MAX_UPLOAD_BYTES", 2)
    assert (
        client.post(
            "/api/atlas/models/import", content=b"bad", headers={"content-type": "application/zip"}
        ).status_code
        == 413
    )
    assert client.post("/api/atlas/models/defaults").status_code == 415
    assert client.post("/api/atlas/models/defaults", json={}).json()["source"] == "defaults"


def test_language_enable_is_explicit_and_compile_cannot_download(model_store, monkeypatch):
    from viscera_core.atlas_materials import make_recipe

    from services.api import atlas, atlas_language_model, atlas_models

    calls = []
    monkeypatch.setattr(atlas_models, "ROOT", model_store)
    monkeypatch.setattr(atlas, "ROOT", model_store)
    monkeypatch.setattr(
        registry, "resolve_imported_lane", lambda root, lane: ("a" * 64, root / lane)
    )
    monkeypatch.setattr(registry, "mark_language_enabled", lambda *args: {"language_enabled": True})
    monkeypatch.setattr(
        atlas_language_model, "enable_adapter", lambda *args, **kwargs: calls.append(kwargs)
    )
    app = FastAPI()
    app.include_router(atlas_models.router)
    app.include_router(atlas.router)
    client = TestClient(app)
    assert client.post("/api/atlas/models/language/enable", json={}).status_code == 422
    assert calls == []
    assert (
        client.post(
            "/api/atlas/models/language/enable", json={"allow_model_download": True}
        ).status_code
        == 200
    )
    assert calls == [{"allow_model_download": True}]
    context = {"template_id": "liver-test", "material": make_recipe("liver").model_dump()}
    assert (
        client.post(
            "/api/atlas/compile",
            json={"text": "wider", "spec": context, "use_trained_language": True},
        ).status_code
        == 422
    )
    monkeypatch.setattr(registry, "language_enabled", lambda *args: True)

    def compile_mock(*args, **kwargs):
        assert kwargs == {"allow_model_download": False}
        assert args[5]["material"] == context["material"]
        return {"status": "unsupported", "message": "Guard rejected the adapter proposal"}

    monkeypatch.setattr(atlas_language_model, "compile_with_adapter", compile_mock)
    response = client.post(
        "/api/atlas/compile", json={"text": "wider", "spec": context, "use_trained_language": True}
    )
    assert response.status_code == 200 and response.json()["status"] == "unsupported"


def test_persisted_language_consent_does_not_claim_cold_cache_is_ready(model_store, monkeypatch):
    from services.api import atlas_language_model

    ready = [False]
    monkeypatch.setattr(atlas_language_model, "is_adapter_enabled", lambda *args: ready[0])
    monkeypatch.setattr(
        registry,
        "_validate_models",
        lambda *args: {
            "language": {"status": "stored_research_adapter_not_enabled", "scope": "fixture"}
        },
    )
    path = archive(model_store / "bundle.zip", {"report.json": b"{}"})
    result = registry.import_weights(model_store, path)
    ready[0] = True
    assert registry.mark_language_enabled(model_store, result["bundle_sha256"])["language_enabled"]
    ready[0] = False
    status = registry.model_status(model_store)
    assert status["language_enabled"] is False
    assert status["lanes"]["language"]["status"] == "stored_research_adapter_not_enabled"
    ready[0] = True
    assert registry.mark_language_enabled(model_store, result["bundle_sha256"])["language_enabled"]


@pytest.mark.skipif(
    not os.environ.get("VISCERA_TEST_WEIGHTS"), reason="opt-in real final Colab ZIP integration"
)
def test_real_final_zip_activates_and_serves_all_three_editor_lanes(model_store, monkeypatch):
    from services.api import atlas, atlas_models

    root = Path(__file__).resolve().parents[2]
    monkeypatch.setattr(atlas, "ROOT", root)
    monkeypatch.setattr(atlas_models, "ROOT", root)
    app = FastAPI()
    app.include_router(atlas.router)
    app.include_router(atlas_models.router)
    client = TestClient(app)
    path = Path(os.environ["VISCERA_TEST_WEIGHTS"])
    response = client.post(
        "/api/atlas/models/import",
        content=path.read_bytes(),
        headers={"content-type": "application/zip"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["source"] == "imported"
    clinical = client.post(
        "/api/atlas/models/clinical/sample",
        json={"organ": "pancreas", "disease_code": "pancreatic_ductal_adenocarcinoma", "seed": 42},
    )
    assert clinical.status_code == 200, clinical.text
    assert clinical.json()["cases"][0]["sampling"] == "empirical_case_retrieval"
    assert "scene" not in clinical.json()
    recipe = {"template_id": "hra-liver-female", "seed": 17}
    shaped = client.post("/api/atlas/sample", json={"spec": recipe, "match_dimensions": False})
    assert shaped.status_code == 200, shaped.text
    assert shaped.json()["summary"]["model"]["model_sha256"] == registry.digest(
        registry.resolve_model(root, "shape")
    )
    textured = client.post("/api/atlas/sample-material", json={"spec": recipe, "seed": 19})
    assert textured.status_code == 200, textured.text
    diseased = client.post(
        "/api/atlas/sample-disease",
        json={"spec": {**recipe, "disease": {"profile_id": "liver-hcc"}}, "seed": 23},
    )
    assert diseased.status_code == 200, diseased.text
    assert diseased.json()["summary"]["disease_model"]["model_sha256"] == registry.digest(
        registry.resolve_model(root, "disease")
    )
    # Re-read persistent state, then detect post-import drift instead of serving it.
    assert registry.model_status(root)["bundle_sha256"] == registry.digest(path)
    registry.resolve_model(root, "disease").write_bytes(b"corruption")
    assert (
        client.post(
            "/api/atlas/sample-disease",
            json={"spec": {**recipe, "disease": {"profile_id": "liver-hcc"}}, "seed": 23},
        ).status_code
        == 422
    )
    assert client.post("/api/atlas/models/defaults", json={}).json()["source"] == "defaults"
