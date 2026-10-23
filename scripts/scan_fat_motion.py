#!/usr/bin/env python3
"""CPU-only diagnostic scan of recorded Fat Lab motion, not a realism test.

Decode every frame to 384x216 grayscale, count pixels below 5, and preserve the
five highest-count candidate frames at original resolution. Dark anatomy may
legitimately score highly: inspect candidates; do not treat the score as PASS/FAIL.
Original video and other evidence are never modified. Requires ffmpeg/ffprobe.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import statistics
import struct
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def sha256(path: Path) -> str:
    checksum = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1 << 20), b""):
            checksum.update(block)
    return checksum.hexdigest()


def executable(name: str) -> str:
    found = shutil.which(name)
    fallback = Path("/opt/homebrew/bin") / name
    if found:
        return found
    if fallback.is_file():
        return str(fallback)
    raise RuntimeError(f"{name} is required; install it or add it to PATH")


def describe(values: list[float]) -> dict:
    return {"samples": len(values), "maximumFraction": max(values, default=0),
            "meanFraction": statistics.fmean(values) if values else None,
            "medianFraction": statistics.median(values) if values else None}


def scan(video: Path, output: Path, compare: Path | None = None) -> dict:
    if not video.is_file() or video.is_symlink():
        raise ValueError("Input must be a regular video file")
    if output.exists():
        raise ValueError(f"Refusing to overwrite evidence directory: {output}")
    ffmpeg, ffprobe = executable("ffmpeg"), executable("ffprobe")
    source_hash = sha256(video)
    probe = json.loads(subprocess.check_output([
        ffprobe, "-v", "error", "-select_streams", "v:0", "-show_frames",
        "-show_entries", "stream=width,height,codec_name:frame=best_effort_timestamp_time",
        "-of", "json", str(video)], timeout=300))
    streams = probe.get("streams", [])
    if len(streams) != 1:
        raise ValueError("Expected one selected video stream")
    timestamps = [float(frame["best_effort_timestamp_time"]) for frame in probe.get("frames", [])]
    if not timestamps or not all(math.isfinite(value) for value in timestamps):
        raise ValueError("Video requires finite presentation timestamps for each decoded frame")
    width, height, threshold = 384, 216, 5
    frame_size = width * height
    frames = []
    with tempfile.TemporaryFile() as errors:
        command = [ffmpeg, "-v", "error", "-i", str(video), "-map", "0:v:0", "-vf",
                   f"scale={width}:{height},format=gray", "-fps_mode", "passthrough", "-enc_time_base", "demux", "-f", "rawvideo", "-"]
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors)
        try:
            assert process.stdout is not None
            while True:
                parts = bytearray()
                while len(parts) < frame_size:
                    block = process.stdout.read(frame_size - len(parts))
                    if not block:
                        break
                    parts.extend(block)
                if not parts:
                    break
                if len(parts) != frame_size:
                    raise ValueError("Decoder returned a partial frame")
                index = len(frames)
                if index >= len(timestamps):
                    raise ValueError("Decoder/probe frame-count mismatch")
                count = sum(parts.count(value) for value in range(threshold))
                frames.append({"decodedFrame": index, "timeSeconds": timestamps[index],
                               "nearBlackPixels": count, "fraction": count / frame_size})
            code = process.wait(timeout=30)
            errors.seek(0)
            decoder_errors = errors.read().decode(errors="replace").strip()
            if code or decoder_errors:
                raise RuntimeError(f"Decoder did not finish cleanly: exit={code}; {decoder_errors}")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            if process.stdout:
                process.stdout.close()
    if len(frames) != len(timestamps):
        raise ValueError("Decoder/probe frame-count mismatch")
    selected = sorted(frames, key=lambda frame: (-frame["nearBlackPixels"], frame["decodedFrame"]))[:5]
    chronological = sorted(selected, key=lambda frame: frame["decodedFrame"])
    output.mkdir(parents=True)
    expression = "+".join(f"eq(n\\,{frame['decodedFrame']})" for frame in chronological)
    subprocess.run([ffmpeg, "-v", "error", "-i", str(video), "-map", "0:v:0", "-vf", f"select={expression}",
                    "-fps_mode", "passthrough", "-enc_time_base", "demux", "-frames:v", str(len(chronological)),
                    str(output / "candidate-%02d.png")], check=True, timeout=300)
    candidates = []
    for number, frame in enumerate(chronological, 1):
        path = output / f"candidate-{number:02d}.png"
        with path.open("rb") as source:
            header = source.read(24)
        if header[:8] != b"\x89PNG\r\n\x1a\n" or struct.unpack(">II", header[16:24]) != (streams[0]["width"], streams[0]["height"]):
            raise ValueError("Candidate PNG does not preserve original video dimensions")
        candidates.append({**frame, "rank": selected.index(frame) + 1, "file": path.name, "sha256": sha256(path)})
    result = {"schema": "viscera.fat-motion-scan/v1", "diagnosticOnly": True,
              "createdAt": datetime.now(timezone.utc).isoformat(), "video": video.name, "videoSha256": source_hash,
              "sourceDimensions": {"width": streams[0]["width"], "height": streams[0]["height"]},
              "method": {"decode": "software ffmpeg; no hardware acceleration requested", "width": width, "height": height,
                         "colorSpace": "ffmpeg grayscale", "thresholdExclusive": threshold, "topCandidates": 5},
              "limitations": "Black-pixel fraction is a diagnostic heuristic, not a universal failure threshold. Camera, lighting, occlusion and scene content affect it. Human inspection remains required; no clinical or photorealism claim.",
              "summary": describe([frame["fraction"] for frame in frames]), "candidates": candidates, "frames": frames}
    raw_path = video.with_name(video.stem + "-raw-samples.json")
    if raw_path.is_file():
        raw = json.loads(raw_path.read_text())
        values = [float(sample["blackFraction"]) for sample in raw.get("samples", [])]
        if not all(math.isfinite(value) and 0 <= value <= 1 for value in values):
            raise ValueError("Invalid raw canvas diagnostic values")
        result["rawCanvas"] = {"file": raw_path.name, "sha256": sha256(raw_path), "summary": describe(values),
                               "notes": raw.get("notes"), "alignment": "Raw canvas clock differs from encoded presentation timestamps; no exact frame pairing inferred."}
    if compare:
        previous = json.loads(compare.read_text())
        result["comparison"] = {"file": str(compare), "sha256": sha256(compare),
                                "summary": describe([float(frame["fraction"]) for frame in previous["frames"]]),
                                "limitation": "Different runs and camera trajectories are not calibrated comparisons."}
    if sha256(video) != source_hash:
        raise ValueError("Source video changed during analysis")
    (output / "scan.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    parser.add_argument("--out", type=Path, help="New artifact directory; existing directories are never overwritten")
    parser.add_argument("--compare", type=Path, help="Optional earlier scan.json or decoded-black-pixel-scan.json")
    arguments = parser.parse_args()
    destination = arguments.out or arguments.video.with_name(arguments.video.stem + "-motion-scan")
    report = scan(arguments.video, destination, arguments.compare)
    print(json.dumps({"scan": str(destination / "scan.json"), "summary": report["summary"],
                      "candidates": report["candidates"], "rawCanvas": report.get("rawCanvas")}, indent=2))
