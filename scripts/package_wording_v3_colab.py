"""Separate v3 wording delivery; frozen v2 runtime, explicit unpromoted candidate."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import sys
import zipfile
from pathlib import Path

PREFIX = "viscera-wording-training"
DRIVE_FOLDER = "VISCERA Wording Coverage V3 2026-10-08"
FROZEN_BUNDLE_SHA = "83a631a7564c5cc2a6a2c3f2b9196e2be9a0be03ed2028172b5a7451f2ea8ddb"


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def cell(kind, text):
    value = {
        "cell_type": kind,
        "metadata": {},
        "id": hashlib.sha256(text.encode()).hexdigest()[:12],
        "source": text.strip().splitlines(keepends=True),
    }
    if kind == "code":
        ast.parse(text.strip())
        value.update(execution_count=None, outputs=[])
    return value


def notebook(archive_sha, blind_ready=False):
    bootstrap = Path(__file__).with_name("wording_notebook_bootstrap.py").read_text()
    cells = [
        cell(
            "markdown",
            """# VISCERA wording v3 — corrected coverage, run all

Choose **Runtime → Change runtime type → A100 GPU**, then **Run all** and approve Drive access. This is a separate run; all previous datasets, trained models and training runs remain preserved. If the prepared ZIP is not already on Drive, the first cell asks you to upload `viscera-wording-training-v3.zip` once and saves it there.

This revision adds qualitative requests and defaults missing from v2's numeric templates. It trains the pinned pretrained Qwen2.5-0.5B-Instruct with rank-16 LoRA, **one complete epoch at learning rate 3e-5**, with no shortened-step or randomly initialized production model. Source code is frozen to the original trainer and semantic contract. Checkpoints save to Drive every 100 optimizer steps; rerunning resumes the same configuration.

**Honest evaluation status:** the v2 audit and challenge have been inspected after the failed v2 candidate and are now regression evidence, not an independent blind test. This release deliberately does not repurpose those files as new blind tests. Fresh independent held-out evaluation remains required before promotion. Run all therefore downloads an **unpromoted research candidate**, not Studio-activatable weights. Validation accuracy is reported; no passing result is fabricated and the existing Studio model is preserved.

The task is bounded visual anatomy editing, not clinical inference or unrestricted text-to-mesh generation. No clinician validation is claimed.""",
        ),
        cell(
            "code",
            f"""from pathlib import Path
import hashlib, json, os, subprocess, sys, zipfile
from google.colab import drive, files
drive.mount('/content/drive')
DELIVERY = Path('/content/drive/MyDrive') / {DRIVE_FOLDER!r}
DELIVERY.mkdir(parents=True, exist_ok=True)
ARCHIVE = DELIVERY / 'viscera-wording-training-v3.zip'
EXPECTED_SHA256 = {archive_sha!r}
if not ARCHIVE.exists():
    print('Upload viscera-wording-training-v3.zip from the prepared delivery.')
    uploaded = files.upload()
    payload = uploaded.get('viscera-wording-training-v3.zip')
    assert payload is not None, 'The v3 training ZIP is required.'
    assert hashlib.sha256(payload).hexdigest() == EXPECTED_SHA256, 'Wrong training bundle'
    with ARCHIVE.open('xb') as stream: stream.write(payload)
with ARCHIVE.open('rb') as stream:
    assert hashlib.file_digest(stream, 'sha256').hexdigest() == EXPECTED_SHA256, 'Training bundle checksum mismatch'
WORK = Path('/content/viscera-wording-v3-' + EXPECTED_SHA256[:12])
WORK.mkdir(exist_ok=True)
with zipfile.ZipFile(ARCHIVE) as bundle:
    names = bundle.namelist()
    assert len(names) == len(set(names)), 'Duplicate ZIP member'
    for item in bundle.infolist():
        p = Path(item.filename)
        assert not p.is_absolute() and '..' not in p.parts and p.parts[0] == {PREFIX!r}, 'Unsafe source bundle'
        assert (item.external_attr >> 16) & 0o170000 != 0o120000, 'Symlinks are not allowed'
    bundle.extractall(WORK)
ROOT = WORK / {PREFIX!r}
manifest = json.loads((ROOT / 'bundle_manifest.json').read_text())
assert manifest['format'] == 'viscera-wording-training-bundle-v3-coverage'
actual = {{p.relative_to(ROOT).as_posix() for p in ROOT.rglob('*') if p.is_file()}}
assert actual == set(manifest['artifact_hashes']) | {{'bundle_manifest.json'}}, 'Unmanifested source file'
for name, expected in manifest['artifact_hashes'].items():
    with (ROOT / name).open('rb') as stream:
        assert hashlib.file_digest(stream, 'sha256').hexdigest() == expected, f'Changed bundled file: {{name}}'
DATA = ROOT / 'dataset'
RUN = DELIVERY / ('run-v3-' + manifest['dataset_release_sha256'][:12])
RUN.mkdir(exist_ok=True)
print('Verified release:', manifest['dataset_release_sha256'])
print('Conformance:', json.loads((ROOT / 'preflight.json').read_text()))
print('Separate persistent run:', RUN)
print('Promotion blocked until a fresh independent evaluation release is prepared.')""",
        ),
        cell(
            "code",
            bootstrap
            + "\n\n"
            + """ENV = Path('/content/viscera-wording-v3-env')
PYTHON = ensure_wording_environment(ENV)
subprocess.run([str(PYTHON), '-m', 'pip', 'install', '--disable-pip-version-check', 'torch==2.8.0', '--index-url', 'https://download.pytorch.org/whl/cu126'], check=True)
subprocess.run([str(PYTHON), '-m', 'pip', 'install', '--disable-pip-version-check', '-r', str(ROOT / 'requirements-wording-colab.txt')], check=True)
ENVIRONMENT = dict(os.environ, PYTHONPATH=str(ROOT / 'source/py') + os.pathsep + str(ROOT / 'source'), TOKENIZERS_PARALLELISM='false', PYTHONDONTWRITEBYTECODE='1')
subprocess.run([str(PYTHON), '-c', "import torch; print(torch.__version__); assert torch.cuda.is_available(), 'Select an A100 GPU runtime'; print(torch.cuda.get_device_name(0)); assert torch.cuda.get_device_properties(0).total_memory >= 35*1024**3, 'This prepared microbatch16 run requires A100 40GB or larger'; assert torch.ones(16,device='cuda').sum().item()==16"], check=True, env=ENVIRONMENT)
print('Training uses isolated Torch 2.8; no kernel restart is necessary.')""",
        ),
        cell(
            "code",
            '''# Use the frozen Python API: its CLI does not expose learning_rate.
TRAIN_CODE = """
import json, sys
from pathlib import Path
from pipelines.train.viscera_train import atlas_wording as trainer
data, out = map(Path, sys.argv[1:3])
cfg = trainer.WordingConfig(epochs=1, learning_rate=3e-5, max_steps=None, batch_size=16, accumulation=2, validation_limit=32, device='cuda', seed=20261008)
if not (out / 'checkpoint.pt').exists():
    trial = trainer.train(data, out, cfg, stop_after=1)
    assert trial == {'status': 'interrupted', 'step': 1}
    import gc, torch
    gc.collect(); torch.cuda.empty_cache()
    print('Real pretrained one-step memory/optimizer check passed; resuming identical configuration.', flush=True)
report = trainer.train(data, out, cfg, resume=(out / 'checkpoint.pt').exists())
assert report['pretrained_base_loaded'] and report['identity']['tiny_fixture'] is False
assert report['steps'] == report['required_steps']
assert report['identity']['config']['max_steps'] is None
assert report['identity']['config']['learning_rate'] == 3e-5
print(json.dumps({'steps': report['steps'], 'validation': report['validation'], 'baseline_comparison': report['baseline_comparison']}, indent=2))
"""
subprocess.run([str(PYTHON), '-u', '-c', TRAIN_CODE, str(DATA), str(RUN)], check=True, cwd=ROOT / 'source', env=ENVIRONMENT)
training_report = json.loads((RUN / 'training_report.json').read_text())
print('Completed the full v3 training epoch. This is not a passing blind evaluation.')''',
        ),
        cell(
            "code",
            """# Export a research archive under a name the Studio auto-importer never accepts.
# Do not call the production export function or mark this adapter promoted.
manifest = json.loads((RUN / 'manifest.json').read_text())
assert manifest['promoted'] is False, 'This workflow only handles unpromoted candidates.'
assert training_report['steps'] == training_report['required_steps']
for name, expected in manifest['artifact_hashes'].items():
    with (RUN / name).open('rb') as stream:
        assert hashlib.file_digest(stream, 'sha256').hexdigest() == expected, f'Changed candidate: {name}'
STATUS = {
    'status': 'trained_research_candidate_pending_independent_evaluation',
    'training_complete': True, 'promoted': False,
    'reason': 'V2 audit/challenge are exposed regression evidence. New independent held-out evaluation is not yet available.',
    'planned_epochs': 1, 'learning_rate': 3e-5,
    'steps': training_report['steps'],
    'dataset_release_sha256': manifest['identity']['dataset_release_sha256'],
    'original_promotion_thresholds_changed': False,
    'studio_autoactivation': False,
}
(RUN / 'candidate_status.json').write_text(json.dumps(STATUS, indent=2) + '\\n')
OUTPUT = DELIVERY / 'viscera-wording-v3-research-candidate.zip'
selected = {'manifest.json', 'training_report.json', 'dataset_release.json', 'checkpoint.pt', 'candidate_status.json', *manifest['artifact_hashes']}
with zipfile.ZipFile(OUTPUT.with_suffix('.tmp'), 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for name in sorted(selected):
        assert (RUN / name).is_file(), f'Missing candidate artifact: {name}'
        archive.write(RUN / name, 'viscera-wording-v3-research-candidate/' + name)
os.replace(OUTPUT.with_suffix('.tmp'), OUTPUT)
print(json.dumps(STATUS, indent=2))
print('Research checkpoint preserved on Drive:', OUTPUT)
print('Keep existing Studio models active. A fresh independent evaluation must pass the unchanged gates before production export.')
files.download(str(OUTPUT))""",
        ),
    ]
    if blind_ready:
        cells[0] = cell(
            "markdown",
            """# VISCERA wording v3 — corrected coverage, run all

Choose **Runtime → Change runtime type → A100 GPU**, then **Run all** and approve Drive access. Upload the prepared v3 training ZIP only if it is not already on Drive. Previous datasets, models and runs remain preserved.

Train the pinned pretrained Qwen2.5-0.5B-Instruct with rank-16 LoRA for **one complete epoch at learning rate 3e-5**. This revision adds qualitative requests/defaults missing from v2. Checkpoints persist every100 steps. Re-running resumes the identical new v3 run; original v2 training is untouched.

The failed v2 audit/challenge are retained separately as **exposed regression evidence**. A new independently authored, frozen audit/challenge is packaged before v3 training. Runtime conformance and partition separation are checked before packaging. Fresh authored tests are not clinician validation or evidence of unrestricted natural-language generalization. Final activation requires all unchanged original generation gates on at least512 audit examples and the complete fresh challenge. A failed gate downloads diagnostics and exports no active weights.

The final cell downloads **viscera-wording-weights.zip** only after passing evaluation. The model creates bounded visual anatomy edit plans, not patient diagnoses, surgical mechanics or unrestricted meshes. No result is promised before testing.""",
        )
        setup = "".join(cells[1]["source"]).replace(
            "print('Promotion blocked until a fresh independent evaluation release is prepared.')",
            "print('Fresh audit/challenge frozen before training; original promotion gates apply.')",
        )
        cells[1] = cell("code", setup)
        cells[3:] = [
            cell(
                "code",
                """# One shared runner owns training, validation, parity testing, evaluation and gated export.
# Resume never changes configuration or repeats an existing final evaluation.
OUTPUT = RUN / 'viscera-wording-weights.zip'
try:
    subprocess.run([str(PYTHON), '-u', str(ROOT / 'run_wording_v3_pipeline.py'), '--data', str(DATA), '--run', str(RUN), '--output', str(OUTPUT)], check=True, cwd=ROOT / 'source', env=ENVIRONMENT)
except subprocess.CalledProcessError:
    if (RUN / 'evaluation.json').is_file():
        files.download(str(RUN / 'evaluation.json'))
    raise
print(json.dumps(json.loads((RUN / 'pipeline_status.json').read_text()), indent=2))""",
            ),
            cell(
                "code",
                """status = json.loads((RUN / 'pipeline_status.json').read_text())
assert status['status'] == 'complete' and status['production_exported'] is True
OUTPUT = Path(status['weights'])
with OUTPUT.open('rb') as stream:
    assert hashlib.file_digest(stream, 'sha256').hexdigest() == status['sha256']
evaluation = json.loads((RUN / 'evaluation.json').read_text())
print(json.dumps({'passed': evaluation['passed'], 'gates': evaluation['gates'], 'generation_execution': evaluation.get('generation_execution')}, indent=2))
print('Validated wording weights:', OUTPUT)
print('Prior joint shape/color models are preserved. Import this separate wording lane in Studio.')
files.download(str(OUTPUT))""",
            ),
        ]
    return {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "accelerator": "GPU",
            "colab": {"name": "VISCERA_wording_v3_coverage_run_all.ipynb", "provenance": []},
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python"},
        },
        "cells": cells,
    }


def hot_cell(nb):
    setup = "".join(nb["cells"][1]["source"])
    return """# Start the new v3 pipeline using the existing verified Torch2.8 A100 worker.
# Existing v2 source, original training and active models are preserved.
assert 'wording_scope' in globals() and 'PYTHON' in wording_scope, 'Run the original verified wording environment setup first'
V3 = {'__name__': '__main__'}
exec(SETUP_SOURCE, V3)
from pathlib import Path
import json, os, subprocess
P = Path(wording_scope['PYTHON'])
R, D, RUN, DELIVERY = (V3[key] for key in ('ROOT', 'DATA', 'RUN', 'DELIVERY'))
ENVIRONMENT = dict(os.environ, PYTHONPATH=str(R / 'source/py') + os.pathsep + str(R / 'source'), TOKENIZERS_PARALLELISM='false', PYTHONDONTWRITEBYTECODE='1')
subprocess.run([str(P), '-c', "import torch; assert torch.__version__.startswith('2.8.'); assert torch.cuda.is_available(); assert torch.cuda.get_device_properties(0).total_memory >= 35*1024**3; print(torch.__version__, torch.cuda.get_device_name(0))"], check=True, env=ENVIRONMENT)
PIPELINE = RUN / 'pipeline_status.json'
assert not PIPELINE.exists(), 'A pipeline has already been started in this exact release run. Inspect pipeline_status.json/training.log before resuming; do not start a duplicate.'
LOG = RUN / 'training.log'
with LOG.open('ab') as log:
    job = subprocess.Popen([str(P), '-u', str(R / 'run_wording_v3_pipeline.py'), '--data', str(D), '--run', str(RUN), '--output', str(RUN / 'viscera-wording-weights.zip')], cwd=R / 'source', env=ENVIRONMENT, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
receipt = {'status': 'launched_not_yet_trained', 'pid': job.pid, 'run': str(RUN), 'log': str(LOG), 'steps_expected': (json.loads((D / 'release.json').read_text())['counts']['train'] + 31) // 32, 'microbatch': 16, 'accumulation': 2, 'epochs': 1, 'learning_rate': 3e-5, 'validation_diagnostic_rows': 32, 'audit_rows': 512, 'fresh_challenge': 'complete', 'production_export': 'only_after_original_gates_pass'}
(RUN / 'launch_receipt.json').write_text(json.dumps(receipt, indent=2) + '\\n')
print(json.dumps(receipt, indent=2))
print('Watch training.log and pipeline_status.json on Drive. No finished weights are claimed.')
""".replace("SETUP_SOURCE", repr(setup))


def package(root, data, destination, frozen_bundle):
    if digest(frozen_bundle) != FROZEN_BUNDLE_SHA:
        raise ValueError("Frozen original source bundle checksum mismatch")
    sys.path[:0] = [str(root), str(root / "py")]
    from pipelines.train.viscera_train import atlas_wording as trainer

    release = json.loads((data / "release.json").read_text())
    for name, expected in release["artifact_hashes"].items():
        path = data / name
        if (
            not path.resolve().is_relative_to(data.resolve())
            or path.is_symlink()
            or digest(path) != expected
        ):
            raise ValueError("Dataset artifact mismatch: " + name)
    train, val = [trainer.read_split(data, name) for name in ("train", "val")]
    trainer.audit_disjoint(train, val)
    for rows in (train, val):
        trainer.validate_gold_rows(rows)
    if len(train) < 10000:
        raise ValueError("Expected real 10k+ coverage training")
    blind_ready = (data / "audit.jsonl").is_file() and (data / "challenge.jsonl").is_file()
    if blind_ready:
        if release.get("promotion_eligible") is not True:
            raise ValueError("Fresh evaluation not declared promotion eligible in frozen release")
        audit, challenge = [trainer.read_split(data, name) for name in ("audit", "challenge")]
        trainer.audit_disjoint(train, val, audit, challenge)
        for rows in (audit, challenge):
            trainer.validate_gold_rows(rows)
        if len(audit) < 512 or len(challenge) < 40:
            raise ValueError("Fresh evaluation coverage below unchanged gate minimum")
        for fresh, exposed in (
            ("audit.jsonl", "exposed_v2_audit.jsonl"),
            ("challenge.jsonl", "exposed_v2_challenge.jsonl"),
        ):
            if (data / exposed).is_file() and digest(data / fresh) == digest(data / exposed):
                raise ValueError("Exposed v2 tests cannot be relabeled independent")
    payloads = {}
    with zipfile.ZipFile(frozen_bundle) as old:
        old_manifest = json.loads(old.read(PREFIX + "/bundle_manifest.json"))
        for name, expected in old_manifest["artifact_hashes"].items():
            if name.startswith("source/") or name == "requirements-wording-colab.txt":
                content = old.read(PREFIX + "/" + name)
                if hashlib.sha256(content).hexdigest() != expected:
                    raise ValueError("Frozen source integrity mismatch")
                payloads[name] = content
    for name, expected in trainer.source_hashes(root).items():
        if hashlib.sha256(payloads["source/" + name]).hexdigest() != expected:
            raise ValueError("Local runtime differs from frozen training: " + name)
    for path in sorted(data.rglob("*")):
        if path.is_file():
            payloads["dataset/" + path.relative_to(data).as_posix()] = path.read_bytes()
    preflight = {
        "passed": True,
        "counts": {"train": len(train), "val": len(val)},
        "gold_runtime_conformance": 1.0,
        "train_validation_family_and_prompt_disjoint": True,
        "independent_audit_ready": blind_ready,
        "v2_evaluation_exposure": "regression_only",
        "production_export_enabled": blind_ready,
    }
    payloads["run_wording_v3_pipeline.py"] = (
        Path(__file__).with_name("run_wording_v3_pipeline.py").read_bytes()
    )
    payloads["wording_batched_evaluation.py"] = (
        Path(__file__).with_name("wording_batched_evaluation.py").read_bytes()
    )
    if (
        blind_ready
        and release.get("evaluation_contract", {}).get("helper_sha256")
        != hashlib.sha256(payloads["wording_batched_evaluation.py"]).hexdigest()
    ):
        raise ValueError("Evaluation helper does not match the frozen release contract")
    payloads["preflight.json"] = (json.dumps(preflight, indent=2) + "\n").encode()
    manifest = {
        "format": "viscera-wording-training-bundle-v3-coverage",
        "dataset_release_sha256": digest(data / "release.json"),
        "frozen_source_bundle_sha256": FROZEN_BUNDLE_SHA,
        "artifact_hashes": {
            name: hashlib.sha256(value).hexdigest() for name, value in payloads.items()
        },
    }
    payloads["bundle_manifest.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    destination.mkdir(parents=True, exist_ok=True)
    archive_path = destination / "viscera-wording-training-v3.zip"
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name, value in sorted(payloads.items()):
            archive.writestr(PREFIX + "/" + name, value)
    checksum = digest(archive_path)
    nb = notebook(checksum, blind_ready=blind_ready)
    notebook_path = destination / "VISCERA_wording_v3_coverage_run_all.ipynb"
    notebook_path.write_text(json.dumps(nb, indent=2) + "\n")
    (root / "notebooks" / notebook_path.name).write_bytes(notebook_path.read_bytes())
    result = {
        "archive": str(archive_path),
        "sha256": checksum,
        "bytes": archive_path.stat().st_size,
        "notebook": str(notebook_path),
        "notebook_sha256": digest(notebook_path),
        "drive_folder": DRIVE_FOLDER,
        "preflight": preflight,
        "code_cells_syntax_checked": sum(c["cell_type"] == "code" for c in nb["cells"]),
        "cloud_training_executed": False,
        "production_export_enabled": blind_ready,
    }
    if blind_ready:
        start_path = destination / "start_v3_in_existing_colab.py"
        start_path.write_text(hot_cell(nb))
        ast.parse(start_path.read_text())
        result["hot_start_cell"] = str(start_path)
        result["hot_start_cell_sha256"] = digest(start_path)
    (destination / "delivery.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--frozen-bundle", type=Path, required=True)
    args = parser.parse_args()
    print(
        json.dumps(
            package(
                args.root.resolve(),
                args.data.resolve(),
                args.out.resolve(),
                args.frozen_bundle.resolve(),
            ),
            indent=2,
        )
    )
