# Anatomy wording v2 training

[Open the uploaded Colab notebook](https://colab.research.google.com/drive/1TO5xXDAlFkdm5cEzZtwU2SZsITLNVH9o) · [Prepared files on Google Drive](https://drive.google.com/drive/u/0/folders/1ZFz4HS8X1IcIaow3eHaOcdnlIHttP9ah). All four files were uploaded and verified in Drive on 7 October 2026.

Open `VISCERA_wording_v2_run_all.ipynb` in Google Colab, select a T4 or A100 GPU, and run all cells. Approve the Drive mount. The notebook locates `MyDrive/VISCERA Wording Training 2026-10-07/viscera-wording-training-v2.zip`, verifies its embedded SHA-256 and every frozen source/data file, creates an isolated environment, tests training, then fine-tunes the public pretrained model. No dataset ID or access token needs editing.

The final download is `viscera-wording-weights.zip`. Keep the local VISCERA studio running and save it to the normal Downloads directory for the wording importer. The same archive and reports remain in the Drive delivery folder. Existing model imports remain separate from this wording adapter.

## What is trained

The base is [`Qwen/Qwen2.5-0.5B-Instruct`](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct), Apache-2.0, pinned to `c89bee90d9f811437d9735454613c35b4a3c4dc8`. Rank-16 LoRA updates attention and MLP projections. Two epochs use the complete train partition, completion-only cross entropy, dynamic padding, gradient accumulation and checkpointing. Effective batch size is 32. A100 uses bf16; T4 uses fp16 with gradient scaling. The notebook installs the official PyTorch 2.8.0 CUDA 12.6 wheel and frozen dependencies in its own virtual environment.

Targets are `atlas-semantic-1` edit plans. The model can propose supported wording beyond the deterministic parser's phrases. Plans still pass source-intent, preservation, range, profile, and geometry validation at application time. Health words describe changes to authored disease appearance. They do not establish biological recovery, diagnosis, or surgical feasibility.

The supervision is authored synthetic text and recipe contexts. Rows are not patient observations or clinician-reviewed annotations. Phrase families and normalized exact prompts separate train, validation and audit partitions. A separately authored regression challenge never enters gradient updates. Its use during implementation review is disclosed; it is not presented as a blind clinical study.

## Checkpoints and acceptance

Training saves the LoRA, optimizer, scaler, random generators, data order and cursor to Drive every 100 optimizer steps. Reconnect to a GPU and run all again after a Colab interruption. Resume rejects changed dataset, source, configuration or dependency identities.

Training reads only train and validation. Before updates, it measures the frozen pretrained base on 96 stratified validation prompts; the training report compares the fine-tuned model on exactly those prompts and reports accuracy changes. Final evaluation generates complete plans without teacher forcing on 1,024 stratified audit examples and the independent challenge. It scores both raw model plans and the plans after the same source-text guard used in the runtime. Required thresholds include:

- Audit: at least 99% valid plans, 98% correct status, 92% exact operations, no false acceptance of unsupported/clarification requests, and at least 85% exact operations per represented organ.
- Challenge: at least 90% exact operations and no false acceptance; insufficient audit/challenge coverage also fails.
- Only complete pretrained runs with at least 10,000 training examples can export. Random tiny models are ineligible.

A failed gate downloads the evaluation report and does not promote weights. Validation can inform a revised training release; the final audit must not become a tuning set. Export binds the evaluation to the exact adapter files, training report, dataset release and source hashes. The archive contains inert safetensors, tokenizer/configuration files, provenance and reports, with no checkpoint pickle or executable source.

## Verification and limits

The local test suite performs actual tiny Qwen LoRA optimizer updates, requires loss decrease, and compares interrupted/resumed weights bit for bit. It also tests partition leakage, complete target masking, invalid-plan scoring, inert tokenizer artifacts, stale-evaluation rejection and failed-promotion rejection. A separate local test loaded the actual pinned pretrained Qwen model and completed two optimizer updates; this verifies the pretrained integration, not generalization.

The full GPU training run and its final held-out accuracy are produced when the notebook runs. No untrained or smoke model is represented as a finished language improvement. CUDA execution on a Colab T4/A100 has not been measured locally. Run duration depends on the assigned GPU and Colab session limits.

Source: `pipelines/train/viscera_train/atlas_wording.py`; delivery builder: `scripts/package_wording_colab.py`; tests: `tests/python/test_atlas_wording_training.py`.

## Colab environment repair — 7 October 2026

The original setup could fail before training when `venv` could not bootstrap pip, and a retry could mistake the remaining Python executable for a complete environment. The corrected notebook creates or repairs the environment with `venv --without-pip`, checks its isolation, and uses the existing Colab pip to install pip 25.2 into that environment if needed. This follows [Python venv](https://docs.python.org/3/library/venv.html) and [pip’s target-interpreter support](https://pip.pypa.io/en/stable/topics/python-option/). Failure messages retain subprocess output. Existing environment files and Drive checkpoints are preserved.

Three regression cases and a real local Python 3.13 partial-environment repair/rerun passed. The source/dataset ZIP and model contract remain unchanged; only notebook setup and delivery metadata changed. The same Colab URL now opens the repaired version.

Live Colab verification after the repair also passed: the complete dependency/setup cell and CUDA assertion completed on the A100 runtime, followed by eight actual tiny-LoRA optimizer steps with decreasing loss and exact checkpoint resume. The full training cell subsequently started and was left running; its eventual quality gates are still pending.
