#!/usr/bin/env python3
"""Package the isolated native-crop/directional-decoder research candidate."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import zipfile
from pathlib import Path

from package_tissue_learning_colab import cell
from package_tissue_learning_colab import notebook as baseline_notebook

ROOT = Path(__file__).resolve().parents[1]
BASELINE_SHA256 = "8a0774e90b453408519bf054c95baf54558e2be554e037d262e45acc95df5313"
SOURCE_RELEASE_SHA256 = "2a21780ad302b0224cfa0d356c7dd888ff8bf6db30ab721fef69d2699b79f485"


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def replace_once(source: str, old: str, new: str) -> str:
    if source.count(old) != 1:
        raise ValueError(f"Baseline notebook contract changed: {old!r}")
    return source.replace(old, new, 1)


DATA_CELL = '''
from viscera_core.tissue_learning.portable import (stage_training_release,
    completed_result, prepare_result_attempt, complete_result, mirror_completed_result)
DATA_SOURCE = PROJECT_ROOT / 'prepared/dsad-research-10ffeb2c6bfd5d0c2021'
SOURCE_RELEASE_SHA256 = '2a21780ad302b0224cfa0d356c7dd888ff8bf6db30ab721fef69d2699b79f485'
if hashlib.sha256((DATA_SOURCE / 'release.json').read_bytes()).hexdigest() != SOURCE_RELEASE_SHA256:
    raise ValueError('Original prepared DSAD source identity changed')
POLICY = {'native_size': 128, 'minimum_valid_fraction': .5,
          'minimum_critic_fraction': .75, 'minimum_validation_groups': 3}
CROP_IDENTITY = {'kind': 'native-tissue-crops-v2',
    'pipeline_sha256': {name: hashlib.sha256((ROOT / 'scripts' / name).read_bytes()).hexdigest()
        for name in ('scan_tissue_native_crop_support.py', 'prepare_tissue_native_crops.py', 'prepare_tissue_v3_dataset.py')},
    'source_release_sha256': SOURCE_RELEASE_SHA256, 'policy': POLICY,
    'environment_lock_manifest_sha256': environment_receipt['manifest_sha256']}
CROP_KEY = hashlib.sha256(json.dumps(CROP_IDENTITY, sort_keys=True).encode()).hexdigest()
LOCAL_CROPS = Path('/content/viscera-native-crops') / CROP_KEY
LOCAL_CROPS.parent.mkdir(parents=True, exist_ok=True)
DRIVE_CROPS = PROJECT_ROOT / 'native-crops' / CROP_KEY
SCAN_IDENTITY = {**CROP_IDENTITY, 'kind': 'native-tissue-mask-scan-v2'}
LOCAL_SCAN = Path('/content/viscera-native-crop-scans') / CROP_KEY
LOCAL_SCAN.parent.mkdir(parents=True, exist_ok=True)
DRIVE_SCAN = PROJECT_ROOT / 'native-crop-scans' / CROP_KEY
if not prepare_result_attempt(LOCAL_CROPS, CROP_IDENTITY):
    if completed_result(DRIVE_CROPS, CROP_IDENTITY):
        mirror_completed_result(DRIVE_CROPS, LOCAL_CROPS, CROP_IDENTITY)
    else:
        ORIGINAL_DATA = Path('/content/viscera-tissue-data') / SOURCE_RELEASE_SHA256
        print(json.dumps(stage_training_release(DATA_SOURCE, ORIGINAL_DATA, SOURCE_RELEASE_SHA256), indent=2))
        if not prepare_result_attempt(LOCAL_SCAN, SCAN_IDENTITY):
            if completed_result(DRIVE_SCAN, SCAN_IDENTITY):
                mirror_completed_result(DRIVE_SCAN, LOCAL_SCAN, SCAN_IDENTITY)
            else:
                RUN_COMMAND([PYTHON, str(ROOT / 'scripts/scan_tissue_native_crop_support.py'),
                    '--source-root', str(ORIGINAL_DATA), '--source-release-sha256', SOURCE_RELEASE_SHA256,
                    '--output', str(LOCAL_SCAN)], env=ENV, check=True)
                complete_result(LOCAL_SCAN, SCAN_IDENTITY)
        mirror_completed_result(LOCAL_SCAN, DRIVE_SCAN, SCAN_IDENTITY)
        RUN_COMMAND([PYTHON, str(ROOT / 'scripts/prepare_tissue_native_crops.py'),
            '--source-root', str(ORIGINAL_DATA), '--source-release-sha256', SOURCE_RELEASE_SHA256,
            '--scan-root', str(LOCAL_SCAN), '--output', str(LOCAL_CROPS), '--size', '128',
            '--minimum-valid-fraction', '.5', '--minimum-critic-fraction', '.75',
            '--minimum-validation-groups', '3'], env=ENV, check=True)
        complete_result(LOCAL_CROPS, CROP_IDENTITY)
mirror_completed_result(LOCAL_CROPS, DRIVE_CROPS, CROP_IDENTITY)
LOCAL_DATA = LOCAL_CROPS
RELEASE_SHA256 = hashlib.sha256((LOCAL_DATA / 'release.json').read_bytes()).hexdigest()
release = json.loads((LOCAL_DATA / 'release.json').read_text())
if release['source_prepared_release_sha256'] != SOURCE_RELEASE_SHA256:
    raise ValueError('Native crop source ancestry mismatch')
print('Native crop release:', RELEASE_SHA256)
print(json.dumps(release['records_by_split'], indent=2))
print('Test metadata retained; no test image payloads were opened or staged.')
READINESS_KEY = hashlib.sha256((CROP_KEY + BUNDLE_SHA256).encode()).hexdigest()
READINESS_DIR = Path('/content/viscera-detail-readiness') / READINESS_KEY
READINESS_DIR.parent.mkdir(parents=True, exist_ok=True)
RUN_COMMAND([PYTHON, str(ROOT / 'scripts/train_tissue_detail.py'), 'prepare-manifest',
    '--manifest', str(LOCAL_DATA / 'records.jsonl'), '--data-root', str(LOCAL_DATA),
    '--output', str(READINESS_DIR), '--minimum-valid-fraction', '.5',
    '--critic-minimum-coverage', '.75'], env=ENV, check=True)
READINESS = json.loads((READINESS_DIR / 'readiness.json').read_text())
TRAINING_MANIFEST = READINESS_DIR / 'records.jsonl'
TRAINING_MANIFEST_SHA256 = hashlib.sha256(TRAINING_MANIFEST.read_bytes()).hexdigest()
if TRAINING_MANIFEST_SHA256 != READINESS['derived_manifest_sha256']:
    raise ValueError('Native readiness manifest identity mismatch')
'''

TRAIN_CELL = '''
from viscera_core.tissue_learning_detail.config import DetailConfig
from viscera_core.tissue_learning.portable import ensure_run_identity, experiment_identity, mirror_completed_result
CONFIG = DetailConfig(steps=MAX_UPDATES, batch_size=BATCH_SIZE, device='cuda', precision='bfloat16')
RUN_IDENTITY = experiment_identity('prepared_group_split', BUNDLE_SHA256, RELEASE_SHA256,
    CONFIG.to_dict(), environment_receipt['manifest_sha256'], TRAINING_MANIFEST_SHA256)
RUN_NAME = RUN_IDENTITY['run_id']
DRIVE_RUN = PROJECT_ROOT / 'detail-runs' / RUN_NAME
LOCAL_RUN = Path('/content/viscera-tissue-detail-runs') / RUN_NAME
ensure_run_identity(DRIVE_RUN, RUN_IDENTITY)
ensure_run_identity(LOCAL_RUN, RUN_IDENTITY)
mirror_completed_result(READINESS_DIR, DRIVE_RUN / 'data-readiness', READINESS['identity'])
print('Scientific detail run identity:', RUN_NAME)
ATTEMPT = DRIVE_RUN / 'attempts' / uuid.uuid4().hex[:16]
ATTEMPT.mkdir(parents=True, exist_ok=False)
(ATTEMPT / 'environment-installation.json').write_text(json.dumps(environment_receipt, indent=2))
(ATTEMPT / 'gpu-preflight.json').write_text(json.dumps(GPU_PREFLIGHT, indent=2))
CONFIG_PATH = LOCAL_RUN / 'config.json'
CONFIG_PATH.write_text(json.dumps(CONFIG.to_dict(), indent=2))
freeze = RUN_COMMAND([PYTHON, '-m', 'pip', 'freeze'], capture_stdout=True, check=True)
(LOCAL_RUN / 'installed-packages.txt').write_text(freeze.stdout)
shutil.copyfile(LOCAL_RUN / 'installed-packages.txt', ATTEMPT / 'installed-packages.txt')
base_command = [PYTHON, str(ROOT / 'scripts/train_tissue_detail.py'), 'train',
    '--manifest', str(TRAINING_MANIFEST), '--data-root', str(LOCAL_DATA),
    '--config', str(CONFIG_PATH), '--output', str(LOCAL_RUN), '--mirror', str(DRIVE_RUN)]
pointer = DRIVE_RUN / 'checkpoints/latest.json'
if not pointer.is_file():
    # The real 50-update checkpoint measures reconstruction warmup. The separate
    # GPU preflight exercises both optimizers with the critic enabled immediately.
    RUN_COMMAND(base_command + ['--stop-after-updates', '50'], env=ENV, check=True)
    warmup = json.loads((LOCAL_RUN / 'training-receipt.json').read_text())
    print('50-update warmup measurement:', json.dumps(warmup, indent=2))
    (ATTEMPT / 'warmup-50-receipt.json').write_text(json.dumps(warmup, indent=2))
pointer_value = json.loads(pointer.read_text())
checkpoint_name = pointer_value['directory']
if not checkpoint_name.startswith('step-') or '/' in checkpoint_name or '\\\\' in checkpoint_name:
    raise ValueError('Invalid Drive checkpoint pointer')
resume = DRIVE_RUN / 'checkpoints' / checkpoint_name
if hashlib.sha256((resume / 'manifest.json').read_bytes()).hexdigest() != pointer_value['manifest_sha256']:
    raise ValueError('Drive checkpoint manifest identity mismatch')
existing_receipt = DRIVE_RUN / 'training-receipt.json'
prior_training = json.loads(existing_receipt.read_text()) if existing_receipt.is_file() else None
if (prior_training and prior_training['status'] == 'completed'
        and prior_training['committed_updates'] == MAX_UPDATES):
    if prior_training['checkpoint_manifest_sha256'] != pointer_value['manifest_sha256']:
        raise ValueError('Completed training receipt and checkpoint disagree')
    training = prior_training
    print('Reusing verified completed training; original timing receipt is preserved.')
else:
    RUN_COMMAND(base_command + ['--resume', str(resume)], env=ENV, check=True)
    training = json.loads((LOCAL_RUN / 'training-receipt.json').read_text())
if training['status'] != 'completed' or training['committed_updates'] != MAX_UPDATES:
    raise ValueError('Detail run did not complete its declared optimizer budget')
print(json.dumps(training, indent=2))
(ATTEMPT / 'training-observation.json').write_text(json.dumps(training, indent=2))
'''

DOWNLOAD_CELL = '''
from google.colab import files
def file_sha(path):
    with Path(path).open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()
training = json.loads((DRIVE_RUN / 'training-receipt.json').read_text())
assert training['status'] == 'completed' and training['committed_updates'] == MAX_UPDATES
assert file_sha(DRIVE_MODEL) == MODEL_SHA256
assert model['schema'] == 'viscera.tissue-appearance-decoder/v2'
assert model['provenance']['qualification'] == 'engineering_unqualified'
pointer = json.loads((DRIVE_RUN / 'checkpoints/latest.json').read_text())
checkpoint = DRIVE_RUN / 'checkpoints' / pointer['directory']
assert file_sha(checkpoint / 'manifest.json') == training['checkpoint_manifest_sha256'] == CHECKPOINT_SHA256
assert pointer['manifest_sha256'] == CHECKPOINT_SHA256
assert model['provenance']['checkpoint_manifest_sha256'] == CHECKPOINT_SHA256
checkpoint_manifest = json.loads((checkpoint / 'manifest.json').read_text())
for name, declared in checkpoint_manifest['files'].items():
    assert name in ('state.json', 'tensors.safetensors')
    assert file_sha(checkpoint / name) == declared['sha256']
selected = [DRIVE_MODEL, *[checkpoint / name for name in ('manifest.json', 'state.json', 'tensors.safetensors')],
    *[DRIVE_RUN / name for name in ('run-identity.json', 'request.json', 'training-receipt.json', 'checkpoints/latest.json')],
    *[DRIVE_RUN / 'data-readiness' / name for name in ('records.jsonl', 'readiness.json', 'completed-result.json')],
    *[ATTEMPT / name for name in ('gpu-preflight.json', 'environment-installation.json', 'installed-packages.txt')]]
entries = [(path, path.relative_to(DRIVE_RUN).as_posix()) for path in selected]
for directory, prefix, names in [
    (DIAGNOSTICS, 'diagnostics', ['diagnostics.json', 'appearance-comparison.png', 'loss-trace.png', 'completed-result.json',
        *[f'condition-{i}-seed42-256.png' for i in range(len(model['architecture']['condition_labels']))]]),
    (LOCAL_DATA, 'native-crops', ['release.json', 'records.jsonl', 'train.jsonl', 'val.jsonl', 'test.jsonl', 'exclusions.json', 'completed-result.json']),
    (BAKE_DIR, 'liver-seed42-4096', ['appearance.png', 'appearance.bake.json', 'completed-result.json']),
    (LOCAL_RUN, 'training-local', ['config.json'])]:
    entries += [(directory / name, prefix + '/' + name) for name in names]
# The optional local journal covers only this VM's attempt; the checkpoint and
# diagnostics retain committed loss history across resumes.
if (LOCAL_RUN / 'metrics.jsonl').is_file():
    entries.append((LOCAL_RUN / 'metrics.jsonl', 'training-local/metrics-this-vm-attempt.jsonl'))
assert len(entries) == len({name for _, name in entries})
assert all(path.is_file() and not path.is_symlink() for path, _ in entries)
assert all(not name.startswith('/') and '\\\\' not in name
    and all(part not in ('', '.', '..') for part in name.split('/')) for _, name in entries)
assert sum(path.stat().st_size for path, _ in entries) < 128 * 1024**2
inventory = {name: {'bytes': path.stat().st_size, 'sha256': file_sha(path)} for path, name in entries}
# Re-running a completed notebook creates a new attempt receipt. Preserve both
# review archives while allowing an identical download cell to be replayed.
inventory_key = hashlib.sha256(json.dumps(inventory, sort_keys=True).encode()).hexdigest()[:16]
archive_path = Path('/content') / (RUN_NAME + '-detail-review-' + MODEL_SHA256[:16] + '-' + inventory_key + '.zip')
if not archive_path.exists():
    with zipfile.ZipFile(archive_path, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for path, name in entries:
            archive.write(path, name)
        archive.writestr('download-inventory.json', json.dumps(inventory, indent=2))
with zipfile.ZipFile(archive_path) as archive:
    assert len(archive.namelist()) == len(inventory) + 1
    assert set(archive.namelist()) == set(inventory) | {'download-inventory.json'}
    assert json.loads(archive.read('download-inventory.json')) == inventory
    for name, declared in inventory.items():
        with archive.open(name) as handle:
            assert hashlib.file_digest(handle, 'sha256').hexdigest() == declared['sha256']
print(json.dumps({'run_id': RUN_NAME, 'model_sha256': MODEL_SHA256,
    'source_bundle_sha256': BUNDLE_SHA256, 'native_crop_release_sha256': RELEASE_SHA256,
    'archive_sha256': file_sha(archive_path), 'archive_bytes': archive_path.stat().st_size,
    'inventory_files': len(inventory), 'archive': str(archive_path)}, indent=2))
files.download(str(archive_path))
'''


def notebook(bundle_sha256: str) -> dict:
    baseline = baseline_notebook(bundle_sha256, None)
    code = [entry['source'] for entry in baseline['cells'] if entry['cell_type'] == 'code']
    setup = code[0]
    for old, new in [
        ("DATA_MODE = 'acquire_dsad_research'", "DATA_MODE = 'prepared_group_split'"),
        ("MAX_UPDATES = 200 if DATA_MODE == 'engineering_real_smoke' else 2000", 'MAX_UPDATES = 3000'),
        ("PATCH_SIZE = 64 if DATA_MODE == 'engineering_real_smoke' else 128", 'PATCH_SIZE = 128'),
        ('MINIMUM_VALID_FRACTION = .01', 'MINIMUM_VALID_FRACTION = .5'),
        ('# Main run settings. Change the mode explicitly for the small training-only smoke.', '# Native-crop detail candidate; preserve the baseline notebook separately.'),
        ('PREPARED_DRIVE_FOLDER = None  # Required only for prepared_group_split.\n', ''),
        ("PREPARED_RELEASE_SHA256 = ''  # Exact reviewed release hash for prepared_group_split.\n", ''),
        ('SMOKE_RELEASE_SHA256 = None\n', ''),
        ('viscera-tissue-learning-colab.zip', 'viscera-tissue-detail-colab.zip'),
        ('/content/viscera-tissue-learning-source', '/content/viscera-tissue-detail-source'),
    ]:
        setup = replace_once(setup, old, new)
    environment = replace_once(code[1],
        "[PYTHON, '-m', 'viscera_core.tissue_learning.preflight']",
        "[PYTHON, str(ROOT / 'scripts/train_tissue_detail.py'), 'preflight', '--device', 'cuda']")
    export = code[4].replace('scripts/train_tissue_appearance.py', 'scripts/train_tissue_detail.py')
    export = replace_once(export, "pointer = json.loads((LOCAL_RUN / 'checkpoints/latest.json').read_text())",
        "pointer = json.loads((DRIVE_RUN / 'checkpoints/latest.json').read_text())")
    export = replace_once(export, "CHECKPOINT = LOCAL_RUN / 'checkpoints' / pointer['directory']",
        "CHECKPOINT = DRIVE_RUN / 'checkpoints' / pointer['directory']")
    export = export.replace('from viscera_core.tissue_learning.artifact import load_artifact',
                            'from viscera_core.tissue_learning_detail.artifact import load_artifact')
    bake = code[5].replace('scripts/train_tissue_appearance.py', 'scripts/train_tissue_detail.py')
    bake = replace_once(bake, 'BAKE_4096 = False', 'BAKE_4096 = True')
    bake = replace_once(bake, 'CONDITION_INDEX = 0', "CONDITION_INDEX = model['architecture']['condition_regions'].index('liver')")
    result = {**baseline, 'cells': [
        cell('markdown', '''# VISCERA · native tissue detail candidate · A100

The previous 2000-update model failed visual review: blurred color fields and axial bands.
This separate candidate uses native 128-pixel tissue crops, directional periodic features,
and a training-only texture critic. It is an experiment, not a photorealism promise.
The notebook verifies a pinned source ZIP, reuses the exact CUDA12.6 environment profile,
prepares surgery-disjoint DSAD crops, runs a 50-update warmup checkpoint then completes
3000 updates, exports weights and diagnostics, bakes an actual4096² RGB image, and downloads
one verified review archive including the final resumable checkpoint. Every scientific
identity differs from the preserved baseline. Native training remains128².

Use **A100, Runtime2026.07/Python3.12**. Upload this notebook and its matching source ZIP
into the existing VISCERA Tissue Training2026-10-19 Drive folder. The original prepared
DSAD release must already be present. Test image payloads are never staged here.
DSAD remains research-only; RGB retains source lighting and is not measured intrinsic albedo.
No output is enabled as the default material without independent visual review.
'''), cell('code', setup), cell('markdown', '## Verify environment and actual candidate GPU/checkpoint path'),
        cell('code', environment), cell('markdown', '## Prepare and persist native crops without resizing'),
        cell('code', DATA_CELL), cell('markdown', '## Train the separate candidate and preserve restart state'),
        cell('code', TRAIN_CELL), cell('markdown', '## Export and inspect observed RGB appearance'),
        cell('code', export), cell('markdown', '## Actual4096² output sampling; native learned patches remain128²'),
        cell('code', bake), cell('markdown', '## Verify and download weights, checkpoint and review evidence'),
        cell('code', DOWNLOAD_CELL)]}
    for entry in result['cells']:
        if entry['cell_type'] == 'code':
            ast.parse(entry['source'])
    return result


def package(baseline_path: Path, output_dir: Path) -> dict:
    baseline_raw = baseline_path.read_bytes()
    if sha(baseline_raw) != BASELINE_SHA256:
        raise ValueError('Use the exact preserved, verified v1 source dependency bundle')
    if output_dir.exists():
        raise FileExistsError('Preserve prior candidate packages; output directory must be new')
    with zipfile.ZipFile(baseline_path) as archive:
        manifest = json.loads(archive.read('bundle-manifest.json'))
        if len(archive.namelist()) != len(set(archive.namelist())):
            raise ValueError('Duplicate baseline members')
        if set(archive.namelist()) != set(manifest['files']) | {'bundle-manifest.json'}:
            raise ValueError('Baseline inventory mismatch')
        payloads = {name: archive.read(name) for name in manifest['files']}
        for name, raw in payloads.items():
            if len(raw) != manifest['files'][name]['bytes'] or sha(raw) != manifest['files'][name]['sha256']:
                raise ValueError('Baseline member hash mismatch')
            if name.startswith(('py/', 'scripts/')) and (ROOT / name).read_bytes() != raw:
                raise ValueError('Local baseline dependency differs from the frozen bundle: ' + name)
    new_files = list((ROOT / 'py/viscera_core/tissue_learning_detail').glob('*.py'))
    new_files += [ROOT / name for name in (
        'scripts/train_tissue_detail.py', 'scripts/package_tissue_detail_colab.py',
        'scripts/scan_tissue_native_crop_support.py', 'scripts/prepare_tissue_native_crops.py',
        'tests/python/test_tissue_learning_detail.py', 'tests/python/test_tissue_native_crops.py',
        'tests/python/test_tissue_detail_colab.py')]
    for path in new_files:
        if not path.is_file() or path.is_symlink():
            raise ValueError(f'Missing or symlinked candidate source: {path}')
        name = path.relative_to(ROOT).as_posix()
        if name in payloads:
            raise ValueError('Candidate must not replace frozen baseline sources')
        payloads[name] = path.read_bytes()
    manifest = {'schema': 'viscera.tissue-learning-source-bundle/v1',
        'baseline_bundle_sha256': BASELINE_SHA256,
        'files': {name: {'bytes': len(raw), 'sha256': sha(raw)} for name, raw in sorted(payloads.items())}}
    output_dir.mkdir(parents=True)
    bundle = output_dir / 'viscera-tissue-detail-colab.zip'
    with zipfile.ZipFile(bundle, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, raw in [*sorted(payloads.items()), ('bundle-manifest.json', (json.dumps(manifest, indent=2) + '\n').encode())]:
            info = zipfile.ZipInfo(name, (2026, 10, 19, 0, 0, 0))
            info.compress_type, info.external_attr = zipfile.ZIP_DEFLATED, 0o100644 << 16
            archive.writestr(info, raw)
    bundle_sha = sha(bundle.read_bytes())
    note = output_dir / 'VISCERA_tissue_detail_A100.ipynb'
    note.write_text(json.dumps(notebook(bundle_sha), indent=2) + '\n')
    receipt = {'bundle': str(bundle), 'bundle_sha256': bundle_sha, 'bundle_bytes': bundle.stat().st_size,
        'notebook': str(note), 'notebook_sha256': sha(note.read_bytes()), 'files': len(payloads),
        'code_cells_compiled': 7, 'gpu_executed': False, 'source_release_sha256': SOURCE_RELEASE_SHA256,
        'baseline_bundle_sha256': BASELINE_SHA256, 'qualification': 'engineering_unqualified'}
    (output_dir / 'package-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline-bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(package(args.baseline_bundle, args.output), indent=2))
