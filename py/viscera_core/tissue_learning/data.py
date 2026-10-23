"""Manifest-indexed image streaming with explicit group and content split checks."""

from __future__ import annotations

import hashlib
import io
import json
import re
from pathlib import Path, PurePosixPath

import numpy as np
from PIL import Image

from .config import identity


class InsufficientCoverageError(ValueError):
    def __init__(self, sample_id: str, best_valid_fraction: float):
        super().__init__(f"insufficient valid tissue coverage after bounded crops: {sample_id}")
        self.sample_id, self.best_valid_fraction = sample_id, best_valid_fraction


def relative_file(root: Path, name: object) -> Path:
    if (not isinstance(name, str) or not name or "\\" in name or ":" in name or "\x00" in name
            or PurePosixPath(name).is_absolute()
            or any(p in ("", ".", "..") for p in name.split("/"))):
        raise ValueError("unsafe data path")
    path = root
    for part in name.split("/"):
        path = path / part
        if path.is_symlink():
            raise ValueError("dataset symlinks are forbidden")
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("dataset path escapes root")
    return path


def read_blob(root: Path, row: dict, prefix: str) -> bytes:
    path = relative_file(root, row[f"{prefix}_path"])
    offset, length = row.get(f"{prefix}_offset"), row.get(f"{prefix}_length")
    if offset is None and length is None:
        offset, length = 0, path.stat().st_size
    if type(offset) is not int or type(length) is not int or offset < 0 or not 0 < length <= 64_000_000:
        raise ValueError("invalid bounded image/shard slice")
    if offset + length > path.stat().st_size:
        raise ValueError("image/shard slice exceeds file")
    with path.open("rb") as handle:
        handle.seek(offset)
        raw = handle.read(length)
    if len(raw) != length or hashlib.sha256(raw).hexdigest() != row[f"{prefix}_sha256"]:
        raise ValueError(f"{prefix} SHA256 mismatch: {row['id']}")
    return raw


class TissueDataset:
    """Image payloads are opened on demand; only JSONL metadata is held in memory.

    Indexed uncompressed TAR member slices are supported without extracting shards.
    Test metadata establishes split isolation; test image bytes remain unopened until
    an explicit frozen-checkpoint evaluation calls load() for those indices.
    """

    def __init__(self, manifest: Path, root: Path, *, commercial_only: bool = True,
                 allow_training_only: bool = False):
        self.manifest, self.root = Path(manifest), Path(root).resolve()
        raw = self.manifest.read_bytes()
        self.digest = hashlib.sha256(raw).hexdigest()
        self.records = [json.loads(line) for line in raw.splitlines() if line.strip()]
        if not self.records:
            raise ValueError("empty training manifest")
        identifiers, groups, contents = set(), {}, {}
        self.splits = {name: [] for name in ("train", "val", "test")}
        for index, row in enumerate(self.records):
            if not isinstance(row, dict):
                raise ValueError("dataset row must be an object")
            for key in ("id", "group_id", "group_level", "group_provenance", "condition",
                        "dataset_id", "source_asset_id", "licence_spdx"):
                if not isinstance(row.get(key), str) or not row[key]:
                    raise ValueError(f"missing dataset field {key}")
            if row["id"] in identifiers or row.get("split") not in self.splits:
                raise ValueError("duplicate sample ID or invalid split")
            identifiers.add(row["id"])
            if row.get("training_eligible") is not True or row.get("observed_rgb") is not True:
                raise ValueError("only explicitly eligible observed-RGB records are accepted")
            if commercial_only and row.get("commercial_eligibility") != "allowed":
                raise ValueError("commercial eligibility is not explicitly allowed")
            split = row["split"]
            if groups.setdefault(row["group_id"], split) != split:
                raise ValueError("group leakage across splits")
            for prefix in ("image", "mask"):
                if prefix == "mask" and not row.get("mask_path"):
                    continue
                relative_file(self.root, row.get(f"{prefix}_path"))
                digest = row.get(f"{prefix}_sha256")
                if not isinstance(digest, str) or not re.fullmatch("[0-9a-f]{64}", digest):
                    raise ValueError(f"invalid {prefix} SHA256")
            if row.get("mask_path") and row.get("mask_semantics") != "valid_tissue_white":
                raise ValueError("mask semantics must explicitly be valid_tissue_white")
            ancestry = [row["image_sha256"]]
            if row.get("derivation_parent_sha256"):
                ancestry.append(row["derivation_parent_sha256"])
            ancestry.extend(row.get("ancestor_sha256", []))
            for digest in ancestry:
                if not isinstance(digest, str) or not re.fullmatch("[0-9a-f]{64}", digest):
                    raise ValueError("invalid content ancestry hash")
                if contents.setdefault(digest, split) != split:
                    raise ValueError("content/derivation leakage across splits")
            self.splits[split].append(index)
        if not self.splits["train"] or (not self.splits["val"] and not allow_training_only):
            raise ValueError("independent train and validation groups are required")
        self.conditions = sorted({self.records[i]["condition"] for i in self.splits["train"]})
        if len(self.conditions) > 64:
            raise ValueError("at most 64 explicit conditions are supported")
        if any(row["condition"] not in self.conditions for row in self.records):
            raise ValueError("held-out condition absent from training support")
        self.condition_regions, self.condition_species = [], []
        for condition in self.conditions:
            rows = [row for row in self.records if row["condition"] == condition]
            for key, default, destination in (("condition_region", "unsupported", self.condition_regions),
                                               ("species", "unknown", self.condition_species)):
                values = {row.get(key, default) for row in rows}
                if len(values) != 1 or not all(isinstance(x, str) and x for x in values):
                    raise ValueError(f"inconsistent {key} mapping for condition")
                destination.append(next(iter(values)))
        self.split_digest = identity([{key: row.get(key) for key in
            ("id", "split", "group_id", "group_level", "group_provenance", "image_sha256",
             "derivation_parent_sha256", "ancestor_sha256")} for row in self.records])

    def summary(self) -> dict:
        return {"manifest_sha256": self.digest, "split_sha256": self.split_digest,
                "conditions": self.conditions,
                "splits": {name: {"samples": len(ids), "groups": len({
                    self.records[i]["group_id"] for i in ids})} for name, ids in self.splits.items()},
                "group_levels": sorted({row["group_level"] for row in self.records}),
                "provided_mask_samples": sum(bool(row.get("mask_path")) for row in self.records),
                "per_condition": {condition: {split: {
                    "samples": sum(self.records[i]["condition"] == condition for i in ids),
                    "groups": len({self.records[i]["group_id"] for i in ids
                                   if self.records[i]["condition"] == condition})}
                    for split, ids in self.splits.items()} for condition in self.conditions},
                "patient_disjoint_claim": all(row["group_level"] == "patient" for row in self.records)}

    def evaluation_indices(self, split: str, limit: int) -> list[int]:
        # Round-robin condition/group buckets avoid a filename-ordered validation
        # cap silently containing only the first organ or first long sequence.
        buckets: dict[tuple[str, str], list[int]] = {}
        for index in self.splits[split]:
            row = self.records[index]
            buckets.setdefault((row["condition"], row["group_id"]), []).append(index)
        ordered = [buckets[key] for key in sorted(buckets)]
        result = []
        for offset in range(max(map(len, ordered), default=0)):
            for bucket in ordered:
                if offset < len(bucket):
                    result.append(bucket[offset])
                    if len(result) == limit:
                        return result
        return result

    def load(self, index: int, patch_size: int, *, crop_seed: int | None = None,
             minimum_valid_fraction: float = .15) -> tuple[np.ndarray, np.ndarray, int]:
        row = self.records[index]
        with Image.open(io.BytesIO(read_blob(self.root, row, "image"))) as image:
            if image.mode != "RGB":
                raise ValueError("image must be RGB; do not silently invent channels")
            if image.width * image.height > 50_000_000:
                raise ValueError("image exceeds bounded decode size")
            image.load()
            width, height = image.size
            if row.get("mask_path"):
                with Image.open(io.BytesIO(read_blob(self.root, row, "mask"))) as supplied:
                    if supplied.mode not in ("L", "1") or supplied.size != image.size:
                        raise ValueError("mask must be one-channel with matching image dimensions")
                    mask = supplied.convert("L")
            else:
                mask = Image.new("L", image.size, 255)
            edge = min(width, height)
            boxes = []
            if crop_seed is None:
                boxes.append(((width - edge) // 2, (height - edge) // 2))
            else:
                rng = np.random.default_rng(crop_seed)
                boxes.extend((int(rng.integers(width - edge + 1)), int(rng.integers(height - edge + 1)))
                             for _ in range(8))
            # Deterministic mask-centered fallback prevents a valid small ROI
            # from disappearing merely because a random square missed it.
            bounds = mask.point(lambda value: 255 if value >= 128 else 0).getbbox()
            if bounds:
                center_x, center_y = (bounds[0] + bounds[2]) // 2, (bounds[1] + bounds[3]) // 2
                boxes.append((max(0, min(width - edge, center_x - edge // 2)),
                              max(0, min(height - edge, center_y - edge // 2))))
            boxes.append(((width - edge) // 2, (height - edge) // 2))
            best_valid_fraction = 0.
            for left, top in boxes:
                box = (left, top, left + edge, top + edge)
                rgb = np.asarray(image.crop(box).resize((patch_size, patch_size),
                                 Image.Resampling.BICUBIC), dtype=np.float32) / 255
                valid = np.asarray(mask.crop(box).resize((patch_size, patch_size),
                                   Image.Resampling.NEAREST)) >= 128
                # Conservative heuristic, not a replacement for reviewed masks.
                valid &= ~((rgb.min(axis=2) > .90) & (rgb.max(axis=2) > .98))
                valid &= rgb.max(axis=2) >= .03
                coverage = float(valid.mean())
                best_valid_fraction = max(best_valid_fraction, coverage)
                if coverage >= minimum_valid_fraction:
                    return (rgb.transpose(2, 0, 1).copy(), valid[None].astype(np.float32),
                            self.conditions.index(row["condition"]))
        raise InsufficientCoverageError(row["id"], best_valid_fraction)
