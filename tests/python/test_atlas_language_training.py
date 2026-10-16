"""No network: actual tiny Qwen LoRA optimization and proposal boundary tests."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
import torch
from viscera_core.atlas_scene import AtlasSpec

from pipelines.train.viscera_train import atlas_language as language
from pipelines.train.viscera_train import atlas_shape as storage


class ByteTokenizer:
    pad_token_id = 0

    def apply_chat_template(self, messages, tokenize, add_generation_prompt):
        text = "".join(f"<{m['role']}>\n{m['content']}\n</end>\n" for m in messages)
        if add_generation_prompt:
            text += "<assistant>\n"
        return [byte + 2 for byte in text.encode()] if tokenize else text

    def save_pretrained(self, path):
        Path(path).mkdir(exist_ok=True, parents=True)
        (Path(path) / "tiny_tokenizer.json").write_text('{"type":"test-only-bytes"}')

    def decode(self, tokens, skip_special_tokens):
        return bytes(int(token) - 2 for token in tokens if 2 <= int(token) <= 257).decode(
            errors="replace"
        )


def tiny_factory(cfg, device):
    from transformers import Qwen2Config, Qwen2ForCausalLM

    model = Qwen2ForCausalLM(
        Qwen2Config(
            vocab_size=258,
            hidden_size=16,
            intermediate_size=24,
            num_hidden_layers=1,
            num_attention_heads=2,
            num_key_value_heads=2,
            max_position_embeddings=4096,
            attention_dropout=0.0,
            pad_token_id=0,
            eos_token_id=1,
        )
    ).to(device)
    return model, ByteTokenizer()


@pytest.fixture
def corpus(tmp_path):
    from viscera_core.atlas_language import _code_hashes

    data, parent = tmp_path / "language", tmp_path / "parent"
    data.mkdir()
    parent.mkdir()
    (parent / "release.json").write_text('{"fixture":true}')
    context = AtlasSpec(template_id="fixture-liver").model_dump()
    rows = {}
    hashes = {}
    for split, count in [("train", 3), ("val", 2)]:
        rows[split] = [
            dict(
                example_id=f"{split}-{i}",
                group_id=f"{split}-g{i}",
                parent_sample_id=f"{split}-p{i}",
                split=split,
                text="add a tumor",
                context_spec=context,
                expected_status="unsupported",
                target_spec=None,
            )
            for i in range(count)
        ]
        path = data / f"{split}.jsonl"
        path.write_text("\n".join(language.canonical(row) for row in rows[split]) + "\n")
        hashes[path.name] = storage.digest(path)
    # Intentionally no audit split exists. Training cannot require or open it.
    (data / "release.json").write_text(
        json.dumps(
            dict(
                recipe=dict(
                    parent_release_sha256=storage.digest(parent / "release.json"),
                    semantic_code_hashes=_code_hashes(),
                ),
                artifact_hashes=hashes,
            )
        )
    )
    return data, parent, rows


def test_complete_assistant_mask_and_forbidden_truncation(corpus):
    row = corpus[2]["train"][0]
    encoded = language.encode_row(ByteTokenizer(), row, 4096)
    labels = encoded["labels"]
    assert labels.count(-100) > 100
    assert labels[-1] != -100
    assert [x for x in labels if x != -100] == encoded["input_ids"][labels.count(-100) :]
    with pytest.raises(ValueError, match="truncation"):
        language.encode_row(ByteTokenizer(), row, 10)


def test_tiny_generation_accepts_explicit_cache_after_training(corpus):
    torch.set_num_threads(1)
    model, tokenizer = tiny_factory(language.LanguageConfig(), "cpu")
    model.config.use_cache = False
    output = language.predictions(model, tokenizer, corpus[2]["val"][:1], "cpu")
    assert len(output) == 1 and isinstance(output[0], str)


def test_split_integrity_and_group_isolation(corpus):
    data, _, rows = corpus
    assert len(language.read_split(data, "train")) == 3
    leaked = copy.deepcopy(rows["val"])
    leaked[0]["parent_sample_id"] = rows["train"][0]["parent_sample_id"]
    with pytest.raises(ValueError, match="leakage"):
        language.audit_groups(rows["train"], leaked)
    with (data / "train.jsonl").open("a") as file:
        file.write("\n")
    with pytest.raises(ValueError, match="integrity"):
        language.read_split(data, "train")


def test_strict_proposal_schema_and_no_partial_edits():
    with pytest.raises(ValueError, match="Duplicate"):
        language.strict_json('{"status":"accepted","status":"unsupported"}')
    with pytest.raises(ValueError, match="Nonfinite"):
        language.strict_json('{"x":NaN}')
    spec = AtlasSpec(template_id="fixture").model_dump()
    spec["controls"].pop("bend")
    with pytest.raises(ValueError, match="Every bounded"):
        language.validate_output(dict(status="accepted", spec=spec))
    with pytest.raises(ValueError, match="partial edits"):
        language.validate_output(dict(status="unsupported", spec=spec))


def test_compiler_guard_precedes_any_generation(monkeypatch, tmp_path):
    import viscera_core.atlas as atlas
    import viscera_core.atlas_scene as scene
    import viscera_core.atlas_text as compiler

    context = AtlasSpec(template_id="fixture").model_dump()
    calls = []
    monkeypatch.setattr(compiler, "compile_text", lambda *a: dict(status="unsupported"))
    monkeypatch.setattr(atlas, "generate", lambda *a: calls.append("generated"))
    monkeypatch.setattr(scene, "get_template", lambda *a: calls.append("loaded"))
    with pytest.raises(ValueError, match="disagrees"):
        language.realize_checked(
            dict(status="accepted", spec=context), tmp_path, "add a tumor", context
        )
    assert (
        language.realize_checked(
            dict(status="unsupported", spec=None), tmp_path, "add a tumor", context
        )
        is None
    )
    assert calls == []
    monkeypatch.setattr(compiler, "compile_text", lambda *a: dict(status="accepted", spec=context))
    altered = copy.deepcopy(context)
    altered["controls"]["bend"] = 0.1
    with pytest.raises(ValueError, match="controls disagree"):
        language.realize_checked(
            dict(status="accepted", spec=altered), tmp_path, "select liver", context
        )
    assert calls == []


def test_real_tiny_qwen_lora_exact_resume_and_no_audit(corpus, tmp_path):
    data, parent, _ = corpus
    cfg = language.LanguageConfig(
        steps=4, checkpoint_every=2, maximum_tokens=4096, rank=2, alpha=4, device="cpu"
    )
    full, resumed = tmp_path / "full", tmp_path / "resumed"
    report = language.train_lora(
        data, parent, full, cfg, factory=tiny_factory, generate_validation=False
    )
    language.train_lora(
        data, parent, resumed, cfg, stop_after=2, factory=tiny_factory, generate_validation=False
    )
    continued = language.train_lora(
        data, parent, resumed, cfg, resume=True, factory=tiny_factory, generate_validation=False
    )
    assert report["losses"] == continued["losses"]
    assert report["audit_opened"] is False
    assert report["pretrained_base_loaded"] is False
    assert report["full_base_weights_updated"] is False
    assert report["trainable_parameters"] > 0
    a, b = storage.safe_load(full / "checkpoint.pt"), storage.safe_load(resumed / "checkpoint.pt")
    assert all(torch.equal(a["adapter"][key], b["adapter"][key]) for key in a["adapter"])
    assert all(torch.isfinite(tensor).all() for tensor in a["adapter"].values())
    assert any(
        torch.count_nonzero(tensor) > 0 for key, tensor in a["adapter"].items() if "lora_B" in key
    )
    # A smoke adapter can never be mistaken for the reviewed pretrained Qwen base.
    with pytest.raises(ValueError, match="provenance"):
        language.load_adapter(data, parent, full)
    (parent / "release.json").write_text('{"tampered":true}')
    with pytest.raises(ValueError, match="parent release"):
        language.train_lora(
            data, parent, resumed, cfg, resume=True, factory=tiny_factory, generate_validation=False
        )
