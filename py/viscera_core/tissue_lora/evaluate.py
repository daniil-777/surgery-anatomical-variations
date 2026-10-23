"""Held-out distribution statistics for learned tiles. Numbers, not a realism certificate.

Features come from a pinned DINOv2-small snapshot. Real reference crops are the
validation split (surgery-disjoint for DSAD). Generated tiles and references
are compared at a common 224-px window scale after random native crops.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image

from .captions import FAMILY_PHRASES
from .data import CropDataset, sha256_bytes, sha256_file
from .model import pick_device

WINDOW = 224


def verify_extractor(snapshot: Path) -> dict:
    snapshot = Path(snapshot)
    lock = json.loads((snapshot / "dinov2-lock.json").read_text())
    if lock.get("repository") != "facebook/dinov2-small":
        raise ValueError("unexpected feature extractor")
    for item in lock["files"]:
        file = snapshot / item["path"]
        if "/" in item["path"] or file.is_symlink() or file.stat().st_size != item["bytes"]:
            raise ValueError(f"extractor file differs: {item['path']}")
    return {"repository": lock["repository"], "revision": lock["revision"],
            "lock_sha256": sha256_file(snapshot / "dinov2-lock.json")}


class Extractor:
    def __init__(self, snapshot: Path, device: str):
        import torch
        from transformers import AutoModel

        self.device = device
        self.model = AutoModel.from_pretrained(str(snapshot), torch_dtype=torch.float32).to(device).eval()
        self.mean = np.array([0.485, 0.456, 0.406], np.float32)
        self.std = np.array([0.229, 0.224, 0.225], np.float32)

    def __call__(self, windows: np.ndarray, batch: int = 32) -> np.ndarray:
        import torch

        outputs = []
        for start in range(0, len(windows), batch):
            chunk = (windows[start:start + batch].astype(np.float32) / 255 - self.mean) / self.std
            tensor = torch.from_numpy(chunk).permute(0, 3, 1, 2).to(self.device)
            with torch.no_grad():
                hidden = self.model(pixel_values=tensor).last_hidden_state
            features = torch.cat((hidden[:, 0], hidden[:, 1:].mean(dim=1)), dim=1)
            outputs.append(features.float().cpu().numpy())
        return np.concatenate(outputs)


def random_windows(rgb: np.ndarray, rng: np.random.Generator, count: int, window: int = WINDOW) -> list[np.ndarray]:
    """Native-scale windows; tiles smaller than the window are rejected (no upsampling)."""
    height, width = rgb.shape[:2]
    if min(height, width) < window:
        return []
    out = []
    for _ in range(count):
        y, x = int(rng.integers(0, height - window + 1)), int(rng.integers(0, width - window + 1))
        out.append(rgb[y:y + window, x:x + window])
    return out


def frechet_distance(a: np.ndarray, b: np.ndarray) -> float:
    from scipy import linalg

    mu_a, mu_b = a.mean(0), b.mean(0)
    cov_a, cov_b = np.cov(a, rowvar=False), np.cov(b, rowvar=False)
    covmean, _ = linalg.sqrtm(cov_a @ cov_b, disp=False)
    if not np.isfinite(covmean).all():
        offset = np.eye(cov_a.shape[0]) * 1e-6
        covmean = linalg.sqrtm((cov_a + offset) @ (cov_b + offset))
    covmean = covmean.real
    return float(np.sum((mu_a - mu_b) ** 2) + np.trace(cov_a) + np.trace(cov_b) - 2 * np.trace(covmean))


def kernel_inception_distance(a: np.ndarray, b: np.ndarray, subsets: int = 50, subset_size: int = 200,
                              seed: int = 0) -> tuple[float, float]:
    """Unbiased polynomial-kernel MMD², averaged over random subsets (mean, std)."""
    rng = np.random.default_rng(seed)
    d = a.shape[1]
    size = min(subset_size, len(a), len(b))
    values = []
    for _ in range(subsets):
        x = a[rng.choice(len(a), size, replace=False)]
        y = b[rng.choice(len(b), size, replace=False)]
        kxx = (x @ x.T / d + 1) ** 3
        kyy = (y @ y.T / d + 1) ** 3
        kxy = (x @ y.T / d + 1) ** 3
        m = size
        values.append((kxx.sum() - np.trace(kxx)) / (m * (m - 1)) + (kyy.sum() - np.trace(kyy)) / (m * (m - 1))
                      - 2 * kxy.mean())
    return float(np.mean(values)), float(np.std(values))


def cosine_matrix(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a = a / np.maximum(np.linalg.norm(a, axis=1, keepdims=True), 1e-8)
    b = b / np.maximum(np.linalg.norm(b, axis=1, keepdims=True), 1e-8)
    return a @ b.T


def train_probe(features: np.ndarray, labels: np.ndarray, classes: int, *, epochs: int = 300, seed: int = 0):
    """Multinomial logistic regression on standardized features (torch, deterministic)."""
    import torch

    torch.manual_seed(seed)
    mean, std = features.mean(0), features.std(0) + 1e-6
    x = torch.from_numpy((features - mean) / std).float()
    y = torch.from_numpy(labels).long()
    weight = torch.zeros(features.shape[1], classes, requires_grad=True)
    bias = torch.zeros(classes, requires_grad=True)
    optimizer = torch.optim.Adam([weight, bias], lr=0.05, weight_decay=1e-3)
    for _ in range(epochs):
        optimizer.zero_grad()
        loss = torch.nn.functional.cross_entropy(x @ weight + bias, y)
        loss.backward()
        optimizer.step()
    return {"mean": mean, "std": std, "weight": weight.detach().numpy(), "bias": bias.detach().numpy()}


def apply_probe(probe: dict, features: np.ndarray) -> np.ndarray:
    logits = ((features - probe["mean"]) / probe["std"]) @ probe["weight"] + probe["bias"]
    return logits.argmax(1)


def reference_indices(dataset: CropDataset, rng: np.random.Generator, max_per_family: int) -> dict[str, list[int]]:
    """Up to max_per_family random crop indices per family (records are sorted by path, so a plain prefix
    would cover only the alphabetically first families)."""
    by_family: dict[str, list[int]] = {}
    for index, row in enumerate(dataset.records):
        by_family.setdefault(row["family"], []).append(index)
    chosen = {}
    for family, indices in sorted(by_family.items()):
        if len(indices) > max_per_family:
            picks = rng.choice(len(indices), size=max_per_family, replace=False)
            indices = [indices[int(i)] for i in sorted(picks)]
        chosen[family] = indices
    return chosen


def _transform_window(window: np.ndarray, transform: str | None) -> np.ndarray:
    if transform is None:
        return window
    if transform == "clean":
        from .postprocess import clean_tile

        return clean_tile(np.ascontiguousarray(window))[0]
    raise ValueError(f"unknown reference transform: {transform}")


def _collect_real(dataset: CropDataset, rng: np.random.Generator, per_crop: int, max_per_family: int,
                  transform: str | None = None) -> tuple[dict, dict]:
    windows: dict[str, list[np.ndarray]] = {}
    for family, indices in reference_indices(dataset, rng, max_per_family).items():
        for index in indices:
            rgb, _, row = dataset.load(index)
            windows.setdefault(row["family"], []).extend(
                _transform_window(w, transform) for w in random_windows(rgb, rng, per_crop))
    return {k: np.stack(v) for k, v in windows.items() if v}, {k: len(v) for k, v in windows.items()}


def _collect_tiles(samples: Path, rng: np.random.Generator, per_tile: int, tile_name: str = "tile.png") -> tuple[dict, dict]:
    windows: dict[str, list[np.ndarray]] = {}
    tiles: dict[str, list[Path]] = {}
    for receipt in sorted(Path(samples).glob("*/sample.json")):
        data = json.loads(receipt.read_text())
        family = data["family"]
        source = receipt.parent / ("native.png" if data.get("hires") and tile_name == "tile.png" else tile_name)
        if not source.is_file():
            raise FileNotFoundError(f"hires tile without its native image: {receipt.parent}")
        with Image.open(source) as image:
            rgb = np.asarray(image.convert("RGB"))
        windows.setdefault(family, []).extend(random_windows(rgb, rng, per_tile))
        tiles.setdefault(family, []).append(receipt.parent)
    return {k: np.stack(v) for k, v in windows.items() if v}, {k: len(v) for k, v in tiles.items()}


def _collect_baseline(directory: Path, rng: np.random.Generator, per_image: int) -> dict[str, np.ndarray]:
    """Baseline PNGs named `<family>-<anything>.png` are compared with their own family's references."""
    windows: dict[str, list[np.ndarray]] = {}
    for path in sorted(Path(directory).glob("*.png")):
        family = next((f for f in sorted(FAMILY_PHRASES, key=len, reverse=True) if path.name.startswith(f)), None)
        if family is None:
            continue
        with Image.open(path) as image:
            windows.setdefault(family, []).extend(random_windows(np.asarray(image.convert("RGB")), rng, per_image))
    return {k: np.stack(v) for k, v in windows.items() if v}


def _reference_features(train_set: CropDataset, val_set: CropDataset, model, rng: np.random.Generator, *,
                        per_crop: int, max_real_per_family: int, cache: Path | None, cache_key: dict,
                        transform: str | None = None) -> tuple[dict, dict, dict, dict]:
    """Real-crop features (train/val windows + one centre window per training crop), optionally cached on disk.

    The cache file is keyed by the crop release, the extractor lock and the sampling policy; any change misses.
    """
    key = sha256_bytes(json.dumps(cache_key, sort_keys=True).encode())[:24]
    path = Path(cache) / f"reference-{key}.npz" if cache else None
    if path is not None and path.is_file():
        stored = np.load(path, allow_pickle=False)
        meta = json.loads(str(stored["meta"]))
        unpack = lambda prefix: {k[len(prefix):]: stored[k] for k in stored.files if k.startswith(prefix)}  # noqa: E731
        # Restore the RNG state a fresh computation would leave, so generated-tile windows match uncached runs.
        rng.bit_generator.state = meta["rng_state"]
        return unpack("train:"), unpack("val:"), unpack("memory:"), {"train": meta["train_counts"], "val": meta["val_counts"], "cache": str(path), "hit": True}
    real_train, train_counts = _collect_real(train_set, rng, per_crop, max_real_per_family, transform)
    real_val, val_counts = _collect_real(val_set, rng, per_crop, max_real_per_family, transform)
    train_f = {k: model(v) for k, v in real_train.items()}
    val_f = {k: model(v) for k, v in real_val.items()}
    memory: dict[str, list[np.ndarray]] = {}
    for index, row in enumerate(train_set.records):
        rgb, _, _ = train_set.load(index)
        if min(rgb.shape[:2]) >= WINDOW:
            y, x = (rgb.shape[0] - WINDOW) // 2, (rgb.shape[1] - WINDOW) // 2
            memory.setdefault(row["family"], []).append(rgb[y:y + WINDOW, x:x + WINDOW])
    memory_f = {k: model(np.stack(v)) for k, v in memory.items() if v}
    if path is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        meta = {"train_counts": train_counts, "val_counts": val_counts, "rng_state": rng.bit_generator.state, "key": cache_key}
        arrays = {**{f"train:{k}": v for k, v in train_f.items()}, **{f"val:{k}": v for k, v in val_f.items()},
                  **{f"memory:{k}": v for k, v in memory_f.items()}}
        tmp = path.with_suffix(".tmp.npz")
        np.savez(tmp, meta=np.array(json.dumps(meta)), **arrays)
        tmp.replace(path)
    return train_f, val_f, memory_f, {"train": train_counts, "val": val_counts, "cache": str(path) if path else None, "hit": False}


def evaluate(dataset_root: Path, samples: Path, output: Path, *, extractor: Path, device: str | None = None,
             baselines: list[str] | None = None, per_crop: int = 2, per_tile: int = 6, max_real_per_family: int = 400,
             seed: int = 0, cache: Path | None = None, tile_name: str = "tile.png",
             reference_transform: str | None = None) -> dict:
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    started = time.time()
    device = pick_device(device)
    lock = verify_extractor(extractor)
    rng = np.random.default_rng(seed)
    train_set = CropDataset(dataset_root, split="train")
    val_set = CropDataset(dataset_root, split="val")
    model = Extractor(extractor, device)
    cache_key = {"release": val_set.release_sha256, "extractor": lock["lock_sha256"], "window": WINDOW, "per_crop": per_crop,
                 "max_real_per_family": max_real_per_family, "seed": seed, "version": 1}
    if reference_transform:
        from .postprocess import POLICY as CLEAN_POLICY

        cache_key = {**cache_key, "reference_transform": reference_transform, "clean_policy": CLEAN_POLICY["version"]}
    train_f, val_f, memory_features, counts = _reference_features(
        train_set, val_set, model, rng, per_crop=per_crop, max_real_per_family=max_real_per_family, cache=cache,
        cache_key=cache_key, transform=reference_transform)
    train_counts, val_counts = counts["train"], counts["val"]
    generated, tile_counts = _collect_tiles(samples, rng, per_tile, tile_name)
    features = {"train": train_f, "val": val_f, "generated": {k: model(v) for k, v in generated.items()}}
    families = sorted(features["train"])
    index = {family: i for i, family in enumerate(families)}
    probe_x = np.concatenate([features["train"][f] for f in families])
    probe_y = np.concatenate([np.full(len(features["train"][f]), index[f]) for f in families])
    probe = train_probe(probe_x, probe_y, len(families))
    per_family = {}
    for family in families:
        row = {"val_windows": int(len(features["val"].get(family, []))), "generated_windows": int(len(features["generated"].get(family, []))),
               "generated_tiles": tile_counts.get(family, 0)}
        if family in features["val"] and len(features["val"][family]) >= 8:
            v = features["val"][family]
            t = features["train"][family]
            row["floor_fid_train_vs_val"] = frechet_distance(t, v)
            row["floor_kid_train_vs_val"] = kernel_inception_distance(t, v)[0]
            row["val_probe_accuracy"] = float((apply_probe(probe, v) == index[family]).mean())
            reference = memory_features.get(family, t)
            sims = cosine_matrix(v, reference).max(1)
            row["val_nearest_train_cosine"] = {"median": float(np.median(sims)), "p95": float(np.percentile(sims, 95)),
                                               "reference_crops": int(len(reference))}
            if family in features["generated"] and len(features["generated"][family]) >= 8:
                g = features["generated"][family]
                row["fid_generated_vs_val"] = frechet_distance(g, v)
                # FID is biased upward at small n: the floor is re-estimated with a train subsample of the same size.
                floors = []
                for repeat in range(5):
                    picks = np.random.default_rng(seed + repeat).choice(len(t), size=min(len(g), len(t)), replace=False)
                    floors.append(frechet_distance(t[picks], v))
                row["floor_fid_matched_n"] = {"mean": float(np.mean(floors)), "std": float(np.std(floors)), "n": int(len(g))}
                kid = kernel_inception_distance(g, v)
                row["kid_generated_vs_val"] = {"mean": kid[0], "std": kid[1]}
                row["generated_probe_as_family"] = float((apply_probe(probe, g) == index[family]).mean())
                gsims = cosine_matrix(g, reference).max(1)
                row["generated_nearest_train_cosine"] = {"median": float(np.median(gsims)), "p95": float(np.percentile(gsims, 95)),
                                                         "max": float(gsims.max())}
                within = cosine_matrix(g, g)
                np.fill_diagonal(within, np.nan)
                vwithin = cosine_matrix(v, v)
                np.fill_diagonal(vwithin, np.nan)
                row["diversity_mean_cosine_distance"] = {"generated": float(1 - np.nanmean(within)),
                                                         "val": float(1 - np.nanmean(vwithin))}
        per_family[family] = row
    baseline_rows = {}
    for item in baselines or []:
        label, _, directory = item.partition("=")
        baseline_rows[label] = {}
        for family, windows in _collect_baseline(directory, rng, per_tile).items():
            if family in features["val"] and len(features["val"][family]) >= 8:
                feats = model(windows)
                v = features["val"][family]
                baseline_rows[label][family] = {"kid_vs_val": kernel_inception_distance(feats, v)[0],
                                                "fid_vs_val": frechet_distance(feats, v) if len(feats) >= 8 else None,
                                                "probe_as_family": float((apply_probe(probe, feats) == index[family]).mean()),
                                                "windows": int(len(feats))}
    summary = {}
    for family, row in per_family.items():
        if "fid_generated_vs_val" in row:
            summary[family] = {"fid": round(row["fid_generated_vs_val"], 2), "floor_fid_matched_n": round(row["floor_fid_matched_n"]["mean"], 2),
                               "floor_fid": round(row["floor_fid_train_vs_val"], 2),
                               "kid": round(row["kid_generated_vs_val"]["mean"], 4), "floor_kid": round(row["floor_kid_train_vs_val"], 4),
                               "probe": round(row["generated_probe_as_family"], 3), "val_probe": round(row["val_probe_accuracy"], 3),
                               "nn_cos_p95": round(row["generated_nearest_train_cosine"]["p95"], 3),
                               "val_nn_cos_p95": round(row["val_nearest_train_cosine"]["p95"], 3)}
    report = {"schema": "viscera.tissue-lora-evaluation/v1", "extractor": lock, "window": WINDOW, "per_crop_windows": per_crop,
              "per_tile_windows": per_tile, "families": per_family, "baselines": baseline_rows, "summary": summary,
              "val_counts": val_counts, "train_counts": train_counts, "max_real_per_family": max_real_per_family,
              "reference_cache": {"path": counts["cache"], "hit": counts["hit"]}, "tile_name": tile_name,
              "reference_transform": reference_transform,
              "crop_release_sha256": val_set.release_sha256, "device": device,
              "seconds": round(time.time() - started, 2), "created": datetime.now(timezone.utc).isoformat(),
              "meaning": ["FID/KID against held-out surgeries in DINOv2 feature space; the train-vs-val floor shows the sampling noise of the reference; compare FID with floor_fid_matched_n (same n), KID is unbiased",
                          "probe = fraction of windows a linear organ classifier trained on real crops assigns to the intended family",
                          "nearest-train cosine near the real val distribution means no copying; values near 1.0 would suggest memorization",
                          "none of these numbers certify surgical realism; visual review and clinician assessment remain separate"]}
    (output / "evaluation.json").write_text(json.dumps(report, indent=2) + "\n")
    return report
