#!/usr/bin/env python3
"""Scan only train/validation validity masks for native pixel crop support.

Reads indexed, checksum-verified mask bytes. Never opens test or RGB payloads.
Window positions overlap; counts do not represent independent observations.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import time
from collections import Counter, defaultdict
from pathlib import Path, PurePosixPath

import numpy as np
from PIL import Image

THRESHOLDS = (0.5, 0.65, 0.75, 0.8, 0.9, 0.95)
SIZES = (128, 256)


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def no_symlinks(path: Path) -> None:
    if any(item.is_symlink() for item in (path, *path.parents)):
        raise ValueError("Symlink paths are forbidden")


def load_source(root: Path, expected_release_sha256: str) -> tuple[dict, list[dict], bytes]:
    no_symlinks(root)
    raw = (root / "release.json").read_bytes()
    if digest(raw) != expected_release_sha256:
        raise ValueError("Source release SHA mismatch")
    release = json.loads(raw)
    if release.get("schema") != "viscera.observed-rgb-dataset/v3":
        raise ValueError("Expected original prepared observed-RGB release")
    records_raw = (root / "records.jsonl").read_bytes()
    if digest(records_raw) != release["manifests"]["records.jsonl"]["sha256"]:
        raise ValueError("Source records SHA mismatch")
    rows = [json.loads(line) for line in records_raw.splitlines() if line.strip()]
    if len(rows) != release["records"]:
        raise ValueError("Source record count mismatch")
    ids, groups, contents = set(), {}, {}
    for row in rows:
        split = row["split"]
        if row["id"] in ids or split not in ("train", "val", "test"):
            raise ValueError("Duplicate ID or invalid split")
        ids.add(row["id"])
        if groups.setdefault(row["group_id"], split) != split:
            raise ValueError("Cross-split group leakage")
        for value in [
            row["image_sha256"],
            row.get("derivation_parent_sha256"),
            *row.get("ancestor_sha256", []),
        ]:
            if value and contents.setdefault(value, split) != split:
                raise ValueError("Cross-split content leakage")
        if row.get("mask_semantics") != "valid_tissue_white":
            raise ValueError("Explicit valid_tissue_white mask required")
    return release, rows, records_raw


def read_blob(root: Path, release: dict, row: dict, kind: str) -> bytes:
    if row["split"] not in ("train", "val"):
        raise ValueError("Test payload access forbidden in native crop preparation")
    if kind not in ("image", "mask"):
        raise ValueError("Invalid blob kind")
    name = row[f"{kind}_path"]
    part = PurePosixPath(name)
    if part.is_absolute() or len(part.parts) != 1 or "\\" in name or name in (".", ".."):
        raise ValueError("Unsafe source shard path")
    shards = [item for item in release["shards"] if item["path"] == name]
    if len(shards) != 1 or shards[0]["split"] != row["split"]:
        raise ValueError("Source shard split/declaration mismatch")
    offset, length = row[f"{kind}_offset"], row[f"{kind}_length"]
    if (
        type(offset) is not int
        or type(length) is not int
        or offset < 0
        or not 0 < length <= 32 * 1024**2
    ):
        raise ValueError("Invalid bounded shard slice")
    path = root / name
    no_symlinks(path)
    if path.stat().st_size != shards[0]["bytes"] or offset + length > path.stat().st_size:
        raise ValueError("Source shard size/slice mismatch")
    with path.open("rb") as stream:
        stream.seek(offset)
        raw = stream.read(length)
    if len(raw) != length or digest(raw) != row[f"{kind}_sha256"]:
        raise ValueError("Source slice hash mismatch")
    return raw


def decode_mask(raw: bytes) -> np.ndarray:
    with Image.open(io.BytesIO(raw)) as image:
        if image.mode != "L" or image.width * image.height > 16_000_000:
            raise ValueError("Mask must be bounded native 8-bit grayscale")
        mask = np.array(image)
    if not np.all((mask == 0) | (mask == 255)):
        raise ValueError("Mask must be binary, without soft/interpolated values")
    return mask == 255


def window_sums(mask: np.ndarray, size: int) -> np.ndarray:
    if type(size) is not int or size < 1 or min(mask.shape) < size:
        raise ValueError("Crop size exceeds native mask dimensions")
    integral = np.pad(mask.astype(np.int32), ((1, 0), (1, 0)))
    integral = integral.cumsum(0, dtype=np.int32).cumsum(1, dtype=np.int32)
    return (
        integral[size:, size:]
        - integral[:-size, size:]
        - integral[size:, :-size]
        + integral[:-size, :-size]
    )


def best_window(mask: np.ndarray, size: int, critic_size: int = 23) -> dict:
    sums = window_sums(mask, size)
    y, x = np.unravel_index(np.argmax(sums), sums.shape)
    crop = mask[y : y + size, x : x + size]
    critic_max = float(window_sums(crop, critic_size).max() / critic_size**2)
    return {
        "crop_box_xyxy": [int(x), int(y), int(x + size), int(y + size)],
        "valid_pixels": int(sums[y, x]),
        "valid_fraction": float(sums[y, x] / size**2),
        "critic_window_size": critic_size,
        "critic_max_valid_fraction": critic_max,
        "tie_break": "maximum valid pixels; earliest y then x in native coordinates",
    }


def scan(root: Path, release_sha256: str, output: Path) -> dict:
    if output.exists():
        raise ValueError("Output exists; preserve previous evidence")
    no_symlinks(output)
    release, rows, _ = load_source(root, release_sha256)
    output.mkdir()
    started = time.monotonic()
    source_counts, support = Counter(), defaultdict(Counter)
    read_count = 0
    try:
        with (
            (output / "mask-candidates.jsonl").open("x") as stream,
            (output / "progress.jsonl").open("x") as progress,
        ):
            for row in rows:
                if row["split"] == "test":
                    continue
                mask = decode_mask(read_blob(root, release, row, "mask"))
                selections = {str(size): best_window(mask, size) for size in SIZES}
                record = {
                    "id": row["id"],
                    "split": row["split"],
                    "condition": row["condition"],
                    "group_id": row["group_id"],
                    "image_sha256": row["image_sha256"],
                    "mask_sha256": row["mask_sha256"],
                    "shape_hw": list(mask.shape),
                    "windows": selections,
                }
                stream.write(json.dumps(record, sort_keys=True) + "\n")
                source_counts[row["condition"], row["split"], row["group_id"]] += 1
                for size, selection in selections.items():
                    for threshold in THRESHOLDS:
                        if (
                            selection["valid_fraction"] >= threshold
                            and selection["critic_max_valid_fraction"] >= 0.75
                        ):
                            support[size, str(threshold)][
                                row["condition"], row["split"], row["group_id"]
                            ] += 1
                read_count += 1
                if read_count % 100 == 0:
                    entry = {
                        "processed_masks": read_count,
                        "elapsed_seconds": time.monotonic() - started,
                    }
                    progress.write(json.dumps(entry) + "\n")
                    progress.flush()
                    stream.flush()
                    print(json.dumps(entry), flush=True)
        def counts(counter):
            return [
                {"condition": key[0], "split": key[1], "group_id": key[2], "samples": n}
                for key, n in sorted(counter.items())
            ]
        report = {
            "schema": "viscera.native-crop-support-scan/v1",
            "status": "completed",
            "source_release_sha256": release_sha256,
            "source_manifest_sha256": release["manifests"]["records.jsonl"]["sha256"],
            "scanner_sha256": digest(Path(__file__).read_bytes()),
            "scanned_train_val_masks": read_count,
            "image_payloads_opened": 0,
            "test_payloads_opened": 0,
            "candidate_sha256": digest((output / "mask-candidates.jsonl").read_bytes()),
            "selection": "One maximum-coverage native square per source frame; ties earliest y then x.",
            "critic_requirement": "At least one native23x23 neighborhood with valid fraction>=0.75.",
            "source_counts": counts(source_counts),
            "support": {
                f"native{key[0]}-valid{key[1]}": counts(counter)
                for key, counter in sorted(support.items())
            },
            "elapsed_seconds": time.monotonic() - started,
            "limits": [
                "These are mask-qualified candidates, not reviewed tissue quality or independent frames.",
                "Pixel crop size is not physical scale; mask errors and residual lighting remain.",
                "No test payload was used to select a threshold.",
            ],
        }
        with (output / "scan.json").open("x") as stream:
            json.dump(report, stream, indent=2)
            stream.write("\n")
        return report
    except Exception as error:
        (output / "failure.json").write_text(
            json.dumps({"error": str(error), "processed_masks": read_count})
        )
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--source-release-sha256", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = scan(args.source_root, args.source_release_sha256, args.output)
    print(
        json.dumps(
            {
                "status": result["status"],
                "masks": result["scanned_train_val_masks"],
                "seconds": result["elapsed_seconds"],
            }
        )
    )
