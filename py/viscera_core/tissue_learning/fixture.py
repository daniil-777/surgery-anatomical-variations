"""Small original synthetic software fixture; never independent real anatomy."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image


def build_fixture(root: Path) -> Path:
    root = Path(root)
    root.mkdir(parents=True, exist_ok=False)
    rows = []
    y, x = np.mgrid[:32, :32] / 32
    for condition_index, region in enumerate(("liver", "colonic_mucosa")):
        for split, count in (("train", 4), ("val", 2), ("test", 2)):
            for index in range(count):
                identifier = f"fixture-{region}-{split}-{index}"
                phase = (len(rows) + 1) * .17
                values = np.stack((.48 + .07 * np.sin(2 * np.pi * x + phase),
                    .20 + .08 * y + .02 * condition_index,
                    .19 + .06 * np.cos(2 * np.pi * (x + y) + phase)), -1)
                image = root / f"{identifier}.png"
                Image.fromarray(np.rint(values * 255).astype(np.uint8)).save(image)
                mask = np.full((32, 32), 255, dtype=np.uint8)
                mask[:4, :8] = 0
                mask_path = root / f"{identifier}-mask.png"
                Image.fromarray(mask).save(mask_path)
                rows.append({"id": identifier, "image_path": image.name,
                    "image_sha256": hashlib.sha256(image.read_bytes()).hexdigest(),
                    "mask_path": mask_path.name, "mask_sha256": hashlib.sha256(mask_path.read_bytes()).hexdigest(),
                    "mask_semantics": "valid_tissue_white", "group_id": identifier,
                    "group_level": "synthetic_fixture", "group_provenance": "original deterministic test field",
                    "split": split, "condition": f"synthetic:{region}", "condition_region": region,
                    "species": "synthetic", "dataset_id": "original-software-fixture-v1",
                    "source_asset_id": identifier, "licence_spdx": "MIT",
                    "commercial_eligibility": "allowed", "training_eligible": True, "observed_rgb": True,
                    "evidence": "synthetic RGB engineering fixture, not a real tissue photograph"})
    manifest = root / "records.jsonl"
    manifest.write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in rows))
    return manifest
