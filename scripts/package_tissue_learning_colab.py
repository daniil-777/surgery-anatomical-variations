#!/usr/bin/env python3
"""Make an allowlisted portable source ZIP and a notebook pinned to its bytes."""

from __future__ import annotations

import argparse
import hashlib
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def digest(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def cell(kind: str, source: str) -> dict:
    value = {"cell_type": kind, "metadata": {}, "source": source.strip() + "\n"}
    if kind == "code":
        value.update(execution_count=None, outputs=[])
    return value


def notebook(bundle_sha256: str, smoke_release_sha256: str | None) -> dict:
    cells = [cell("markdown", """
# VISCERA · masked RGB tissue appearance · A100 research client

This notebook calls an executable package with real gradients, safe resumable
checkpoints and portable browser export. It does not contain a second trainer.
**This compact baseline failed local photorealism review.** Its global latent,
axis-periodic Fourier MLP and RGB reconstruction objective produced smooth fields
and rectangular bands. A larger A100 training budget or 4096² output sampling
does not establish realistic anatomical detail. Use this notebook to reproduce
and measure a research baseline, not as a promised photoreal texture solution.
The default acquires the **DSAD research dataset directly into Drive** and runs a
bounded2000-update experiment. It uses the published surgery split and remains
research-only because the source licence statements conflict. This is a measured
baseline experiment, not an expectation of photoreal model quality.

The optional **66-image real-data engineering smoke** uses 64 HyperKvasir polyp
ROIs and 2 porcine HeiPor organ images, all in train. Their source groups cannot
support a held-out generalization claim. These are not healthy-colon labels.

The first cell sets `DATA_MODE='acquire_dsad_research'` for raw acquisition through training.
This downloads about 21 GB and needs substantial local scratch and Drive capacity.
For an already prepared experiment, set `DATA_MODE='prepared_group_split'` and provide
the private Drive folder of reviewed, split-separated shards plus its release
SHA256. DSAD acquisition/preparation scripts and reviewed catalog are included;
DSAD's conflicting licence statements keep that dataset research-only. Test
payloads are excluded from staging and require a separate frozen-checkpoint audit.

Select **Runtime → Change runtime type → A100 GPU → Runtime Version: 2026.07**,
then run the cells in order. This past runtime supplies Python 3.12.13; the newer
default Python 3.13 does not match this pinned wheel profile. Recheck the selected
runtime after reconnecting. [Official runtime versions](https://research.google.com/colaboratory/runtime-version-faq.html)
Availability is not guaranteed. The source ZIP is loaded from the project folder
on Drive; no manual file-upload cell is required. Mounted Drive requires your
authorization. This notebook records actual GPU/model, memory and throughput; no
GPU execution is asserted by the accompanying CPU tests. RGB appearance is not
albedo, PBR ground truth, patient anatomy or clinical qualification.
"""), cell("code", f'''
from pathlib import Path
import hashlib, json, os, shutil, subprocess, sys, uuid, zipfile
import platform
from google.colab import drive

# Main run settings. Change the mode explicitly for the small training-only smoke.
PROJECT_ROOT = Path('/content/drive/MyDrive/VISCERA Tissue Training 2026-10-19')
DATA_MODE = 'acquire_dsad_research'  # or 'engineering_real_smoke' / 'prepared_group_split'
PREPARED_DRIVE_FOLDER = None  # Required only for prepared_group_split.
PREPARED_RELEASE_SHA256 = ''  # Exact reviewed release hash for prepared_group_split.
MAX_UPDATES = 200 if DATA_MODE == 'engineering_real_smoke' else 2000
BATCH_SIZE = 8
PATCH_SIZE = 64 if DATA_MODE == 'engineering_real_smoke' else 128
MINIMUM_VALID_FRACTION = .01
DOWNLOAD_ARTIFACTS = False  # Completed artifacts are persisted on Drive automatically.
drive.mount('/content/drive')
if not PROJECT_ROOT.is_dir():
    raise FileNotFoundError('Upload the matching notebook/source ZIP into: ' + str(PROJECT_ROOT))

# These identity fields are generated from the packaged bytes, not guessed paths.
BUNDLE_SHA256 = {bundle_sha256!r}
SMOKE_RELEASE_SHA256 = {smoke_release_sha256!r}
SOURCE_ZIP = PROJECT_ROOT / 'viscera-tissue-learning-colab.zip'
if not SOURCE_ZIP.is_file():
    raise FileNotFoundError('Matching pinned source bundle is missing from Drive: ' + str(SOURCE_ZIP))
if hashlib.sha256(SOURCE_ZIP.read_bytes()).hexdigest() != BUNDLE_SHA256:
    raise ValueError('Source bundle hash mismatch; use the matching notebook and ZIP')
ROOT = Path('/content/viscera-tissue-learning-source') / BUNDLE_SHA256
# Bootstrap only after verifying the notebook-pinned complete ZIP identity.
with zipfile.ZipFile(SOURCE_ZIP) as archive:
    manifest = json.loads(archive.read('bundle-manifest.json'))
    if set(archive.namelist()) != set(manifest['files']) | {{'bundle-manifest.json'}}:
        raise ValueError('Bundle inventory mismatch')
    if len(archive.namelist()) != len(set(archive.namelist())):
        raise ValueError('Duplicate ZIP members')
    for name, record in manifest['files'].items():
        if name.startswith('/') or '\\\\' in name or any(p in ('', '.', '..') for p in name.split('/')):
            raise ValueError('Unsafe package path')
        raw = archive.read(name)
        if len(raw) != record['bytes'] or hashlib.sha256(raw).hexdigest() != record['sha256']:
            raise ValueError('Bundle member hash mismatch')
        target = ROOT / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and target.read_bytes() != raw:
            raise ValueError('Existing source differs; use a fresh runtime or extraction folder')
        target.write_bytes(raw)
sys.path.insert(0, str(ROOT / 'py'))
# Run-all after a source update must not reuse helpers imported from an older ZIP.
for module_name in list(sys.modules):
    if module_name == 'viscera_core' or module_name.startswith('viscera_core.'):
        del sys.modules[module_name]
print('Verified source bundle:', BUNDLE_SHA256)
'''), cell("markdown", """
## Explicit CUDA 12.6 environment, locked on first use

The selected profile is PyTorch 2.8.0 with CUDA 12.6, using the official wheel
for Python 3.11 or 3.12. On first use the resolver obtains exact dependency wheel
URLs and SHA256 hashes from package metadata and writes an immutable lock to
Drive. It then installs with `--require-hashes`; reconnects reuse that lock.
This is a runtime-resolved lock, not a falsely claimed preverified wheel archive.
No fallback to a different Torch/CUDA version is permitted. A fresh subprocess
uses the installed interpreter, avoiding already-imported notebook libraries.
The preflight first imports the actual training CLI and verifies an exact
checkpoint save/load round trip, including populated optimizer state and bfloat16
tensors. This catches missing application dependencies before dataset acquisition.
The NVIDIA driver and an actual A100 must then pass the GPU checks. These enable
strict deterministic algorithms and run the actual encoder, decoder, mask and
loss backward at both 64² and 128² under bfloat16 AMP before training.
"""), cell("code", '''
if sys.version_info[:2] not in ((3, 11), (3, 12)):
    raise RuntimeError('Select Runtime → Change runtime type → A100 GPU → Runtime Version 2026.07 (Python 3.12), save, reconnect and Run All. The pinned wheels require Python 3.11/3.12.')
from functools import partial
from viscera_core.tissue_learning.portable import run_notebook_command
COMMAND_LOGS = PROJECT_ROOT / 'execution-logs' / uuid.uuid4().hex[:16]
RUN_COMMAND = partial(run_notebook_command, log_directory=COMMAND_LOGS)
profile_hash = hashlib.sha256((ROOT / 'notebooks/tissue-learning-colab-cu126-profile.json').read_bytes()).hexdigest()
runtime_key = hashlib.sha256(json.dumps({'python': platform.python_version(),
    'libc': platform.libc_ver(), 'machine': platform.machine(), 'profile_sha256': profile_hash},
    sort_keys=True).encode()).hexdigest()[:20]
LOCK_ROOT = PROJECT_ROOT / 'environment-locks' / ('cu126-' + runtime_key)
LOCK_ROOT.parent.mkdir(parents=True, exist_ok=True)
# The helper validates publisher hosts, exact Torch identity and every wheel hash.
environment_run = RUN_COMMAND([sys.executable, str(ROOT / 'scripts/resolve_tissue_colab_environment.py'),
    '--profile', str(ROOT / 'notebooks/tissue-learning-colab-cu126-profile.json'),
    '--lock-root', str(LOCK_ROOT), '--venv', '/content/viscera-cu126', '--install'],
    check=True, capture_stdout=True)  # Both pipes are drained; stderr is forwarded through the kernel.
print(environment_run.stdout)
environment_receipt = json.loads(environment_run.stdout)
PYTHON = environment_receipt['python']
ENV = dict(os.environ, PYTHONPATH=str(ROOT / 'py'), CUBLAS_WORKSPACE_CONFIG=':4096:8')
preflight_run = RUN_COMMAND([PYTHON, '-m', 'viscera_core.tissue_learning.preflight'],
    env=ENV, check=True, capture_stdout=True)
GPU_PREFLIGHT = json.loads(preflight_run.stdout)
print(json.dumps(GPU_PREFLIGHT, indent=2))
'''), cell("code", '''
RESEARCH_ONLY = DATA_MODE != 'engineering_real_smoke'  # DSAD is not commercially cleared.
from viscera_core.tissue_learning.portable import prepare_dsad_research, stage_training_release
if DATA_MODE == 'engineering_real_smoke':
    if SMOKE_RELEASE_SHA256 is None:
        raise ValueError('This source-only package has no real smoke corpus')
    uploaded_smoke = PROJECT_ROOT / 'existing-rgb-smoke'
    DATA_SOURCE = uploaded_smoke if (uploaded_smoke / 'release.json').is_file() else ROOT / 'data/real-smoke'
    RELEASE_SHA256 = SMOKE_RELEASE_SHA256
elif DATA_MODE == 'prepared_group_split':
    if PREPARED_DRIVE_FOLDER is None or len(PREPARED_RELEASE_SHA256) != 64:
        raise ValueError('Prepared mode requires an explicit Drive folder and exact release SHA256')
    DATA_SOURCE, RELEASE_SHA256 = PREPARED_DRIVE_FOLDER, PREPARED_RELEASE_SHA256
elif DATA_MODE == 'acquire_dsad_research':
    # Explicit research-only source policy; do not clear DSAD for commercial use.
    # Archive and prepared shards persist on Drive; acquisition resumes partial ranges.
    ARCHIVE_DIR = PROJECT_ROOT / 'raw' / 'dsad-research'
    if not Path('/content/drive/MyDrive').is_dir():
        raise RuntimeError('Mount Drive before persistent source acquisition')
    preparation_sha = hashlib.sha256((ROOT / 'scripts/prepare_tissue_v3_dataset.py').read_bytes()).hexdigest()
    DSAD_PREPARED = PROJECT_ROOT / 'prepared' / ('dsad-research-' + preparation_sha[:20])
    preparation = prepare_dsad_research(ROOT, ARCHIVE_DIR, DSAD_PREPARED, PYTHON, ENV, runner=RUN_COMMAND)
    DATA_SOURCE = Path(preparation['source'])
    RELEASE_SHA256 = preparation['release_sha256']
    print('Prepared DSAD release SHA256:', RELEASE_SHA256)
else:
    raise ValueError('Unknown data mode')
LOCAL_DATA = Path('/content/viscera-tissue-data') / RELEASE_SHA256
stage_receipt = stage_training_release(DATA_SOURCE, LOCAL_DATA, RELEASE_SHA256)
print(json.dumps(stage_receipt, indent=2))
readiness_key = hashlib.sha256(json.dumps({'bundle': BUNDLE_SHA256, 'release': RELEASE_SHA256,
    'patch_size': PATCH_SIZE, 'minimum_valid_fraction': MINIMUM_VALID_FRACTION,
    'environment': environment_receipt['manifest_sha256']}, sort_keys=True).encode()).hexdigest()
READINESS_DIR = Path('/content/viscera-tissue-readiness') / readiness_key
readiness_command = [PYTHON, str(ROOT / 'scripts/train_tissue_appearance.py'), 'prepare-manifest',
    '--manifest', str(LOCAL_DATA / 'records.jsonl'), '--data-root', str(LOCAL_DATA),
    '--output', str(READINESS_DIR), '--patch-size', str(PATCH_SIZE),
    '--minimum-valid-fraction', str(MINIMUM_VALID_FRACTION)]
if RESEARCH_ONLY:
    readiness_command.append('--research-only')
if DATA_MODE == 'engineering_real_smoke':
    readiness_command.append('--training-only')
RUN_COMMAND(readiness_command, env=ENV, check=True)
READINESS = json.loads((READINESS_DIR / 'readiness.json').read_text())
TRAINING_MANIFEST = READINESS_DIR / 'records.jsonl'
TRAINING_MANIFEST_SHA256 = hashlib.sha256(TRAINING_MANIFEST.read_bytes()).hexdigest()
if TRAINING_MANIFEST_SHA256 != READINESS['derived_manifest_sha256']:
    raise ValueError('Readiness manifest identity mismatch')
'''), cell("markdown", """
## Fixed experiment and restart

The real-data smoke defaults to200 optimizer updates and explicitly has no
held-out evaluation. A full prepared-group experiment uses independent train/val
groups and reports posterior reconstruction against the training-mean baseline,
KL/posterior variance and prior diversity. None is an automatic realism gate.
The sampler balances conditions explicitly: minority images are repeated, which
does not create additional independent observations or resolve sparse coverage.
Run names bind source, dataset release, config and the exact environment lock.
An incompatible change creates a separately identified run instead of overwriting
or attempting to resume a different experiment.

Before training, a deterministic scan verifies train/validation image bytes and
the actual resized mask coverage. Only insufficient-coverage rows may be excluded;
every exclusion retains its original row ID, hashes and reason. Integrity errors
stop the run. The threshold is unchanged. Test rows are preserved byte for byte
without opening test payloads. The derived manifest and report are saved on Drive
and its hash binds this run. Use that exact manifest for a later frozen test audit.

Each completed checkpoint is copied to Drive and read-back verified. A fresh
kernel stages the same sources/data, locates the verified Drive pointer and
restores model, AdamW, RNG and data cursor. A partial upload is never a checkpoint.
Same-session Drive readback is not proof of survival after VM eviction; hashes
are checked again after reconnect. Local scratch must have room for the selected
shards and checkpoints. Logs and minibatch reads stay local.

An abrupt interruption during the first dependency resolution or21GB source
acquisition may leave a persistent writer lock. The helper gives explicit recovery
instructions; first confirm every other kernel using that location is stopped.
Locks are never removed automatically based on a PID from another VM. Ordinary
training checkpoint resume is separate from this acquisition-lock recovery.
"""), cell("code", '''
from viscera_core.tissue_learning.config import ExperimentConfig
from viscera_core.tissue_learning.portable import ensure_run_identity, experiment_identity, mirror_completed_result
CONFIG = ExperimentConfig(steps=MAX_UPDATES, batch_size=BATCH_SIZE, patch_size=PATCH_SIZE,
    frequencies=(1, 2, 4, 8, 16) if PATCH_SIZE == 64 else (1, 2, 4, 8, 16, 32),
    device='cuda', precision='bfloat16', minimum_valid_fraction=MINIMUM_VALID_FRACTION,
    checkpoint_every=50, validation_every=100, validation_limit=128,
    sampling='condition_balanced',
    commercial_only=not RESEARCH_ONLY, fixture=False,
    validation_mode='training_only' if DATA_MODE == 'engineering_real_smoke' else 'heldout')
RUN_IDENTITY = experiment_identity(DATA_MODE, BUNDLE_SHA256, RELEASE_SHA256,
    CONFIG.to_dict(), environment_receipt['manifest_sha256'], TRAINING_MANIFEST_SHA256)
RUN_NAME = RUN_IDENTITY['run_id']
DRIVE_RUN = PROJECT_ROOT / 'runs' / RUN_NAME
LOCAL_RUN = Path('/content/viscera-tissue-runs') / RUN_NAME
ensure_run_identity(DRIVE_RUN, RUN_IDENTITY)
ensure_run_identity(LOCAL_RUN, RUN_IDENTITY)
mirror_completed_result(READINESS_DIR, DRIVE_RUN / 'data-readiness', READINESS['identity'])
print('Scientific run identity:', RUN_NAME)
# Runtime observations use unique attempt folders; prior evidence is preserved.
ATTEMPT = DRIVE_RUN / 'attempts' / uuid.uuid4().hex[:16]
ATTEMPT.mkdir(parents=True, exist_ok=False)
(ATTEMPT / 'environment-installation.json').write_text(json.dumps(environment_receipt, indent=2))
(ATTEMPT / 'gpu-preflight.json').write_text(json.dumps(GPU_PREFLIGHT, indent=2))
CONFIG_PATH = LOCAL_RUN / 'config.json'
CONFIG_PATH.write_text(json.dumps(CONFIG.to_dict(), indent=2))
freeze = RUN_COMMAND([PYTHON, '-m', 'pip', 'freeze'], capture_stdout=True, check=True)
(LOCAL_RUN / 'installed-packages.txt').write_text(freeze.stdout)
shutil.copyfile(LOCAL_RUN / 'installed-packages.txt', ATTEMPT / 'installed-packages.txt')
command = [PYTHON, str(ROOT / 'scripts/train_tissue_appearance.py'), 'train',
    '--manifest', str(TRAINING_MANIFEST), '--data-root', str(LOCAL_DATA),
    '--config', str(CONFIG_PATH), '--output', str(LOCAL_RUN), '--mirror', str(DRIVE_RUN)]
pointer_path = DRIVE_RUN / 'checkpoints/latest.json'
if pointer_path.is_file():
    pointer = json.loads(pointer_path.read_text())
    name = pointer['directory']
    if not name.startswith('step-') or '/' in name or '\\\\' in name:
        raise ValueError('Invalid Drive checkpoint pointer')
    resume = pointer_path.parent / name
    if hashlib.sha256((resume / 'manifest.json').read_bytes()).hexdigest() != pointer['manifest_sha256']:
        raise ValueError('Drive checkpoint manifest mismatch')
    command += ['--resume', str(resume)]
RUN_COMMAND(command, env=ENV, check=True)
receipt = json.loads((LOCAL_RUN / 'training-receipt.json').read_text())
print(json.dumps(receipt, indent=2))
# Actual allocated/reserved VRAM and samples/wall-second include validation/checkpoint work.
'''), cell("markdown", """
## Export and inspect

The data-only model is experimental even if loss improves. It contains explicit
condition→region/species mappings, native training patch size, source/data/split
identities, tensor hashes and cross-language reference vectors. Import it into
the Tissue Lab's learned-appearance control. A stable UV bake can change observed
color only; the other physical-material channels retain their separate evidence.
"""), cell("code", '''
pointer = json.loads((LOCAL_RUN / 'checkpoints/latest.json').read_text())
CHECKPOINT = LOCAL_RUN / 'checkpoints' / pointer['directory']
CHECKPOINT_SHA256 = hashlib.sha256((CHECKPOINT / 'manifest.json').read_bytes()).hexdigest()
from viscera_core.tissue_learning.portable import complete_result, prepare_result_attempt, mirror_completed_result
MODEL_DIR = LOCAL_RUN / ('model-' + CHECKPOINT_SHA256[:16])
MODEL_IDENTITY = {'kind': 'tissue-model-export', 'checkpoint_sha256': CHECKPOINT_SHA256, 'run_id': RUN_NAME}
MODEL = MODEL_DIR / f'{RUN_NAME}-{pointer["directory"]}-{CHECKPOINT_SHA256[:16]}.tissue-model.json'
MODEL_COMPLETE = prepare_result_attempt(MODEL_DIR, MODEL_IDENTITY)
if not MODEL_COMPLETE:
    RUN_COMMAND([PYTHON, str(ROOT / 'scripts/train_tissue_appearance.py'),
        'export', str(CHECKPOINT), str(MODEL)], env=ENV, check=True)
model = json.loads(MODEL.read_text())
if model['provenance']['checkpoint_manifest_sha256'] != CHECKPOINT_SHA256:
    raise ValueError('Stale exported model does not match the selected checkpoint')
MODEL_SHA256 = hashlib.sha256(MODEL.read_bytes()).hexdigest()
RUN_COMMAND([PYTHON, '-c', 'import sys; from viscera_core.tissue_learning.artifact import load_artifact; load_artifact(sys.argv[1])',
    str(MODEL)], env=ENV, check=True)
if not MODEL_COMPLETE:
    complete_result(MODEL_DIR, MODEL_IDENTITY)
DRIVE_MODEL = DRIVE_RUN / MODEL.name
from viscera_core.tissue_learning.portable import publish_verified_file
publish_verified_file(MODEL, DRIVE_MODEL)
print('Conditions:', model['architecture']['condition_labels'])
print('Training native patch:', model['provenance']['training_native_patch_size'])
print('Qualification:', model['provenance']['qualification'])
DIAGNOSTICS = LOCAL_RUN / f'diagnostics-{MODEL_SHA256[:16]}'
DIAGNOSTIC_IDENTITY = {'kind': 'tissue-diagnostics', 'model_sha256': MODEL_SHA256,
    'checkpoint_manifest_sha256': CHECKPOINT_SHA256, 'run_id': RUN_NAME}
if not prepare_result_attempt(DIAGNOSTICS, DIAGNOSTIC_IDENTITY):
    RUN_COMMAND([PYTHON, str(ROOT / 'scripts/train_tissue_appearance.py'), 'diagnose',
        '--checkpoint', str(CHECKPOINT), '--manifest', str(TRAINING_MANIFEST),
        '--data-root', str(LOCAL_DATA), '--model', str(MODEL), '--output', str(DIAGNOSTICS),
        '--device', 'cuda'], env=ENV, check=True)
    complete_result(DIAGNOSTICS, DIAGNOSTIC_IDENTITY)
quality = json.loads((DIAGNOSTICS / 'diagnostics.json').read_text())
if quality['model_file_sha256'] != MODEL_SHA256:
    raise ValueError('Stale diagnostics model identity')
print(json.dumps({k:v for k,v in quality.items() if k != 'loss_trace'}, indent=2))
print('NOT QUALIFIED FOR PHOTOREALISM: posterior error is not prior-sample realism.')
from IPython.display import Image, display
display(Image(filename=str(DIAGNOSTICS / 'appearance-comparison.png')))
display(Image(filename=str(DIAGNOSTICS / 'loss-trace.png')))
mirror_completed_result(DIAGNOSTICS, DRIVE_RUN / DIAGNOSTICS.name, DIAGNOSTIC_IDENTITY)
from google.colab import files
print('Verified model saved on Drive:', DRIVE_MODEL)
if DOWNLOAD_ARTIFACTS:
    files.download(str(MODEL))
'''), cell("markdown", """
## Optional actual4096² appearance bake

This executes the coordinate decoder in bounded chunks and writes an actual
4096×4096 PNG; it records the elapsed time. It is output sampling of the trained
low-resolution prior, not evidence of learned native4K detail. No clinical or
photorealism claim follows from pixel count. Toggle the flag to run it.
"""), cell("code", '''
BAKE_4096 = False
CONDITION_INDEX = 0
SEED_DECIMAL = '42'
if BAKE_4096:
    BAKE_DIR = LOCAL_RUN / f'appearance-{MODEL_SHA256[:16]}-{CONDITION_INDEX}-{SEED_DECIMAL}-4096'
    BAKE_IDENTITY = {'kind': 'tissue-appearance-bake', 'model_sha256': MODEL_SHA256,
        'condition_index': CONDITION_INDEX, 'seed_decimal': SEED_DECIMAL, 'resolution': 4096}
    PNG = BAKE_DIR / 'appearance.png'
    if not prepare_result_attempt(BAKE_DIR, BAKE_IDENTITY):
        BAKE_DIR.mkdir(parents=True, exist_ok=False)
        RUN_COMMAND([PYTHON, str(ROOT / 'scripts/train_tissue_appearance.py'),
            'bake', str(MODEL), str(PNG), '--condition-index', str(CONDITION_INDEX),
            '--seed', SEED_DECIMAL, '--resolution', '4096', '--chunk-pixels', '16384',
            '--device', 'cuda'], env=ENV, check=True)
        bake_receipt = json.loads(PNG.with_suffix('.bake.json').read_text())
        if bake_receipt['sha256'] != hashlib.sha256(PNG.read_bytes()).hexdigest() or bake_receipt['resolution'] != [4096,4096]:
            raise ValueError('Bake receipt/image integrity mismatch')
        complete_result(BAKE_DIR, BAKE_IDENTITY)
    print(PNG.with_suffix('.bake.json').read_text())
    mirror_completed_result(BAKE_DIR, DRIVE_RUN / BAKE_DIR.name, BAKE_IDENTITY)
    if DOWNLOAD_ARTIFACTS:
        files.download(str(PNG))
'''), cell("markdown", """
## Full research data and final audit

The package includes `acquire_tissue_v3.py`, its reviewed catalog and
`prepare_tissue_v3_dataset.py`. Their DSAD source pipeline uses the publisher's
surgery split before preprocessing. The data README documents the licence conflict
and transport limits. Stage prepared train/validation shards from Drive using the
release hash above. Default training transport excludes test image payloads.

After selecting and freezing one checkpoint, use the package's separate
`evaluate-test --freeze` command with the complete evaluator data. Do not tune
after reading that audit. Model promotion still requires independent appearance,
temporal, optical and expert review; training loss is not sufficient.
""")]
    return {"cells": cells, "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python"}, "accelerator": "GPU",
            "colab": {"provenance": [], "gpuType": "A100"}}, "nbformat": 4, "nbformat_minor": 4}


def package(output: Path, *, smoke_data: Path | None = None) -> dict:
    files = {"py/viscera_core/__init__.py": ROOT / "py/viscera_core/__init__.py"}
    for path in (ROOT / "py/viscera_core/tissue_learning").glob("*"):
        if path.is_file() and path.suffix in (".py", ".md"):
            files[path.relative_to(ROOT).as_posix()] = path
    for name in ("scripts/train_tissue_appearance.py", "scripts/package_tissue_learning_colab.py",
                 "scripts/resolve_tissue_colab_environment.py",
                 "notebooks/tissue-learning-colab-cu126-profile.json", "tests/python/test_tissue_learning.py",
                 "tests/python/test_tissue_learning_portable.py",
                 "tests/python/test_tissue_learning_preflight.py",
                 "tests/python/test_tissue_learning_readiness.py",
                 "tests/python/test_tissue_colab_environment.py",
                 "tests/python/test_acquire_tissue_parallel.py",
                 "scripts/acquire_tissue_v3.py", "scripts/acquire_tissue_datasets.py",
                 "scripts/acquire_tissue_parallel.py", "scripts/prepare_tissue_v3_dataset.py",
                 "research/tissue-v3/acquisition-catalog.json", "research/tissue-v3/README.md",
                 "research/tissue-v3/colab-environment.md"):
        files[name] = ROOT / name
    smoke_digest = None
    if smoke_data:
        release = json.loads((smoke_data / "release.json").read_text())
        if any(shard["split"] != "train" for shard in release["shards"]):
            raise ValueError("bundled engineering smoke must not contain held-out payloads")
        for name in ["release.json", *release["manifests"], *[x["path"] for x in release["shards"]]]:
            if "/" in name or "\\" in name or name in (".", ".."):
                raise ValueError("smoke bundle expects flat indexed shards")
            files[f"data/real-smoke/{name}"] = smoke_data / name
        smoke_digest = digest(smoke_data / "release.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest = {"schema": "viscera.tissue-learning-source-bundle/v1", "files": {}}
    for name, path in sorted(files.items()):
        if not path.is_file() or path.is_symlink():
            raise ValueError(f"missing or symlinked bundle source: {name}")
        manifest["files"][name] = {"bytes": path.stat().st_size, "sha256": digest(path)}
    temporary = output.with_suffix(".partial.zip")
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        payloads = [(name, path.read_bytes()) for name, path in sorted(files.items())]
        payloads.append(("bundle-manifest.json", (json.dumps(manifest, indent=2) + "\n").encode()))
        for name, raw in payloads:
            info = zipfile.ZipInfo(name, (2026, 10, 19, 0, 0, 0))
            info.compress_type, info.external_attr = zipfile.ZIP_DEFLATED, 0o100644 << 16
            archive.writestr(info, raw)
    temporary.replace(output)
    notebook_path = ROOT / "notebooks/VISCERA_tissue_appearance_A100.ipynb"
    notebook_path.write_text(json.dumps(notebook(digest(output), smoke_digest), indent=2) + "\n")
    receipt = {"schema": "viscera.tissue-learning-package-receipt/v1", "bundle": str(output),
               "sha256": digest(output), "bytes": output.stat().st_size, "files": len(files),
               "notebook": str(notebook_path), "notebook_sha256": digest(notebook_path),
               "contains_real_training_only_smoke": bool(smoke_data), "gpu_executed": False,
               "scope": "source, explicit runtime-resolved CUDA12.6 profile, thin client and optional attributed engineering corpus"}
    output.with_suffix(".receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/colab/viscera-tissue-learning-colab.zip")
    parser.add_argument("--smoke-data", type=Path, default=ROOT / "artifacts/tissue-materials-2026-10-19/neural-v3/existing-rgb-smoke")
    parser.add_argument("--source-only", action="store_true")
    args = parser.parse_args()
    print(json.dumps(package(args.output, smoke_data=None if args.source_only else args.smoke_data), indent=2))
