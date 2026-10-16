"""A promoted adapter must not break bounded edits when its first load fails."""

from copy import deepcopy
from pathlib import Path

import pytest
from viscera_core.atlas_semantic import make_plan

from pipelines.train.viscera_train import atlas_wording as trained
from services.api import atlas_wording_model as wording
from services.api.atlas import LegacyAtlasSpec

ROOT = Path(__file__).resolve().parents[2]
TEMPLATES = ROOT / "datasets/atlas/cohort-v2/templates"


@pytest.fixture
def selected(tmp_path, monkeypatch):
    wording.clear_cache()
    state = {"active_bundle": "a" * 64, "manifest_sha256": "b" * 64}
    monkeypatch.setattr(wording, "active", lambda root: (state, tmp_path / "adapter"))
    spec = LegacyAtlasSpec(
        template_id="hra-liver-female",
        disease={"profile_id": "liver-cirrhosis", "severity": .7, "contrast": .6},
    )
    yield spec
    wording.clear_cache()


def test_cold_offline_model_uses_semantic_fallback_and_keeps_recipe_input(selected, monkeypatch):
    before = selected.model_dump(mode="json")

    def offline(*args, **kwargs):
        raise OSError("Pinned base model is not cached and the network is unavailable")

    monkeypatch.setattr(trained, "load_adapter", offline)
    result = wording.compile_request(
        ROOT, TEMPLATES, "healthier", selected, {"status": "unsupported"},
    )
    assert result["status"] == "accepted"
    assert result["spec"]["disease"]["severity"] == .56
    assert result["spec"]["disease"]["contrast"] == .48
    assert result["wording_model"]["inference_executed"] is False
    assert result["wording_model"]["model_failure_stage"] == "load"
    assert "built-in compiler" in result["message"]
    assert selected.model_dump(mode="json") == before


def test_invalid_generated_json_can_fall_back_to_an_already_accepted_legacy_edit(selected, monkeypatch):
    monkeypatch.setattr(trained, "load_adapter", lambda *args, **kwargs: (object(), object()))

    def malformed(*args, **kwargs):
        raise ValueError("Plan must be a JSON object")

    monkeypatch.setattr(trained, "predict_plan", malformed)
    legacy = {"status": "accepted", "spec": selected.model_dump(mode="json"), "message": "Set twist to 0.2.", "policy_version": "frozen-shape"}
    legacy["spec"]["controls"]["twist"] = .2
    before = deepcopy(legacy)
    result = wording.compile_request(ROOT, TEMPLATES, "twist 0.2", selected, legacy)
    assert result["status"] == "accepted"
    assert result["spec"] == legacy["spec"]
    assert result["wording_model"]["inference_executed"] is True
    assert result["wording_model"]["model_failure_stage"] == "predict"
    assert legacy == before


def test_valid_model_refusal_never_falls_back_to_an_edit(selected, monkeypatch):
    monkeypatch.setattr(trained, "load_adapter", lambda *args, **kwargs: (object(), object()))
    monkeypatch.setattr(trained, "predict_plan", lambda *args: make_plan(status="clarify", message="Specify the intended appearance."))
    legacy = {"status": "accepted", "spec": selected.model_dump(mode="json"), "message": "Prepared an edit."}
    result = wording.compile_request(ROOT, TEMPLATES, "twist 0.2", selected, legacy)
    assert result["status"] == "clarify"
    assert "spec" not in result
    assert result["wording_model"]["inference_executed"] is True
    assert result["wording_model"]["method"] == "Qwen2.5_LoRA_semantic_plans"


def test_fallback_cannot_turn_an_ungrounded_clause_into_a_partial_edit(selected, monkeypatch):
    def unavailable(*args, **kwargs):
        raise RuntimeError("MPS allocation failed")

    monkeypatch.setattr(trained, "load_adapter", unavailable)
    result = wording.compile_request(
        ROOT, TEMPLATES, "healthier and add a spaceship", selected,
        {"status": "unsupported"},
    )
    assert result["status"] in {"unsupported", "clarify"}
    assert "spec" not in result
    assert result["operations"] == []


def test_adapter_integrity_failure_is_not_hidden_by_inference_fallback(selected, monkeypatch):
    def corrupt(root):
        raise ValueError("Wording source hash mismatch")

    monkeypatch.setattr(wording, "active", corrupt)
    with pytest.raises(ValueError, match="hash mismatch"):
        wording.compile_request(ROOT, TEMPLATES, "healthier", selected, {"status": "unsupported"})


def test_new_selection_releases_old_model_before_loading_its_base(selected, monkeypatch):
    wording._CACHE.update(identity=("old-selection", "old-hash"), model=object(), tokenizer=object())

    def replacement(*args, **kwargs):
        assert not wording._CACHE
        return object(), object()

    monkeypatch.setattr(trained, "load_adapter", replacement)
    monkeypatch.setattr(trained, "predict_plan", lambda *args: make_plan(status="clarify", message="Specify the edit."))
    result = wording.compile_request(ROOT, TEMPLATES, "healthier", selected, {"status": "unsupported"})
    assert result["status"] == "clarify"
    assert wording._CACHE["identity"] != ("old-selection", "old-hash")
