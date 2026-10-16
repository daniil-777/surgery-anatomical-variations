"""Build the expanded-disease Run All notebook with exact archive identities."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def build(index: Path, output: Path) -> Path:
    release = json.loads(index.read_text())
    packages = release["packages"]
    if set(packages) != {"baseline", "disease", "runtime"}:
        raise ValueError("Expected baseline, disease and runtime archives")
    datasets = release["datasets"]
    baseline_count = datasets["baseline"]["samples"]
    disease_count = datasets["disease"]["samples"]
    cells = []

    def cell(kind: str, source: str) -> None:
        row = {"cell_type": kind, "id": f"joint-v2-{len(cells):02}", "metadata": {}, "source": source.strip() + "\n"}
        if kind == "code":
            row.update(execution_count=None, outputs=[])
        cells.append(row)

    cell("markdown", f"""
# VISCERA · Expanded disease, shape and colour generation

Choose **Runtime → Change runtime type → A100 GPU** if available, then **Run all**.
Approve the Google Drive prompt when Google asks. No code edits or API keys are needed.
Other CUDA GPUs are supported; allocation and compute limits are controlled by Google.
This notebook does not buy compute or change your account plan.

Keep the three training ZIPs beside this notebook in **{release['drive_folder']}**.
The final cell downloads **viscera-joint-v2-weights.zip**, and saves a copy in Drive.
Studio retains every old model and lets you switch between generations.

This release trains a **bounded rational-quadratic spline flow**, with explicit
disease design-strength bands and coupled shape/material/disease controls.
Its control prior is shared across anatomy profiles because these authored samples
do not establish patient-population differences between diseases. The renderer
applies the selected organ, phenotype and independently seeded spatial pattern.
The separate datasets contain **{baseline_count:,} baseline** and **{disease_count:,} disease**
authored examples. Paired surface observations include denser and lesion-focused queries.
Source templates, split families, recipes, phase seeds, licences and hashes are retained.
Full-source mesh checks are a separate export gate; surface-query records are not
independent patients or proof of collision-free anatomy for every possible recipe.

The open-evidence archive contains unpaired photographic references and measured 3D
case evidence. Eleven photographic ROI palettes contribute to rendered colour targets;
the new CT cases are reference material, not inputs to the training sampler or geometry
targets. Photographic RGB is not measured albedo; design severity is not clinical stage.
No tissue physics or new language model is trained by this notebook.
""")
    cell("code", (ROOT / "scripts/joint_v2_notebook_bootstrap.py").read_text() + f"""

PACKAGES = {packages!r}
DRIVE_FOLDER_NAME = {release['drive_folder']!r}
try:
    import google.colab
    IS_COLAB = True
except ImportError:
    IS_COLAB = False
if os.environ.get("VISCERA_JOINT_ARCHIVES"):
    DRIVE_FOLDER = Path(os.environ["VISCERA_JOINT_ARCHIVES"]).resolve()
elif IS_COLAB:
    from google.colab import drive
    drive.mount("/content/drive")
    DRIVE_FOLDER = Path("/content/drive/MyDrive") / DRIVE_FOLDER_NAME
else:
    DRIVE_FOLDER = Path.cwd()
WORK = Path(os.environ.get("VISCERA_JOINT_WORK", "/content/viscera-joint-v2" if IS_COLAB else str(Path.cwd() / "viscera-joint-v2-work"))).resolve()
WORK.mkdir(parents=True, exist_ok=True)
PATHS = {{}}
for lane, package in PACKAGES.items():
    source = DRIVE_FOLDER / package["filename"]
    if not source.is_file():
        raise FileNotFoundError(f"Missing {{source}}. Keep all three training ZIPs in the named Drive folder.")
    local = WORK / package["filename"]
    if not local.exists() or file_digest(local) != package["sha256"]:
        shutil.copyfile(source, local)
    PATHS[lane] = extract_package(local, package["sha256"], WORK / package["sha256"][:12], package["prefix"])
    print("Verified", lane, package["sha256"])
ROOT = PATHS["runtime"]
""")
    cell("markdown", """
## Prepare the isolated training environment

Setup preserves the host's PyTorch/CUDA wheel variant and installs pinned scientific
dependencies into a separate environment. The notebook kernel needs no restart.
The printed device identifies the GPU actually allocated, rather than assuming A100.
""")
    cell("code", """
TRAIN_PYTHON = install_environment(ROOT, WORK / "train-env")
RUNTIME = json.loads(subprocess.check_output([str(TRAIN_PYTHON), "-c", "import torch,sys,json; print(json.dumps({'python':sys.version.split()[0],'torch':torch.__version__,'cuda':torch.cuda.is_available(),'gpu':torch.cuda.get_device_name(0) if torch.cuda.is_available() else None}))"], text=True))
run_identity = hashlib.sha256(json.dumps({"packages": PACKAGES, "runtime": RUNTIME}, sort_keys=True).encode()).hexdigest()[:16]
OUT = Path(os.environ.get("VISCERA_JOINT_OUT", str(DRIVE_FOLDER / "runs" / run_identity)))
OUT.mkdir(parents=True, exist_ok=True)
print("Runtime:", RUNTIME)
print("Outputs:", OUT)
if IS_COLAB and not RUNTIME["cuda"]:
    print("No GPU was allocated. CPU is supported, but switch to a GPU runtime for faster full training.")
""")
    cell("markdown", """
## Train, compare held-out distributions, and audit full rendered meshes

Training uses a shared baseline/disease control prior and bounded invertible spline
couplings. Validation selects a checkpoint against the identity/uniform baseline;
the untouched audit split must also improve before weights can be exported.
The report retains per-profile/severity results even where a baseline performs better.
The query network measures how well surface fields can be predicted. Its loss is
diagnostic by default: the tested field regularizer did not improve held-out density.

After training, the exact renderer checks three seeds for baseline conditions and
three seeds in each mild/moderate/severe design band for every disease condition.
The ZIP is exported only after all required checks pass. This is engineering
verification, not medical or mechanical validation.

Completed training artifacts are verified before reuse. The training log and model
report remain in the Drive run directory. Errors do not produce a success receipt.
""")
    cell("code", """
command = [str(TRAIN_PYTHON), "-u", str(ROOT / "scripts/joint_v2_train.py"),
           "--baseline", str(PATHS["baseline"]), "--disease", str(PATHS["disease"]),
           "--templates", str(ROOT / "templates"), "--out", str(OUT), "--device", "auto"]
environment = dict(os.environ, PYTHONPATH=str(ROOT / "py") + os.pathsep + str(ROOT), PYTHONDONTWRITEBYTECODE="1")
with (OUT / "training.log").open("a") as log:
    process = subprocess.Popen(command, cwd=ROOT, env=environment, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, bufsize=1)
    for line in process.stdout:
        print(line, end="", flush=True)
        log.write(line)
        log.flush()
    returncode = process.wait()
if returncode:
    raise RuntimeError(f"Training/export failed with code {returncode}. See {OUT / 'training.log'}; no successful weights are claimed.")
COMPLETION = json.loads((OUT / "completion.json").read_text())
MODEL = json.loads((OUT / "model/model.json").read_text())
print("Selected method:", MODEL["selected_method"])
print("Selected training step:", MODEL.get("selected_step"), "of", MODEL.get("completed_steps"))
print("Validation density:", json.dumps(MODEL.get("validation", {}).get("density", {}).get("macro", {}), indent=2))
print("Audit density:", json.dumps(MODEL.get("audit", {}).get("density", {}).get("macro", {}), indent=2))
print("Promotion checks:", json.dumps(MODEL.get("validation_acceptance", {}), indent=2))
print("Full per-profile reports:", OUT / "model/training_report.json")
print("Full renderer audit:", OUT / "exact-renderer-audit.json")
""")
    cell("markdown", """
## Download and play in Studio

Import **viscera-joint-v2-weights.zip** in **Trained models → Validate & activate**.
Choose an organ and a supported disease, set **Disease design range**, then use
**Joint flow variation** or **New joint variation**. Shape, colour and disease vary
together. The displayed mesh remains editable and supports textured GLB export.

Use **Preserved joint models** to reactivate an earlier VAE or flow. Importing this
new generation does not erase older weights or retrain the separate text adapter.
""")
    cell("code", """
WEIGHTS = OUT / "viscera-joint-v2-weights.zip"
weights_sha = verify_weights(WEIGHTS, COMPLETION)
print("Verified weights:", WEIGHTS)
print("SHA-256:", weights_sha)
if IS_COLAB:
    from google.colab import files
    files.download(str(WEIGHTS))
else:
    print("Local full run complete. Import the displayed ZIP in Studio.")
""")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"nbformat": 4, "nbformat_minor": 5, "cells": cells, "metadata": {"accelerator": "GPU", "colab": {"name": output.name, "provenance": [], "gpuType": "A100"}, "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"}, "language_info": {"name": "python"}}}, indent=2) + "\n")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=ROOT / "notebooks/VISCERA_expanded_disease_run_all.ipynb")
    args = parser.parse_args()
    print(build(args.index, args.out))
