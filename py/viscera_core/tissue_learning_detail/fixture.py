"""Original 128px software fixtures only; never real tissue training evidence."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image


def build_fixture(root):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=False)
    rows = []
    y, x = np.mgrid[:128, :128] / 128
    for condition, region in enumerate(("liver", "colonic_mucosa")):
        for split, count in (("train", 3), ("val", 1), ("test", 1)):
            for index in range(count):
                name = f"native-fixture-{region}-{split}-{index}"
                phase = (len(rows) + 1) * .19
                rgb = np.stack((.48 + .05 * np.sin(2 * np.pi * (3 * x + y) + phase),
                    .2 + .04 * np.cos(2 * np.pi * (x + 4 * y) + phase), .18 + .04 * x + .02 * condition), -1)
                image, mask_file = root / (name + ".png"), root / (name + "-valid.png")
                Image.fromarray(np.rint(rgb * 255).astype(np.uint8)).save(image)
                mask = np.full((128, 128), 255, dtype=np.uint8)
                mask[:16, :32] = 0
                Image.fromarray(mask).save(mask_file)
                rows.append({"id": name, "image_path": image.name, "mask_path": mask_file.name,
                    "image_sha256": hashlib.sha256(image.read_bytes()).hexdigest(),
                    "mask_sha256": hashlib.sha256(mask_file.read_bytes()).hexdigest(),
                    "mask_semantics": "valid_tissue_white", "group_id": name, "group_level": "synthetic_fixture",
                    "group_provenance": "original deterministic native128 engineering fixture",
                    "split": split, "condition": f"synthetic:{region}", "condition_region": region,
                    "species": "synthetic", "dataset_id": "original-native-software-fixture-v1",
                    "source_asset_id": name, "licence_spdx": "MIT", "commercial_eligibility": "allowed",
                    "training_eligible": True, "observed_rgb": True})
    manifest = root / "records.jsonl"
    manifest.write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in rows))
    return manifest
