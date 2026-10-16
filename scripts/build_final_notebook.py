"""Build the external Run-all notebook, pinned to one immutable dataset ZIP."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def build(archive: Path, output: Path | None = None) -> Path:
    output = output or ROOT / "notebooks/VISCERA_final_run_all.ipynb"
    with archive.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    cells = []

    def cell(kind: str, value: str) -> None:
        record = {
            "cell_type": kind,
            "id": f"viscera-final-{len(cells):02}",
            "metadata": {},
            "source": value.strip() + "\n",
        }
        if kind == "code":
            record.update(outputs=[], execution_count=None)
        cells.append(record)

    cell(
        "markdown",
        """
# VISCERA · Run all → download model weights

**No code edits required.** Choose **Runtime → Run all** and approve Google Drive
access when Google asks. The dataset ZIP stays in the same Drive folder as this
notebook: **VISCERA Final Training 2026-10-07**. The notebook verifies it, installs
an isolated environment, trains, validates, freezes, audits, checks inference and
downloads **one `viscera-final-weights.zip`**. A copy remains in Drive.

A GPU is requested. Core models also train on CPU. The optional pinned Qwen LoRA
experiment runs only with CUDA; skipped/failed adapter status is shown explicitly
and does not prevent exporting the verified core models. No API keys are needed.
The first isolated PyTorch installation may take several minutes.

**Dataset:** 1,536 geometry recipes / 24 templates; 768 appearance recipes;
9,216 compiler-derived language examples; 3,600 disease recipes / 25 profiles /
12 organs; 200 realized disease surfaces; 3 CC BY pancreatic clinical cases.
These counts describe separate datasets, not independent patients or one large
paired cohort. The clinical prior has only one training patient.

**What the models learn:** bounded geometry/material/disease controls, decoded
by the supplied anatomy library. Validation may select a stronger regression or
empirical baseline instead of a neural candidate. Optional language weights are
a guarded text-to-spec adapter, not an unrestricted text-to-3D foundation model.
There are no measured physics labels or calibrated organ mechanics in this ZIP.

Keep this notebook paired with its exact dataset archive. Notebook code has been
reviewed and locally exercised; hosted GPU availability remains controlled by
Google. [Colab documentation](https://research.google.com/colaboratory/faq.html)
""",
    )
    bootstrap = (ROOT / "scripts/final_notebook_bootstrap.py").read_text()
    cell(
        "code",
        bootstrap
        + f"""

ARCHIVE_NAME = {archive.name!r}
EXPECTED_SHA256 = {digest!r}
DRIVE_FOLDER_NAME = "VISCERA Final Training 2026-10-07"
try:
    import google.colab
    IS_COLAB = True
except ImportError:
    IS_COLAB = False
DRIVE_FOLDER = None
explicit_archive = os.environ.get("VISCERA_BUNDLE_PATH")
if explicit_archive:
    ARCHIVE = Path(explicit_archive).expanduser().resolve()
elif IS_COLAB:
    from google.colab import drive
    drive.mount("/content/drive")
    DRIVE_FOLDER = Path("/content/drive/MyDrive") / DRIVE_FOLDER_NAME
    ARCHIVE = DRIVE_FOLDER / ARCHIVE_NAME
else:
    ARCHIVE = Path.cwd() / ARCHIVE_NAME
if not ARCHIVE.is_file():
    raise FileNotFoundError(f"Keep {{ARCHIVE_NAME}} in {{DRIVE_FOLDER_NAME}}, then Run all again. Looked at {{ARCHIVE}}")
WORK = Path(os.environ.get("VISCERA_WORK_DIR", "/content/viscera-final" if IS_COLAB else str(Path.cwd() / "viscera-final-work"))).resolve()
LOCAL_ZIP = WORK / ARCHIVE_NAME
WORK.mkdir(parents=True, exist_ok=True)
if ARCHIVE.resolve() != LOCAL_ZIP.resolve():
    if not LOCAL_ZIP.exists() or file_digest(LOCAL_ZIP) != EXPECTED_SHA256:
        shutil.copy2(ARCHIVE, LOCAL_ZIP)
ROOT, MANIFEST = extract_verified(LOCAL_ZIP, EXPECTED_SHA256, WORK / EXPECTED_SHA256[:12])
print("Verified dataset ZIP:", EXPECTED_SHA256)
print("Verified packaged files:", len(MANIFEST["artifact_hashes"]))
print("Dataset paths:", json.dumps(MANIFEST["dataset_paths"], indent=2))
""",
    )
    cell(
        "markdown",
        """
## Install and verify the training environment

Training uses a separate Python environment so package installation does not
require restarting this notebook. Data are extracted to local runtime storage;
completed stages and output weights are retained in the dedicated Drive folder.
""",
    )
    cell(
        "code",
        """
TRAIN_PYTHON = install_environment(ROOT, WORK / "train-env")
runtime_probe = subprocess.check_output([str(TRAIN_PYTHON), "-c", "import torch,sys,json; print(json.dumps({'python':sys.version.split()[0],'torch':torch.__version__,'cuda':torch.cuda.is_available(),'gpu':torch.cuda.get_device_name(0) if torch.cuda.is_available() else None}))"], text=True)
RUNTIME = json.loads(runtime_probe)
PROFILE = os.environ.get("VISCERA_RUN_PROFILE", "full")
DEVICE = os.environ.get("VISCERA_RUN_DEVICE", "auto")
LANGUAGE = os.environ.get("VISCERA_RUN_LANGUAGE", "auto")
runtime_id = hashlib.sha256(json.dumps(RUNTIME, sort_keys=True).encode()).hexdigest()[:8]
run_name = EXPECTED_SHA256[:12] + "-" + PROFILE + "-" + runtime_id
output_base = DRIVE_FOLDER / "runs" if DRIVE_FOLDER else WORK / "runs"
OUT = Path(os.environ.get("VISCERA_RUN_OUT", str(output_base / run_name)))
OUT.mkdir(parents=True, exist_ok=True)
print("Runtime:", json.dumps(RUNTIME, indent=2))
print("Run:", OUT)
print("Core training runs on CPU or CUDA. Optional language adapter requires CUDA in auto mode.")
""",
    )
    cell(
        "markdown",
        """
## Train → select → freeze → audit → verify inference

This executes all stages with fixed defaults. Training and selection use the
training/validation splits; held-out evaluation follows model freezing. Preflight
checks the integrity and structure of all splits without fitting on audit targets.
A verified completed stage is reused when
you run the notebook again; an interrupted stage restarts in a new attempt folder.
The final ZIP includes selected inference models, manifests,
source/data identities, measurements, attribution and scope limits.
""",
    )
    cell(
        "code",
        """
command = [str(TRAIN_PYTHON), "-u", str(ROOT / "scripts/final_train.py"),
           "--root", str(ROOT), "--out", str(OUT), "--profile", PROFILE,
           "--device", DEVICE, "--language", LANGUAGE]
training_env = dict(os.environ, PYTHONPATH=str(ROOT / "py") + os.pathsep + str(ROOT), PYTHONDONTWRITEBYTECODE="1")
log_path = OUT / "notebook-training.log"
with log_path.open("a") as log:
    process = subprocess.Popen(command, cwd=ROOT, env=training_env, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, bufsize=1)
    for line in process.stdout:
        print(line, end="", flush=True)
        log.write(line)
        log.flush()
    result = process.wait()
if result:
    raise RuntimeError(f"Training stopped (exit {result}); inspect {log_path}. No success is reported for a failed run.")
COMPLETION = json.loads((OUT / "completion.json").read_text())
METRICS = json.loads((OUT / "export/metrics.json").read_text())
print(json.dumps(METRICS, indent=2))
""",
    )
    cell(
        "markdown",
        """
## Download and import into the Studio

The next cell checks the exported archive and starts a single browser download.
If your browser blocks automatic downloads, use the displayed file link or the
saved Drive copy. In the updated Studio, open **Trained models**, select this ZIP,
then choose **Validate & activate**. The server verifies compatibility before
activation. Use the learned sampling controls to generate new geometry, surfaces
or disease recipes. Clinical case retrieval and the optional, explicitly enabled
text adapter remain separately labeled.
""",
    )
    cell(
        "code",
        """
WEIGHTS = OUT / "viscera-final-weights.zip"
if not WEIGHTS.is_file():
    raise FileNotFoundError("The verified weights export is missing")
weights_sha = verify_weights(WEIGHTS, COMPLETION)
receipt = {"weights_file": WEIGHTS.name, "weights_sha256": weights_sha,
           "dataset_sha256": EXPECTED_SHA256, "runtime": RUNTIME,
           "profile": PROFILE, "bytes": WEIGHTS.stat().st_size}
receipt_path = OUT / "download-receipt.json"
receipt_path.write_text(json.dumps(receipt, indent=2) + "\\n")
if DRIVE_FOLDER:
    delivered = DRIVE_FOLDER / "weights"
    delivered.mkdir(exist_ok=True)
    for path in (WEIGHTS, receipt_path):
        target = delivered / path.name
        temporary = target.with_suffix(target.suffix + ".tmp")
        shutil.copy2(path, temporary)
        temporary.replace(target)
    print("Saved Drive copy:", delivered)
print("Weights:", WEIGHTS)
print("SHA-256:", weights_sha)
from IPython.display import FileLink, display
display(FileLink(str(WEIGHTS)))
if IS_COLAB:
    from google.colab import files
    files.download(str(WEIGHTS))
print("Finished. Review metrics.json for the selected model and language status.")
""",
    )
    notebook = {
        "nbformat": 4,
        "nbformat_minor": 5,
        "cells": cells,
        "metadata": {
            "kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"},
            "language_info": {"name": "python", "version": "3.12"},
            "accelerator": "GPU",
            "colab": {"name": output.name, "provenance": [], "gpuType": "T4"},
        },
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(notebook, indent=2) + "\n")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    print(build(args.archive, args.output))
