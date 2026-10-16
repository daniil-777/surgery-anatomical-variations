"""Encode a timestamp-aware review video, preserving one frame per source JPEG.

Requires ffmpeg/ffprobe and numpy. Original arrays remain authoritative.
"""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

import numpy as np


def build(folder: Path) -> dict:
    t = np.load(folder / 'synchronized.npz')['t_s']
    # Quantize absolute timestamps first to avoid accumulated per-duration truncation.
    ticks = np.rint((t - t[0]) * 1000000).astype(np.int64)
    if np.any(np.diff(ticks) <= 0):
        raise ValueError('Source frames are too close for microsecond encoding')
    concat = ['ffconcat version 1.0']
    for i in range(len(t)):
        concat.extend([f"file 'left/{i:06d}.jpg'", 'option framerate 1000000',
                       f'duration {(ticks[i+1]-ticks[i])/1000000 if i+1 < len(t) else .034:.6f}'])
    (folder / 'left.ffconcat').write_text('\n'.join(concat) + '\n')
    video = folder / 'left_preview.mp4'
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
                    '-i', str(folder / 'left.ffconcat'), '-fps_mode', 'vfr',
                    '-enc_time_base', '1:1000000', '-c:v', 'libx264', '-crf', '20',
                    '-video_track_timescale', '1000000', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', str(video)], check=True)
    return inspect(folder)


def inspect(folder: Path) -> dict:
    t = np.load(folder / 'synchronized.npz')['t_s']
    video = folder / 'left_preview.mp4'
    raw = subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
        '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', str(video)])
    probe = json.loads(raw)
    pts = np.asarray([float(f['best_effort_timestamp_time']) for f in probe['frames']])
    if len(pts) != len(t):
        raise ValueError(f'Preview lost/duplicated frames: {len(pts)} vs {len(t)}')
    error = pts + t[0] - t
    if np.max(np.abs(error)) > .00001:
        raise ValueError('Preview timestamp error exceeds 10 microseconds')
    mapping = dict(schema='viscera.physics.preview_timing.v1',
        source_frame_count=int(len(t)), encoded_frame_count=int(len(pts)),
        encoded_frame_index_equals_left_jpeg_index=True,
        video_pts_to_bag_relative_t_s_offset=float(t[0]),
        video_pts_quantization_s=.000001,
        max_abs_video_to_source_time_error_s=float(np.max(np.abs(error))),
        video_sha256=hashlib.sha256(video.read_bytes()).hexdigest(),
        frame_pts_s=pts.tolist(), source_bag_t_s=t.tolist(),
        instruction='For seek/chart alignment use video.currentTime + offset, then nearest source t_s. All source JPEGs occur once; microsecond timestamp quantization remains. Decoder/seek behavior can show nearest keyframe until seek completes.',
        acquisition_caveat='Encoding alignment is separate from physical acquisition synchronization. Bag recording timestamps do not resolve unknown sensor/camera hardware latency.')
    (folder / 'preview-timing.json').write_text(json.dumps(mapping, indent=2) + '\n')
    return {k:v for k,v in mapping.items() if k not in ['frame_pts_s','source_bag_t_s']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('sequence', type=Path)
    parser.add_argument('--inspect-only', action='store_true')
    args = parser.parse_args()
    print(json.dumps(inspect(args.sequence) if args.inspect_only else build(args.sequence), indent=2))
