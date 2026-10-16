"""Verify the local observation-only surgical interaction pilot."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def verify(root: Path) -> dict:
    manifest = json.loads((root / 'manifest.json').read_text())
    assert sha256(root / 'manifest.json') == (root / 'manifest.sha256').read_text().strip()
    for name, expected in manifest['files'].items():
        path = (root / name).resolve()
        assert path.is_relative_to(root.resolve()), name
        assert path.is_file(), name
        assert path.stat().st_size == expected['bytes'], name
        assert sha256(path) == expected['sha256'], name
    folder = root / 'M1_L_V1_1'
    raw = np.load(folder / 'signals_raw.npz', allow_pickle=False)
    synced = np.load(folder / 'synchronized.npz', allow_pickle=False)
    n = len(synced['t_s'])
    assert n == 1747
    assert len(list((folder / 'left').glob('*.jpg'))) == n
    assert len(list((folder / 'right').glob('*.jpg'))) == 1746
    assert np.all(np.diff(synced['t_s']) > 0)
    for name in ['position_m', 'orientation_xyzw', 'force_n', 'torque_nm']:
        assert np.all(np.isfinite(synced[name])), name
    np.testing.assert_allclose(np.linalg.norm(synced['orientation_xyzw'], axis=1), 1, atol=1e-10)
    np.testing.assert_array_equal(synced['left_frame_index'], np.arange(n))
    for signal, prefix, idx in [('position_m','pose','pose_index'),('force_n','force','force_index')]:
        np.testing.assert_array_equal(synced[signal],raw[signal][synced[idx]])
        np.testing.assert_allclose(synced[prefix+'_dt_s'],raw[prefix+'_t_s'][synced[idx]]-synced['t_s'],atol=1e-12)
    timing = json.loads((folder / 'preview-timing.json').read_text())
    assert timing['encoded_frame_count'] == timing['source_frame_count'] == n
    assert timing['video_sha256'] == sha256(folder / 'left_preview.mp4')
    assert timing['max_abs_video_to_source_time_error_s'] <= .00001
    np.testing.assert_allclose(timing['source_bag_t_s'],synced['t_s'],atol=0)
    readiness = json.loads((root / 'calibration-readiness.json').read_text())
    assert readiness['constitutive_parameter_promotion_allowed'] is False
    assert readiness['fitted_material_parameters'] is None
    assert manifest['license'] == 'CC-BY-4.0'
    assert manifest['sequence_ids'] == ['M1_L_V1_1']
    return {'status':'integrity_verified_observations_only','files_verified':len(manifest['files']),
            'left_frames':n,'constitutive_promotion_allowed':False}


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('root',type=Path)
    print(json.dumps(verify(parser.parse_args().root),indent=2))
