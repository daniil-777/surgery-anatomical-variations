"""Create a zero-edit Colab notebook pinned to three separate release archives."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def build(index: Path, output: Path) -> Path:
    release = json.loads(index.read_text())
    packages = release["packages"]
    if set(packages) != {"baseline", "disease", "runtime"}:
        raise ValueError("Joint notebook requires separate baseline, disease and runtime packages")
    cells = []

    def cell(kind: str, text: str) -> None:
        entry = {
            "cell_type": kind,
            "id": f"joint-{len(cells):02}",
            "metadata": {},
            "source": text.strip() + "\n",
        }
        if kind == "code":
            entry.update(execution_count=None, outputs=[])
        cells.append(entry)

    cell(
        "markdown",
        """
# VISCERA · Joint shape + colour + disease VAE

Choose **Runtime → Run all**. Approve the Google Drive prompt when Google asks.
No source edits, API keys or manual dataset selection are needed. Keep the three
matching ZIP files beside this notebook in **VISCERA Joint VAE Training 2026-10-07**.
The final cell downloads **viscera-joint-weights.zip**; a copy remains in Drive.

This is an actual conditional VAE with a shared latent representation and separate
shape, material and disease heads. It never substitutes ridge regression. Training
uses paired rendered surface positions, linear RGB and roughness, with a frozen
renderer surrogate connecting observation losses to the generated editor controls.
The decoder retains the full reference mesh and supports texture export in Studio.

**Two separate datasets:** 2,304 baseline examples and 4,800 disease examples;
24 references, 12 organ categories and 25 supported disease profiles. Shared
synthetic families stay in the same train/validation/audit split across both sets.
These are authored examples, not 7,104 independent patients or measured tissue
colour. Additional DRENDS RGB/3D observations are a separately supplied porcine
benchmark, excluded from this human disease training run.

GPU execution is requested in the notebook metadata. CPU execution also works;
runtime allocation and limits are controlled by [Google Colab](https://research.google.com/colaboratory/faq.html).
No language or physics model is retrained in this notebook.
""",
    )
    cell(
        "code",
        (ROOT / "scripts/joint_notebook_bootstrap.py").read_text()
        + f"""

PACKAGES = {packages!r}
DRIVE_FOLDER_NAME = {release["drive_folder"]!r}
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
WORK = Path(os.environ.get("VISCERA_JOINT_WORK", "/content/viscera-joint" if IS_COLAB else str(Path.cwd() / "viscera-joint-work"))).resolve()
WORK.mkdir(parents=True, exist_ok=True)
PATHS = {{}}
for lane, package in PACKAGES.items():
    source = DRIVE_FOLDER / package["filename"]
    if not source.is_file():
        raise FileNotFoundError(f"Missing {{source}}. Keep all three release ZIPs in the named Drive folder.")
    local = WORK / package["filename"]
    if not local.exists() or file_digest(local) != package["sha256"]:
        shutil.copyfile(source, local)
    PATHS[lane] = extract_package(local, package["sha256"], WORK / package["sha256"][:12], package["prefix"])
    print("Verified", lane, package["sha256"])
ROOT = PATHS["runtime"]
""",
    )
    cell(
        "markdown",
        """
## Install an isolated training environment

The notebook kernel remains unchanged. Setup retains the host's PyTorch/CUDA wheel
variant, installs the pinned scientific dependencies and verifies imports in a
fresh process. The first setup can take several minutes.
""",
    )
    cell(
        "code",
        """
TRAIN_PYTHON = install_environment(ROOT, WORK / "train-env")
RUNTIME = json.loads(subprocess.check_output([str(TRAIN_PYTHON), "-c", "import torch,sys,json; print(json.dumps({'python':sys.version.split()[0],'torch':torch.__version__,'cuda':torch.cuda.is_available(),'gpu':torch.cuda.get_device_name(0) if torch.cuda.is_available() else None}))"], text=True))
run_identity = hashlib.sha256(json.dumps({"packages": PACKAGES, "runtime": RUNTIME}, sort_keys=True).encode()).hexdigest()[:16]
OUT = Path(os.environ.get("VISCERA_JOINT_OUT", str(DRIVE_FOLDER / "runs" / run_identity)))
OUT.mkdir(parents=True, exist_ok=True)
print("Runtime:", RUNTIME)
print("Outputs:", OUT)
""",
    )
    cell(
        "markdown",
        """
## Train the joint VAE, evaluate, then verify the actual rendered outputs

The default run trains the observation surrogate for 1,400 steps and the VAE for
4,000 steps. Training uses KL warmup, free bits, a learned conditional prior,
balanced condition sampling and cross-modal reconstruction/distribution losses.
Checkpoint selection uses validation only; audit results are measured after the
checkpoint is frozen. Baseline comparisons and limitations remain in the report.

The export checks seeded replay and actual mesh/colour variation across every
supported condition. It is not a clinical realism or physics certification.
A completed, checksum-verified training stage is reused on rerun; interrupted
training without a completed artifact restarts.
""",
    )
    cell(
        "code",
        """
command = [str(TRAIN_PYTHON), "-u", str(ROOT / "scripts/joint_train.py"),
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
print("Validation reconstruction:", json.dumps(MODEL["validation"]["reconstruction"], indent=2))
print("Held-out prior comparisons:", json.dumps(MODEL["audit"]["prior"]["macro"], indent=2))
print("Full renderer audit:", OUT / "exact-renderer-audit.json")
""",
    )
    cell(
        "markdown",
        """
## Download and use in Studio

Open Studio → **Trained models** → choose **viscera-joint-weights.zip** →
**Validate & activate**. Choose an organ and optional disease profile, then use
**Joint VAE variation**. Change the seed for another reproducible result; the
variation temperature controls sampling spread. This action changes mesh,
material/colour and disease controls together.

Existing separate models and text controls remain available. The joint bundle
requires the updated Studio code and matching reference library. Its importer
checks both before activation. The full training report travels inside the ZIP.
""",
    )
    cell(
        "code",
        """
WEIGHTS = OUT / "viscera-joint-weights.zip"
weights_sha = verify_weights(WEIGHTS, COMPLETION)
print("Verified weights:", WEIGHTS)
print("SHA-256:", weights_sha)
if IS_COLAB:
    from google.colab import files
    files.download(str(WEIGHTS))
else:
    print("Local run complete. Import the displayed ZIP in Studio.")
""",
    )
    notebook = {
        "nbformat": 4,
        "nbformat_minor": 5,
        "cells": cells,
        "metadata": {
            "accelerator": "GPU",
            "colab": {"name": output.name, "provenance": []},
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python"},
        },
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(notebook, indent=2) + "\n")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", type=Path, required=True)
    parser.add_argument(
        "--out", type=Path, default=ROOT / "notebooks/VISCERA_joint_VAE_run_all.ipynb"
    )
    args = parser.parse_args()
    print(build(args.index, args.out))
