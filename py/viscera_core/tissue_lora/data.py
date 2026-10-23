"""Crop release preparation from lawful sources and the training-time loader.

Sources keep their specimen groups and publisher splits. Crops are taken at
native pixels (no resampling), glints are masked and filled, smooth lighting
is divided out, exposure is normalized to a family median. Everything is
recorded per crop; the release is hash-locked and written last.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import zipfile
from collections.abc import Iterator
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path, PurePosixPath

import numpy as np
from PIL import Image
from scipy import ndimage

from . import SCHEMA_CROPS
from .captions import DSAD_FAMILIES, HYPERKVASIR_CLASSES, RIGHTS_PROFILES, caption, stable_split
from .imaging import (
    CROP_SIZES,
    LUMA,
    candidate_windows,
    dark_fraction,
    exposure_gain,
    flatten_illumination,
    glint_mask,
    inpaint_normalized,
    linear_to_srgb_u8,
    sharpness,
    srgb_to_linear,
)

POLICY = {
    "version": "tissue-crops-v1",
    "sizes": list(CROP_SIZES),
    "min_valid_fraction": 0.92,
    "max_windows_per_frame": 4,
    "glint": "clipped neutral (max>=245, min>=180, spread<=0.35) or luminance>=236, dilated 2 px; excluded then filled",
    "glint_local_contrast": False,
    "fill": "normalized convolution, Gaussian support 2..32 px; filled pixels carry loss weight 0",
    "flatten": "degree-2 polynomial fit of log luminance over valid pixels, gain clipped to [0.5, 2]",
    "exposure": "mean valid linear luminance scaled to the family median, gain clipped to [0.5, 2]",
    "dark_limit": "crops with >3% pixels below luminance 20/255 are dropped (lumen holes, shadows)",
    "resampling": "none; native pixels only",
    "meaning": "illumination-flattened observed RGB, not measured albedo",
}
MAX_IMAGE_PIXELS = 16_000_000


def sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024**2), b""):
            digest.update(block)
    return digest.hexdigest()


def _safe_member(name: str) -> None:
    part = PurePosixPath(name)
    if part.is_absolute() or "\\" in name or any(p in ("", ".", "..") for p in part.parts):
        raise ValueError(f"unsafe member path: {name!r}")


class DsadSource:
    """Reads the prepared DSAD exterior release (viscera.observed-rgb-dataset/v3) in place."""

    dataset_id = "dsad"

    def __init__(self, root: Path, *, splits: tuple[str, ...] = ("train", "val")):
        self.root = Path(root)
        if any(split not in ("train", "val") for split in splits):
            raise ValueError("DSAD test payloads are never opened by crop preparation")
        release_raw = (self.root / "release.json").read_bytes()
        self.release = json.loads(release_raw)
        self.release_sha256 = sha256_bytes(release_raw)
        if self.release.get("schema") != "viscera.observed-rgb-dataset/v3":
            raise ValueError("unsupported DSAD release schema")
        self.shards = {item["path"]: item for item in self.release["shards"]}
        for name, item in self.shards.items():
            _safe_member(name)
            if (self.root / name).stat().st_size != item["bytes"]:
                raise ValueError(f"shard size differs from release: {name}")
        rows = [json.loads(line) for line in (self.root / "records.jsonl").read_bytes().splitlines() if line.strip()]
        self.records = [row for row in rows if row["split"] in splits and row["condition_region"] in DSAD_FAMILIES]
        self.untouched_test = sum(1 for row in rows if row["split"] == "test")

    def _blob(self, row: dict, kind: str) -> bytes:
        name = row[f"{kind}_path"]
        shard = self.shards.get(name)
        if shard is None or shard["split"] != row["split"]:
            raise ValueError("record shard/split mismatch")
        offset, length = row[f"{kind}_offset"], row[f"{kind}_length"]
        if type(offset) is not int or type(length) is not int or offset < 0 or not 0 < length <= 32 * 1024**2:
            raise ValueError("invalid shard slice")
        with (self.root / name).open("rb") as stream:
            stream.seek(offset)
            raw = stream.read(length)
        if len(raw) != length or sha256_bytes(raw) != row[f"{kind}_sha256"]:
            raise ValueError(f"{kind} digest mismatch: {row['id']}")
        return raw

    def items(self) -> list[dict]:
        rights = RIGHTS_PROFILES["dsad"]
        return [{"source_id": row["id"], "dataset_id": "dsad", "family": DSAD_FAMILIES[row["condition_region"]],
                 "condition": None, "group_id": row["group_id"], "group_level": row["group_level"],
                 "split": row["split"], "source_member": row["source_member"],
                 "source_sha256": row["image_sha256"], **rights} for row in self.records]

    def load(self, index: int) -> tuple[np.ndarray, np.ndarray]:
        row = self.records[index]
        with Image.open(io.BytesIO(self._blob(row, "image"))) as image:
            if image.mode != "RGB" or image.width * image.height > MAX_IMAGE_PIXELS:
                raise ValueError("expected bounded native RGB frame")
            rgb = np.asarray(image)
        with Image.open(io.BytesIO(self._blob(row, "mask"))) as mask_image:
            mask = np.asarray(mask_image.convert("L"))
        if mask.shape != rgb.shape[:2]:
            raise ValueError("mask/frame dimensions differ")
        return rgb, mask >= 128


def hyperkvasir_content_mask(rgb: np.ndarray) -> np.ndarray:
    """Non-black endoscope field minus overlays (teal navigation box, text), eroded 12 px."""
    luminance = rgb.astype(np.float32) @ LUMA
    content = luminance > 10
    content = ndimage.binary_opening(content, iterations=6)
    r, g, b = (rgb[..., c].astype(np.int32) for c in range(3))
    teal = (g > r + 40) & (b > r + 40)
    if teal.any():
        content &= ~ndimage.binary_dilation(teal, iterations=15)
    return ndimage.binary_erosion(content, iterations=12)


class HyperKvasirSource:
    """Reads selected HyperKvasir labelled classes (CC BY 4.0) from the original ZIP."""

    dataset_id = "hyperkvasir"

    def __init__(self, archive: Path, *, include_pathology: bool = False, val_fraction: float = 0.1,
                 archive_sha256: str | None = None):
        self.archive = Path(archive)
        # Workers receive the digest the parent computed; they never rehash the 3.9 GB archive.
        self.archive_sha256 = archive_sha256 or sha256_file(self.archive)
        with zipfile.ZipFile(self.archive) as zf:
            names = [info.filename for info in zf.infolist() if not info.is_dir()]
        self.records: list[dict] = []
        for name in sorted(names):
            _safe_member(name)
            lower = name.lower()
            if not lower.endswith((".jpg", ".jpeg", ".png")):
                continue
            parts = PurePosixPath(name).parts
            key = "/".join(parts[-4:-1]) if len(parts) >= 4 else ""
            if key not in HYPERKVASIR_CLASSES:
                continue
            family, condition = HYPERKVASIR_CLASSES[key]
            if condition is not None and not include_pathology:
                continue
            self.records.append({"member": name, "class": key, "family": family, "condition": condition,
                                 "split": stable_split(parts[-1], val_fraction)})

    def items(self) -> list[dict]:
        rights = RIGHTS_PROFILES["hyperkvasir"]
        return [{"source_id": "hyperkvasir-" + PurePosixPath(row["member"]).stem, "dataset_id": "hyperkvasir",
                 "family": row["family"], "condition": row["condition"],
                 "group_id": "hyperkvasir:class:" + row["class"].rsplit("/", 1)[-1], "group_level": "unknown",
                 "split": row["split"], "source_member": row["member"], "source_sha256": None, **rights}
                for row in self.records]

    def load(self, index: int) -> tuple[np.ndarray, np.ndarray]:
        with zipfile.ZipFile(self.archive) as zf:
            raw = zf.read(self.records[index]["member"])
        with Image.open(io.BytesIO(raw)) as image:
            if image.width * image.height > MAX_IMAGE_PIXELS:
                raise ValueError("frame exceeds pixel budget")
            rgb = np.asarray(image.convert("RGB"))
        return rgb, hyperkvasir_content_mask(rgb)


def frame_luminance(rgb: np.ndarray, valid: np.ndarray, policy: dict = POLICY) -> float | None:
    usable = valid & ~glint_mask(rgb, local_contrast=bool(policy.get("glint_local_contrast", False)))
    if usable.sum() < 4096:
        return None
    return float((srgb_to_linear(rgb) @ LUMA)[usable].mean())


def crops_from_frame(rgb: np.ndarray, valid: np.ndarray, *, target_luminance: float,
                     policy: dict = POLICY) -> list[dict]:
    """Native windows → glint fill → flatten → exposure → sRGB crop with its loss-weight mask."""
    usable = valid & ~glint_mask(rgb, local_contrast=bool(policy.get("glint_local_contrast", False)))
    results = []
    for window in candidate_windows(usable, sizes=tuple(policy["sizes"]),
                                    min_valid=policy["min_valid_fraction"],
                                    max_windows=policy["max_windows_per_frame"]):
        x0, y0, x1, y1 = window["box_xyxy"]
        crop, crop_valid = rgb[y0:y1, x0:x1], usable[y0:y1, x0:x1]
        if dark_fraction(crop) > 0.03:
            continue
        linear = inpaint_normalized(srgb_to_linear(crop), crop_valid)
        linear, flatten = flatten_illumination(linear, crop_valid)
        gain = exposure_gain(linear, crop_valid, target_luminance)
        out = linear_to_srgb_u8(linear * gain)
        results.append({"image": out, "valid": crop_valid, "box_xyxy": window["box_xyxy"], "size": window["size"],
                        "valid_fraction": window["valid_fraction"], "filled_fraction": float(1 - crop_valid.mean()),
                        "flatten": flatten, "exposure_gain": gain, "sharpness": sharpness(out, crop_valid),
                        "dark_fraction": dark_fraction(crop)})
    return results


def _png(array: np.ndarray) -> bytes:
    stream = io.BytesIO()
    Image.fromarray(array).save(stream, format="PNG", compress_level=6)
    return stream.getvalue()


_WORKER: dict = {}


def _worker_init(kind: str, location: str, options: dict, policy: dict) -> None:
    source = DsadSource(Path(location)) if kind == "dsad" else HyperKvasirSource(Path(location), **options)
    _WORKER["source"], _WORKER["items"], _WORKER["policy"] = source, source.items(), policy


def _worker_luminance(index: int) -> tuple[int, float | None]:
    rgb, valid = _WORKER["source"].load(index)
    return index, frame_luminance(rgb, valid, _WORKER["policy"])


def _worker_crops(task: tuple[int, float, str]) -> tuple[int, list[dict]]:
    index, target, output = task
    rgb, valid = _WORKER["source"].load(index)
    item = _WORKER["items"][index]
    results = []
    for number, crop in enumerate(crops_from_frame(rgb, valid, target_luminance=target, policy=_WORKER["policy"])):
        name = f"{item['split']}/{item['family']}/{item['source_id']}-c{number}"
        png, valid_png = _png(crop["image"]), _png(crop["valid"].astype(np.uint8) * 255)
        for suffix, raw in ((".png", png), (".valid.png", valid_png)):
            path = Path(output) / (name + suffix)
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("xb") as handle:
                handle.write(raw)
        results.append({**{k: v for k, v in crop.items() if k not in ("image", "valid")},
                        "file": name + ".png", "valid_file": name + ".valid.png",
                        "sha256": sha256_bytes(png), "bytes": len(png), "valid_sha256": sha256_bytes(valid_png)})
    return index, results


def policy_with(*, min_size: int | None = None, min_valid: float | None = None, version: str | None = None,
                glint_local_contrast: bool | None = None) -> dict:
    """A documented variant of the default crop policy (smaller windows admit small-mask organs)."""
    policy = dict(POLICY)
    if glint_local_contrast is not None:
        policy["glint_local_contrast"] = bool(glint_local_contrast)
        if glint_local_contrast:
            policy["glint"] += "; glint-v2: specks >= 150/255 and >= local Gaussian mean (sigma 6) + 40 also excluded"
    if min_size is not None:
        if type(min_size) is not int or not 64 <= min_size <= 512 or min_size % 64:
            raise ValueError("min_size must be a multiple of 64 in 64..512")
        policy["sizes"] = [s for s in range(512, min_size - 1, -64)]
    if min_valid is not None:
        if not 0.5 <= min_valid <= 1:
            raise ValueError("min_valid must be in [0.5, 1]")
        policy["min_valid_fraction"] = float(min_valid)
    if version is not None:
        policy["version"] = version
    return policy


def prepare_release(sources: list[tuple[str, Path, dict]], output: Path, *, workers: int = 4,
                    limit_per_source: int | None = None, policy: dict = POLICY) -> dict:
    """Two passes per source: family exposure targets, then crops. Output must be new."""
    if any(type(s) is not int or s < 64 or s % 64 for s in policy["sizes"]):
        raise ValueError("crop sizes must be multiples of 64 (latent-friendly)")
    output = Path(output)
    if output.exists():
        raise ValueError("refusing to write into an existing crop release")
    output.mkdir(parents=True)
    records: list[dict] = []
    source_receipts = []
    for kind, location, options in sources:
        source = DsadSource(Path(location)) if kind == "dsad" else HyperKvasirSource(Path(location), **options)
        items = source.items()
        indices = list(range(len(items)))[:limit_per_source]
        worker_options = {**options, "archive_sha256": source.archive_sha256} if kind != "dsad" else options
        with ProcessPoolExecutor(max_workers=workers, initializer=_worker_init,
                                 initargs=(kind, str(location), worker_options, policy)) as pool:
            luminance = dict(pool.map(_worker_luminance, indices, chunksize=8))
            by_family: dict[str, list[float]] = {}
            for index in indices:
                if luminance[index] is not None:
                    by_family.setdefault(items[index]["family"], []).append(luminance[index])
            targets = {family: float(np.median(values)) for family, values in by_family.items()}
            tasks = [(index, targets[items[index]["family"]], str(output))
                     for index in indices if luminance[index] is not None]
            for index, crops in pool.map(_worker_crops, tasks, chunksize=4):
                for crop in crops:
                    records.append({**items[index], **crop, "caption": caption(items[index]["family"],
                                                                                items[index]["condition"]),
                                    "exposure_target_luminance": targets[items[index]["family"]]})
        source_receipts.append({"kind": kind, "location": str(location), "frames_considered": len(indices),
                                "frames_with_tissue": len(tasks), "exposure_targets": targets, **options,
                                **({"release_sha256": source.release_sha256, "untouched_test_frames": source.untouched_test}
                                   if kind == "dsad" else {"archive_sha256": source.archive_sha256})})
    records.sort(key=lambda row: row["file"])
    lines = "".join(json.dumps(row, sort_keys=True, allow_nan=False) + "\n" for row in records)
    (output / "records.jsonl").write_text(lines)
    counts: dict[str, dict[str, int]] = {}
    for row in records:
        counts.setdefault(row["split"], {}).setdefault(row["family"], 0)
        counts[row["split"]][row["family"]] += 1
    groups = {split: sorted({row["group_id"] for row in records if row["split"] == split}) for split in counts}
    # Specimen-level groups (surgery, animal, patient) must not straddle train/val. Sources without
    # specimen identifiers (group_level "unknown") are split by name and declared as such.
    levels = {row["group_id"]: row["group_level"] for row in records}
    leaked = {g for g in set(groups.get("train", [])) & set(groups.get("val", [])) if levels[g] != "unknown"}
    if leaked:
        raise ValueError(f"specimen group leaks across train/val: {sorted(leaked)[:3]}")
    release = {"schema": SCHEMA_CROPS, "policy": policy, "sources": source_receipts, "counts": counts,
               "groups": {split: len(values) for split, values in groups.items()},
               "records_sha256": sha256_bytes(lines.encode()), "records": len(records),
               "rights": sorted({row["training_profile"] for row in records}),
               "split_semantics": {"dsad": "surgery-disjoint (publisher split)",
                                   "hyperkvasir": "name-keyed 90/10 within class; no patient identifiers, so val is not specimen-disjoint"},
               "meaning": "Native-pixel, illumination-flattened observed surgical RGB crops with specimen-level splits; not albedo, not patient anatomy"}
    with (output / "release.json").open("x") as handle:
        json.dump(release, handle, indent=2, allow_nan=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    return release


class CropDataset:
    """Verified crop release reader with size buckets; payloads open on demand."""

    def __init__(self, root: Path, *, split: str = "train", families: tuple[str, ...] | None = None,
                 min_sharpness: float = 0.0, profiles: tuple[str, ...] = ("noncommercial-research", "unrestricted"),
                 verify_hashes: bool = False):
        self.root = Path(root)
        release_raw = (self.root / "release.json").read_bytes()
        self.release = json.loads(release_raw)
        self.release_sha256 = sha256_bytes(release_raw)
        if self.release.get("schema") != SCHEMA_CROPS:
            raise ValueError("unsupported crop release schema")
        lines = (self.root / "records.jsonl").read_bytes()
        if sha256_bytes(lines) != self.release["records_sha256"]:
            raise ValueError("records.jsonl differs from release lock")
        rows = [json.loads(line) for line in lines.splitlines() if line.strip()]
        self.records = [row for row in rows if row["split"] == split and row["training_profile"] in profiles
                        and (families is None or row["family"] in families) and row["sharpness"] >= min_sharpness]
        for row in self.records:
            _safe_member(row["file"])
            _safe_member(row["valid_file"])
        if verify_hashes:
            for row in self.records:
                if sha256_file(self.root / row["file"]) != row["sha256"]:
                    raise ValueError(f"crop digest mismatch: {row['file']}")
                if sha256_file(self.root / row["valid_file"]) != row["valid_sha256"]:
                    raise ValueError(f"valid mask digest mismatch: {row['valid_file']}")
        self.buckets: dict[int, list[int]] = {}
        for index, row in enumerate(self.records):
            self.buckets.setdefault(int(row["size"]), []).append(index)

    def __len__(self) -> int:
        return len(self.records)

    def load(self, index: int) -> tuple[np.ndarray, np.ndarray, dict]:
        row = self.records[index]
        with Image.open(self.root / row["file"]) as image:
            rgb = np.asarray(image.convert("RGB"))
        with Image.open(self.root / row["valid_file"]) as image:
            valid = np.asarray(image.convert("L")) >= 128
        if rgb.shape[:2] != (row["size"], row["size"]) or valid.shape != rgb.shape[:2]:
            raise ValueError(f"crop dimensions differ from record: {row['file']}")
        return rgb, valid, row

    def iter_rows(self) -> Iterator[dict]:
        yield from self.records


def subset_release(source: Path, output: Path, *, max_train_per_family: int | None = None, seed: int = 0,
                   zip_path: Path | None = None) -> dict:
    """Copy a family-capped subset of a release (all validation crops) into a new locked release, optionally zipped.

    The subset carries its parent's identity. Train crops are drawn uniformly at random per family so the
    Drive upload for Colab stays bounded without changing any crop bytes.
    """
    source, output = Path(source), Path(output)
    parent = CropDataset(source, split="train")
    val = CropDataset(source, split="val")
    rng = np.random.default_rng(seed)
    chosen: list[dict] = list(val.records)
    by_family: dict[str, list[dict]] = {}
    for row in parent.records:
        by_family.setdefault(row["family"], []).append(row)
    for family, rows in sorted(by_family.items()):
        if max_train_per_family is not None and len(rows) > max_train_per_family:
            picks = rng.choice(len(rows), size=max_train_per_family, replace=False)
            rows = [rows[int(i)] for i in sorted(picks)]
        chosen.extend(rows)
    if output.exists():
        raise ValueError("refusing to write into an existing subset release")
    if zip_path is not None:
        zip_path = Path(zip_path)
        if zip_path.exists():
            raise ValueError("zip target exists")
        if zip_path.resolve().is_relative_to(output.resolve()):
            raise ValueError("zip target must lie outside the subset directory")
    output.mkdir(parents=True)
    for row in chosen:
        for key, digest in (("file", "sha256"), ("valid_file", "valid_sha256")):
            target = output / row[key]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((source / row[key]).read_bytes())
            if sha256_file(target) != row[digest]:
                raise ValueError(f"copy changed a file: {row[key]}")
    chosen.sort(key=lambda row: row["file"])
    lines = "".join(json.dumps(row, sort_keys=True, allow_nan=False) + "\n" for row in chosen)
    (output / "records.jsonl").write_text(lines)
    counts: dict[str, dict[str, int]] = {}
    for row in chosen:
        counts.setdefault(row["split"], {}).setdefault(row["family"], 0)
        counts[row["split"]][row["family"]] += 1
    release = {**parent.release, "records_sha256": sha256_bytes(lines.encode()), "records": len(chosen), "counts": counts,
               "subset_of": {"records_sha256": parent.release["records_sha256"], "max_train_per_family": max_train_per_family,
                             "seed": seed}}
    (output / "release.json").write_text(json.dumps(release, indent=2, allow_nan=False) + "\n")
    if zip_path is not None:
        # Archive exactly the manifest's files (never filesystem sidecars such as exFAT "._" AppleDouble files).
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as archive:
            for name in ("release.json", "records.jsonl"):
                archive.write(output / name, name)
            for row in chosen:
                for key in ("file", "valid_file"):
                    archive.write(output / row[key], row[key])
        release["zip"] = {"path": str(zip_path), "bytes": zip_path.stat().st_size, "sha256": sha256_file(zip_path)}
    return release
