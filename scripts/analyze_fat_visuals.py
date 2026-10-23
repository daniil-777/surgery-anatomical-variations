"""Decode actual experiment videos and summarize display-space evidence, not tissue accuracy."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def sheet(files, destination, columns=3):
    width, height = 480, 360
    out = Image.new("RGB", (width * columns, (len(files) + columns - 1) // columns * (height + 28)), "#152026")
    draw = ImageDraw.Draw(out)
    for i, file in enumerate(files):
        image = Image.open(file).convert("RGB")
        image.thumbnail((width, height))
        x, y = i % columns * width, i // columns * (height + 28)
        out.paste(image, (x, y))
        draw.text((x + 8, y + height + 5), file.name, fill="white")
    out.save(destination)


def analyze(root):
    observations = json.loads((root / "observations.json").read_text())
    result = {"stage": root.name, "metric_scope": "Display-space diagnostics; no registered real-tissue ground truth or realism score.", "videos": [], "images": []}
    for entry in observations["videos"]:
        video = root / entry["file"]
        probe = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(video)]))
        frames = root / (video.stem + "-decoded")
        frames.mkdir(exist_ok=True)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(video), "-vf", "fps=1", str(frames / "frame-%03d.png")], check=True)
        files = sorted(frames.glob("frame-*.png"))
        sheet(files, root / (video.stem + "-contact.png"))
        # Full-frame changes include UI and camera movement, so no physiological interpretation.
        arrays = [np.asarray(Image.open(f).convert("RGB"), dtype=np.float32) / 255 for f in files]
        delta = [float(np.abs(a - b).mean()) for a, b in zip(arrays, arrays[1:])]
        times = np.array(entry["frameTimesMs"], dtype=np.float64)
        times = times[np.isfinite(times) & (times > 0)]
        result["videos"].append({"file": video.name, "sha256": hashlib.sha256(video.read_bytes()).hexdigest(),
            "duration_seconds": float(probe["format"]["duration"]), "stream": {k: probe["streams"][0].get(k) for k in ["codec_name", "width", "height", "avg_frame_rate"]},
            "decoded_frames_1fps": len(files), "adjacent_frame_mean_absolute_rgb_change": delta,
            "raf_interval_ms_median": float(np.median(times)), "raf_interval_ms_p95": float(np.percentile(times, 95)),
            "raf_intervals_over_50ms": int((times > 50).sum()), "raf_samples": int(len(times))})
    for case in observations["cases"]:
        file = root / (case["name"] + ".png")
        a = np.asarray(Image.open(file).convert("RGB"))
        # Only the viewport body below title; excludes side-panel controls. Explicit heuristic mask.
        a = a[250:860, 70:1000]
        tissue = (a[..., 0] > 100) & (a[..., 1] > 75) & (a[..., 0] > a[..., 2] * 1.12)
        values = a[tissue].astype(np.float64)
        result["images"].append({"file": file.name, "sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
            "heuristic_tissue_pixels": len(values), "display_mean_rgb": values.mean(0).tolist() if len(values) else None,
            "white_clipped_fraction": float(np.all(values >= 250, axis=1).mean()) if len(values) else None})
    selected = [root / (c["name"] + ".png") for c in observations["cases"] if c["name"].endswith("front")]
    if selected:
        sheet(selected, root / "seed-contact.png")
    ablations = sorted(root.glob("ablation-*.png"))
    if ablations:
        sheet(ablations, root / "ablation-contact.png", 2)
    (root / "analysis.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"stage": root.name, "images": len(result["images"]), "videos": len(result["videos"])}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    analyze(parser.parse_args().directory)
