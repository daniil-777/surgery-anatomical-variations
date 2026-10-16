#!/usr/bin/env python3
"""Inventory, deduplicate and inspect videos without claiming material identification.

Requires ffmpeg/ffprobe, NumPy, OpenCV and Pillow. Metrics are pixels at the
declared analysis resolution, not millimetres or calibrated tissue strain.
Use only scoped roots: the inventory is explicit about what was searched.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def probe(path: Path) -> dict:
    output = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path),
    ], timeout=45)
    data = json.loads(output)
    stream = next(s for s in data["streams"] if s["codec_type"] == "video")
    numerator, denominator = map(float, stream.get("avg_frame_rate", "0/1").split("/"))
    return {"duration_s": float(data["format"].get("duration", stream.get("duration", 0))),
            "width": stream["width"], "height": stream["height"],
            "fps": numerator / denominator if denominator else None,
            "codec": stream["codec_name"]}


def frame_at(path: Path, time_s: float, width: int = 640) -> np.ndarray:
    data = subprocess.check_output([
        "ffmpeg", "-v", "error", "-ss", str(time_s), "-i", str(path),
        "-frames:v", "1", "-vf", f"scale={width}:-2", "-f", "image2pipe", "-vcodec", "png", "-",
    ], timeout=45)
    frame = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError(f"No decodable frame at {time_s}")
    return frame


def color_candidate(frame: np.ndarray) -> np.ndarray:
    """Largest pink/red component: a diagnostic heuristic, NOT segmentation GT."""
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    mask = (((hsv[:, :, 0] < 22) | (hsv[:, :, 0] > 165)) &
            (hsv[:, :, 1] > 45) & (hsv[:, :, 2] > 55)).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    if count <= 1:
        return np.zeros(mask.shape, dtype=bool)
    component = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return labels == component


def pair_metrics(before: np.ndarray, after: np.ndarray, dt: float, browser: bool) -> dict:
    if before.shape != after.shape or before.ndim != 3 or before.shape[2] != 3:
        raise ValueError("Aligned BGR frames with equal dimensions are required")
    if not math.isfinite(dt) or dt <= 0:
        raise ValueError("Positive finite elapsed time is required")
    gray0, gray1 = [cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in [before, after]]
    forward = cv2.calcOpticalFlowFarneback(gray0, gray1, None, 0.5, 3, 21, 3, 5, 1.2, 0)
    reverse = cv2.calcOpticalFlowFarneback(gray1, gray0, None, 0.5, 3, 21, 3, 5, 1.2, 0)
    yy, xx = np.mgrid[:gray0.shape[0], :gray0.shape[1]].astype(np.float32)
    mapped_x, mapped_y = xx + forward[:, :, 0], yy + forward[:, :, 1]
    back = cv2.remap(reverse, mapped_x, mapped_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    valid = ((mapped_x >= 0) & (mapped_x <= gray0.shape[1] - 1) &
             (mapped_y >= 0) & (mapped_y <= gray0.shape[0] - 1))
    candidate0, candidate1 = color_candidate(before), color_candidate(after)
    roi = candidate0 if browser else (gray0 > 15)
    roi &= valid
    magnitude = np.linalg.norm(forward, axis=2)
    consistency_error = np.linalg.norm(forward + back, axis=2)
    values = magnitude[roi]
    union = np.count_nonzero(candidate0 | candidate1)
    return {
        "flow_median_px_s": float(np.median(values) / dt) if len(values) >= 64 else None,
        "flow_p95_px_s": float(np.quantile(values, 0.95) / dt) if len(values) >= 64 else None,
        "forward_backward_consistent_fraction": float(np.mean(consistency_error[roi] < 1.5)) if len(values) >= 64 else None,
        "roi_pixels": int(np.count_nonzero(roi)),
        "candidate_color_area_px": int(np.count_nonzero(candidate1)),
        "candidate_color_iou": float(np.count_nonzero(candidate0 & candidate1) / union) if union else None,
        "mean_absolute_image_change_0_255": float(np.mean(np.abs(gray0.astype(float) - gray1))),
    }


def analyze(path: Path, output: Path, sha: str, rate: float) -> dict:
    cached = output / "metrics.json"
    if cached.exists() and (output / "contact-sheet.jpg").exists():
        existing = json.loads(cached.read_text())
        if existing.get("sampling_rate_hz") == rate and existing.get("analysis_version") == 3:
            return {key: value for key, value in existing.items() if key != "samples"}
    metadata = probe(path)
    browser = "external" not in path.parts and ("benchmarks" in path.parts or "test-results" in path.parts or "playground" in path.name)
    output.mkdir(parents=True, exist_ok=True)
    duration = metadata["duration_s"]
    if duration <= 0:
        raise ValueError("Video duration must be positive")
    stamps = np.linspace(0, max(0, duration - 0.15), 12)
    sheet = Image.new("RGB", (1280, 4 * 264 + 55), "#101820")
    draw = ImageDraw.Draw(sheet)
    draw.text((12, 10), f"{sha[:12]}  {path.name}  duration={duration:.2f}s", fill="white")
    draw.text((12, 28), "Uniform temporal samples; not proof of motion between samples", fill="#c2cad0")
    for i, stamp in enumerate(stamps):
        frame = frame_at(path, float(stamp))
        cv2.imwrite(str(output / f"frame-{i:02d}.jpg"), frame)
        tile = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        tile.thumbnail((416, 232))
        x, y = (i % 3) * 426, 55 + (i // 3) * 264
        sheet.paste(tile, (x, y))
        draw.text((x + 5, y + 235), f"t={stamp:.3f} s", fill="white")
    sheet.save(output / "contact-sheet.jpg", quality=93)
    # A deterministic bounded sampling grid; no time warping and no hidden fps assumption.
    times = np.arange(0, max(duration - 0.1, 0.01), 1 / rate)
    samples = []
    previous, previous_time = None, None
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        raise ValueError("OpenCV cannot decode video")
    for stamp in times:
        capture.set(cv2.CAP_PROP_POS_MSEC, float(stamp) * 1000)
        success, native = capture.read()
        if not success:
            continue
        height = 2 * round(native.shape[0] * 480 / native.shape[1] / 2)
        frame = cv2.resize(native, (480, height), interpolation=cv2.INTER_AREA)
        if previous is not None:
            samples.append({"time_s": float(stamp), **pair_metrics(previous, frame, float(stamp - previous_time), browser)})
        previous, previous_time = frame, stamp
    capture.release()
    flow = [s["flow_median_px_s"] for s in samples if s["flow_median_px_s"] is not None]
    summary = {
        "analysis_version": 3,
        "decode_method": "ffmpeg representative frames; OpenCV timestamp seeking for motion samples",
        "metadata": metadata, "analysis_width_px": 480, "sampling_rate_hz": rate,
        "sampled_intervals": len(samples), "valid_flow_intervals": len(flow),
        "median_of_median_flow_px_s": float(np.median(flow)) if flow else None,
        "p95_of_median_flow_px_s": float(np.quantile(flow, 0.95)) if flow else None,
        "low_motion_fraction_at_0_1_px_s": float(np.mean(np.array(flow) < 0.1)) if flow else None,
        "roi_method": "largest red/pink connected component (unvalidated)" if browser else "all non-dark image pixels (includes tools/camera)",
        "contour_method": "unvalidated red/pink connected component; contour IoU is an image diagnostic, not tissue overlap GT",
        "physical_validation": "NOT_RUN",
        "stiffness_pa": None, "calibrated_strain": None,
        "limitations": ["Optical flow combines tissue, camera, tool and illumination motion", "Static tissue, pause and freezes cannot be distinguished without protocol/clock data", "Pixel flow does not establish 3D material strain or stiffness", "Uniform sampled review can miss brief events; raw videos retained"],
        "samples": samples,
    }
    (output / "metrics.json").write_text(json.dumps(summary, indent=2, allow_nan=False) + "\n")
    return {key: value for key, value in summary.items() if key != "samples"}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, action="append", default=[])
    parser.add_argument("--video", type=Path, action="append", default=[])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--sample-hz", type=float, default=2)
    args = parser.parse_args()
    if not math.isfinite(args.sample_hz) or not 0 < args.sample_hz <= 30:
        parser.error("sample-hz must be positive, finite and <=30")
    files = set(args.video)
    for root in args.root:
        files.update(p for p in root.rglob("*") if p.suffix.lower() in {".mp4", ".webm", ".mov", ".avi", ".gif"})
    args.output.mkdir(parents=True, exist_ok=True)
    entries, seen = [], {}
    for path in sorted(files):
        entry = {"path": str(path), "bytes": path.stat().st_size}
        try:
            sha = digest(path)
            entry["sha256"] = sha
            if sha in seen:
                entry["duplicate_of"] = seen[sha]
            else:
                seen[sha] = str(path)
                folder = args.output / sha[:12]
                entry.update(analyze(path, folder, sha, args.sample_hz))
                entry["contact_sheet"] = str(folder / "contact-sheet.jpg")
                entry["visual_review"] = {"status": "PENDING_VISUAL_INSPECTION", "reviewer_type": None}
            print(json.dumps({"path": str(path), "status": "duplicate" if "duplicate_of" in entry else "analyzed", "sha256": sha}), flush=True)
        except Exception as exc:
            entry["error"] = f"{type(exc).__name__}: {exc}"
            print(json.dumps(entry), flush=True)
        entries.append(entry)
        (args.output / "inventory.json").write_text(json.dumps({
            "roots": [str(r) for r in args.root], "explicit_videos": [str(p) for p in args.video],
            "opencv_version": cv2.__version__, "numpy_version": np.__version__,
            "files": entries,
        }, indent=2, allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
