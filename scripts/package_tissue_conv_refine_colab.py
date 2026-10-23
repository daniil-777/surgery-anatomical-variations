#!/usr/bin/env python3
"""Package a bounded objective pilot without changing the frozen spatial decoder."""
from __future__ import annotations

import argparse
import ast
import json
import zipfile
from pathlib import Path

from package_tissue_conv_colab import notebook as conv_notebook
from package_tissue_detail_colab import replace_once, sha
from package_tissue_learning_colab import cell

ROOT = Path(__file__).resolve().parents[1]
BASELINE_SHA256 = '1e15cb6cf5880c6ed7f3bed0e3ce86af8adf811e0224f796cbfd696436dd8d3a'
NATIVE_RELEASE_SHA256 = '26f0dd07b29375249239016e3281c399e3c89fed4c16354a9011f6440a288565'
PARENT_MODEL_SHA256 = '39085f410b1762018e3dff7e0dc47cd7bd973a6217834e3d14ba0fd41d9f5455'
PARENT_CHECKPOINT_SHA256 = 'b1a24c8dcc028f52d84d5b68bfd60017ec055dce8ad10823f9796d9c6772b4d6'

TRAIN_CELL = r'''from viscera_core.tissue_learning_conv.config import ConvConfig
from viscera_core.tissue_learning_conv_refine.config import RefineConfig
from viscera_core.tissue_learning.portable import ensure_run_identity, experiment_identity, mirror_completed_result, completed_result
CONFIG = RefineConfig(training=ConvConfig(steps=MAX_UPDATES, batch_size=BATCH_SIZE,
    device='cuda', precision='bfloat16', seed=20261020, lr=5e-5, critic_lr=5e-5,
    critic_warmup_updates=0, validation_every=100))
if MAX_UPDATES != 1000 or TARGET_UPDATES not in (300, 1000):
    raise ValueError('Pilot budget is1000; first execution must stop at300 for review')
def file_sha(path):
    with Path(path).open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()
if file_sha(PARENT_MODEL) != PARENT_MODEL_SHA256 or file_sha(PARENT_CHECKPOINT / 'manifest.json') != PARENT_CHECKPOINT_SHA256:
    raise ValueError('Warm-start parent bytes differ from the locally verified6000 run')
RUN_IDENTITY = experiment_identity('prepared_group_split', BUNDLE_SHA256, RELEASE_SHA256,
    {'refinement_config': CONFIG.to_dict(), 'parent_model_sha256': PARENT_MODEL_SHA256,
     'parent_checkpoint_sha256': PARENT_CHECKPOINT_SHA256},
    environment_receipt['manifest_sha256'], TRAINING_MANIFEST_SHA256)
RUN_NAME = RUN_IDENTITY['run_id']
DRIVE_RUN = PROJECT_ROOT / 'conv-refine-runs' / RUN_NAME
LOCAL_RUN = Path('/content/viscera-tissue-conv-refine-runs') / RUN_NAME
ensure_run_identity(DRIVE_RUN, RUN_IDENTITY)
ensure_run_identity(LOCAL_RUN, RUN_IDENTITY)
mirror_completed_result(READINESS_DIR, DRIVE_RUN / 'data-readiness', READINESS['identity'])
print('Scientific objective-pilot identity:', RUN_NAME)
ATTEMPT = DRIVE_RUN / 'attempts' / uuid.uuid4().hex[:16]
ATTEMPT.mkdir(parents=True, exist_ok=False)
(ATTEMPT / 'environment-installation.json').write_text(json.dumps(environment_receipt, indent=2))
(ATTEMPT / 'gpu-preflight.json').write_text(json.dumps(GPU_PREFLIGHT, indent=2))
CONFIG_PATH = LOCAL_RUN / 'config.json'
CONFIG_PATH.write_text(json.dumps(CONFIG.to_dict(), indent=2))
freeze = RUN_COMMAND([PYTHON, '-m', 'pip', 'freeze'], capture_stdout=True, check=True)
(LOCAL_RUN / 'installed-packages.txt').write_text(freeze.stdout)
shutil.copyfile(LOCAL_RUN / 'installed-packages.txt', ATTEMPT / 'installed-packages.txt')
base_command = [PYTHON, str(ROOT / 'scripts/train_tissue_conv_refine.py'), 'train',
    '--manifest', str(TRAINING_MANIFEST), '--data-root', str(LOCAL_DATA),
    '--config', str(CONFIG_PATH), '--output', str(LOCAL_RUN), '--mirror', str(DRIVE_RUN),
    '--warm-start', str(PARENT_CHECKPOINT), '--parent-model', str(PARENT_MODEL),
    '--expected-parent-model-sha256', PARENT_MODEL_SHA256,
    '--stop-after-updates', str(TARGET_UPDATES)]
pointer = DRIVE_RUN / 'checkpoints/latest.json'
if pointer.is_file():
    pointer_value = json.loads(pointer.read_text())
    name = pointer_value['directory']
    if len(name) != 14 or not name.startswith('step-') or not name[5:].isdigit():
        raise ValueError('Invalid checkpoint pointer')
    resume = DRIVE_RUN / 'checkpoints' / name
    if file_sha(resume / 'manifest.json') != pointer_value['manifest_sha256']:
        raise ValueError('Drive checkpoint manifest identity mismatch')
    if int(name[5:]) > TARGET_UPDATES:
        raise ValueError('Run already advanced; select its actual target without rewinding')
    base_command += ['--resume', str(resume)]
elif TARGET_UPDATES != 300:
    raise ValueError('Cold start must stop at300 before continuation')
if TARGET_UPDATES > 300:
    GATE_PATH = DRIVE_RUN / 'gate-review/step-000000300/objective-gate.json'
    REVIEW_PATH = PROJECT_ROOT / (RUN_NAME + '-visual-review-300.json')
    if not GATE_PATH.is_file() or not REVIEW_PATH.is_file():
        raise ValueError('Bound quantitative gate and explicit saved visual review are required')
    base_command += ['--gate-receipt', str(GATE_PATH), '--visual-review', str(REVIEW_PATH)]
receipt_path = DRIVE_RUN / 'training-receipt.json'
prior = json.loads(receipt_path.read_text()) if receipt_path.is_file() else None
expected_status = 'completed' if TARGET_UPDATES == MAX_UPDATES else 'interrupted'
if prior and prior['committed_updates'] == TARGET_UPDATES and prior['status'] == expected_status:
    if not pointer.is_file() or prior['checkpoint_manifest_sha256'] != pointer_value['manifest_sha256']:
        raise ValueError('Saved training receipt/checkpoint mismatch')
    snapshot = DRIVE_RUN / 'prior-snapshots' / f'step-{TARGET_UPDATES:09d}'
    marker = snapshot / 'completed-result.json'
    snapshot_identity = json.loads(marker.read_text())['identity'] if marker.is_file() else None
    if snapshot_identity and (snapshot_identity['step'] != TARGET_UPDATES or
            snapshot_identity['checkpoint_manifest_sha256'] != prior['checkpoint_manifest_sha256']):
        raise ValueError('Snapshot and committed checkpoint differ')
    if not snapshot_identity or not completed_result(snapshot, snapshot_identity):
        RUN_COMMAND(base_command, env=ENV, check=True)  # Same-stage repair preserves the original receipt.
    training = json.loads(receipt_path.read_text())
    if training != prior:
        raise ValueError('Same-stage recovery changed the original timing receipt')
    print('Reusing committed stage; preserving original training timing.')
else:
    RUN_COMMAND(base_command, env=ENV, check=True)
    training = json.loads((LOCAL_RUN / 'training-receipt.json').read_text())
if training['committed_updates'] != TARGET_UPDATES or training['status'] != expected_status:
    raise ValueError('Pilot did not reach its declared stage')
print(json.dumps(training, indent=2))
if TARGET_UPDATES == 300:
    print('STOPPED AT300 FOR IMAGE REVIEW. The1000-update budget is NOT completed.')
(ATTEMPT / 'training-observation.json').write_text(json.dumps(training, indent=2))
'''

DOWNLOAD_CELL = r'''from google.colab import files
training = json.loads((DRIVE_RUN / 'training-receipt.json').read_text())
assert training['committed_updates'] == TARGET_UPDATES
assert training['status'] == ('completed' if TARGET_UPDATES == MAX_UPDATES else 'interrupted')
assert file_sha(DRIVE_MODEL) == MODEL_SHA256
assert model['schema'] == 'viscera.tissue-appearance-decoder/v3'
assert model['provenance']['qualification'] == 'engineering_unqualified'
assert model['provenance']['refinement']['parent']['model_sha256'] == PARENT_MODEL_SHA256
pointer = json.loads((DRIVE_RUN / 'checkpoints/latest.json').read_text())
assert pointer['directory'] == f'step-{TARGET_UPDATES:09d}'
assert pointer['manifest_sha256'] == CHECKPOINT_SHA256 == training['checkpoint_manifest_sha256']
entries = [(DRIVE_MODEL, DRIVE_MODEL.name)]
for step in sorted({0, 300, TARGET_UPDATES}):
    checkpoint = DRIVE_RUN / 'checkpoints' / f'step-{step:09d}'
    checkpoint_manifest = json.loads((checkpoint / 'manifest.json').read_text())
    assert set(checkpoint_manifest['files']) == {'state.json', 'tensors.safetensors'}
    for name, declared in checkpoint_manifest['files'].items():
        assert file_sha(checkpoint / name) == declared['sha256']
    entries += [(checkpoint / name, f'checkpoints/step-{step:09d}/' + name)
        for name in ('manifest.json', 'state.json', 'tensors.safetensors')]
    snapshot = DRIVE_RUN / 'prior-snapshots' / f'step-{step:09d}'
    receipt = json.loads((snapshot / 'receipt.json').read_text())
    assert receipt['step'] == step and receipt['native_resolution'] == [128, 128]
    assert receipt['checkpoint_manifest_sha256'] == file_sha(checkpoint / 'manifest.json')
    expected = {f'condition-{i}-seed42-native128.png' for i in range(6)}
    assert set(receipt['files']) == expected
    for name, declared in receipt['files'].items():
        assert file_sha(snapshot / name) == declared['sha256']
    entries += [(snapshot / name, f'prior-snapshots/step-{step:09d}/' + name)
        for name in sorted(expected | {'receipt.json', 'completed-result.json'})]
for name in ('run-identity.json', 'request.json', 'train-reference.json', 'training-receipt.json', 'checkpoints/latest.json'):
    entries.append((DRIVE_RUN / name, name))
for name in ('records.jsonl', 'readiness.json', 'completed-result.json'):
    entries.append((DRIVE_RUN / 'data-readiness' / name, 'data-readiness/' + name))
for name in ('gpu-preflight.json', 'environment-installation.json', 'installed-packages.txt', 'training-observation.json'):
    entries.append((ATTEMPT / name, 'attempts/' + ATTEMPT.name + '/' + name))
entries += [(PARENT_MODEL, 'parent/model.tissue-model.json'),
    (PARENT_CHECKPOINT / 'manifest.json', 'parent/manifest.json'),
    (PARENT_CHECKPOINT / 'state.json', 'parent/state.json')]
diagnostic_names = ['diagnostics.json', 'objective-gate.json', 'appearance-comparison.png', 'group-balanced-posterior-comparison.png', 'loss-trace.png', 'completed-result.json',
    *[f'condition-{i}-seed42-256.png' for i in range(6)],
    *[f'{kind}-condition-{i}-seed{seed}-native128.png' for kind in ('parent', 'candidate')
        for i in range(6) for seed in ('42', '43', '18446744073709551615')]]
for directory, prefix, names in [
    (DIAGNOSTICS, 'diagnostics', diagnostic_names),
    (LOCAL_DATA, 'native-crops', ['release.json', 'records.jsonl', 'train.jsonl', 'val.jsonl', 'test.jsonl', 'exclusions.json', 'completed-result.json']),
    (BAKE_DIR, 'liver-seed42-4096', ['appearance.png', 'appearance.bake.json', 'completed-result.json']),
    (LOCAL_RUN, 'training-local', ['config.json'])]:
    entries += [(directory / name, prefix + '/' + name) for name in names]
if TARGET_UPDATES == 1000:
    entries += [(DRIVE_RUN / 'continuation-review.json', 'continuation-review.json'),
        (GATE_PATH, 'gate-review/step-000000300/objective-gate.json'),
        (GATE_PATH.with_name('diagnostics.json'), 'gate-review/step-000000300/diagnostics.json'),
        (REVIEW_PATH, 'gate-review/step-000000300/visual-review.json')]
if (LOCAL_RUN / 'metrics.jsonl').is_file():
    entries.append((LOCAL_RUN / 'metrics.jsonl', 'training-local/metrics-this-vm-attempt.jsonl'))
assert len(entries) == len({name for _, name in entries})
assert all(path.is_file() and not path.is_symlink() for path, _ in entries)
assert all(not name.startswith('/') and '\\' not in name
    and all(part not in ('', '.', '..') for part in name.split('/')) for _, name in entries)
assert sum(path.stat().st_size for path, _ in entries) < 128 * 1024**2
inventory = {name: {'bytes': path.stat().st_size, 'sha256': file_sha(path)} for path, name in entries}
inventory_key = hashlib.sha256(json.dumps(inventory, sort_keys=True).encode()).hexdigest()[:16]
archive_path = Path('/content') / (RUN_NAME + '-refine-review-' + MODEL_SHA256[:16] + '-' + inventory_key + '.zip')
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
# Print both complete hashes first so the UI's bounded accessibility text retains them.
print(json.dumps({'model_sha256': MODEL_SHA256, 'archive_sha256': file_sha(archive_path),
    'archive_bytes': archive_path.stat().st_size, 'stage_updates': TARGET_UPDATES,
    'budget_updates': MAX_UPDATES, 'run_id': RUN_NAME, 'inventory_files': len(inventory),
    'source_bundle_sha256': BUNDLE_SHA256, 'native_crop_release_sha256': RELEASE_SHA256,
    'parent_model_sha256': PARENT_MODEL_SHA256, 'archive': str(archive_path)}, indent=2))
files.download(str(archive_path))
'''


def notebook(bundle_sha256: str) -> dict:
    result = conv_notebook(bundle_sha256)
    codes = [entry['source'] for entry in result['cells'] if entry['cell_type'] == 'code']
    for i, source in enumerate(codes):
        codes[i] = source.replace('train_tissue_conv.py', 'train_tissue_conv_refine.py').replace(
            'viscera-tissue-conv', 'viscera-tissue-conv-refine')
    codes[0] = replace_once(codes[0], 'MAX_UPDATES = 6000', 'MAX_UPDATES = 1000\nTARGET_UPDATES = 300  # Never advance until the saved gate and images have been reviewed.')
    codes[0] += f'''\nPARENT_MODEL_SHA256 = '{PARENT_MODEL_SHA256}'
PARENT_CHECKPOINT_SHA256 = '{PARENT_CHECKPOINT_SHA256}'
PARENT_RUN = PROJECT_ROOT / 'conv-runs/prepared_group_split-061223c89fb79dc57e5687c8'
PARENT_CHECKPOINT = PARENT_RUN / 'checkpoints/step-000006000'
PARENT_MODEL = PARENT_RUN / 'prepared_group_split-061223c89fb79dc57e5687c8-step-000006000-b1a24c8dcc028f52.tissue-model.json'
'''
    codes[2] = codes[2].replace('/content/viscera-conv-readiness', '/content/viscera-conv-refine-readiness')
    codes[3] = TRAIN_CELL
    codes[4] = replace_once(codes[4], "'--checkpoint', str(CHECKPOINT), '--manifest'",
        "'--checkpoint', str(CHECKPOINT), '--warm-start', str(PARENT_CHECKPOINT), '--manifest'")
    codes[4] = replace_once(codes[4],
        "print(json.dumps({k:v for k,v in quality.items() if k not in ('loss_trace', 'loss_history')}, indent=2))",
        "print((DIAGNOSTICS / 'objective-gate.json').read_text())")
    codes[4] = replace_once(codes[4], "display(Image(filename=str(DIAGNOSTICS / 'loss-trace.png')))",
        "display(Image(filename=str(DIAGNOSTICS / 'loss-trace.png')))\n"
        "display(Image(filename=str(DIAGNOSTICS / 'group-balanced-posterior-comparison.png')))")
    codes[4] += '''\nif TARGET_UPDATES == 300:
    GATE_PATH = DRIVE_RUN / 'gate-review/step-000000300/objective-gate.json'
    publish_verified_file(DIAGNOSTICS / 'objective-gate.json', GATE_PATH)
    publish_verified_file(DIAGNOSTICS / 'diagnostics.json', GATE_PATH.with_name('diagnostics.json'))
    print('Saved quantitative gate; visual inspection is still required before continuation.')
'''
    codes[6] = DOWNLOAD_CELL
    result['cells'] = [cell('markdown', '''# VISCERA · bounded tissue objective refinement · A100

The completed6000-update spatial model removed the Fourier lattice but still
failed visual review: blurred fine detail, broad dark fields and a plastic sheen.
This isolated pilot retains the same spatial decoder and verified native crops.
It warm-starts the6000-update model/critic, resets both optimizers and RNG/sampler,
and adds normalized masked neighbor Charbonnier plus train-only prior frequency
and palette/contrast constraints. Renderer changes are evaluated separately.

Use **A100, Runtime2026.07/Python3.12**. Run All stops at **300 updates** of an
immutable1000-update budget, exports weights and downloads review evidence.
Continuation requires a model/checkpoint-bound numerical gate and explicit saved
visual review. The notebook never manufactures that review or advances on a timer.
Existing runs, checkpoints, data splits and the untouched test images are preserved.

The native learned output remains **128 × 128** observed RGB with baked lighting.
4096² PNGs **interpolate** those pixels. Outputs remain research-only and
engineering-unqualified; metric gains are not evidence of surgical realism.
''')]
    titles = ['Verify frozen source and parent model', 'Verify environment and objective GPU preflight',
        'Reuse the exact native crop release', 'Run the bounded pilot with exact resume',
        'Export and compare with the verified parent', 'Export explicit4096² interpolation',
        'Verify and download the complete stage evidence']
    for title, source in zip(titles, codes, strict=True):
        ast.parse(source)
        result['cells'].extend([cell('markdown', '## ' + title), cell('code', source)])
    return result


def package(baseline_path: Path, output_dir: Path) -> dict:
    if sha(baseline_path.read_bytes()) != BASELINE_SHA256:
        raise ValueError('Use the exact frozen and verified v3 source bundle')
    if output_dir.exists():
        raise FileExistsError('Preserve earlier packages; output must be a new directory')
    with zipfile.ZipFile(baseline_path) as archive:
        original = json.loads(archive.read('bundle-manifest.json'))
        names = archive.namelist()
        if len(names) != len(set(names)) or set(names) != set(original['files']) | {'bundle-manifest.json'}:
            raise ValueError('Frozen bundle inventory mismatch')
        payloads = {name: archive.read(name) for name in original['files']}
        for name, data in payloads.items():
            declared = original['files'][name]
            if len(data) != declared['bytes'] or sha(data) != declared['sha256']:
                raise ValueError('Frozen member hash mismatch: ' + name)
            if name.startswith(('py/', 'scripts/')) and (ROOT / name).read_bytes() != data:
                raise ValueError('Local frozen dependency changed: ' + name)
    paths = list((ROOT / 'py/viscera_core/tissue_learning_conv_refine').glob('*.py'))
    paths += [ROOT / name for name in ('scripts/train_tissue_conv_refine.py',
        'scripts/package_tissue_conv_refine_colab.py', 'tests/python/test_tissue_learning_conv_refine.py',
        'tests/python/test_tissue_conv_refine_colab.py')]
    if len(paths) < 10:
        raise ValueError('Incomplete refinement package')
    for path in paths:
        if not path.is_file() or path.is_symlink():
            raise ValueError('Missing/symlinked candidate source: ' + str(path))
        name = path.relative_to(ROOT).as_posix()
        if name in payloads:
            raise ValueError('Pilot cannot replace frozen dependencies: ' + name)
        payloads[name] = path.read_bytes()
    manifest = {'schema': 'viscera.tissue-learning-source-bundle/v1',
        'baseline_bundle_sha256': BASELINE_SHA256, 'parent_model_sha256': PARENT_MODEL_SHA256,
        'files': {name: {'bytes': len(data), 'sha256': sha(data)} for name, data in sorted(payloads.items())}}
    output_dir.mkdir(parents=True)
    bundle = output_dir / 'viscera-tissue-conv-refine-colab.zip'
    with zipfile.ZipFile(bundle, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in [*sorted(payloads.items()), ('bundle-manifest.json', (json.dumps(manifest, indent=2) + '\n').encode())]:
            info = zipfile.ZipInfo(name, (2026, 10, 19, 0, 0, 0))
            info.compress_type, info.external_attr = zipfile.ZIP_DEFLATED, 0o100644 << 16
            archive.writestr(info, data)
    bundle_sha = sha(bundle.read_bytes())
    note = output_dir / 'VISCERA_tissue_conv_refine_A100.ipynb'
    note.write_text(json.dumps(notebook(bundle_sha), indent=2) + '\n')
    receipt = {'bundle': str(bundle), 'bundle_sha256': bundle_sha, 'bundle_bytes': bundle.stat().st_size,
        'notebook': str(note), 'notebook_sha256': sha(note.read_bytes()), 'files': len(payloads),
        'code_cells_compiled': 7, 'gpu_executed': False, 'stage_updates': 300, 'budget_updates': 1000,
        'native_release_sha256': NATIVE_RELEASE_SHA256, 'baseline_bundle_sha256': BASELINE_SHA256,
        'parent_model_sha256': PARENT_MODEL_SHA256, 'parent_checkpoint_sha256': PARENT_CHECKPOINT_SHA256,
        'qualification': 'engineering_unqualified'}
    (output_dir / 'package-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline-bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(package(args.baseline_bundle, args.output), indent=2))
