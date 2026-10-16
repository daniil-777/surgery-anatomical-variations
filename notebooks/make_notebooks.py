"""Generate portable notebooks; all code cells are ordinary executable Python."""

import json
import textwrap
from pathlib import Path


def cell(kind, source):
    result = {
        "cell_type": kind,
        "metadata": {},
        "source": textwrap.dedent(source).strip().splitlines(keepends=True),
    }
    if kind == "code":
        result.update({"execution_count": None, "outputs": []})
    return result


cells = [
    cell(
        "markdown",
        """
# VISCERA: original dataset → conditional shape model → checked variations

This notebook creates original procedural liver/gallbladder samples, trains a real
compact conditional rectified flow, compares conditional PCA and nearest-design
baselines, evaluates an explicit within-generator test split, and packages weights,
reports and numerical mechanics trials. **The anatomy is unreviewed synthetic
design. No tissue or population validation is claimed.** A trained model samples
construction parameters; the supplied procedural decoder generates the 3D mesh.
The default seed reproduces the development pilot; its original test rows have
already been observed during development. Use new seeds and freeze model choices
before a new untouched audit; rerunning this notebook does not reset that history.

Upload the source ZIP produced by the project, or choose an existing checkout.
No paid service, fixed repository URL, pre-existing Drive mount or A100 is assumed.
Select a GPU in Colab if available; CPU also works. Read every cell before Run all.
The default pilot is intentionally small; enlarge only after reviewing failures.
""",
    ),
    cell(
        "code",
        """
from pathlib import Path
import os, sys, json, subprocess, shutil, hashlib, time, zipfile, tempfile

SOURCE_MODE = "upload"            # "upload" or "existing"
EXISTING_PROJECT = "/content/viscera"
INSTALL_DEPENDENCIES = True
DATASET_COUNT = 128
RESOLUTION = "medium"
TRAIN_STEPS = 600
SEED = 20261006
RUN_ID = "adult-design-shape-pilot-v1"  # change for a new experiment; keep to resume
USE_DRIVE = False
DRIVE_SUBDIR = "viscera-checkpoints"
RUN_MECHANICS = True
DOWNLOAD_RESULTS = True

try:
    from google.colab import files, drive
    IN_COLAB = True
except ImportError:
    IN_COLAB = False
""",
    ),
    cell(
        "code",
        """
if SOURCE_MODE == "upload":
    if not IN_COLAB:
        raise RuntimeError("Outside Colab choose SOURCE_MODE='existing' and set EXISTING_PROJECT")
    uploaded = files.upload()
    archives = [Path(name) for name in uploaded if name.lower().endswith(".zip")]
    if len(archives) != 1:
        raise ValueError("Upload exactly one VISCERA source ZIP")
    source_root = Path(tempfile.mkdtemp(prefix="viscera-source-", dir="/content"))
    with zipfile.ZipFile(archives[0]) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or "MANIFEST.json" not in names:
            raise ValueError("Source archive requires unique paths and MANIFEST.json")
        total = sum(info.file_size for info in archive.infolist())
        if total > 2_000_000_000:
            raise ValueError("Source archive exceeds the 2 GB expanded-size limit")
        for info in archive.infolist():
            target = (source_root / info.filename).resolve()
            if not target.is_relative_to(source_root.resolve()) or (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError("Unsafe archive path or symlink")
        manifest = json.loads(archive.read("MANIFEST.json"))
        if set(manifest["files"]) != set(names) - {"MANIFEST.json"}:
            raise ValueError("Source archive contents disagree with their manifest")
        for name, expected in manifest["files"].items():
            with archive.open(name) as source:
                if hashlib.file_digest(source, "sha256").hexdigest() != expected:
                    raise ValueError("Source checksum mismatch: " + name)
        archive.extractall(source_root)
    candidates = [p.parent for p in source_root.rglob("pyproject.toml") if (p.parent / "py/viscera_core/geometry.py").exists()]
    if len(candidates) != 1:
        raise ValueError("Archive must contain exactly one VISCERA project")
    PROJECT = candidates[0].resolve()
elif SOURCE_MODE == "existing":
    PROJECT = Path(EXISTING_PROJECT).expanduser().resolve()
else:
    raise ValueError("SOURCE_MODE must be upload or existing")
if not (PROJECT / "py/viscera_core/geometry.py").exists():
    raise FileNotFoundError("Project geometry source is missing")
os.chdir(PROJECT)
if INSTALL_DEPENDENCIES:
    requirements = PROJECT / "notebooks/requirements-colab.txt"
    if not requirements.exists():
        raise FileNotFoundError("Pinned Colab requirements missing from source bundle")
    subprocess.run([sys.executable, "-m", "pip", "install", "--require-hashes", "-r", str(requirements)], check=True)
    subprocess.run([sys.executable, "-m", "pip", "install", "--no-deps", "-e", str(PROJECT)], check=True)
sys.path.insert(0, str(PROJECT))
sys.path.insert(0, str(PROJECT / "py"))
# Child training/evaluation processes need the same source roots when using an
# existing environment without an editable package installation.
os.environ["PYTHONPATH"] = os.pathsep.join(
    [str(PROJECT), str(PROJECT / "py")]
    + [p for p in os.environ.get("PYTHONPATH", "").split(os.pathsep) if p]
)
print("Project:", PROJECT)
""",
    ),
    cell(
        "code",
        """
import torch, numpy as np
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
WORK = (Path("/content/viscera-work") if IN_COLAB else PROJECT / "artifacts/notebook") / RUN_ID
WORK.mkdir(parents=True, exist_ok=True)
MODEL_DIR = WORK / "model"
DATA_DIR = WORK / "dataset"
REMOTE = None
if USE_DRIVE:
    if not IN_COLAB:
        raise RuntimeError("Drive staging is available only in Colab; local results stay in WORK")
    drive.mount("/content/drive")
    REMOTE = Path("/content/drive/MyDrive") / DRIVE_SUBDIR / RUN_ID
    REMOTE.mkdir(parents=True, exist_ok=True)
    if (REMOTE / "checkpoint.pt").exists() and not (MODEL_DIR / "checkpoint.pt").exists():
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        for name in ("checkpoint.pt", "checkpoint.pt.sha256.json"):
            shutil.copy2(REMOTE / name, MODEL_DIR / name)
probe = {"device": DEVICE, "torch": torch.__version__, "python": sys.version,
         "gpu": torch.cuda.get_device_name(0) if DEVICE == "cuda" else None,
         "vram_bytes": torch.cuda.get_device_properties(0).total_memory if DEVICE == "cuda" else None,
         "free_disk_bytes": shutil.disk_usage(WORK).free}
(WORK / "hardware.json").write_text(json.dumps(probe, indent=2))
print(json.dumps(probe, indent=2))
""",
    ),
    cell(
        "markdown",
        """
## Original data and strict split files

The release keeps each seed and its descriptions in one split. All samples use
one authored recipe, so the benchmark measures within-generator interpolation.
It cannot establish independent-design or biological generalization. The geometry
checks do not replace expert review. The trainer reads only train/validation;
the explicit evaluation cell below is the only model-scoring test access.
""",
    ),
    cell(
        "code",
        """
from viscera_core.dataset import create_dataset
release = create_dataset(DATA_DIR, count=DATASET_COUNT, seed=SEED, resolution=RESOLUTION, sampler_profile="adult_design_v1")
print(json.dumps({k: release[k] for k in ("attempted", "accepted", "rejected", "split_counts", "profile")}, indent=2))
if not all(release["split_counts"].get(k, 0) > 0 for k in ("train", "val", "test")):
    raise RuntimeError("Insufficient accepted samples in a split; inspect failures before training")
""",
    ),
    cell(
        "code",
        """
from pipelines.train.viscera_train.shape import safe_load
command = [sys.executable, "-m", "pipelines.train.viscera_train.shape", "train",
           "--data", str(DATA_DIR), "--out", str(MODEL_DIR), "--steps", str(TRAIN_STEPS),
           "--seed", str(SEED), "--device", DEVICE]
if (MODEL_DIR / "checkpoint.pt").exists():
    command.append("--resume")
def persist_checkpoint():
    if REMOTE is None or not (MODEL_DIR / "checkpoint.pt").exists():
        return
    checkpoint = MODEL_DIR / "checkpoint.pt"
    try:
        expected = json.loads((MODEL_DIR / "checkpoint.pt.sha256.json").read_text())["sha256"]
        payload = checkpoint.read_bytes()
        if hashlib.sha256(payload).hexdigest() != expected:
            return  # atomic local checkpoint may be newer than its sidecar; try next poll
        temporary = REMOTE / "checkpoint.pt.uploading"
        temporary.write_bytes(payload)
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != expected:
            raise IOError("Drive read-back checksum failed")
        temporary.replace(REMOTE / "checkpoint.pt")
        (REMOTE / "checkpoint.pt.sha256.json").write_text(json.dumps({"sha256": expected}))
    except FileNotFoundError:
        return
started = time.perf_counter()
process = subprocess.Popen(command, cwd=PROJECT)
try:
    while process.poll() is None:
        persist_checkpoint()
        time.sleep(3)
except BaseException:
    process.terminate()
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    raise
finally:
    persist_checkpoint()
if process.returncode != 0:
    raise RuntimeError("Training failed; inspect output and preserved checkpoint")
training = json.loads((MODEL_DIR / "training_report.json").read_text())
print({"status": training["status"], "steps": training["step"], "wall_time_s": training["wall_time_s"],
       "parameter_count": training["parameter_count"], "peak_gpu_bytes": training["peak_gpu_bytes"]})
""",
    ),
    cell(
        "markdown",
        """
## Frozen evaluation and sampled variants

Compare the learned model against conditional Gaussian/PCA and nearest-design
retrieval. Rejections count in the denominator. Control-space MMD is **not** a
surface-anatomy metric. Inspect per-condition measured errors, fixed-condition
diversity, and failure cases. This cell does not retrain or select checkpoints.
""",
    ),
    cell(
        "code",
        """
subprocess.run([sys.executable, "-m", "pipelines.train.viscera_train.shape", "evaluate",
                "--data", str(DATA_DIR), "--model", str(MODEL_DIR / "model.pt"),
                "--split", "test", "--out", str(WORK / "test_evaluation.json")], check=True)
subprocess.run([sys.executable, "-m", "pipelines.train.viscera_train.shape", "sample",
                "--model", str(MODEL_DIR / "model.pt"), "--conditions", "{}", "--count", "12",
                "--out", str(WORK / "sampled_variants.json"), "--scene-dir", str(WORK / "generated-scenes")], check=True)
evaluation = json.loads((WORK / "test_evaluation.json").read_text())
for method, result in evaluation["methods"].items():
    print(method, "accepted", result["decoded_accepted"], "/", result["decoded_attempted"],
          "control-space MMD", result["parameter_mmd"], "coverage", result["parameter_coverage"])
""",
    ),
    cell(
        "code",
        """
if RUN_MECHANICS:
    subprocess.run([sys.executable, "-m", "viscera_core.mechanics", "--out", str(WORK / "mechanics"),
                    "--resolutions", "3,4,5"], check=True)
    print("Mechanics is numerical polynomial Eq.13 block-patch verification, not organ T1 contact or tissue validation.")
""",
    ),
    cell(
        "code",
        """
from viscera_core.geometry import generate_scene
import matplotlib.pyplot as plt
samples = json.loads((WORK / "sampled_variants.json").read_text())["samples"]
accepted = [row for row in samples if row["accepted"]][:6]
fig = plt.figure(figsize=(14, 5))
for index, row in enumerate(accepted):
    scene = generate_scene({"seed": SEED + index, "parameters": row["parameters"]}, resolution=RESOLUTION)
    ax = fig.add_subplot(2, 3, index + 1, projection="3d")
    organ = scene["organs"][0]
    vertices = np.asarray(organ["positions"]).reshape(-1, 3)
    faces_array = np.asarray(organ["indices"]).reshape(-1, 3)
    ax.plot_trisurf(vertices[:, 0], vertices[:, 1], vertices[:, 2], triangles=faces_array, color="#aa594e", linewidth=0, alpha=.95)
    ax.set_box_aspect(np.ptp(vertices, axis=0))
    ax.set_axis_off()
    ax.set_title(f"Unreviewed synthetic variant {index + 1}")
if not accepted:
    fig.text(.1, .5, "No sampled candidate passed; inspect failure records.")
fig.tight_layout()
fig.savefig(WORK / "sampled_variants.png", dpi=130)
plt.show()
""",
    ),
    cell(
        "code",
        """
bundle_base = WORK.parent / (RUN_ID + "-results")
archive = Path(shutil.make_archive(str(bundle_base), "zip", WORK))
print("Result archive:", archive, "bytes:", archive.stat().st_size)
if REMOTE is not None:
    shutil.copy2(archive, REMOTE / archive.name)
    if hashlib.sha256((REMOTE / archive.name).read_bytes()).hexdigest() != hashlib.sha256(archive.read_bytes()).hexdigest():
        raise IOError("Result archive Drive checksum mismatch")
if DOWNLOAD_RESULTS and IN_COLAB:
    files.download(str(archive))
print("Weights, decoder source identity, dataset release, baseline comparison, failures, model card and numerical mechanics are packaged.")
""",
    ),
]

notebook = {
    "nbformat": 4,
    "nbformat_minor": 5,
    "metadata": {
        "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
        "language_info": {"name": "python", "version": "3.11"},
        "colab": {"name": "VISCERA_original_dataset_and_shape_training.ipynb"},
    },
    "cells": cells,
}
if __name__ == "__main__":
    output = Path(__file__).with_name("VISCERA_original_dataset_and_shape_training.ipynb")
    output.write_text(json.dumps(notebook, indent=2) + "\n")
    print(output)


language_cells = [
    cell(
        "markdown",
        """
# VISCERA: optional text → bounded edit proposals with LoRA

This is a **separate language experiment**, not a text-to-mesh foundation model.
It prepares an original authored-template dataset, compares the deterministic
compiler and frozen small language model, trains a real LoRA adapter with loss
only on assistant JSON, then evaluates a sealed wording-family test split.
Targets include supported dimensional edits, ambiguous requests and unsupported
requests. The template set currently trains length controls; the output validator
recognizes the whole bounded pilot schema. Other capabilities need additional
authored training data before claiming coverage. State groups and wording families
are disjoint; operation families are shared. Human language generalization and
anatomical correctness are **not established**. This adapter is not deployed.

This notebook downloads `Qwen/Qwen2.5-0.5B-Instruct` at an immutable revision
(Apache-2.0). Source: [official model/license](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct).
LoRA uses [official PEFT](https://huggingface.co/docs/peft/package_reference/lora).
Use a Colab GPU when available. No weights were downloaded or pretrained-model
training executed as part of the local repository verification.
""",
    ),
    cell(
        "code",
        """
from pathlib import Path
import os, sys, json, subprocess, shutil, hashlib, time, zipfile, tempfile
SOURCE_MODE = "upload"  # or "existing"
EXISTING_PROJECT = "/content/viscera"
INSTALL_DEPENDENCIES = True
RUN_ID = "language-lora-pilot-v0"
MODEL_ID = "Qwen/Qwen2.5-0.5B-Instruct"
MODEL_REVISION = "c89bee90d9f811437d9735454613c35b4a3c4dc8"
TRAIN_STEPS = 200
USE_DRIVE = False
DOWNLOAD_RESULTS = True
try:
    from google.colab import files, drive
    IN_COLAB = True
except ImportError:
    IN_COLAB = False
""",
    ),
    cells[2],
    cell(
        "code",
        """
if INSTALL_DEPENDENCIES:
    subprocess.run([sys.executable, "-m", "pip", "install", "--require-hashes", "-r",
                    str(PROJECT / "notebooks/requirements-language-colab.txt")], check=True)
import torch
from pipelines.train.viscera_train.language import prepare_data, read_rows, audit_rows, score_predictions, compiler_predictions
WORK = (Path("/content/viscera-work") if IN_COLAB else PROJECT / "artifacts/notebook") / RUN_ID
WORK.mkdir(parents=True, exist_ok=True)
DATA_DIR, MODEL_DIR = WORK / "language-data", WORK / "language-model"
REMOTE = None
if USE_DRIVE:
    if not IN_COLAB:
        raise RuntimeError("Drive staging requires Colab; leave USE_DRIVE=False locally")
    drive.mount("/content/drive")
    REMOTE = Path("/content/drive/MyDrive/viscera-checkpoints") / RUN_ID
    REMOTE.mkdir(parents=True, exist_ok=True)
    if (REMOTE / "checkpoint.pt").exists() and not (MODEL_DIR / "checkpoint.pt").exists():
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        for name in ("checkpoint.pt", "checkpoint.pt.sha256.json"):
            shutil.copy2(REMOTE / name, MODEL_DIR / name)
hardware = {"torch": torch.__version__, "device": "cuda" if torch.cuda.is_available() else "cpu",
            "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
            "vram_bytes": torch.cuda.get_device_properties(0).total_memory if torch.cuda.is_available() else None}
(WORK / "hardware.json").write_text(json.dumps(hardware, indent=2))
print(hardware)
""",
    ),
    cell(
        "code",
        """
prepare_data(DATA_DIR)
train_rows, val_rows = read_rows(DATA_DIR, "train"), read_rows(DATA_DIR, "val")
audit_rows(train_rows, val_rows)
baseline = score_predictions(val_rows, compiler_predictions(val_rows))
(WORK / "compiler_validation.json").write_text(json.dumps(baseline, indent=2))
print("Train:", len(train_rows), "Validation:", len(val_rows), "Compiler validation:", baseline["exact_target_rate"])
print("Targets are independently authored operations. Test wording is not consumed by training.")
""",
    ),
    cell(
        "markdown",
        """
## Train a bounded compiler adapter

The trainer downloads safe pretrained tensors with remote custom code disabled,
uses rank-8 LoRA on attention query/value projections, masks all prompt tokens,
and keeps optimizer plus RNG state for local checkpoint resume. Every 25 steps
it writes an atomic checkpoint with a checksum. Drive staging is optional.
The same device and package environment are required for comparable resumed runs;
cross-device bitwise equivalence is not claimed. The final fixed-step model is
evaluated on validation; there is no test-driven checkpoint selection.
""",
    ),
    cell(
        "code",
        """
command = [sys.executable, "-m", "pipelines.train.viscera_train.language", "train",
           "--data", str(DATA_DIR), "--out", str(MODEL_DIR), "--model", MODEL_ID,
           "--revision", MODEL_REVISION, "--steps", str(TRAIN_STEPS)]
if (MODEL_DIR / "checkpoint.pt").exists():
    command.append("--resume")
def persist_language_checkpoint():
    if REMOTE is None:
        return
    try:
        payload = (MODEL_DIR / "checkpoint.pt").read_bytes()
        sidecar = (MODEL_DIR / "checkpoint.pt.sha256.json").read_text()
        if hashlib.sha256(payload).hexdigest() != json.loads(sidecar)["sha256"]:
            return
        temporary = REMOTE / "checkpoint.pt.uploading"
        temporary.write_bytes(payload)
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != json.loads(sidecar)["sha256"]:
            raise IOError("Drive checkpoint read-back mismatch")
        temporary.replace(REMOTE / "checkpoint.pt")
        (REMOTE / "checkpoint.pt.sha256.json").write_text(sidecar)
    except FileNotFoundError:
        return
process = subprocess.Popen(command, cwd=PROJECT)
try:
    while process.poll() is None:
        persist_language_checkpoint()
        time.sleep(3)
except BaseException:
    process.terminate()
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    raise
finally:
    persist_language_checkpoint()
if process.returncode != 0:
    raise RuntimeError("Language training failed; checkpoint and stderr are retained")
report = json.loads((MODEL_DIR / "training_report.json").read_text())
print({k: report[k] for k in ("status", "step", "trainable_parameters", "wall_time_s")})
""",
    ),
    cell(
        "code",
        """
subprocess.run([sys.executable, "-m", "pipelines.train.viscera_train.language", "evaluate",
               "--data", str(DATA_DIR), "--out", str(MODEL_DIR)], check=True)
evaluation = json.loads((MODEL_DIR / "test_evaluation.json").read_text())
for method in ("compiler", "frozen", "adapter"):
    item = evaluation[method]
    print(method, {k: item[k] for k in ("attempted", "valid_json_schema", "exact_target_rate", "unsafe_false_ready")})
print("All invalid outputs and false-ready cases count as failures. No automatic runtime promotion.")
""",
    ),
    cell(
        "code",
        """
archive = Path(shutil.make_archive(str(WORK.parent / (RUN_ID + "-results")), "zip", WORK))
if REMOTE is not None:
    shutil.copy2(archive, REMOTE / archive.name)
    if hashlib.sha256((REMOTE / archive.name).read_bytes()).hexdigest() != hashlib.sha256(archive.read_bytes()).hexdigest():
        raise IOError("Drive result bundle checksum mismatch")
if DOWNLOAD_RESULTS and IN_COLAB:
    files.download(str(archive))
print("Language dataset, LoRA adapter, safe checkpoint, model card and three-way evaluation:", archive)
""",
    ),
]

if __name__ == "__main__":
    language_notebook = {
        **notebook,
        "cells": language_cells,
        "metadata": {
            **notebook["metadata"],
            "colab": {"name": "VISCERA_optional_language_LoRA.ipynb"},
        },
    }
    output = Path(__file__).with_name("VISCERA_optional_language_LoRA.ipynb")
    output.write_text(json.dumps(language_notebook, indent=2) + "\n")
    print(output)
