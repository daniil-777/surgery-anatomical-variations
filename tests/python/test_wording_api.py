import copy
import json
import zipfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services.api import atlas
from services.api import atlas_model_registry as registry
from services.api import atlas_wording_model as wording


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("VISCERA_MODEL_STORE", str(tmp_path / "models"))
    app = FastAPI()
    app.include_router(atlas.router)
    yield TestClient(app)
    wording.clear_cache()


def specimen():
    return atlas.LegacyAtlasSpec.model_validate({
        "template_id": "hra-liver-female", "seed": 71,
        "controls": {"bend": .15, "twist": .2},
        "disease": {"profile_id": "liver-cirrhosis", "severity": .7, "contrast": .6},
    }).model_dump(mode="json")


def test_healthier_works_without_an_import_and_preserves_unrequested_state(client):
    before = specimen()
    response = client.post("/api/atlas/compile", json={"text": "make the liver healthier", "spec": before})
    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "accepted"
    after = result["spec"]
    assert after["disease"]["severity"] == pytest.approx(.56)
    assert after["disease"]["contrast"] == pytest.approx(.48)
    expected = copy.deepcopy(before)
    expected["disease"].update(severity=.56, contrast=.48)
    assert after == expected
    assert "semantic_plan" in result
    assert "wording_model" not in result


@pytest.mark.parametrize("text", [
    "make it healthier and resect the left lobe",
    "make it healthier but do not change the disease",
    "5% wider and add a second liver",
])
def test_unsupported_or_contradictory_clause_prevents_partial_edit(client, text):
    response = client.post("/api/atlas/compile", json={"text": text, "spec": specimen()})
    assert response.status_code == 200
    result = response.json()
    assert result["status"] in {"unsupported", "clarify"}
    assert not result.get("spec")


def test_baseline_healthier_does_not_invent_disease(client):
    spec = specimen()
    spec["disease"] = None
    result = client.post("/api/atlas/compile", json={"text": "healthier", "spec": spec}).json()
    assert result["status"] == "accepted"
    assert atlas.LegacyAtlasSpec.model_validate(result["spec"]) == atlas.LegacyAtlasSpec.model_validate(spec)


def test_diseased_absolute_dimension_guard_precedes_legacy_compiler(client):
    result = client.post("/api/atlas/compile", json={"text": "width 247 mm", "spec": specimen()}).json()
    assert result["status"] == "clarify"
    assert not result.get("spec")


@pytest.mark.parametrize("renderer_v2", [False, True])
@pytest.mark.parametrize("text", [
    "make the liver healthier", "clear disease", "make it wetter", "healthier and 5% wider",
])
def test_legacy_shape_opt_in_keeps_contextual_edits_available(client, monkeypatch, renderer_v2, text):
    before = specimen()
    if renderer_v2:
        before["renderer_version"] = "disease-v2"
    expected = client.post("/api/atlas/compile", json={"text": text, "spec": before})
    assert expected.status_code == 200 and expected.json()["status"] == "accepted"

    def unused_shape_adapter(*args):
        raise AssertionError("Contextual edits must not require the legacy shape-only model")

    monkeypatch.setattr(registry, "language_enabled", unused_shape_adapter)
    actual = client.post("/api/atlas/compile", json={
        "text": text, "spec": before, "use_trained_language": True,
    })
    assert actual.status_code == 200
    assert actual.json()["status"] == "accepted"
    assert actual.json()["spec"] == expected.json()["spec"]
    assert "wording_model" not in actual.json()  # No trained wording inference is claimed.


def test_legacy_shape_opt_in_keeps_baseline_healthier_noop(client):
    before = specimen()
    before["disease"] = None
    result = client.post("/api/atlas/compile", json={
        "text": "healthier", "spec": before, "use_trained_language": True,
    }).json()
    assert result["status"] == "accepted"
    assert atlas.LegacyAtlasSpec.model_validate(result["spec"]) == atlas.LegacyAtlasSpec.model_validate(before)


@pytest.mark.parametrize("text", [
    "make it healthier and resect the left lobe",
    "make it healthier but do not change the disease",
    "width 247 mm",
])
def test_source_guards_also_precede_opted_in_legacy_adapter(client, monkeypatch, text):
    monkeypatch.setattr(registry, "language_enabled", lambda *args: pytest.fail("Guard bypassed"))
    result = client.post("/api/atlas/compile", json={
        "text": text, "spec": specimen(), "use_trained_language": True,
    }).json()
    assert result["status"] in {"unsupported", "clarify"}
    assert not result.get("spec")


@pytest.mark.parametrize("text", ["5% wider", "more bent"])
def test_explicit_legacy_shape_opt_in_still_uses_that_model(client, monkeypatch, text):
    from services.api import atlas_language_model

    calls = []
    monkeypatch.setattr(registry, "language_enabled", lambda *args: True)
    monkeypatch.setattr(registry, "resolve_imported_lane", lambda *args: ("a" * 64, atlas.ROOT))
    monkeypatch.setattr(registry, "data_paths", lambda *args: {"language": atlas.ROOT, "shape": atlas.ROOT})

    def legacy(*args, **kwargs):
        calls.append((args, kwargs))
        return {"status": "clarify", "message": "Legacy model response"}

    monkeypatch.setattr(atlas_language_model, "compile_with_adapter", legacy)
    result = client.post("/api/atlas/compile", json={
        "text": text, "spec": specimen(), "use_trained_language": True,
    }).json()
    assert result == {"status": "clarify", "message": "Legacy model response"}
    assert len(calls) == 1
    assert calls[0][1] == {"allow_model_download": False}


def test_smoke_wording_archive_cannot_replace_existing_selection(tmp_path, monkeypatch):
    monkeypatch.setenv("VISCERA_MODEL_STORE", str(tmp_path / "store"))
    pointer = registry.store_root(tmp_path) / "active-wording.json"
    selected = {"version": 1, "active_bundle": "a" * 64}
    registry._atomic_json(pointer, selected)
    archive_path = tmp_path / "viscera-wording-weights.zip"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr(wording.PREFIX + "manifest.json", json.dumps({"format": wording.FORMAT, "promoted": False}))
    with pytest.raises(ValueError, match="passed evaluation"):
        registry.import_weights(tmp_path, archive_path)
    assert json.loads(pointer.read_text()) == selected
    assert not list(registry.store_root(tmp_path).glob(".wording-staging-*"))
