"""Real optional HF integration, using random tiny local weights and no Hub access."""

import json

import pytest
import torch

from pipelines.train.viscera_train import language


def test_real_qwen_lora_masked_update_checkpoint_reload_and_generation(tmp_path, monkeypatch):
    transformers = pytest.importorskip("transformers")
    peft = pytest.importorskip("peft")
    tokenizers = pytest.importorskip("tokenizers")
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    monkeypatch.setenv("TRANSFORMERS_OFFLINE", "1")
    torch.set_num_threads(2)
    base_dir, data, out = tmp_path / "tiny-random-base", tmp_path / "data", tmp_path / "run"
    vocab = {
        token: i
        for i, token in enumerate(
            (
                "<pad>",
                "<bos>",
                "<eos>",
                "<unk>",
                "ready",
                "patches",
                "status",
                "replace",
                "value",
                "path",
                "liver",
                "width",
                "mm",
                "220",
            )
        )
    }
    raw = tokenizers.Tokenizer(tokenizers.models.WordLevel(vocab, unk_token="<unk>"))
    raw.pre_tokenizer = tokenizers.pre_tokenizers.Whitespace()
    tokenizer = transformers.PreTrainedTokenizerFast(
        tokenizer_object=raw,
        pad_token="<pad>",
        bos_token="<bos>",
        eos_token="<eos>",
        unk_token="<unk>",
    )
    tokenizer.chat_template = (
        "{% for message in messages %}{{ '<' + message['role'] + '> ' + message['content'] + ' ' }}{% endfor %}"
        "{% if add_generation_prompt %}{{ '<assistant> ' }}{% endif %}"
    )
    tokenizer.save_pretrained(base_dir)
    config = transformers.Qwen2Config(
        vocab_size=len(vocab),
        hidden_size=32,
        intermediate_size=64,
        num_hidden_layers=1,
        num_attention_heads=4,
        num_key_value_heads=2,
        max_position_embeddings=2048,
        bos_token_id=1,
        eos_token_id=2,
        pad_token_id=0,
    )
    torch.manual_seed(198)
    base = transformers.Qwen2ForCausalLM(config)
    base.save_pretrained(base_dir, safe_serialization=True)
    language.prepare_data(data, (8, 2, 2))
    row = language.read_rows(data, "train")[0]
    encoded = language.tokenize_row(tokenizer, row)
    prefix = len(
        tokenizer.apply_chat_template(
            language.prompt(row), tokenize=True, add_generation_prompt=True
        )
    )
    assert encoded["labels"][:prefix] == [-100] * prefix
    assert encoded["labels"][prefix:] == encoded["input_ids"][prefix:]
    assert len(encoded["input_ids"]) > prefix
    report = language.train_lora(data, out, str(base_dir), "0" * 40, steps=2, device="cpu")
    assert report["step"] == 2
    assert len(report["losses"]) == 2 and all(torch.isfinite(torch.tensor(report["losses"])))
    assert (out / "adapter/adapter_model.safetensors").exists()
    reloaded = peft.PeftModel.from_pretrained(base, out / "adapter")
    # LoRA B is initialized to zero. Nonzero B proves a real gradient update.
    assert any(
        torch.count_nonzero(p) > 0 for name, p in reloaded.named_parameters() if "lora_B" in name
    )
    reloaded.eval()
    ids = torch.tensor([encoded["input_ids"][:prefix]])
    with torch.inference_mode():
        generated = reloaded.generate(
            ids,
            attention_mask=torch.ones_like(ids),
            max_new_tokens=4,
            do_sample=False,
            pad_token_id=2,
        )
    assert generated.shape[1] > ids.shape[1]
    from pipelines.train.viscera_train.shape import safe_load

    checkpoint = safe_load(out / "checkpoint.pt")
    assert checkpoint["step"] == 2 and checkpoint["optimizer"]["state"]
    for key, tensor in checkpoint["adapter"].items():
        assert torch.equal(tensor, reloaded.state_dict()[key])
    assert any(
        torch.count_nonzero(t) > 0 for key, t in checkpoint["adapter"].items() if "lora_B" in key
    )
    with pytest.raises(ValueError, match="Existing language run"):
        language.train_lora(data, out, str(base_dir), "0" * 40, steps=2, device="cpu")
    resumed_out = tmp_path / "resumed"
    partial = language.train_lora(
        data, resumed_out, str(base_dir), "0" * 40, steps=2, device="cpu", stop_after=1
    )
    assert partial["status"] == "interrupted"
    assert not (resumed_out / "adapter").exists()
    with pytest.raises(ValueError, match="complete"):
        language.evaluate_lora(data, resumed_out)
    continued = language.train_lora(
        data, resumed_out, str(base_dir), "0" * 40, steps=2, device="cpu", resume=True
    )
    resumed_checkpoint = safe_load(resumed_out / "checkpoint.pt")
    assert continued["wall_time_s"] >= partial["wall_time_s"]
    assert checkpoint["losses"] == resumed_checkpoint["losses"]
    assert checkpoint["cursor"] == resumed_checkpoint["cursor"]
    assert torch.equal(checkpoint["order"], resumed_checkpoint["order"])
    for key in checkpoint["adapter"]:
        assert torch.equal(checkpoint["adapter"][key], resumed_checkpoint["adapter"][key])
    evaluation = language.evaluate_lora(data, out)
    assert evaluation["attempted"] == 2
    assert set(("compiler", "frozen", "adapter")) <= set(evaluation)
    for method in ("compiler", "frozen", "adapter"):
        assert evaluation[method]["attempted"] == 2
    assert json.loads((out / "test_evaluation.json").read_text())["promotion"].startswith("NONE")
    changed_data = tmp_path / "changed-data"
    language.prepare_data(changed_data, (8, 2, 2), seed=938)
    with pytest.raises(ValueError, match="trained language release"):
        language.evaluate_lora(changed_data, out)
    tokenizer_file = out / "adapter/tokenizer.json"
    tokenizer_file.write_text(tokenizer_file.read_text() + "\n")
    with pytest.raises(ValueError, match="checksum"):
        language.evaluate_lora(data, out)
