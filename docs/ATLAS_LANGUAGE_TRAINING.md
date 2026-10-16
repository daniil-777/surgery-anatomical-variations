# Optional atlas language adapter

The studio's operational text path uses the conservative atlas compiler. This separate optional workflow learns to propose its structured outputs from the current complete atlas state and an instruction. It does not train a text-to-mesh foundation model or replace the compiler.

`datasets/atlas/language-v1` contains paired compiler requests and measured target recipes derived from `cohort-v2`. Every derivative inherits its parent geometry's group and split. This prevents recipe derivatives crossing train/validation boundaries, but it is not an independent patient or human-language holdout. Unsupported requests are retained with `status:unsupported,spec:null`.

## Model and training contract

- Base: [Qwen/Qwen2.5-0.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct/tree/c89bee90d9f811437d9735454613c35b4a3c4dc8), exact revision `c89bee90d9f811437d9735454613c35b4a3c4dc8`, [Apache-2.0](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct/raw/c89bee90d9f811437d9735454613c35b4a3c4dc8/LICENSE).
- Frozen base weights; only LoRA `q_proj`/`v_proj` adapters are optimized. Default rank 8, alpha 16, dropout 0, learning rate 0.0002, 200 optimizer steps. These are initial experiment settings, not validated optimal settings.
- The individually hashed `train.jsonl` and `val.jsonl` are parsed; neither `audit.jsonl` nor the combined `pairs.jsonl` is read by training.
- Full contextual state is supplied. Prompt tokens are masked, and every assistant target token is supervised. Any row exceeding the complete token budget fails; no silently truncated JSON targets.
- Resume binds exact data releases, train/validation bytes, source, immutable base, configuration, Python/PyTorch/NumPy/Transformers/PEFT/tokenizer versions, device and random state. The tiny CPU fixture verifies exact interrupted/resumed adapter tensors and loss equality.
- Safe checkpoint loading uses a checksum sidecar and `weights_only=True`. Exported adapters use safetensors; inference checks all adapter artifacts and provenance before loading. Checksums detect corruption; they are not signatures from a trusted publisher.
- The frozen base and adapter share the same deterministic, organ/status-balanced validation subset. Reports include schema validity, status accuracy, exact compiler agreement, false accept counts and per-organ counts. This is a small monitoring subset; it cannot establish general language quality.

## Guarded inference

`guard_proposal(...)` requires strict JSON without duplicate keys or nonfinite values, exactly `status` and `spec`, all seven bounded controls, complete AtlasSpec fields, and agreement with the authoritative compiler. It checks template, appearance, seed and source state, not just numeric bounds. Controls must agree within 1e-8. Rejected proposals never reach geometry realization. Accepted proposals return the compiler's exact canonical result; the model does not get to bypass the compiler's intent boundary.

`realize_checked(...)` adds real high-resolution geometry generation and surface QA after the guard. Neither this numerical QA nor compiler agreement establishes medical realism, pathology coverage, or tissue mechanics. The runtime does not automatically load or promote adapters. In particular, a model that produces approximate JSON/control values may be rejected frequently; the validation report makes this failure visible.

## Run

Open `notebooks/VISCERA_atlas_text_to_spec_training.ipynb` from the atlas bundle. Its default inspection mode does not download base weights. Set `RUN_TRAINING=True` on a GPU to start the optional experiment. A pinned requirements export is generated from the preserved project lock and includes Transformers 4.57.1, PEFT 0.17.1 and Accelerate 1.10.1.

Alternatively, from `viscera/` with `PYTHONPATH=py:.`:

```sh
python -m pipelines.train.viscera_train.atlas_language \
  --data datasets/atlas/language-v1 --parent datasets/atlas/cohort-v2 \
  --out artifacts/atlas/language-colab-run-v1 --steps 200 --device cuda
```

Use the identical command with `--resume` after interruption. A changed source, config or environment requires a fresh run directory. The optional notebook leaves audit examples closed; a selected adapter must be frozen before a future one-time audit.

## Delivery evidence

Actual local tests use a randomly initialized tiny Qwen2 model and a test-only byte tokenizer. Real PEFT LoRA optimization, finite adapter updates, full-target masking, exact resume, split integrity and strict proposal boundaries are exercised without downloading pretrained weights. Tiny model outputs are not a usable language model.

Full pretrained Qwen LoRA training, a learned-language audit, GPU Colab execution, and independent human-language generalization are **NOT_RUN**. The delivered geometry/control model has a separate frozen training and audit report; these language tests do not change or reuse its audit for model selection.
