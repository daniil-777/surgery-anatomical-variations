"""Build a checksum-pinned, self-contained Drive/Colab wording training delivery."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

PREFIX = "viscera-wording-training"
DRIVE_FOLDER = "VISCERA Wording Training 2026-10-07"


def digest(path):
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def cell(kind, text):
    value = {
        "cell_type": kind,
        "metadata": {},
        "id": hashlib.sha256(text.encode()).hexdigest()[:12],
        "source": text.strip().splitlines(keepends=True),
    }
    if kind == "code":
        value.update(execution_count=None, outputs=[])
    return value


def notebook(archive_sha: str) -> dict:
    bootstrap = Path(__file__).with_name("wording_notebook_bootstrap.py").read_text()
    cells = [
        cell(
            "markdown",
            """# VISCERA — broader anatomy wording, run all

Select **Runtime → Change runtime type → T4 GPU** (A100 also works), then **Run all**. Approve the Google Drive mount. No folder IDs, dataset paths, or model tokens need editing. The public Qwen base downloads automatically. Two training epochs use the complete training partition; checkpoints are stored on Drive every 100 optimizer steps. If Colab disconnects, reconnect to a GPU and run all again to resume exactly the same run.

The model learns bounded visual-authoring intent, including healthier, milder pathology, proportions, material adjectives, and preservation constraints. It does not infer a patient's diagnosis or simulate surgery. The dataset is synthetic authored supervision, with phrase-family-separated validation/audit and an independent agent-authored regression challenge. No clinician review is claimed.

The final cell downloads **viscera-wording-weights.zip** only if independent generation tests pass. VISCERA's running local studio watches Downloads for this archive and validates/activates it automatically. A failed gate saves a detailed report and keeps the existing model; training loss is never substituted for wording accuracy.""",
        ),
        cell(
            "code",
            f"""from pathlib import Path
import hashlib, json, os, shutil, subprocess, sys, zipfile
from google.colab import drive, files
drive.mount('/content/drive')
DELIVERY = Path('/content/drive/MyDrive') / {DRIVE_FOLDER!r}
ARCHIVE = DELIVERY / 'viscera-wording-training-v2.zip'
EXPECTED_SHA256 = {archive_sha!r}
assert ARCHIVE.is_file(), f'Missing prepared dataset/source bundle: {{ARCHIVE}}'
with ARCHIVE.open('rb') as handle:
    assert hashlib.file_digest(handle, 'sha256').hexdigest() == EXPECTED_SHA256, 'Bundle checksum mismatch'
WORK = Path('/content/viscera-wording-v2')
WORK.mkdir(exist_ok=True)
with zipfile.ZipFile(ARCHIVE) as archive:
    names = archive.namelist()
    assert len(names) == len(set(names)), 'Duplicate ZIP entries'
    for item in archive.infolist():
        p = Path(item.filename)
        assert not p.is_absolute() and '..' not in p.parts and p.parts[0] == {PREFIX!r}, 'Unsafe bundle path'
        assert (item.external_attr >> 16) & 0o170000 != 0o120000, 'Symlink is not allowed'
    archive.extractall(WORK)
ROOT = WORK / {PREFIX!r}
manifest = json.loads((ROOT / 'bundle_manifest.json').read_text())
for name, expected in manifest['artifact_hashes'].items():
    with (ROOT / name).open('rb') as handle:
        assert hashlib.file_digest(handle, 'sha256').hexdigest() == expected, f'Changed source or dataset: {{name}}'
DATA = ROOT / 'dataset'
RUN = DELIVERY / 'run-v2'
RUN.mkdir(exist_ok=True)
print('Verified dataset and frozen source:', manifest['dataset_release_sha256'])
print('Release conformance:', json.loads((ROOT / 'preflight.json').read_text()))
print('Persistent run:', RUN)""",
        ),
        cell(
            "code",
            bootstrap + "\n\n" + """# All training runs in an isolated Python environment; no kernel restart is needed.
ENV = Path('/content/viscera-wording-env')
PYTHON = ensure_wording_environment(ENV)
subprocess.run([str(PYTHON), '-m', 'pip', 'install', '--disable-pip-version-check', 'torch==2.8.0', '--index-url', 'https://download.pytorch.org/whl/cu126'], check=True)
subprocess.run([str(PYTHON), '-m', 'pip', 'install', '--disable-pip-version-check', '-r', str(ROOT / 'requirements-wording-colab.txt')], check=True)
ENVIRONMENT = dict(os.environ, PYTHONPATH=str(ROOT / 'source/py') + os.pathsep + str(ROOT / 'source'), TOKENIZERS_PARALLELISM='false')
subprocess.run([str(PYTHON), '-c', "import torch; print(torch.__version__); assert torch.cuda.is_available(), 'Choose a GPU runtime before Run all'; print(torch.cuda.get_device_name(0)); a=torch.ones(16,device='cuda'); assert a.sum().item()==16"], check=True, env=ENVIRONMENT)
def wording(action, *arguments):
    subprocess.run([str(PYTHON), '-u', '-m', 'pipelines.train.viscera_train.atlas_wording', action, *map(str, arguments)], check=True, cwd=ROOT / 'source', env=ENVIRONMENT)""",
        ),
        cell(
            "code",
            """# Actual tiny Qwen LoRA optimizer updates, loss decrease and exact checkpoint resume.
# These randomly initialized smoke weights are never exportable.
wording('smoke', '--data', DATA, '--out', ROOT / 'cpu-smoke')
smoke_report = json.loads((ROOT / 'cpu-smoke/smoke_report.json').read_text())
assert smoke_report['passed']
print(json.dumps(smoke_report, indent=2))""",
        ),
        cell(
            "code",
            """# Public, immutable Qwen2.5-0.5B-Instruct base; complete train partition, two epochs.
# Completion-only cross entropy; rank-16 LoRA on attention and MLP projections.
# Dynamic padding, gradient accumulation/checkpointing, bf16 on A100/fp16 on T4.
arguments = ['--data', DATA, '--out', RUN, '--device', 'cuda', '--epochs', '2']
if (RUN / 'checkpoint.pt').exists():
    arguments.append('--resume')
wording('train', *arguments)
training_report = json.loads((RUN / 'training_report.json').read_text())
assert training_report['pretrained_base_loaded'] and not training_report['identity']['tiny_fixture']
print('Completed optimizer steps:', training_report['steps'])
print('Validation:', training_report['validation'])
print('Frozen-base comparison on identical validation prompts:', training_report['baseline_comparison'])""",
        ),
        cell(
            "code",
            """# Only now open the held-out audit/challenge partitions. They never drive updates.
wording('evaluate', '--data', DATA, '--out', RUN, '--device', 'cuda')
evaluation = json.loads((RUN / 'evaluation.json').read_text())
print(json.dumps({'passed': evaluation['passed'], 'gates': evaluation['gates'], 'audit_operations_accuracy': evaluation['audit']['operations_accuracy'], 'challenge_operations_accuracy': evaluation['challenge']['operations_accuracy']}, indent=2))
if not evaluation['passed']:
    files.download(str(RUN / 'evaluation.json'))
    raise RuntimeError('Independent wording gates failed. Evaluation report saved/downloaded; no weights were promoted. Do not tune against this blind audit. Review validation errors and create a new untouched audit for a revised release.')""",
        ),
        cell(
            "code",
            """OUTPUT = DELIVERY / 'viscera-wording-weights.zip'
wording('export', '--out', RUN, '--destination', OUTPUT)
print('Validated weights saved on Drive:', OUTPUT)
print('Keep the local VISCERA studio running and save this download in your normal Downloads folder.')
files.download(str(OUTPUT))""",
        ),
    ]
    return {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "accelerator": "GPU",
            "colab": {"name": "VISCERA_wording_v2_run_all.ipynb", "provenance": []},
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python"},
        },
        "cells": cells,
    }


def verify_release(root: Path, data: Path) -> dict:
    """Stream every gold plan through the runtime contract before packaging."""
    sys.path.insert(0, str(root / "py"))
    from viscera_core.atlas_semantic import plan_fingerprint, validate_plan

    release = json.loads((data / "release.json").read_text())
    for name, expected in release["artifact_hashes"].items():
        path = data / name
        if (
            not path.resolve().is_relative_to(data.resolve())
            or path.is_symlink()
            or digest(path) != expected
        ):
            raise ValueError("Release artifact mismatch: " + name)
    for name, expected in {
        **release["source_hashes"],
        **release.get("provenance_source_hashes", {}),
    }.items():
        if digest(root / name) != expected:
            raise ValueError("Release source mismatch: " + name)
    groups, prompts, identifiers, counts, statuses = {}, {}, {}, {}, {}
    for split in ("train", "val", "audit", "challenge"):
        groups[split], prompts[split], identifiers[split] = set(), set(), set()
        counts[split] = 0
        with (data / (split + ".jsonl")).open() as handle:
            for line in handle:
                if not line.strip():
                    continue
                row = json.loads(line)
                if row["split"] != split or row["id"] in identifiers[split]:
                    raise ValueError("Invalid partition example identity")
                checked = validate_plan(row["target"], row["context"], text=row["text"])
                if plan_fingerprint(checked) != plan_fingerprint(row["target"]):
                    raise ValueError(
                        f"Gold/runtime mismatch {row['id']}: {row['text']}: {checked['message']}"
                    )
                identifiers[split].add(row["id"])
                groups[split].add(row["family_id"])
                prompts[split].add(re.sub(r"[^\w%.+-]+", " ", row["text"].lower()).strip())
                counts[split] += 1
                key = split + ":" + row["target"]["status"]
                statuses[key] = statuses.get(key, 0) + 1
    splits = list(counts)
    for i, left in enumerate(splits):
        for right in splits[i + 1 :]:
            for label, values in (
                ("id", identifiers),
                ("family", groups),
                ("normalized text", prompts),
            ):
                if values[left] & values[right]:
                    raise ValueError(f"Partition {label} leakage: {left}/{right}")
    return {
        "passed": True,
        "gold_runtime_conformance": 1.0,
        "counts": counts,
        "status_counts": statuses,
        "phrase_family_disjoint": True,
        "normalized_text_disjoint": True,
        "dataset_release_sha256": digest(data / "release.json"),
    }


def package(root: Path, data: Path, destination: Path) -> dict:
    destination.mkdir(parents=True, exist_ok=True)
    preflight = verify_release(root, data)
    with tempfile.TemporaryDirectory(prefix="viscera-wording-package-") as temporary:
        staging = Path(temporary) / PREFIX
        staging.mkdir()
        shutil.copytree(
            data,
            staging / "dataset",
            copy_function=shutil.copyfile,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
        sources = [
            p
            for p in (root / "py/viscera_core").rglob("*")
            if p.is_file() and p.suffix in {".py", ".json"} and "__pycache__" not in p.parts
        ]
        sources += [
            root / name
            for name in (
                "pipelines/__init__.py",
                "pipelines/train/__init__.py",
                "pipelines/train/viscera_train/__init__.py",
                "pipelines/train/viscera_train/atlas_wording.py",
            )
        ]
        for source in sources:
            target = staging / "source" / source.relative_to(root)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        shutil.copyfile(
            root / "notebooks/requirements-wording-colab.txt",
            staging / "requirements-wording-colab.txt",
        )
        release = json.loads((data / "release.json").read_text())
        for name, expected in release["source_hashes"].items():
            if digest(staging / "source" / name) != expected:
                raise ValueError("Source changed during packaging: " + name)
        (staging / "preflight.json").write_text(json.dumps(preflight, indent=2) + "\n")
        manifest = {
            "format": "viscera-wording-training-bundle-v2",
            "dataset_release_sha256": digest(data / "release.json"),
            "artifact_hashes": {
                str(p.relative_to(staging)): digest(p)
                for p in sorted(staging.rglob("*"))
                if p.is_file()
            },
        }
        (staging / "bundle_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        archive_path = destination / "viscera-wording-training-v2.zip"
        with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for path in sorted(staging.rglob("*")):
                if path.is_file():
                    archive.write(path, str(path.relative_to(staging.parent)))
    archive_sha = digest(archive_path)
    notebook_path = destination / "VISCERA_wording_v2_run_all.ipynb"
    notebook_path.write_text(json.dumps(notebook(archive_sha), indent=2) + "\n")
    shutil.copyfile(notebook_path, root / "notebooks/VISCERA_wording_v2_run_all.ipynb")
    result = {
        "archive": str(archive_path),
        "sha256": archive_sha,
        "bytes": archive_path.stat().st_size,
        "notebook": str(notebook_path),
        "notebook_sha256": digest(notebook_path),
        "drive_folder": DRIVE_FOLDER,
    }
    (destination / "delivery.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    print(
        json.dumps(package(args.root.resolve(), args.data.resolve(), args.out.resolve()), indent=2)
    )
