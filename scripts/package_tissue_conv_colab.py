#!/usr/bin/env python3
"""Freeze the spatial convolutional candidate beside its failed predecessors."""

from __future__ import annotations

import argparse
import ast
import json
import zipfile
from pathlib import Path

from package_tissue_detail_colab import notebook as detail_notebook
from package_tissue_detail_colab import replace_once, sha
from package_tissue_learning_colab import cell

ROOT = Path(__file__).resolve().parents[1]
BASELINE_SHA256 = 'ef15a31f9b812ed7445187e3def49f07ed7396a7ead0134d787c6435cd923163'
NATIVE_RELEASE_SHA256 = '26f0dd07b29375249239016e3281c399e3c89fed4c16354a9011f6440a288565'


def notebook(bundle_sha256: str) -> dict:
    result = detail_notebook(bundle_sha256)
    codes = [entry['source'] for entry in result['cells'] if entry['cell_type'] == 'code']
    for index, source in enumerate(codes):
        source = source.replace('tissue_learning_detail', 'tissue_learning_conv')
        source = source.replace('train_tissue_detail.py', 'train_tissue_conv.py')
        source = source.replace('viscera-tissue-detail', 'viscera-tissue-conv')
        codes[index] = source
    codes[0] = replace_once(codes[0], 'MAX_UPDATES = 3000', 'MAX_UPDATES = 6000')
    codes[0] = replace_once(codes[0], 'BATCH_SIZE = 8', 'BATCH_SIZE = 16')
    codes[0] = replace_once(codes[0],
        "ROOT = Path('/content/viscera-tissue-conv-source') / BUNDLE_SHA256",
        "ROOT = Path('/content/viscera-tissue-conv-source') / BUNDLE_SHA256\n"
        "for loaded_name, loaded_module in tuple(sys.modules.items()):\n"
        "    loaded_file = getattr(loaded_module, '__file__', None)\n"
        "    if loaded_name.startswith('viscera_core') and loaded_file and not Path(loaded_file).resolve().is_relative_to(ROOT.resolve()):\n"
        "        raise RuntimeError('Restart the Colab session before switching source bundles; existing dataset and Drive files are preserved.')")
    # Reuse only the exact verified native release. Its original scan and
    # preparation identities are unchanged; no test image payloads are staged.
    codes[2] = replace_once(codes[2], "print('Native crop release:', RELEASE_SHA256)",
        f"if RELEASE_SHA256 != '{NATIVE_RELEASE_SHA256}':\n"
        "    raise ValueError('Native release differs from the reviewed 3000-update experiment')\n"
        "print('Native crop release:', RELEASE_SHA256)")
    codes[2] = codes[2].replace('/content/viscera-detail-readiness', '/content/viscera-conv-readiness')
    codes[3] = codes[3].replace('DetailConfig', 'ConvConfig').replace("'detail-runs'", "'conv-runs'")
    codes[3] = codes[3].replace("'50'", "'300'").replace('warmup-50-receipt.json', 'probe-300-receipt.json')
    codes[3] = codes[3].replace('50-update warmup measurement', '300-update measurement (includes active critic)')
    codes[3] = codes[3].replace('Scientific detail run identity:', 'Scientific convolutional run identity:')
    codes[3] = codes[3].replace(
        'The real 50-update checkpoint measures reconstruction warmup. The separate\n'
        '    # GPU preflight exercises both optimizers with the critic enabled immediately.',
        'The real 300-update checkpoint includes active-critic updates after\n'
        '    # warmup. GPU preflight independently exercises both optimizers.')
    codes[4] = replace_once(codes[4],
        "print(json.dumps({k:v for k,v in quality.items() if k != 'loss_trace'}, indent=2))",
        "print(json.dumps({k:v for k,v in quality.items() if k not in ('loss_trace', 'loss_history')}, indent=2))")
    codes[6] = replace_once(codes[6], "'viscera.tissue-appearance-decoder/v2'", "'viscera.tissue-appearance-decoder/v3'")
    codes[6] = codes[6].replace("'-detail-review-'", "'-conv-review-'")
    codes[6] = replace_once(codes[6],
        "entries = [(path, path.relative_to(DRIVE_RUN).as_posix()) for path in selected]",
        "probe_receipt = ATTEMPT / 'probe-300-receipt.json'\n"
        "if probe_receipt.is_file():\n"
        "    selected.append(probe_receipt)\n"
        "    probe_manifest = DRIVE_RUN / 'checkpoints/step-000000300/manifest.json'\n"
        "    if file_sha(probe_manifest) != json.loads(probe_receipt.read_text())['checkpoint_manifest_sha256']:\n"
        "        raise ValueError('Probe checkpoint identity mismatch')\n"
        "    selected.append(probe_manifest)\n"
        "for snapshot_step in (1000, 3000, MAX_UPDATES):\n"
        "    snapshot_dir = DRIVE_RUN / 'prior-snapshots' / f'step-{snapshot_step:09d}'\n"
        "    snapshot_receipt = json.loads((snapshot_dir / 'receipt.json').read_text())\n"
        "    if snapshot_receipt['step'] != snapshot_step or snapshot_receipt['native_resolution'] != [128, 128]:\n"
        "        raise ValueError('Intermediate prior sample identity mismatch')\n"
        "    for name, declared in snapshot_receipt['files'].items():\n"
        "        if '/' in name or '\\\\' in name or not name.startswith('condition-') or not name.endswith('-seed42-native128.png'):\n"
        "            raise ValueError('Unsafe intermediate sample name')\n"
        "        if file_sha(snapshot_dir / name) != declared['sha256']:\n"
        "            raise ValueError('Intermediate prior sample hash mismatch')\n"
        "        selected.append(snapshot_dir / name)\n"
        "    selected.extend([snapshot_dir / 'receipt.json', snapshot_dir / 'completed-result.json'])\n"
        "    if snapshot_step != MAX_UPDATES:\n"
        "        early_checkpoint = DRIVE_RUN / 'checkpoints' / f'step-{snapshot_step:09d}'\n"
        "        if file_sha(early_checkpoint / 'manifest.json') != snapshot_receipt['checkpoint_manifest_sha256']:\n"
        "            raise ValueError('Intermediate checkpoint manifest identity mismatch')\n"
        "        early_manifest = json.loads((early_checkpoint / 'manifest.json').read_text())\n"
        "        if file_sha(early_checkpoint / 'state.json') != early_manifest['files']['state.json']['sha256']:\n"
        "            raise ValueError('Intermediate checkpoint metadata hash mismatch')\n"
        "        selected.extend([early_checkpoint / 'manifest.json', early_checkpoint / 'state.json'])\n"
        "entries = [(path, path.relative_to(DRIVE_RUN).as_posix()) for path in selected]")
    result['cells'] = [cell('markdown', '''# VISCERA · spatial convolutional tissue candidate · A100

The prior 2000- and 3000-update experiments completed but failed visual review.
The latter produced a repeated Fourier lattice and blurred tissue detail. This
separate experiment removes coordinate/Fourier features and uses spatial latent
noise with circular convolutions and nearest-neighbor upsampling. A masked
conditional critic explicitly trains generated prior samples.

Use **A100, Runtime2026.07/Python3.12**. All 6000 updates belong to one immutable
experiment, with a real 300-update checkpoint then exact continuation. The exact
previously verified native training/validation release is reused. Existing
models, checkpoints and test-image isolation are preserved.

Native learned output is **128 × 128**. Larger exported PNGs interpolate that
texture; they are not newly learned 4K detail. All outputs remain research-only,
observed RGB with baked illumination, and unqualified pending visual review.
''')]
    titles = ['Verify source and mount the existing project',
              'Verify the frozen environment and actual GPU/checkpoint path',
              'Verify and reuse native crops without opening test images',
              'Train the separate spatial candidate with resumable checkpoints',
              'Export and critically inspect the actual learned samples',
              'Export 4096² PNG by explicit interpolation of native128² output',
              'Verify and download weights, checkpoint and review evidence']
    for title, source in zip(titles, codes, strict=True):
        ast.parse(source)
        result['cells'].extend([cell('markdown', '## ' + title), cell('code', source)])
    return result


TRAIN_CELL = [entry['source'] for entry in notebook('0' * 64)['cells'] if entry['cell_type'] == 'code'][3]
DOWNLOAD_CELL = [entry['source'] for entry in notebook('0' * 64)['cells'] if entry['cell_type'] == 'code'][-1]


def package(baseline_path: Path, output_dir: Path) -> dict:
    raw_bundle = baseline_path.read_bytes()
    if sha(raw_bundle) != BASELINE_SHA256:
        raise ValueError('Use the exact frozen, verified v2 dependency bundle')
    if output_dir.exists():
        raise FileExistsError('Preserve earlier packages; output must be a new directory')
    with zipfile.ZipFile(baseline_path) as archive:
        original = json.loads(archive.read('bundle-manifest.json'))
        if len(archive.namelist()) != len(set(archive.namelist())):
            raise ValueError('Duplicate frozen members')
        if set(archive.namelist()) != set(original['files']) | {'bundle-manifest.json'}:
            raise ValueError('Frozen inventory mismatch')
        payloads = {name: archive.read(name) for name in original['files']}
        for name, data in payloads.items():
            declared = original['files'][name]
            if len(data) != declared['bytes'] or sha(data) != declared['sha256']:
                raise ValueError('Frozen member hash mismatch: ' + name)
            if name.startswith(('py/', 'scripts/')) and (ROOT / name).read_bytes() != data:
                raise ValueError('Local frozen dependency changed: ' + name)
    paths = list((ROOT / 'py/viscera_core/tissue_learning_conv').glob('*.py'))
    paths += [ROOT / name for name in (
        'scripts/train_tissue_conv.py', 'scripts/package_tissue_conv_colab.py',
        'tests/python/test_tissue_learning_conv.py', 'tests/python/test_tissue_conv_colab.py')]
    for path in paths:
        if not path.is_file() or path.is_symlink():
            raise ValueError('Missing/symlinked candidate source: ' + str(path))
        name = path.relative_to(ROOT).as_posix()
        if name in payloads:
            raise ValueError('New candidate cannot replace frozen dependencies: ' + name)
        payloads[name] = path.read_bytes()
    manifest = {'schema': 'viscera.tissue-learning-source-bundle/v1',
                'baseline_bundle_sha256': BASELINE_SHA256,
                'files': {name: {'bytes': len(data), 'sha256': sha(data)}
                          for name, data in sorted(payloads.items())}}
    output_dir.mkdir(parents=True)
    bundle = output_dir / 'viscera-tissue-conv-colab.zip'
    with zipfile.ZipFile(bundle, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in [*sorted(payloads.items()),
                ('bundle-manifest.json', (json.dumps(manifest, indent=2) + '\n').encode())]:
            info = zipfile.ZipInfo(name, (2026, 10, 19, 0, 0, 0))
            info.compress_type, info.external_attr = zipfile.ZIP_DEFLATED, 0o100644 << 16
            archive.writestr(info, data)
    bundle_sha = sha(bundle.read_bytes())
    note = output_dir / 'VISCERA_tissue_conv_A100.ipynb'
    note.write_text(json.dumps(notebook(bundle_sha), indent=2) + '\n')
    receipt = {'bundle': str(bundle), 'bundle_sha256': bundle_sha,
               'bundle_bytes': bundle.stat().st_size, 'notebook': str(note),
               'notebook_sha256': sha(note.read_bytes()), 'files': len(payloads),
               'code_cells_compiled': 7, 'gpu_executed': False,
               'native_release_sha256': NATIVE_RELEASE_SHA256,
               'baseline_bundle_sha256': BASELINE_SHA256,
               'qualification': 'engineering_unqualified'}
    (output_dir / 'package-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline-bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(package(args.baseline_bundle, args.output), indent=2))
