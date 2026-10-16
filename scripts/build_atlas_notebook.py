"""Generate a standalone, reviewable atlas Colab workflow without legacy edits."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def cell(kind: str, source: str) -> dict[str, Any]:
    value: dict[str, Any] = {
        "cell_type": kind,
        "metadata": {},
        "source": source.strip() + "\n",
    }
    if kind == "code":
        value.update(execution_count=None, outputs=[])
    return value


def build() -> Path:
    cells = [
        cell(
            "markdown",
            """
# VISCERA · Atlas-preserving anatomy dataset and training

This workflow uses the downloaded **Human Reference Atlas (CC BY 4.0)** and
**BodyParts3D (official archive, CC BY 4.0)** templates. It preserves their detailed
geometry while learning bounded, template-specific deformation controls.

The dataset contains synthetic variations of a small number of source lineages.
A new random seed is **not a new patient**. Validation and audit measure held-out
synthetic recipes. These models do not establish clinical realism, calibrated
population frequencies, wet tissue texture, or measured biomechanics.

The workflow compares a template mean, nearest reference, ridge baseline, and a
small conditional neural model. Neural weights are promoted only when validation
improves by at least 2% and no organ's control error worsens by more than 10%.
All meshes still pass the independent geometry decoder's checks.

Sources: [HRA](https://humanatlas.io/3d-reference-library),
[BodyParts3D](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/download.html).
Attributions and exact source hashes are retained inside the dataset templates.
""",
        ),
        cell(
            "markdown",
            """
## 1 · Load the project bundle

Upload `viscera-atlas-colab.zip`, created with `python scripts/package_atlas_colab.py`.
It includes the new source, hashed dependency lock, notebook and atlas release.
No training is performed on the frozen legacy eight-parameter model. On a local
checkout this cell simply detects the `viscera` directory and uses it.
""",
        ),
        cell(
            "code",
            """
from pathlib import Path
import json, os, stat, sys, zipfile

candidates = [Path.cwd(), Path.cwd() / "viscera", Path("/content/viscera")]
ROOT = next((p for p in candidates if (p / "pipelines/train/viscera_train/atlas_shape.py").is_file()), None)
if ROOT is None:
    from google.colab import files
    uploaded = files.upload()
    archives = [Path(name) for name in uploaded if name.endswith(".zip")]
    if len(archives) != 1:
        raise ValueError("Upload one VISCERA atlas bundle ZIP")
    target = Path("/content").resolve()
    with zipfile.ZipFile(archives[0]) as archive:
        if sum(member.file_size for member in archive.infolist()) > 2_000_000_000:
            raise ValueError("Unexpectedly large bundle")
        for member in archive.infolist():
            path = (target / member.filename).resolve()
            if not path.is_relative_to(target) or stat.S_ISLNK(member.external_attr >> 16):
                raise ValueError("Unsafe archive member")
        archive.extractall(target)
    ROOT = target / "viscera"
if not (ROOT / "pipelines/train/viscera_train/atlas_shape.py").is_file():
    raise FileNotFoundError("Bundle lacks atlas trainer")
os.chdir(ROOT)
sys.path[:0] = [str(ROOT), str(ROOT / "py")]
print("Project:", ROOT)
""",
        ),
        cell(
            "markdown",
            """
## 2 · Install the checked dependency lock

Python 3.11 or 3.12 is required by the project. A Colab CPU runtime is sufficient
for this compact control model; a GPU is optional. CPU and GPU results are not
promised to be bitwise equal. Exact resume requires the same device, runtime,
source, dataset and configuration.
""",
        ),
        cell(
            "code",
            """
import subprocess
if not ((3, 11) <= sys.version_info[:2] < (3, 13)):
    raise RuntimeError("Use a Python 3.11 or 3.12 runtime")
IN_COLAB = "google.colab" in sys.modules
if IN_COLAB:
    subprocess.run([sys.executable, "-m", "pip", "install", "--require-hashes",
                    "-r", str(ROOT / "notebooks/requirements-colab.txt")], check=True)
import numpy as np
import torch
print("Python", sys.version.split()[0], "NumPy", np.__version__, "PyTorch", torch.__version__)
""",
        ),
        cell(
            "markdown",
            """
## 3 · Verify the immutable dataset and inspect coverage

The bundle includes `datasets/atlas/cohort-v2`. If only templates were packaged,
this cell creates an original, separately versioned release with 64 variations
per template, 1,024 surface points per variation and grouped 70/15/15 splits.
The point clouds are auxiliary research data; the final decoder preserves the
full template resolution. Volume and compactness remain masked for display
assemblies lacking validated closed tissue envelopes.
""",
        ),
        cell(
            "code",
            """
from viscera_core.atlas_dataset import create_dataset, verify_release
from pipelines.train.viscera_train import atlas_shape

DATASET = ROOT / "datasets/atlas/cohort-v2"
if not (DATASET / "release.json").exists():
    create_dataset(ROOT / "datasets/atlas/templates-v2", DATASET,
                   count_per_template=64, seed=20261006, point_count=1024)
release = verify_release(DATASET)
train_rows = atlas_shape.read_split(DATASET, "train")
val_rows = atlas_shape.read_split(DATASET, "val")
atlas_shape.audit_splits(train_rows, val_rows)
print("Release:", release.get("release_id"))
print("Training recipes:", len(train_rows["controls"]), "Validation:", len(val_rows["controls"]))
print("Organs:", train_rows["organ_names"].tolist())
print("Templates:", sorted(set(train_rows["template_ids"])))
print("Observed training targets:", dict(zip(train_rows["condition_names"],
                                            train_rows["condition_mask"].sum(0).tolist())))
""",
        ),
        cell(
            "markdown",
            """
## 4 · Train and compare against simple baselines

The training command reads **only train and validation** arrays. Feature
normalization uses training values only, missing conditions have explicit masks,
and mini-batches balance organs and templates. Each checkpoint includes optimizer
and random states for exact continuation. Re-running this cell resumes the same
run; use a new output directory for a changed configuration.
""",
        ),
        cell(
            "code",
            """
OUT = ROOT / "artifacts/atlas/colab-run-v1"
CONFIG = atlas_shape.TrainConfig(steps=2000, batch_size=128, hidden=128,
                                checkpoint_every=100, device="auto", seed=6143)
report = atlas_shape.train(DATASET, OUT, CONFIG, resume=(OUT / "checkpoint.pt").exists())
print("Selected method:", report["selected_method"])
for method, metrics in report["comparisons"].items():
    print(method, "macro template normalized control RMSE:",
          round(metrics["macro_template_control_nrmse"], 5))
print("Neural promotion:", report["promotion"])
""",
        ),
        cell(
            "markdown",
            """
## 5 · Decode and measure the selected validation model

This measures actual high-resolution generated geometry, not a learned metric
proxy. Unavailable physical targets remain unavailable. An attractive rendering
is not evidence of validated mechanics.
""",
        ),
        cell(
            "code",
            """
decoder = atlas_shape.make_geometry_decoder(DATASET / "templates")
validation = atlas_shape.evaluate(DATASET, OUT / "model.pt", "val", decoder)
atlas_shape.atomic_json(OUT / "validation_geometry.json", validation)
print(json.dumps(validation["decoded_geometry"], indent=2))
""",
        ),
        cell(
            "markdown",
            """
## 6 · Freeze the model, then run the one-time synthetic audit

This audit is a held-out seed test within the same atlas lineages. It is not an
independent patient or clinical realism test. Freeze precedes access; do not tune
against these results. Further model changes require a fresh audit release.
""",
        ),
        cell(
            "code",
            """
freeze = {"model_sha256": atlas_shape.digest(OUT / "model.pt"),
          "release_sha256": atlas_shape.digest(DATASET / "release.json"),
          "selection_split": "val"}
atlas_shape.atomic_json(OUT / "freeze.json", freeze)
AUDIT_REPORT = OUT / "audit_geometry.json"
if AUDIT_REPORT.exists():
    audit = json.loads(AUDIT_REPORT.read_text())
    if audit["model_sha256"] != freeze["model_sha256"]:
        raise RuntimeError("Audit already consumed by different weights; use a fresh audit release")
else:
    audit = atlas_shape.evaluate(DATASET, OUT / "model.pt", "audit", decoder)
    atlas_shape.atomic_json(AUDIT_REPORT, audit)
print(json.dumps({k: audit[k] for k in ["split", "rows", "macro_template_control_nrmse", "decoded_geometry"]}, indent=2))
""",
        ),
        cell(
            "markdown",
            """
## 7 · Generate a variation of one exact template

The template identifier fixes organ identity and source lineage. Numeric
conditions are measured dimensions in their declared units. Omitted conditions
remain free; geometry controls are bounded. Unconditional generation samples the
actual synthetic prior. Inspect several camera views of each exported organ and
review anatomy before using it as training evidence.
""",
        ),
        cell(
            "code",
            """
from viscera_core.atlas import generate, load_template
model = atlas_shape.load_model(OUT / "model.pt")
TEMPLATE = next((t for t in model["preprocessing"]["templates"] if "liver" in t),
                model["preprocessing"]["templates"][0])
controls = atlas_shape.sample_controls(model, TEMPLATE, count=12, seed=914)
template = load_template(DATASET / "templates", TEMPLATE)
examples = [generate(template, row, seed=914+i) for i, row in enumerate(controls)]
atlas_shape.atomic_json(OUT / "sample_controls.json", {"template_id": TEMPLATE,
    "control_names": atlas_shape.CONTROL_NAMES, "controls": controls.tolist(),
    "model_sha256": atlas_shape.digest(OUT / "model.pt")})
print(TEMPLATE, "generated", len(examples), "high-resolution template variations")
print("First geometry QA:", examples[0].qa)
""",
        ),
        cell(
            "markdown",
            """
## 8 · Save the run

The training report contains baseline comparisons, per-organ metrics, exact data
and source hashes, hardware/runtime identity and model limitations. The output
archive preserves weights, checksums and QA reports. Attribution travels with the
dataset/template bundle; retain it when redistributing derived geometry.
""",
        ),
        cell(
            "code",
            """
import shutil
archive = shutil.make_archive(str(OUT.parent / "viscera-atlas-trained-run"), "zip", OUT)
print("Saved:", archive)
if IN_COLAB:
    from google.colab import files
    files.download(archive)
""",
        ),
    ]
    notebook = {
        "nbformat": 4,
        "nbformat_minor": 5,
        "cells": cells,
        "metadata": {
            "kernelspec": {"name": "python3", "display_name": "Python 3"},
            "language_info": {"name": "python", "version": "3.11"},
            "colab": {"name": "VISCERA_atlas_dataset_and_training.ipynb"},
        },
    }
    for i, value in enumerate(cells):
        value["id"] = f"atlas-{i:02d}"
    output = ROOT / "notebooks/VISCERA_atlas_dataset_and_training.ipynb"
    output.write_text(json.dumps(notebook, indent=2) + "\n")
    return output


if __name__ == "__main__":
    print(build())
