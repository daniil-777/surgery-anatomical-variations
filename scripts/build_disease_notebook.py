"""Build a self-contained disease recipe / clinical source training notebook."""

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
    cells = [
        cell(
            "markdown",
            """
# VISCERA · Disease variation training and reproducible inference

This notebook keeps **two evidence lanes separate**:

1. **Visual design recipes:** 25 supported, source-referenced profiles across all
   12 organ families. A conditional VAE learns nine editable recipe controls;
   a licensed atlas and deterministic bounded deformation renderer produce the
   actual geometry. The remaining 11 profiles are reference-only because the
   required valves, vessels, lumen or topology are not represented.
2. **Measured clinical cases:** three pancreatic ductal adenocarcinoma patients
   under CC BY 4.0, split by patient into train/validation/audit. An empirical
   conditional prior retrieves observed paired organ/lesion cases. It does not
   invent population variability from a single training patient. A separate,
   explicitly opted-in bundle can add four noncommercial KiTS19 kidney cases.

The bundle also contains **200 realized disease surface samples** with point
clouds, normals, colors, measured geometry, exact parent recipe groups and a
licensed template library for full-resolution replay. These synthetic surfaces
stay separate from the clinical case lane and do not increase the patient count.

Photographs motivate profile design; they are **not paired 3D labels**. Recipe
strength is not clinical stage. Neither lane supplies measured tissue mechanics,
optics, histology, invasion, prevalence or validation for surgical decisions.

## 1 · Upload the disease Colab bundle
Use `viscera-disease-colab.zip`. An already extracted bundle also works. The cell
checks every packaged file before importing code. Use a fresh runtime for a new
bundle; the package never edits the frozen healthy atlas training runs.
""",
        ),
        cell(
            "code",
            """
import hashlib, json, pathlib, sys, zipfile

if sys.version_info[:2] not in ((3, 11), (3, 12)):
    raise RuntimeError("Use a Python 3.11 or 3.12 runtime for this tested bundle")
ROOT = pathlib.Path.cwd()
if not (ROOT / "disease-bundle-manifest.json").exists():
    candidate = ROOT / "viscera-disease"
    if (candidate / "disease-bundle-manifest.json").exists():
        ROOT = candidate
    else:
        from google.colab import files
        uploaded = files.upload()
        if len(uploaded) != 1:
            raise ValueError("Upload exactly one VISCERA disease Colab ZIP")
        archive_path = pathlib.Path(next(iter(uploaded)))
        destination = pathlib.Path.cwd().resolve()
        with zipfile.ZipFile(archive_path) as archive:
            members = archive.infolist()
            if len({m.filename for m in members}) != len(members):
                raise ValueError("Duplicate archive entries")
            if sum(m.file_size for m in members) > 2_000_000_000:
                raise ValueError("Unexpectedly large bundle")
            for item in members:
                path = destination / item.filename
                if not path.resolve().is_relative_to(destination):
                    raise ValueError("Unsafe archive path")
                if ((item.external_attr >> 16) & 0o170000) == 0o120000:
                    raise ValueError("Symlinks are not supported in this bundle")
            archive.extractall(destination)
        ROOT = destination / "viscera-disease"

manifest = json.loads((ROOT / "disease-bundle-manifest.json").read_text())
for relative, expected in manifest["artifact_hashes"].items():
    path = ROOT / relative
    if not path.resolve().is_relative_to(ROOT.resolve()):
        raise ValueError("Unsafe manifest path")
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != expected:
        raise ValueError(f"Bundle checksum mismatch: {relative}")
sys.path[:0] = [str(ROOT / "py"), str(ROOT)]
print("Verified files:", len(manifest["artifact_hashes"]))
print("Source rights:", manifest["clinical_rights"])
""",
        ),
        cell(
            "markdown",
            """
## 2 · Install the tested package versions
CPU is sufficient for this compact model; a GPU is not required. These are tested
package pins, not a claim of bitwise reproducibility across operating systems.
The run stores package versions and the exact dataset/decoder hashes. PyTorch is
needed only for training; deployed inference uses the exported NumPy decoder.
""",
        ),
        cell(
            "code",
            """
import subprocess
subprocess.run([sys.executable, "-m", "pip", "install", "-r",
                str(ROOT / "notebooks/requirements-disease-colab.txt")], check=True)
from pipelines.train.viscera_train import atlas_disease as prior
from viscera_core import atlas_disease_recipe_dataset as recipes
from viscera_core import atlas_disease_dataset as clinical
from viscera_core import atlas_disease_geometry_dataset as geometry

DATA = ROOT / manifest["recipe_release"]
SOURCE_DATA = ROOT / manifest["clinical_release"]
GEOMETRY_DATA = ROOT / manifest["geometry_release"]
OUT = ROOT / "artifacts/disease/colab-recipes-new-run"
SOURCE_OUT = ROOT / "artifacts/disease/colab-source-new-run"
import importlib.metadata
environment = sorted({f"{d.metadata['Name']}=={d.version}" for d in importlib.metadata.distributions()
                      if d.metadata.get("Name")})
for run_directory in (OUT, SOURCE_OUT):
    run_directory.mkdir(parents=True, exist_ok=True)
    (run_directory / "environment-packages.txt").write_text("\\n".join(environment) + "\\n")
release = recipes.verify_release(DATA)
source_release = clinical.verify_release(SOURCE_DATA)
geometry_release = geometry.verify_release(GEOMETRY_DATA)
assert geometry_release["parent_recipe_release_sha256"] == recipes.digest(DATA / "release.json")
print("Recipe profiles / organ families:", release["profile_count"], release["organ_count"])
print("Recipe splits:", release["split_counts"])
print("Reference-only profiles:", release["reference_only_profile_ids"])
print("Clinical patients:", source_release["case_count"])
print("Realized geometry release:", geometry_release["release_id"])
print("Integrity verified. Audit metrics have not been evaluated for the new run.")
""",
        ),
        cell(
            "markdown",
            """
## 3 · Train the all-organ recipe candidate and compare with the baseline
The conditional VAE has a profile embedding, eight latent dimensions and a small
two-layer encoder/decoder. Training balances profiles. Whole recipe IDs and all
their future views/meshes stay in one split; source atlas lineages remain shared.

The selected method must improve validation reconstruction over a profile mean,
retain distribution spread and diversity, and match the deployed decoder to
within 2e-6 absolute error. Otherwise empirical training-recipe bootstrap remains
selected. Reconstruction concerns recipe controls, **not photo realism**. These
profiles use an authored design prior, not observed disease population frequencies.
""",
        ),
        cell(
            "code",
            """
if not (OUT / "model.npz").exists():
    report = prior.train_recipe(DATA, OUT, prior.Config(steps=1200))
else:
    prior.load_recipe_model(OUT / "model.npz")
    report = json.loads((OUT / "training_report.json").read_text())
print("Selected:", report["selected_method"])
print("Selection gates:", json.dumps(report["selection_gates"], indent=2))
print("Decoder parity:", report["deployment_max_absolute_error"])
""",
        ),
        cell(
            "markdown",
            """
## 4 · Run the identical editor inference path
Choose a supported profile and a seed. The returned nine controls remain editable.
Repeating the seed reproduces a proposal; changing it draws a new recipe and a new
spatial seed. The serving helper rejects a model trained against a different
renderer or catalog. Geometry validation remains the renderer's responsibility.
""",
        ),
        cell(
            "code",
            """
from services.api.atlas_disease_model import sample_recipe_model
MODEL = prior.load_recipe_model(OUT / "model.npz")
PROFILE = "liver-cirrhosis"
proposal = sample_recipe_model(OUT / "model.npz", DATA, PROFILE, seed=28631)
print(json.dumps(proposal, indent=2))
assert proposal == sample_recipe_model(OUT / "model.npz", DATA, PROFILE, seed=28631)
different = sample_recipe_model(OUT / "model.npz", DATA, PROFILE, seed=28632)
assert different["disease"] != proposal["disease"]
""",
        ),
        cell(
            "markdown",
            """
### Inspect and export the actual editor geometry
This cell calls the same disease realization and bound-export functions as the
editor. It exports every source triangle, preserving provenance and geometry QA.
The preview is an ordinary surface render; disease coloration remains authored,
not measured tissue color. Set `BAKE_MATERIAL = True` for the procedural PBR
material export (slower). Geometric checks do not certify clinical realism,
self-intersection freedom, internal anatomy or mechanical behavior.
""",
        ),
        cell(
            "code",
            """
import matplotlib.pyplot as plt
import numpy as np
from mpl_toolkits.mplot3d.art3d import Poly3DCollection
from viscera_core.atlas_disease import DiseaseSpec
from viscera_core.atlas_disease_scene import DiseaseAtlasSpec, realize, export_glb
from viscera_core.atlas_materials import make_recipe

TEMPLATES = GEOMETRY_DATA / "templates"
template_catalog = json.loads((TEMPLATES / "catalog.json").read_text())
organ_name = MODEL["profile_organs"][PROFILE]
template = next(t for t in template_catalog["templates"] if t["organ"] == organ_name)
BAKE_MATERIAL = False
spec = DiseaseAtlasSpec(template_id=template["template_id"],
    disease=DiseaseSpec(**proposal["disease"]),
    material=make_recipe(organ_name) if BAKE_MATERIAL else None)
realized = realize(TEMPLATES, spec)
bound_spec = DiseaseAtlasSpec.model_validate(realized["spec"])
generated_path = OUT / f"{PROFILE}-{proposal['disease']['seed']}.glb"
generated_path.write_bytes(export_glb(TEMPLATES, bound_spec, texture_resolution=1024))
item = realized["scene"]["organs"][0]
vertices = np.asarray(item["positions"]).reshape(-1, 3)
faces = np.asarray(item["indices"]).reshape(-1, 3)
colors = np.asarray(item["colors"]).reshape(-1, 3)
fig = plt.figure(figsize=(10, 8)); ax = fig.add_subplot(111, projection="3d")
surface = Poly3DCollection(vertices[faces], facecolors=colors[faces].mean(1),
                           linewidths=0, rasterized=True)
ax.add_collection3d(surface)
ax.auto_scale_xyz(vertices[:, 0], vertices[:, 1], vertices[:, 2])
ax.set_box_aspect(np.maximum(np.ptp(vertices, axis=0), 1))
ax.set_title(PROFILE + " · authored outer-surface variation")
ax.set(xlabel="Atlas X (mm)", ylabel="Atlas Y (mm)", zlabel="Atlas Z (mm)")
plt.show()
print("Saved full-resolution mesh:", generated_path)
print(json.dumps(realized["scene"]["metadata"]["qa"], indent=2))
""",
        ),
        cell(
            "markdown",
            """
### Inspect the materialized geometry targets
The geometry cohort keeps corresponding rest and disease surface samples in a
shared atlas millimetre frame. These are actual surface samples and measured
decoder outputs, not independent patients. Each row inherits its exact parent
recipe split; the validation/audit subsets must not become extra training rows.
""",
        ),
        cell(
            "code",
            """
geometry_train = geometry.read_split(GEOMETRY_DATA, "train", verify=False)
row = int(np.flatnonzero(geometry_train["profile_ids"] == PROFILE)[0])
rest = geometry_train["rest_points_mm"][row]
changed = geometry_train["points_mm"][row]
fig = plt.figure(figsize=(14, 6))
for panel, (title, points) in enumerate([("Reference surface correspondence", rest),
                                         ("Generated disease surface target", changed)], 1):
    ax = fig.add_subplot(1, 2, panel, projection="3d")
    ax.scatter(*points.T, s=2, c="#aab5bc" if panel == 1 else geometry_train["colors_srgb"][row])
    ax.set_box_aspect(np.maximum(np.ptp(changed, axis=0), 1))
    ax.set(title=title, xlabel="Atlas X (mm)", ylabel="Atlas Y (mm)", zlabel="Atlas Z (mm)")
plt.show()
print("Sample:", geometry_train["sample_ids"][row])
print("Parent recipe group:", geometry_train["group_ids"][row])
print("Measured geometry:", dict(zip(geometry_train["feature_names"].tolist(),
                                      geometry_train["features"][row].tolist())))
""",
        ),
        cell(
            "markdown",
            """
## 5 · Train the separate patient-case prior
The default bundle contains three CC BY pancreatic patients. It therefore has
only one training patient: the prior learns that patient's measured support and
reports zero identifiable population variance. Held-out cases quantify feature
error; they are never used to fit the prior. Noncommercial kidney data require
explicit opt-in below **and** the separately packaged NC release. Disease labels
with no training patients are reported unsupported, never silently reassigned.
""",
        ),
        cell(
            "code",
            """
ALLOW_NONCOMMERCIAL = False  # Set True only for an explicitly selected NC source bundle.
if not (SOURCE_OUT / "source_model.json").exists():
    source_report = prior.train_source(SOURCE_DATA, SOURCE_OUT,
                                      allow_noncommercial=ALLOW_NONCOMMERCIAL)
else:
    prior.load_source_model(SOURCE_OUT / "source_model.json",
                            allow_noncommercial=ALLOW_NONCOMMERCIAL)
    source_report = json.loads((SOURCE_OUT / "training_report.json").read_text())
print(json.dumps(source_report, indent=2))
""",
        ),
        cell(
            "markdown",
            """
## 6 · Inspect measured paired organ / lesion coordinates
This view displays a training source patient's sampled annotation surfaces, not
a synthetic photo or a healthy/diseased correspondence pair. Organ and lesion
share one RAS millimetre frame; they must never be normalized independently.
""",
        ),
        cell(
            "code",
            """
import matplotlib.pyplot as plt
import numpy as np
source_train = clinical.read_split(SOURCE_DATA, "train")
organ = source_train["organ_points_mm"][0]
lesion = source_train["lesion_points_mm"][0]
fig = plt.figure(figsize=(10, 8))
ax = fig.add_subplot(111, projection="3d")
ax.scatter(*organ.T, s=2, alpha=.12, color="#77b8bd", label="Organ annotation")
ax.scatter(*lesion.T, s=5, alpha=.8, color="#ed8c5b", label="Lesion annotation")
extent = np.ptp(np.concatenate((organ, lesion)), axis=0)
ax.set_box_aspect(np.maximum(extent, 1))
ax.set(xlabel="Right (mm)", ylabel="Anterior (mm)", zlabel="Superior (mm)",
       title=str(source_train["case_ids"][0]))
ax.legend()
plt.show()
""",
        ),
        cell(
            "markdown",
            """
## 7 · Freeze first, then audit once
Training already freezes the model choice before opening audit labels. Save these
reports and do not tune this run against the audit afterward. Recipe audit measures
within-generator distribution coverage; source audit holds out whole patients but
is far too small for clinical generalization claims.
""",
        ),
        cell(
            "code",
            """
for target, evaluate in [
    (OUT / "audit.json", lambda: prior.evaluate_recipe(DATA, OUT / "model.npz",
                                                       freeze=OUT / "freeze.json")),
    (SOURCE_OUT / "audit.json", lambda: prior.evaluate_source(
        SOURCE_DATA, SOURCE_OUT / "source_model.json", freeze=SOURCE_OUT / "freeze.json",
        allow_noncommercial=ALLOW_NONCOMMERCIAL)),
]:
    if not target.exists():
        prior.write_json(target, evaluate())
    print(target.name, target.read_text())
""",
        ),
        cell(
            "markdown",
            """
## 8 · Save both runs
Keep recipe and clinical artifacts separate. The compact inference model is
non-pickle NPZ plus a checked JSON manifest. Retain checksums, source licenses,
validation decisions and audit reports when copying a model into the editor.
""",
        ),
        cell(
            "code",
            """
import shutil
for source, target in [
    (DATA / "release.json", OUT / "recipe-release.json"),
    (DATA / "catalog.json", OUT / "profile-catalog.json"),
    (TEMPLATES / "ATTRIBUTIONS.md", OUT / "template-ATTRIBUTIONS.md"),
    (SOURCE_DATA / "release.json", SOURCE_OUT / "clinical-release.json"),
    (SOURCE_DATA / "manifest.jsonl", SOURCE_OUT / "clinical-source-manifest.jsonl"),
    (SOURCE_DATA / "dataset_card.json", SOURCE_OUT / "clinical-dataset-card.json"),
]:
    shutil.copy2(source, target)
outputs = []
for directory in (OUT, SOURCE_OUT):
    outputs.append(shutil.make_archive(str(directory), "zip", directory))
print("Saved:", outputs)
if "google.colab" in sys.modules:
    from google.colab import files
    for archive in outputs:
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
        "nbformat_minor": 5,
    }
    for i, item in enumerate(cells):
        item["id"] = f"disease-cell-{i:02d}"
    output = ROOT / "notebooks/VISCERA_disease_variations_and_training.ipynb"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(notebook, indent=2) + "\n")
    return output


if __name__ == "__main__":
    print(build())
