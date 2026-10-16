"""Guarded serving tests use a fake loader: no pretrained model/network claim."""

from __future__ import annotations

import copy
import json
from dataclasses import asdict

import pytest
from viscera_core import atlas_text
from viscera_core.atlas_disease_scene import DiseaseAtlasSpec
from viscera_core.atlas_language import _code_hashes
from viscera_core.atlas_materials import make_recipe

from pipelines.train.viscera_train import atlas_language as language
from services.api import atlas_language_model as serving


class Tokenizer:
    def apply_chat_template(self, *args, **kwargs):
        return [1] * 12


@pytest.fixture
def environment(tmp_path, monkeypatch):
    serving.clear_cache()
    templates, adapter, data, parent = [
        tmp_path / n for n in ("templates", "model", "language", "shape")
    ]
    for path in (templates, adapter / "adapter", data, parent):
        path.mkdir(parents=True)
    (parent / "release.json").write_text('{"fixture":true}')
    (data / "release.json").write_text(
        json.dumps(
            {
                "recipe": {
                    "parent_release_sha256": serving._digest(parent / "release.json"),
                    "semantic_code_hashes": _code_hashes(),
                }
            }
        )
    )
    weights = adapter / "adapter/adapter_model.safetensors"
    weights.write_bytes(b"fake-loader fixture; not actual tensors")
    manifest = {
        "identity": {
            "format": language.FORMAT,
            "tiny_fixture": False,
            "source_sha256": serving._digest(__import__("pathlib").Path(language.__file__)),
            "language_release_sha256": serving._digest(data / "release.json"),
            "parent_release_sha256": serving._digest(parent / "release.json"),
            "config": asdict(language.LanguageConfig()),
        },
        "artifact_hashes": {"adapter/adapter_model.safetensors": serving._digest(weights)},
    }
    (adapter / "adapter_manifest.json").write_text(json.dumps(manifest))
    loaded = []
    generated = []

    def loader(*args):
        loaded.append(args)
        return object(), Tokenizer()

    def compile_text(root, text, spec):
        if text == "add a tumor":
            return {"status": "unsupported", "message": "unsupported shape request"}
        target = copy.deepcopy(spec.model_dump())
        target["controls"]["scale_x"] = 0.25
        target["template_sha256"] = None
        target["realized_id"] = None
        if text == "select kidney":
            target["template_id"] = "fixture-kidney"
        if text == "clay appearance":
            target["appearance"] = "clay"
        return {"status": "accepted", "spec": target, "message": "fixture authoritative intent"}

    def predictions(model, tokenizer, rows, device):
        generated.extend(rows)
        spec = __import__(
            "viscera_core.atlas_scene", fromlist=["AtlasSpec"]
        ).AtlasSpec.model_validate(rows[0]["context_spec"])
        expected = compile_text(templates, rows[0]["text"], spec)
        return [language.canonical({"status": expected["status"], "spec": expected.get("spec")})]

    monkeypatch.setattr(serving, "_default_loader", loader)
    monkeypatch.setattr(atlas_text, "compile_text", compile_text)
    monkeypatch.setattr(language, "predictions", predictions)
    context = DiseaseAtlasSpec(
        template_id="fixture-liver",
        material=make_recipe("liver"),
        disease={"profile_id": "liver-hcc"},
    ).model_dump()
    yield {
        "args": (templates, adapter, data, parent),
        "context": context,
        "loaded": loaded,
        "generated": generated,
        "weights": weights,
    }
    serving.clear_cache()


def test_no_model_load_until_explicit_enable(environment):
    e = environment
    with pytest.raises(ValueError, match="Enable"):
        serving.compile_with_adapter(*e["args"], "make wider", e["context"], device="cpu")
    assert not e["loaded"] and not e["generated"]
    status = serving.enable_adapter(*e["args"], allow_model_download=True, device="cpu")
    assert status["status"] == "enabled_guarded_shape_adapter"
    assert len(e["loaded"]) == 1 and not e["generated"]
    serving.enable_adapter(*e["args"], device="cpu")
    assert len(e["loaded"]) == 1


def test_exactly_guarded_shape_edit_preserves_material_and_disease(environment):
    e = environment
    serving.enable_adapter(*e["args"], allow_model_download=True, device="cpu")
    result = serving.compile_with_adapter(*e["args"], "make wider", e["context"], device="cpu")
    assert result["status"] == "accepted" and result["adapter"]["guard"] == "passed"
    assert result["spec"]["controls"]["scale_x"] == 0.25
    for field in ("material", "disease"):
        assert result["spec"][field] == e["context"][field]
    assert e["context"]["controls"]["scale_x"] == 0
    assert "material" not in e["generated"][0]["context_spec"]
    assert "disease" not in e["generated"][0]["context_spec"]


def test_rendered_context_clears_only_derived_identifiers_before_prediction(environment):
    e = environment
    current = copy.deepcopy(e["context"])
    current["template_sha256"] = "a" * 64
    current["realized_id"] = "b" * 64
    snapshot = copy.deepcopy(current)
    serving.enable_adapter(*e["args"], allow_model_download=True, device="cpu")
    result = serving.compile_with_adapter(*e["args"], "make wider", current, device="cpu")
    assert result["status"] == "accepted" and current == snapshot
    assert result["adapter"]["derived_identifiers_cleared"] == ["template_sha256", "realized_id"]
    predicted_context = e["generated"][0]["context_spec"]
    assert predicted_context == {
        key: None if key in {"template_sha256", "realized_id"} else value
        for key, value in snapshot.items()
        if key not in {"material", "disease"}
    }
    assert result["spec"]["template_sha256"] is None
    assert result["spec"]["realized_id"] is None
    for field in ("material", "disease"):
        assert result["spec"][field] == snapshot[field]


@pytest.mark.parametrize("text", ["add a tumor", "select kidney", "clay appearance"])
def test_unsupported_requests_do_not_load_or_generate(environment, text):
    e = environment
    result = serving.compile_with_adapter(*e["args"], text, e["context"], device="cpu")
    assert result["status"] == "unsupported" and result["spec"] is None
    assert not e["loaded"] and not e["generated"]


@pytest.mark.parametrize(
    "proposal",
    ["not JSON", '{"status":"accepted","spec":null}', '{"status":"unsupported","spec":null}'],
)
def test_invalid_or_disagreeing_prediction_never_falls_back_to_applying_edit(
    environment, monkeypatch, proposal
):
    e = environment
    serving.enable_adapter(*e["args"], allow_model_download=True, device="cpu")
    monkeypatch.setattr(language, "predictions", lambda *a: [proposal])
    result = serving.compile_with_adapter(*e["args"], "make wider", e["context"], device="cpu")
    assert result["status"] == "unsupported" and result["spec"] is None
    assert result["adapter"]["guard"] == "rejected"


def test_cached_adapter_cannot_bypass_changed_weight_integrity(environment):
    e = environment
    serving.enable_adapter(*e["args"], allow_model_download=True, device="cpu")
    e["weights"].write_bytes(b"tampered adapter")
    with pytest.raises(ValueError, match="integrity"):
        serving.compile_with_adapter(*e["args"], "make wider", e["context"], device="cpu")
    assert len(e["loaded"]) == 1 and not e["generated"]


def test_cache_clear_requires_explicit_reenable(environment):
    e = environment
    serving.enable_adapter(*e["args"], allow_model_download=True, device="cpu")
    assert serving.is_adapter_enabled(*e["args"][1:], device="cpu")
    serving.clear_cache()
    assert not serving.is_adapter_enabled(*e["args"][1:], device="cpu")
    with pytest.raises(ValueError, match="Enable"):
        serving.compile_with_adapter(*e["args"], "make wider", e["context"], device="cpu")


def test_adapter_subdirectory_symlink_rejected_before_loading(environment):
    e = environment
    adapter = e["args"][1]
    external = adapter.parent / "external-adapter"
    (adapter / "adapter").rename(external)
    (adapter / "adapter").symlink_to(external, target_is_directory=True)
    with pytest.raises(ValueError, match="file set"):
        serving.enable_adapter(*e["args"], allow_model_download=True, device="cpu")
    assert not e["loaded"]


def test_complete_token_budget_checked_before_generation(environment, monkeypatch):
    e = environment
    serving.enable_adapter(*e["args"], allow_model_download=True, device="cpu")
    monkeypatch.setattr(Tokenizer, "apply_chat_template", lambda *a, **kw: [1] * 2049)
    with pytest.raises(ValueError, match="token budget"):
        serving.compile_with_adapter(*e["args"], "make wider", e["context"], device="cpu")
    assert not e["generated"]
