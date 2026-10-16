"""Extract CC-BY dVRK chicken pilot; no tissue-property or contact inference.

Requires numpy, rosbags. Original JPEG payloads are preserved byte-for-byte.
All synchronization uses ROS bag record timestamps because camera/force header
stamps are zero in this release. Run into a new destination directory.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from rosbags.highlevel import AnyReader


def nearest_indices(times: np.ndarray, query: np.ndarray) -> np.ndarray:
    right = np.searchsorted(times, query).clip(0, len(times) - 1)
    left = (right - 1).clip(0, len(times) - 1)
    return np.where(abs(times[left] - query) <= abs(times[right] - query), left, right)


def extract(bag: Path, out: Path) -> None:
    if out.exists():
        raise FileExistsError(f"Use a fresh output directory: {out}")
    out.mkdir(parents=True)
    arrays: dict[str, list] = {k: [] for k in (
        'pose_record_ns', 'pose_header_ns', 'position_m', 'orientation_xyzw',
        'force_record_ns', 'force_header_ns', 'force_n', 'torque_nm',
        'left_record_ns', 'left_header_ns', 'right_record_ns', 'right_header_ns')}
    frame_ids: dict[str, set[str]] = {}
    topics = {
        '/dvrk/PSM1/position_cartesian_current': 'pose',
        '/force_sensor': 'force',
        '/camera/left/image_color/compressed': 'left',
        '/camera/right/image_color/compressed': 'right',
    }
    for side in ('left', 'right'):
        (out / side).mkdir()
    with AnyReader([bag]) as reader:
        start_ns = reader.start_time
        inventory = [{'topic': c.topic, 'type': c.msgtype, 'count': c.msgcount}
                     for c in reader.connections]
        selected = [c for c in reader.connections if c.topic in topics]
        for connection, timestamp, raw in reader.messages(connections=selected):
            msg = reader.deserialize(raw, connection.msgtype)
            prefix = topics[connection.topic]
            index = len(arrays[prefix + '_record_ns'])
            arrays[prefix + '_record_ns'].append(timestamp)
            arrays[prefix + '_header_ns'].append(msg.header.stamp.sec * 10**9 + msg.header.stamp.nanosec)
            frame_ids.setdefault(prefix, set()).add(msg.header.frame_id)
            if prefix == 'pose':
                p, q = msg.pose.position, msg.pose.orientation
                arrays['position_m'].append([p.x, p.y, p.z])
                arrays['orientation_xyzw'].append([q.x, q.y, q.z, q.w])
            elif prefix == 'force':
                f, t = msg.wrench.force, msg.wrench.torque
                arrays['force_n'].append([f.x, f.y, f.z])
                arrays['torque_nm'].append([t.x, t.y, t.z])
            else:
                (out / prefix / f'{index:06d}.jpg').write_bytes(msg.data.tobytes())
    data = {k: np.asarray(v, dtype=np.int64 if k.endswith('_ns') else np.float64)
            for k, v in arrays.items()}
    for prefix in ('pose', 'force', 'left', 'right'):
        data[prefix + '_t_s'] = (data[prefix + '_record_ns'] - start_ns) / 1e9
        if not np.all(np.diff(data[prefix + '_record_ns']) >= 0):
            raise ValueError(f'Nonmonotone recording clock for {prefix}')
    np.savez_compressed(out / 'signals_raw.npz', **data)
    t = data['left_t_s']
    indices = {p: nearest_indices(data[p + '_t_s'], t) for p in ('pose', 'force', 'right')}
    errors = {p: data[p + '_t_s'][idx] - t for p, idx in indices.items()}
    # Timestamp proximity is not proof of physical simultaneity; retain residuals.
    synced = dict(t_s=t, left_frame_index=np.arange(len(t)),
                  right_frame_index=indices['right'],
                  position_m=data['position_m'][indices['pose']],
                  orientation_xyzw=data['orientation_xyzw'][indices['pose']],
                  force_n=data['force_n'][indices['force']],
                  torque_nm=data['torque_nm'][indices['force']],
                  pose_index=indices['pose'], force_index=indices['force'],
                  pose_dt_s=errors['pose'], force_dt_s=errors['force'],
                  right_dt_s=errors['right'],
                  valid_timing=(abs(errors['pose']) <= .02) & (abs(errors['force']) <= .02)
                  & (abs(errors['right']) <= .02))
    np.savez_compressed(out / 'synchronized.npz', **synced)
    summary = {
        'schema': 'viscera.physics.observed_sequence.v1',
        'sequence_id': bag.stem, 'specimen_group': bag.stem.split('_')[0],
        'source_partition': 'seen_view_seen_material_train',
        'source_data_url': 'https://zenodo.org/records/21041361',
        'source_license': 'CC-BY-4.0', 'download_sha256': hashlib.sha256(bag.read_bytes()).hexdigest(),
        'bag_start_record_ns': start_ns, 'topics': inventory,
        'frame_ids': {k: sorted(v) for k, v in frame_ids.items()},
        'synchronization': 'Nearest ROS bag recording timestamp; no smoothing/interpolation; camera/force header stamps are zero. No hardware latency correction.',
        'units': {'position_m': 'm, dVRK PSM1 Cartesian frame',
                  'orientation_xyzw': 'unit quaternion, source PSM1 frame',
                  'force_n': 'N, force-sensor local frame, unnamed',
                  'torque_nm': 'N*m, force-sensor local frame, unnamed',
                  't_s': 's since first bag record'},
        'unit_evidence': 'ROS REP-103 SI convention and author extraction script; force scaling is retained exactly, not independently calibrated.',
        'not_provided_in_bag': ['camera intrinsics', 'stereo extrinsics', 'force-to-PSM transform', 'contact labels', 'tissue rest shape/thickness/boundary conditions', 'instrument tip-to-contact offset'],
        'physical_parameter_scope': 'Observed motion and unprojected force. Apparent force/displacement identification only after contact/axis checks; no Young modulus labels.',
        'split_policy': 'Keep all frames and cycles of this specimen/sequence grouped. Within-sequence temporal holdout is not unseen-specimen validation.',
        'counts': {p: len(data[p + '_t_s']) for p in ('pose', 'force', 'left', 'right')},
        'duration_s': float(max(data['left_t_s']) - min(data['left_t_s'])),
        'timing': {p: {'median_abs_ms': float(np.median(abs(e))*1000),
                       'max_abs_ms': float(max(abs(e))*1000)} for p, e in errors.items()},
        'valid_timing_frames': int(np.sum(synced['valid_timing'])),
        'changes_from_source': 'Decoded ROS container; original JPEG payloads unchanged; nearest-record-time synchronized arrays derived. No training or clinical validation.'
    }
    (out / 'sequence.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps({'counts': summary['counts'], 'timing': summary['timing'],
                      'sha256': summary['download_sha256']}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('bag', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    extract(args.bag, args.output)
