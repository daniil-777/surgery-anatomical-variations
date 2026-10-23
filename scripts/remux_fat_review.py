#!/usr/bin/env python3
"""Create seekable WebM review copies without re-encoding any video packets."""
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import shlex
import subprocess

ROOT = Path(__file__).resolve().parents[1] / "artifacts/fat-quality-v3-2026-10-19"
OUTPUT = ROOT / "review-playback"
OUTPUT.mkdir(parents=True, exist_ok=True)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def probe(path, frames=False):
    arguments = ["ffprobe", "-v", "error", "-select_streams", "v:0"]
    if frames:
        arguments += ["-show_frames", "-show_entries", "frame=best_effort_timestamp_time,pkt_dts_time,width,height,pict_type"]
    else:
        arguments += ["-show_packets", "-show_data_hash", "sha256", "-show_entries",
                      "stream=codec_name,width,height,time_base:format=duration:packet=pts_time,dts_time,duration_time,size,data_hash"]
    arguments += ["-of", "json", str(path)]
    return json.loads(subprocess.check_output(arguments, text=True))


def maximum_difference(before, after):
    if len(before) != len(after):
        raise AssertionError("Timestamp/count mismatch")
    return max((abs(a - b) for a, b in zip(before, after)), default=0)


manifest = {
    "createdAt": datetime.now(timezone.utc).isoformat(),
    "operation": "FFmpeg stream-copy remux to a seekable WebM container; no video encoding or quality modification.",
    "source": "candidate-03 original MediaRecorder captures, preserved unchanged",
    "cadenceSource": "All displayed measured frame rates remain the raw capture's decoded timestamp measurements.",
    "ffmpegVersion": subprocess.check_output(["ffmpeg", "-version"], text=True).splitlines()[0],
    "commandWorkingDirectory": str(ROOT),
    "videos": [],
}
recordings = json.loads((ROOT / "candidate-03/all-observations.json").read_text())["videos"]
for video in recordings:
    source = ROOT / "candidate-03" / video["file"]
    derived = OUTPUT / video["file"]
    original_hash = sha256(source)
    assert original_hash == video["sha256"], "Original differs from the recorded capture manifest"
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-copyts",
               "-i", str(source.relative_to(ROOT)), "-map", "0", "-c", "copy", "-avoid_negative_ts", "disabled", str(derived.relative_to(ROOT))]
    if not derived.exists():
        subprocess.run(command, cwd=ROOT, check=True)
    before, after = probe(source), probe(derived)
    before_frames, after_frames = probe(source, True)["frames"], probe(derived, True)["frames"]
    before_packets, after_packets = before["packets"], after["packets"]
    before_times = [float(frame["best_effort_timestamp_time"]) for frame in before_frames]
    after_times = [float(frame["best_effort_timestamp_time"]) for frame in after_frames]
    before_intervals = [b - a for a, b in zip(before_times, before_times[1:])]
    after_intervals = [b - a for a, b in zip(after_times, after_times[1:])]
    packet_fields = ["pts_time", "dts_time", "size", "data_hash"]
    packet_equivalent = [[packet.get(field) for field in packet_fields] for packet in before_packets] == [[packet.get(field) for field in packet_fields] for packet in after_packets]
    frame_dimensions_equal = [[frame["width"], frame["height"]] for frame in before_frames] == [[frame["width"], frame["height"]] for frame in after_frames]
    audit = {
        "experiment": video["experiment"], "originalFile": str(source.relative_to(ROOT)), "playbackFile": str(derived.relative_to(ROOT)),
        "originalSha256": original_hash, "playbackSha256": sha256(derived), "originalUnchanged": sha256(source) == original_hash,
        "matchesRecordedCaptureSha256": original_hash == video["sha256"],
        "command": command, "commandShell": shlex.join(command),
        "originalBytes": source.stat().st_size, "playbackBytes": derived.stat().st_size,
        "originalFormatDurationSec": before.get("format", {}).get("duration"),
        "playbackFormatDurationSec": float(after["format"]["duration"]),
        "originalStream": before["streams"][0], "playbackStream": after["streams"][0],
        "packetCountOriginal": len(before_packets), "packetCountPlayback": len(after_packets),
        "frameCountOriginal": len(before_frames), "frameCountPlayback": len(after_frames),
        "packetPayloadHashesSizesPtsDtsIdentical": packet_equivalent,
        "frameDimensionsIdentical": frame_dimensions_equal,
        "maximumFrameTimestampDifferenceSec": maximum_difference(before_times, after_times),
        "maximumFrameIntervalDifferenceSec": maximum_difference(before_intervals, after_intervals),
        "packetDurationMetadataChanges": sum(a.get("duration_time") != b.get("duration_time") for a, b in zip(before_packets, after_packets)),
        "rawMeasuredFps": video["cadence"]["measuredAverageFps"],
    }
    assert audit["originalUnchanged"] and packet_equivalent and frame_dimensions_equal
    assert audit["maximumFrameTimestampDifferenceSec"] == 0 and audit["maximumFrameIntervalDifferenceSec"] == 0
    assert audit["frameCountOriginal"] == audit["frameCountPlayback"] == video["cadence"]["decodedFrames"]
    assert before["streams"][0] == after["streams"][0]
    assert math.isfinite(audit["playbackFormatDurationSec"]) and audit["playbackFormatDurationSec"] > 0
    manifest["videos"].append(audit)
    print(json.dumps({"video": video["file"], "durationSec": audit["playbackFormatDurationSec"],
                      "frames": len(after_frames), "packetPayloadsIdentical": packet_equivalent}), flush=True)
manifest["allPassed"] = len(manifest["videos"]) == 5
(OUTPUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
