"""Verify completed visual witnesses and compose one 64-specimen sheet per template.

This is a presentation/coverage audit. It cannot certify anatomy or mechanics.
Requires Pillow; run after render_atlas_witness.mjs finishes.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for name in (
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        if Path(name).is_file():
            return ImageFont.truetype(name, size)
    return ImageFont.load_default(size=size)


def build(manifest: Path, witness_dir: Path) -> dict:
    source_bytes = manifest.read_bytes()
    manifest_hash = hashlib.sha256(source_bytes).hexdigest()
    cohort = [json.loads(line) for line in source_bytes.decode().splitlines() if line]
    witnesses = [json.loads(line) for line in (witness_dir / "witness.jsonl").read_text().splitlines() if line]
    samples = {sample["sample_id"]: sample for sample in cohort}
    records = {record["sample_id"]: record for record in witnesses}
    if len(samples) != len(cohort) or len(records) != len(witnesses):
        raise ValueError("Duplicate sample or witness identity")
    if samples.keys() != records.keys():
        raise ValueError(f"Visual coverage incomplete: {len(records)} of {len(samples)} records")
    groups: dict[str, list[dict]] = defaultdict(list)
    max_rounding = 0.0
    min_occupancy = 1.0
    for sample_id, sample in samples.items():
        record = records[sample_id]
        if record["source_manifest_sha256"] != manifest_hash:
            raise ValueError(f"Wrong manifest binding: {sample_id}")
        if record["geometry_sha256"] != sample["geometry_sha256"] or record["scene_payload_geometry_sha256"] != sample["geometry_sha256"]:
            raise ValueError(f"Wrong rendered geometry: {sample_id}")
        if record["template_id"] != sample["template_id"]:
            raise ValueError(f"Wrong source reference: {sample_id}")
        for key in ("template_id", "seed", "appearance", "controls"):
            if record["spec"][key] != sample["spec"][key]:
                raise ValueError(f"Wrong realized recipe field {key}: {sample_id}")
        if record["display_normals"]["sha256"] != record["scene_payload_normal_sha256"]:
            raise ValueError(f"Wrong display normals: {sample_id}")
        if [view["pose"] for view in record["views"]] != ["oblique", "back", "top"]:
            raise ValueError(f"Missing camera views: {sample_id}")
        image_path = witness_dir / record["image"]
        if hashlib.sha256(image_path.read_bytes()).hexdigest() != record["image_sha256"]:
            raise ValueError(f"Modified image: {sample_id}")
        for view in record["views"]:
            bounds = view["bounds_bottom_origin"]
            if view["opaque_pixels"] < 40 or min(bounds[:2]) <= 0 or bounds[2] >= view["width"] - 1 or bounds[3] >= view["height"] - 1:
                raise ValueError(f"Empty or clipped view: {sample_id}")
            min_occupancy = min(min_occupancy, view["occupied_fraction"])
        max_rounding = max(max_rounding, record["max_gpu_coordinate_rounding_mm"])
        groups[sample["template_id"]].append(record)

    output = witness_dir / "contacts"
    output.mkdir(exist_ok=True)
    contacts = []
    margin, columns, tile_width, tile_height, header = 32, 4, 600, 232, 112
    for template_id, group in sorted(groups.items()):
        rows = (len(group) + columns - 1) // columns
        width, height = margin * 2 + columns * tile_width, header + rows * tile_height + 55
        sheet = Image.new("RGB", (width, height), "#0c131a")
        draw = ImageDraw.Draw(sheet)
        draw.text((margin, 24), template_id, fill="#e5eeeb", font=font(30))
        draw.text((margin, 69), f"{len(group)} exact dataset specimens  |  Each row of views: oblique / back / top  |  Fixed inspection lighting", fill="#8ea6ad", font=font(19))
        mapping = []
        for index, record in enumerate(group):
            x = margin + index % columns * tile_width
            y = header + index // columns * tile_height
            label = f"{index + 1:02d}   {record['sample_id']}   / {record['split']}"
            draw.text((x + 8, y + 7), label, fill="#afc7c9", font=font(16))
            with Image.open(witness_dir / record["image"]) as source:
                if source.size != (768, 256):
                    raise ValueError(f"Wrong triptych size for {record['sample_id']}")
                sheet.paste(source.convert("RGB").resize((600, 200), Image.Resampling.LANCZOS), (x, y + 30))
            mapping.append({"sample_id": record["sample_id"], "box": [x, y, x + 600, y + 232], "image": record["image"]})
        draw.text((margin, height - 35), "Source-based development previews. Raster coverage does not establish anatomical or mechanical validity.", fill="#788d98", font=font(17))
        filename = output / f"{template_id}.png"
        sheet.save(filename, optimize=True)
        contacts.append({"template_id": template_id, "count": len(group), "image": str(filename.relative_to(witness_dir)), "image_sha256": hashlib.sha256(filename.read_bytes()).hexdigest(), "size": [width, height], "cells": mapping})
        print(json.dumps({"contact": template_id, "specimens": len(group)}), flush=True)
    result = {
        "status": "PASS", "source_manifest_sha256": manifest_hash,
        "objects": len(samples), "views": len(samples) * 3, "templates": len(groups),
        "geometry_payload_hash_matches": len(samples), "verified_image_hashes": len(samples),
        "empty_or_clipped_views": 0, "minimum_occupied_fraction": min_occupancy,
        "maximum_gpu_coordinate_rounding_mm": max_rounding,
        "contacts": contacts,
    }
    (witness_dir / "contacts.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--witness-dir", type=Path, required=True)
    args = parser.parse_args()
    summary = build(args.manifest, args.witness_dir)
    print(json.dumps({key: value for key, value in summary.items() if key != "contacts"}))
