"""Frozen train-only normalization and unpaired prior-statistic targets."""

from dataclasses import asdict

import numpy as np
import torch

from viscera_core.tissue_learning.config import identity

from .losses import native_statistics


def build_reference(dataset, objective, minimum_valid_fraction):
    indices = dataset.evaluation_indices("train", objective.reference_limit)
    grouped = {i: [] for i in range(len(dataset.conditions))}
    rows = []
    for index in indices:
        row = dataset.records[index]
        if row["split"] != "train":
            raise ValueError("calibration may never read validation/test payloads")
        rgb, mask, ci = dataset.load(index, 128, minimum_valid_fraction=minimum_valid_fraction)
        x, m = torch.from_numpy(rgb[None]), torch.from_numpy(mask[None])
        with torch.no_grad():
            stats = native_statistics(x, m, objective.kernels)
        neighbor_numerator, neighbor_count = np.zeros(3), 0
        for axis in (-2, -1):
            a, b = [slice(None)] * 3, [slice(None)] * 3
            a[axis], b[axis] = slice(1, None), slice(None, -1)
            a, b = tuple(a), tuple(b)
            valid = mask[a] * mask[b]
            neighbor_numerator += (np.abs(rgb[a] - rgb[b]) * valid).sum((1, 2))
            neighbor_count += valid.sum()
        grouped[ci].append(
            {
                "neighbor": neighbor_numerator / max(neighbor_count, 1),
                "palette": torch.cat((stats["mean"], stats["std"], stats["tails"]), 1)[0].numpy(),
                "frequency": stats["frequency"][0].numpy(),
                "support": stats["support"][0].numpy(),
            }
        )
        rows.append(
            {
                "id": row["id"],
                "split": row["split"],
                "group_id": row["group_id"],
                "condition": row["condition"],
                "image_sha256": row["image_sha256"],
                "mask_sha256": row["mask_sha256"],
            }
        )
    result = {
        "schema": "viscera.tissue-refine-train-reference/v1",
        "manifest_sha256": dataset.digest,
        "conditions": dataset.conditions,
        "selection": "fixed condition/group round-robin train rows; no augmentation",
        "objective_sha256": identity(asdict(objective)),
        "rows": rows,
        "neighbor_scale": [],
        "frequency_rms": [],
        "palette_lower": [],
        "palette_upper": [],
        "valid_windows_per_scale": [],
    }
    for ci in grouped:
        samples = grouped[ci]
        if not samples:
            raise ValueError("calibration lacks a training condition")
        palette = np.stack([s["palette"] for s in samples])
        # Bounds accommodate source variation; this is not paired prior supervision.
        lower, upper = np.quantile(palette, 0.05, axis=0), np.quantile(palette, 0.95, axis=0)
        lower[:6] = np.maximum(lower[:6] - 0.02, 0)
        upper[:6] = np.minimum(upper[:6] + 0.02, 1)
        lower[6:] = 0
        upper[6:] = np.minimum(upper[6:] + 0.02, 1)
        frequency, windows = [], []
        for scale in range(len(objective.kernels)):
            valid = [s for s in samples if s["support"][scale] > 0]
            if not valid:
                raise ValueError("calibration condition lacks a fully valid detail neighborhood")
            frequency.append(np.mean([s["frequency"][scale] for s in valid], axis=0).tolist())
            windows.append(int(sum(s["support"][scale] for s in valid)))
        result["neighbor_scale"].append(
            np.maximum(
                np.mean([s["neighbor"] for s in samples], axis=0), objective.scale_floor
            ).tolist()
        )
        result["frequency_rms"].append(frequency)
        result["palette_lower"].append(lower.tolist())
        result["palette_upper"].append(upper.tolist())
        result["valid_windows_per_scale"].append(windows)
    result["sha256"] = identity(result)
    return result
