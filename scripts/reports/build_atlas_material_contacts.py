"""Lay out unchanged Studio captures and verify material-review provenance."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--review-dir", type=Path, required=True)
    args = parser.parse_args()
    root: Path = args.review_dir
    manifest = json.loads((root / "manifest.json").read_text())
    if manifest["status"] != "PASS":
        raise ValueError("A complete successful capture manifest is required")
    font_path = next((path for path in [Path("/System/Library/Fonts/Helvetica.ttc"), Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")] if path.exists()), None)
    font = ImageFont.truetype(str(font_path), 21) if font_path else ImageFont.load_default(size=21)
    small = ImageFont.truetype(str(font_path), 15) if font_path else ImageFont.load_default(size=15)
    rows: dict[str, list[dict]] = {}
    for record in manifest["records"]:
        if hashlib.sha256((root / record["image"]).read_bytes()).hexdigest() != record["image_sha256"]:
            raise ValueError(f"Modified capture: {record['image']}")
        if record["group"] == "preset_grid":
            rows.setdefault(record["organ"], []).append(record)
    if len(rows) != 12 or any(len(records) != 4 for records in rows.values()):
        raise ValueError("Expected twelve organ families and four presets each")
    sheet = Image.new("RGB", (1680, 112 + len(rows) * 420), "#e9efec")
    draw = ImageDraw.Draw(sheet)
    draw.text((22, 18), "VISCERA · organ-specific material presets", font=font, fill="#183331")
    draw.text((22, 50), "Actual Studio fragment shader · same geometry, appearance seed 42 and camera within each row · authored appearance", font=small, fill="#43645f")
    metrics = []
    for row, (organ, records) in enumerate(rows.items()):
        if len({record["geometry_sha256"] for record in records}) != 1 or len({record["scene_payload_normal_sha256"] for record in records}) != 1:
            raise ValueError(f"Geometry or source normals changed across {organ} presets")
        y = 100 + row * 420
        draw.text((22, y), organ.replace("-", " ").title(), font=font, fill="#183331")
        arrays = []
        for column, record in enumerate(records):
            image = Image.open(root / record["image"]).convert("RGB")
            arrays.append(np.asarray(image, dtype=float))
            sheet.paste(image.resize((386, 386), Image.Resampling.LANCZOS), (22 + column * 416, y + 28))
            draw.text((30 + column * 416, y + 37), record["label"], font=small, fill="white")
        differences = [float(np.mean(np.abs(arrays[0] - other))) for other in arrays[1:]]
        if min(differences) <= 0.05:
            raise ValueError(f"Preset captures do not differ visibly: {organ}")
        metrics.append({"organ": organ, "reference_preset": "balanced", "mae_rgb_8bit_other_presets": differences, "unique_image_hashes": len({record["image_sha256"] for record in records})})
    sheet.save(root / "all-12-organs-4-presets.png")
    for organ in ["liver", "pancreas"]:
        records = [record for record in manifest["records"] if record["organ"] == organ and record["group"] == "detail_and_seed"]
        if len(records) != 4:
            raise ValueError(f"Incomplete detail inspection: {organ}")
        sheet = Image.new("RGB", (2080, 2150), "#e9efec")
        draw = ImageDraw.Draw(sheet)
        draw.text((24, 12), f"{organ.title()} · fine-detail and independent-seed inspection", font=font, fill="#183331")
        for index, record in enumerate(records):
            x, y = 16 + index % 2 * 1032, 70 + index // 2 * 1040
            sheet.paste(Image.open(root / record["image"]), (x, y))
            draw.text((x + 10, y + 10), record["label"], font=font, fill="white")
        sheet.save(root / f"{organ}-detail-and-seed.png")
    (root / "visual-checks.json").write_text(json.dumps({"status": "PASS", "verified_png_hashes": len(manifest["records"]), "same_geometry_per_organ": True, "same_normals_per_organ": True, "metrics": metrics}, indent=2) + "\n")


if __name__ == "__main__":
    main()
