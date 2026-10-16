"""Generate the optional atlas-specific text-to-spec LoRA Colab notebook."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def cell(kind: str, source: str) -> dict[str, Any]:
    value: dict[str, Any] = {"cell_type": kind, "metadata": {}, "source": source.strip() + "\n"}
    if kind == "code":
        value.update(execution_count=None, outputs=[])
    return value


def build() -> Path:
    geometry = json.loads((ROOT / "notebooks/VISCERA_atlas_dataset_and_training.ipynb").read_text())
    setup = geometry["cells"][2]
    install = geometry["cells"][4]
    install["source"] = install["source"].replace(
        "requirements-colab.txt", "requirements-atlas-language-colab.txt"
    )
    cells = [
        cell(
            "markdown",
            """
# VISCERA · Optional atlas text-to-spec adapter

This separate research workflow trains **LoRA adapters** on paired requests and
complete, bounded atlas specifications. It uses the immutable Apache-2.0
[Qwen2.5-0.5B-Instruct revision](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct/tree/c89bee90d9f811437d9735454613c35b4a3c4dc8).
The base weights stay frozen. This is **not** a text-to-mesh foundation model.

The operational studio already uses a conservative deterministic compiler.
Learned outputs remain untrusted proposals: strict JSON, complete schema,
compiler agreement and geometry QA are required before realization. A model that
fails to exactly preserve state or requested controls will be rejected.

The local delivery exercised actual tiny-Qwen LoRA optimization and exact resume
on CPU. **Training the full pretrained Qwen adapter and GPU Colab execution are
NOT_RUN locally.** This notebook supplies that optional next experiment. It never
automatically replaces the studio compiler or promotes an adapter.

## 1 · Load the bundle
Upload `viscera-atlas-colab.zip`, or run from an extracted `viscera` folder.
""",
        ),
        setup,
        cell(
            "markdown",
            """
## 2 · Install pinned dependencies
Use Python 3.11 or 3.12. Select a GPU runtime for the pretrained-model experiment.
The exact lock pins Transformers 4.57.1, PEFT 0.17.1 and Accelerate 1.10.1.
The download includes approximately 1 GB of base weights from the pinned revision.
""",
        ),
        install,
        cell(
            "code",
            """
from pipelines.train.viscera_train import atlas_language as language
from pipelines.train.viscera_train import atlas_shape as storage
from viscera_core.atlas_dataset import verify_release

PARENT = ROOT / "datasets/atlas/cohort-v2"
DATA = ROOT / "datasets/atlas/language-v1"
OUT = ROOT / "artifacts/atlas/language-colab-run-v1"
verify_release(PARENT)
release = language.verify_contract(DATA, PARENT)
train = language.read_split(DATA, "train")
val = language.read_split(DATA, "val")
language.audit_groups(train, val)
print("Parent release:", json.loads((PARENT / "release.json").read_text())["release_id"])
print("Language rows:", {"train": len(train), "val": len(val)})
print("Audit examples have not been parsed.")
print("Context:", train[0]["context_spec"])
print("Request:", train[0]["text"])
print("Target:", language.target(train[0]))
""",
        ),
        cell(
            "markdown",
            """
##  · Train the optional adapter
The train/validation/audit partitions inherit geometry parent groups. Rendering
or paraphrasing a parent cannot move its descendants into another partition.
These are synthetic compiler-generated requests, not independent human language.

The trainer masks prompt tokens and supervises the **entire** assistant answer.
It rejects truncation, validates every row, uses safe checkpoint weights, and
binds resume to exact sources, data, device, dependency versions and configuration.
Baseline and adapter are evaluated on the same organ/status-balanced validation
examples. Invalid proposals are counted and never applied to geometry.

Leave `RUN_TRAINING = False` to inspect the data and compiler without downloading
weights. Change it to `True` to start the optional experiment on a GPU. A 200-step
run is an initial research experiment; it is not a demonstrated quality target.
""",
        ),
        cell(
            "code",
            """
RUN_TRAINING = False
CONFIG = language.LanguageConfig(steps=200, checkpoint_every=25, validation_limit=24,
                                 maximum_tokens=2048, device="cuda")
if RUN_TRAINING:
    if not torch.cuda.is_available():
        raise RuntimeError("Select a GPU runtime for this optional pretrained-model experiment")
    report = language.train_lora(DATA, PARENT, OUT, CONFIG,
                                 resume=(OUT / "checkpoint.pt").is_file())
    print(json.dumps({k: v for k, v in report.items() if k != "losses"}, indent=2))
    print("Frozen-base validation:")
    print((OUT / "frozen_base_validation.json").read_text())
else:
    print("Pretrained Qwen adapter training: NOT_RUN. Dataset/compiler inspection remains available.")
""",
        ),
        cell(
            "markdown",
            """
## 4 · Inspect the strict geometry boundary
This cell exercises the real paired target through the same guard used for model
proposals. The guard checks every state field against the deterministic compiler
before high-resolution realization. It is not evidence that a language model
produced this answer. Only the measured high-resolution atlas decoder determines
geometry; text output can never inject code or arbitrary topology.
""",
        ),
        cell(
            "code",
            """
example = next(row for row in val if row["expected_status"] == "accepted")
proposal = language.canonical(language.target(example))
checked = language.guard_proposal(proposal, PARENT / "templates", example["text"], example["context_spec"])
sample = language.realize_checked(proposal, PARENT / "templates", example["text"], example["context_spec"])
print("Paired compiler target:", example["text"])
print("Checked status:", checked["status"], "Surface QA:", sample.qa)
print("Measurements:", sample.measurements)
""",
        ),
        cell(
            "markdown",
            """
## 5 · Inspect learned proposals without automatic promotion
The loader verifies every adapter file and its source/dataset provenance before
loading safe weights. Proposed text is checked; disagreement is reported as a
rejection. No checkpoint is automatically installed into the studio.
""",
        ),
        cell(
            "code",
            """
if RUN_TRAINING:
    model, tokenizer = language.load_adapter(DATA, PARENT, OUT, device="cuda")
    proposals = language.predictions(model, tokenizer, [example], "cuda")
    print("Learned proposal:", proposals[0])
    try:
        print("Guard result:", language.guard_proposal(proposals[0], PARENT / "templates",
                                                       example["text"], example["context_spec"]))
    except (ValueError, TypeError, KeyError) as error:
        print("REJECTED; no geometry was generated:", str(error))
else:
    print("Learned inference: NOT_RUN")
""",
        ),
        cell(
            "markdown",
            """
## 6 · Preserve evidence
The training path never reads audit examples. Freeze the chosen adapter and
validation decision before any future audit evaluation. This notebook intentionally
leaves audit closed. Report schema validity, supported/unsupported decisions,
compiler semantic agreement and per-organ results; do not infer language or
clinical generalization from synthetic policy replication.

The geometry source licenses and lineage limitations still apply. Mechanical
material calibration, pathological variation, internal anatomy and scanned-tissue
textures are outside this release. See `docs/ATLAS_LANGUAGE_TRAINING.md`.
""",
        ),
        cell(
            "code",
            """
if RUN_TRAINING:
    import shutil
    archive = shutil.make_archive(str(OUT), "zip", OUT)
    print("Saved unpromoted adapter and metrics:", archive)
    if "google.colab" in sys.modules:
        from google.colab import files
        files.download(archive)
""",
        ),
    ]
    nb = {
        "cells": cells,
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python", "version": "3.11.16"},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    output = ROOT / "notebooks/VISCERA_atlas_text_to_spec_training.ipynb"
    output.write_text(json.dumps(nb, indent=2) + "\n")
    return output


if __name__ == "__main__":
    print(build())
