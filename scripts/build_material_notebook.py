"""Build the independent material-prior Colab notebook."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def cell(kind: str, source: str) -> dict[str, Any]:
    result: dict[str, Any] = {"cell_type": kind, "metadata": {}, "source": source.strip() + "\n"}
    if kind == "code":
        result.update(execution_count=None, outputs=[])
    return result


def build() -> Path:
    old = json.loads((ROOT / "notebooks/VISCERA_atlas_dataset_and_training.ipynb").read_text())
    setup = old["cells"][2]
    setup["source"] = setup["source"].replace(
        "pipelines/train/viscera_train/atlas_shape.py",
        "pipelines/train/viscera_train/atlas_material.py",
    )
    setup["source"] = (
        setup["source"]
        .replace("Bundle lacks atlas trainer", "Bundle lacks material trainer")
        .replace("one VISCERA atlas bundle ZIP", "one VISCERA material bundle ZIP")
    )
    install = old["cells"][4]
    install["source"] = install["source"].replace(
        "requirements-colab.txt", "requirements-material-colab.txt"
    )
    cells = [
        cell(
            "markdown",
            """
# VISCERA · Independent surface-material dataset and prior

This notebook trains an **appearance-code model**, independently of the frozen
atlas geometry and text models. It uses 768 authored material recipes across
12 organs and four organ-aware styles. Six controls change tint, pigment,
physical mottle scale, wetness, fine detail and surface structure strength.

The target field supplies arbitrary-coordinate linear/sRGB color, roughness,
normal-map height and spatial gradient. **Height is shading detail, not anatomical
surface displacement.** Geometry remains exactly fixed. The dataset stores
complete field samples on licensed atlas surface coordinates and measured
conditions; every patch/view inherits its material recipe's split.

This is a synthetic appearance design space. It contains no measured tissue
photographs, calibrated optics, histology labels, pathology, or population
frequencies. Neural training does not make those missing data appear.

## 1 · Upload `viscera-material-colab.zip`
The bundle contains source, locked requirements, parent atlas templates, the
separate material dataset and the frozen pilot material model. A local extracted
project can run these cells directly. New training uses a fresh output directory.
""",
        ),
        setup,
        cell(
            "markdown",
            """
## 2 · Install the lock
CPU is sufficient for this compact pilot. Python 3.11 or 3.12 is required. The
same seed does not imply cross-platform bitwise parity; exact CPU resume requires
the same source, dataset, dependency versions, platform and configuration.
""",
        ),
        install,
        cell(
            "code",
            """
from pipelines.train.viscera_train import atlas_material as prior
from viscera_core import atlas_material_dataset as material_data

DATA = ROOT / "datasets/atlas/material-v1"
OUT = ROOT / "artifacts/atlas/material-colab-run-v1"
release = material_data.verify_material_release(DATA)
train = material_data.read_split(DATA, "train")
val = material_data.read_split(DATA, "val")
prior.ensure_groups(train, val)
print("Material release", release["release_id"])
print("Train / validation", len(train["controls"]), len(val["controls"]))
print("Controls:", material_data.CONTROL_NAMES)
print("Conditions:", material_data.CONDITION_NAMES)
print("Audit labels remain unopened.")
""",
        ),
        cell(
            "markdown",
            """
## 3 · Compare baselines and train
The trainer fits a group mean, nearest measured-condition baseline, ridge inverse
model with leave-one-out residuals, and a conditional mean/variance network.
Preprocessing uses training data only. Complete organ/style groups are balanced
when sampling neural batches. It evaluates actual decoded surface fields on
validation recipes, not a learned proxy for the material decoder.

Neural selection requires at least 2% improvement in macro organ/style field
summary error and no organ regression above 10%; otherwise a baseline remains
selected. All reconstruction metrics refer to the procedural teacher. They are
not tissue-photo fidelity scores. The separate pilot report records the actual
selected model; this notebook starts a new reproducible run.
""",
        ),
        cell(
            "code",
            """
CONFIG = prior.Config(steps=2000, checkpoint_every=250)
report = prior.train(DATA, OUT, CONFIG, resume=(OUT / "checkpoint.pt").is_file())
print("Selected:", report["selected"])
for method, metrics in report["validation"].items():
    print(method, "macro field summary NRMSE:", metrics["macro_field_summary_nrmse"],
          "RGB MAE:", metrics["field_mae_rmse"]["rgb_linear_mae"])
""",
        ),
        cell(
            "markdown",
            """
## 4 · Inspect factorized proposals and field measurements
Unconditional generation bootstraps the exact organ/style's training controls
with a new spatial field seed. Conditional proposals use the selected inverse
model and learned residual/variance sampling. Requested field statistics are
proposals, and must be measured on actual surface anchors before being called
matched. Unsupported organ/style pairs and targets outside observed training
support are rejected.
""",
        ),
        cell(
            "code",
            """
import numpy as np
from scripts.qa_material_prior import run as qa_prior

model = prior.load_model(OUT / "model.npz")
proposal = prior.sample_recipe(model, "liver", "rich", 28371)
print(json.dumps(proposal, indent=2))
qa = qa_prior(DATA, OUT / "model.npz", OUT / "generated_material_qa.json", per_mode=4)
print({k: v for k, v in qa.items() if k not in ("diversity", "samples_detail")})
""",
        ),
        cell(
            "markdown",
            """
## 5 · Freeze, then audit once
Freeze the selected checkpoint and validation decision before the one-time audit.
Do not tune on this audit afterward. It holds out whole synthetic material
recipes; geometry lineages remain shared and independent real appearance
performance is unknown. The generation path cannot change atlas geometry.
""",
        ),
        cell(
            "code",
            """
FREEZE = OUT / "freeze.json"
if not FREEZE.exists():
    prior.write_json(FREEZE, {"model_sha256": prior.digest(OUT / "model.npz"),
                             "selected": report["selected"], "tuning_closed": True})
AUDIT = OUT / "audit_material_fields.json"
if not AUDIT.exists():
    prior.write_json(AUDIT, prior.evaluate(DATA, OUT / "model.npz", "audit", freeze=FREEZE))
print(AUDIT.read_text())
""",
        ),
        cell(
            "markdown",
            """
## 6 · Save this separate run
The compact inference model is a non-pickle NPZ with a validated JSON manifest.
The training checkpoint additionally retains optimizer/RNG state for exact CPU
resume. Keep the material run separate from frozen geometry and language runs.
""",
        ),
        cell(
            "code",
            """
import shutil
archive = shutil.make_archive(str(OUT), "zip", OUT)
print("Material run:", archive)
if "google.colab" in sys.modules:
    from google.colab import files
    files.download(archive)
""",
        ),
    ]
    notebook = {
        "cells": cells,
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python", "version": "3.11"},
        },
        "nbformat": 4,
        "nbformat_minor": 4,
    }
    output = ROOT / "notebooks/VISCERA_material_dataset_and_training.ipynb"
    output.write_text(json.dumps(notebook, indent=2) + "\n")
    return output


if __name__ == "__main__":
    print(build())
