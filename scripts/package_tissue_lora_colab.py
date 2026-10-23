#!/usr/bin/env python3
"""Freeze the tissue-LoRA source into a notebook pinned to its bytes (A100 Colab client).

The notebook embeds the exact source, the base-model and feature-extractor locks
and the crop-release identity. It downloads only pinned revisions, trains with
the same code as the local pilot, and leaves every result on Drive with receipts.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_FILES = [
    "py/viscera_core/tissue_lora/__init__.py", "py/viscera_core/tissue_lora/captions.py",
    "py/viscera_core/tissue_lora/imaging.py", "py/viscera_core/tissue_lora/data.py",
    "py/viscera_core/tissue_lora/model.py", "py/viscera_core/tissue_lora/train.py",
    "py/viscera_core/tissue_lora/sample.py", "py/viscera_core/tissue_lora/pbr.py",
    "py/viscera_core/tissue_lora/evaluate.py", "py/viscera_core/tissue_lora/library.py",
    "py/viscera_core/tissue_lora/postprocess.py", "py/viscera_core/tissue_lora/service.py",
    "py/viscera_core/__init__.py", "py/viscera_core/tissue_materials/__init__.py", "py/viscera_core/tissue_materials/appearance.py",
    "py/viscera_core/tissue_materials/export.py", "py/viscera_core/tissue_materials/field.py",
    "py/viscera_core/tissue_materials/recipe.py", "py/viscera_core/tissue_materials/vascular.py",
    "scripts/tissue_lora_server.py",
    "py/viscera_core/tissue_diffusion/__init__.py", "py/viscera_core/tissue_diffusion/contract.py",
    "py/viscera_core/tissue_diffusion/runtime.py", "py/viscera_core/tissue_diffusion/stablematerials-lock.json",
    "scripts/tissue_lora.py", "tests/python/test_tissue_lora.py",
]
PIP_PROFILE = ["torch==2.8.0", "torchvision==0.23.0", "--index-url", "https://download.pytorch.org/whl/cu126"]
PIP_PACKAGES = ["diffusers==0.35.1", "transformers==4.57.1", "peft==0.17.1", "accelerate==1.10.1",
                "safetensors>=0.5,<1", "scipy>=1.15,<2", "pillow>=11,<13", "numpy>=2.2,<3", "huggingface_hub>=0.30,<1",
                "pytest>=8.3,<10"]


def bundle(root: Path) -> tuple[bytes, dict]:
    inventory = {}
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in SOURCE_FILES:
            data = (root / name).read_bytes()
            if not data:
                raise ValueError(f"refusing to freeze an empty file (iCloud placeholder?): {name}")
            if name.endswith(".py"):
                compile(data, name, "exec")
            inventory[name] = hashlib.sha256(data).hexdigest()
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            archive.writestr(info, data)
        info = zipfile.ZipInfo("source-inventory.json", date_time=(1980, 1, 1, 0, 0, 0))
        archive.writestr(info, json.dumps(inventory, indent=2, sort_keys=True))
    return stream.getvalue(), inventory


def cell(kind: str, source: str) -> dict:
    value = {"cell_type": kind, "metadata": {}, "source": source.strip() + "\n"}
    if kind == "code":
        value.update(execution_count=None, outputs=[])
    return value


def notebook(archive: bytes, inventory: dict, locks: dict, crop_release: dict | None) -> dict:
    archive_sha = hashlib.sha256(archive).hexdigest()
    release_line = (f"Expected crop release `records_sha256` = `{crop_release['records_sha256']}` "
                    f"({crop_release['records']} crops)." if crop_release else "No crop release identity was pinned at packaging time.")
    cells = [cell("markdown", f"""
# VISCERA · learned tissue tiles · LoRA on Stable Diffusion 1.5 · A100

Trains a UNet LoRA on native-scale, illumination-flattened surgical crops (DSAD exterior organs, research-only;
HyperKvasir mucosa, CC BY 4.0), then samples seamless tiles with circular padding, exports Studio material
studies and computes held-out statistics against unseen surgeries. The same frozen source ran the local Metal pilot.

Select **Runtime → Change runtime type → A100 GPU**, fresh Python 3.11/3.12 runtime, then run all cells.
Upload the crop release ZIP produced on the workstation (`tissue-crops-v1-<sha8>.zip`) to
`MyDrive/VISCERA Tissue LoRA 2026-10-21/` first. {release_line}

What this is not: measured albedo, patient anatomy, a 4K learned texture, or clinical qualification. The
base model is CreativeML OpenRAIL-M; DSAD-derived weights and tiles stay research-only until the dataset
licence conflict is resolved. Nothing here publishes to the public site.
"""), cell("code", f"""
import sys, subprocess, shutil
if sys.version_info[:2] not in ((3, 11), (3, 12)):
    raise RuntimeError("Select a Colab Python 3.11/3.12 runtime.")
if any(name in sys.modules for name in ("torch", "diffusers", "peft")):
    raise RuntimeError("Start a fresh runtime before installing the pinned profile.")
if shutil.disk_usage("/content").free < 20 * 1024**3:
    raise RuntimeError("At least 20 GiB free runtime disk is required.")
subprocess.run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", *{json.dumps(PIP_PROFILE)}], check=True)
subprocess.run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", *{json.dumps(PIP_PACKAGES)}], check=True)
"""), cell("code", """
import torch, importlib.metadata, json
if not torch.cuda.is_available() or "A100" not in torch.cuda.get_device_name(0):
    raise RuntimeError("This profile requires an actual NVIDIA A100; no silent fallback.")
print({"GPU": torch.cuda.get_device_name(0), "CUDA": torch.version.cuda, "packages": {name: importlib.metadata.version(name)
    for name in ("torch", "diffusers", "transformers", "peft", "accelerate", "safetensors")}})
"""), cell("markdown", """
## Restore the frozen source
The archive is pinned by SHA-256 and every file is checked against its inventory before use. The embedded tests
run on the restored tree so the CPU contracts are verified on this runtime before any GPU time is spent.
"""), cell("code", f"""
import base64, hashlib, io, json, os, shutil, subprocess, sys, zipfile
from pathlib import Path
SOURCE_SHA256 = {archive_sha!r}
SOURCE_BASE64 = {base64.b64encode(archive).decode('ascii')!r}
raw = base64.b64decode(SOURCE_BASE64, validate=True)
assert hashlib.sha256(raw).hexdigest() == SOURCE_SHA256
ROOT = Path("/content/viscera-tissue-lora") / SOURCE_SHA256[:16]
if ROOT.exists():
    shutil.rmtree(ROOT)  # same bundle hash → identical bytes; a stale partial restore is replaced
with zipfile.ZipFile(io.BytesIO(raw)) as archive:
    inventory = json.loads(archive.read("source-inventory.json"))
    names = set(archive.namelist())
    if names != set(inventory) | {{"source-inventory.json"}}:
        raise ValueError("unexpected source files")
    for name, digest in inventory.items():
        if Path(name).is_absolute() or ".." in Path(name).parts:
            raise ValueError("unsafe path")
        data = archive.read(name)
        if hashlib.sha256(data).hexdigest() != digest:
            raise ValueError("source digest mismatch: " + name)
        target = ROOT / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
os.environ["PYTHONPATH"] = f"{{ROOT / 'py'}}:{{ROOT}}"
print("Verified source:", SOURCE_SHA256)
subprocess.run([sys.executable, "-m", "pytest", str(ROOT / "tests/python/test_tissue_lora.py"), "-q", "-p", "no:cacheprovider",
                "-k", "not trainer_runs and not sampler_writes", "-W", "ignore"], check=True, cwd=ROOT)
"""), cell("markdown", """
## Drive, crop release and pinned models
Drive carries the crop release in and the results out. The base model and the feature extractor are downloaded
at their pinned revisions and verified against the embedded locks (sizes and SHA-256) before loading.
"""), cell("code", f"""
from google.colab import drive
import hashlib, json, shutil, zipfile
from datetime import datetime, timezone
drive.mount("/content/drive")
PROJECT = Path("/content/drive/MyDrive/VISCERA Tissue LoRA 2026-10-21")
PROJECT.mkdir(parents=True, exist_ok=True)
EXPECTED_RECORDS_SHA256 = {(crop_release['records_sha256'] if crop_release else None)!r}
zips = sorted(PROJECT.glob("tissue-crops-v1*.zip"))
if not zips:
    raise FileNotFoundError("Upload the crop release ZIP into " + str(PROJECT))
CROPS = Path("/content/tissue-crops")
if not CROPS.exists():
    with zipfile.ZipFile(zips[-1]) as archive:
        for name in archive.namelist():
            if Path(name).is_absolute() or ".." in Path(name).parts:
                raise ValueError("unsafe crop path")
        archive.extractall(CROPS)
release = json.loads((CROPS / "release.json").read_text())
records_sha = hashlib.sha256((CROPS / "records.jsonl").read_bytes()).hexdigest()
if records_sha != release["records_sha256"]:
    raise ValueError("records.jsonl differs from release.json")
# Accept the pinned release itself or a family-capped subset of it (subset_of.records_sha256 = parent identity).
parent_sha = (release.get("subset_of") or {{}}).get("records_sha256")
if EXPECTED_RECORDS_SHA256 and EXPECTED_RECORDS_SHA256 not in (records_sha, parent_sha):
    raise ValueError("crop release is neither the pinned release nor a subset of it")
print("Crop release:", records_sha, "subset of:", parent_sha, release["counts"])

LOCKS = json.loads({json.dumps(json.dumps(locks))})
from huggingface_hub import snapshot_download
def restore(lock, dest, allow):
    dest = Path(dest)
    path = snapshot_download(lock["repository"], revision=lock["revision"], allow_patterns=allow, local_dir=str(dest))
    for item in lock["files"]:
        file = dest / item["path"]
        digest = hashlib.sha256(file.read_bytes()).hexdigest() if file.stat().st_size < 400 * 1024**2 else None
        if file.stat().st_size != item["bytes"] or (digest and digest != item["sha256"]):
            raise ValueError("pinned model file differs: " + item["path"])
    (dest / lock["name"]).write_text(json.dumps(lock, indent=2) + "\\n")
    return dest
SD15 = restore(LOCKS["sd15"], "/content/sd15-451f4fe1", [f["path"] for f in LOCKS["sd15"]["files"]])
DINO = restore(LOCKS["dinov2"], "/content/dinov2-small", [f["path"] for f in LOCKS["dinov2"]["files"]])
print("Pinned models verified.")
"""), cell("markdown", """
## Train
One immutable experiment per configuration (run id = config + crop release + model lock). Checkpoints mirror to
Drive so a disconnected runtime resumes exactly. The default budget below is the A100 profile; the local Metal pilot
used the same code with a smaller budget.
"""), cell("code", """
import shutil, time, subprocess, json, sys
# Lessons from the Metal pilots (see docs/tissue-lora-training-2026-10-21.md): a mixed exterior+mucosa model learned
# a generic endoscopic style with almost no organ conditioning and inherited lumen holes, bubbles and residue from
# the endoscopy frames. Train the exterior organs alone with organ-first captions and uniform family sampling.
CONFIG = {"steps": 4000, "rank": 64, "alpha": 64, "learning_rate": 1e-4, "pixel_budget": 512 * 512 * 8, "max_batch": 16,
          "checkpoint_every": 500, "validation_every": 500, "validation_size": 512, "validation_steps": 25,
          "validation_guidance": 7.0, "caption_style": "v2", "caption_dropout": 0.05, "family_power": 0.0,
          "families": ["liver", "spleen", "stomach", "small_bowel", "large_bowel", "pancreas"],
          "profiles": ["noncommercial-research"], "device": "cuda", "precision": "bf16", "gradient_checkpointing": True}
# Mucosa (HyperKvasir, CC BY 4.0) needs a cleaner crop release first (prepare with --glint-local-contrast and review
# the dark/residue rules); then a second run with families ["colonic_mucosa", "gastric_mucosa"], profiles ["unrestricted"].
RUN = PROJECT / "runs" / ("a100-" + hashlib.sha256(json.dumps(CONFIG, sort_keys=True).encode()).hexdigest()[:8])
RUN.mkdir(parents=True, exist_ok=True)
CLI = ROOT / "scripts/tissue_lora.py"
subprocess.run([sys.executable, str(CLI), "train", "--dataset", str(CROPS), "--model", str(SD15), "--output", str(RUN),
                "--config-json", json.dumps(CONFIG)], check=True, cwd=ROOT)
receipt = json.loads((RUN / "training-receipt.json").read_text())
print({k: receipt[k] for k in ("run_id", "status", "steps_completed", "seconds", "peak_memory_bytes")})
"""), cell("markdown", """
## Sample a tile library, evaluate against held-out surgeries, export review studies
Tiles use circular padding (seamless by construction) and CPU-seeded noise. The evaluation reports FID/KID in
DINOv2 feature space against the validation surgeries, the train-vs-val floor, an organ probe, nearest-neighbour
cosine (memorization check) and diversity. These are statistics, not a realism certificate.
"""), cell("code", """
latest = json.loads((RUN / "checkpoints/latest.json").read_text())
LORA = RUN / "checkpoints" / latest["directory"]
COLOUR = RUN / "colour-stats.json"
if not COLOUR.exists():
    subprocess.run([sys.executable, str(CLI), "colour-stats", "--dataset", str(CROPS), "--output", str(COLOUR)], check=True, cwd=ROOT)
# Cleaned tiles: baked glints/halos/specks removed and organ colour matched to the real crops (raw.png kept beside).
CLEAN = ["--clean", "clean-colour", "--colour-stats", str(COLOUR)]
TILES = RUN / "tiles-512"
FAMILIES = CONFIG.get("families") or ["liver", "spleen", "stomach", "small_bowel", "large_bowel", "pancreas", "colonic_mucosa", "gastric_mucosa"]
SEEDS = ",".join(str(s) for s in range(1, 17))
if not (TILES / "contact.png").exists():
    if TILES.exists():
        shutil.rmtree(TILES)  # a partial tile set from an interrupted run is regenerated
    subprocess.run([sys.executable, str(CLI), "sample", "--model", str(SD15), "--lora", str(LORA), "--output", str(TILES),
                    "--families", *FAMILIES, "--seeds", SEEDS, "--size", "512", "--steps", "20", "--guidance", "7",
                    "--device", "cuda", *CLEAN], check=True, cwd=ROOT)
HIRES = RUN / "tiles-1024-hires"
if not (HIRES / "contact.png").exists():
    if HIRES.exists():
        shutil.rmtree(HIRES)
    subprocess.run([sys.executable, str(CLI), "sample", "--model", str(SD15), "--lora", str(LORA), "--output", str(HIRES),
                    "--families", *FAMILIES, "--seeds", "1,2,3,4", "--size", "512", "--steps", "20", "--guidance", "7",
                    "--device", "cuda", "--hires"], check=True, cwd=ROOT)
EVAL = RUN / "evaluation-512"
subprocess.run([sys.executable, str(CLI), "evaluate", "--dataset", str(CROPS), "--samples", str(TILES), "--output", str(EVAL),
                "--extractor", str(DINO), "--device", "cuda", "--cache", str(PROJECT / "eval-cache")], check=True, cwd=ROOT)
print(json.dumps(json.loads((EVAL / "evaluation.json").read_text())["summary"], indent=2))
STUDIES = RUN / "studies-512"
STUDIES.mkdir(exist_ok=True)
for receipt in sorted(TILES.glob("*/sample.json"))[:16]:
    target = STUDIES / receipt.parent.name
    if not (target / "manifest.json").exists():
        subprocess.run([sys.executable, str(CLI), "export", str(receipt.parent), str(target)], check=True, cwd=ROOT)
print("review-only studies:", len(list(STUDIES.glob("*/manifest.json"))), "(the Studio catalog step runs on the workstation)")
"""), cell("code", """
# Everything already lives on Drive under RUN; this prints the identities to copy into the project record.
import hashlib
weights = LORA / "pytorch_lora_weights.safetensors"
print(json.dumps({"run": str(RUN), "lora_sha256": hashlib.sha256(weights.read_bytes()).hexdigest(),
                  "lora_bytes": weights.stat().st_size, "tiles": str(TILES), "evaluation": str(EVAL / "evaluation.json"),
                  "contact_sheet": str(TILES / "contact.png")}, indent=2))
""")]
    return {"cells": cells, "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
                                        "language_info": {"name": "python"}, "accelerator": "GPU"},
            "nbformat": 4, "nbformat_minor": 5}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sd15-lock", type=Path, default=Path("/Volumes/LaCie/VirtaMed/viscera-tissue-models/sd15-451f4fe1/sd15-lock.json"))
    parser.add_argument("--dinov2-lock", type=Path, default=Path("/Volumes/LaCie/VirtaMed/viscera-tissue-models/dinov2-small/dinov2-lock.json"))
    parser.add_argument("--crop-release", type=Path, help="release.json of the crop release to pin")
    parser.add_argument("--output", type=Path, default=ROOT / "notebooks/VISCERA_tissue_lora_A100.ipynb")
    parser.add_argument("--receipt", type=Path, default=ROOT / "notebooks/VISCERA_tissue_lora_A100.receipt.json")
    args = parser.parse_args()
    archive, inventory = bundle(ROOT)
    locks = {}
    for key, path in (("sd15", args.sd15_lock), ("dinov2", args.dinov2_lock)):
        lock = json.loads(path.read_text())
        locks[key] = {"name": path.name, "repository": lock["repository"], "revision": lock["revision"],
                      "license": lock.get("license"), "files": [{k: f[k] for k in ("path", "bytes", "sha256")} for f in lock["files"]]}
    crop_release = json.loads(args.crop_release.read_text()) if args.crop_release else None
    document = notebook(archive, inventory, locks, crop_release)
    for entry in document["cells"]:
        if entry["cell_type"] == "code":
            compile(entry["source"], "<cell>", "exec")
    args.output.write_text(json.dumps(document, indent=1) + "\n")
    receipt = {"notebook": args.output.name, "notebook_sha256": hashlib.sha256(args.output.read_bytes()).hexdigest(),
               "source_sha256": hashlib.sha256(archive).hexdigest(), "source_files": inventory,
               "locks": {k: {"repository": v["repository"], "revision": v["revision"]} for k, v in locks.items()},
               "crop_release_records_sha256": crop_release["records_sha256"] if crop_release else None}
    args.receipt.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({k: receipt[k] for k in ("notebook", "notebook_sha256", "source_sha256")}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
