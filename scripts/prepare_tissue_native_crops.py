#!/usr/bin/env python3
"""Create split-preserving, native-pixel RGB/mask crops from a reviewed mask scan.

One best crop per source frame, no image resizing or colour transformation.
Original test metadata is byte-preserved; no test payload is read or copied.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import shutil
import uuid
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import PIL
from PIL import Image
from prepare_tissue_v3_dataset import ShardWriter, sha256_file
from scan_tissue_native_crop_support import (
    decode_mask,
    digest,
    load_source,
    no_symlinks,
    read_blob,
    window_sums,
)


def png_bytes(array: np.ndarray) -> bytes:
    stream = io.BytesIO()
    Image.fromarray(array).save(stream, format="PNG", compress_level=6)
    return stream.getvalue()


def critic_alignment(mask: np.ndarray) -> list[float]:
    """Exact RF coverage for stride4/padding11/k23, under all D4 augmentations."""
    maxima = []
    for rotation in range(4):
        for flipped in (False, True):
            transformed = np.rot90(mask, rotation)
            if flipped:
                transformed = np.flip(transformed, axis=1)
            padded = np.pad(transformed, ((11, 11), (11, 11)))
            values = window_sums(padded, 23)[::4, ::4] / 23**2
            maxima.append(float(values.max()))
    return maxima


def crop_native(
    image_raw: bytes, mask_raw: bytes, candidate: dict, size: int
) -> tuple[bytes, bytes, dict]:
    mask = decode_mask(mask_raw)
    with Image.open(io.BytesIO(image_raw)) as image:
        if image.mode != "RGB" or image.width * image.height > 16_000_000:
            raise ValueError("Expected bounded native RGB image, no conversion allowed")
        if image.size != (mask.shape[1], mask.shape[0]):
            raise ValueError("Native RGB/mask dimensions differ")
        box = candidate["crop_box_xyxy"]
        if (
            len(box) != 4
            or any(type(x) is not int for x in box)
            or box[0] < 0
            or box[1] < 0
            or box[2] > image.width
            or box[3] > image.height
            or box[2] - box[0] != size
            or box[3] - box[1] != size
        ):
            raise ValueError("Invalid native crop box")
        rgb = np.array(image.crop(tuple(box)))
    x0, y0, x1, y1 = box
    valid = mask[y0:y1, x0:x1]
    quality = {
        "valid_pixels": int(valid.sum()),
        "valid_fraction": float(valid.mean()),
        "critic_window_size": 23,
        "critic_max_valid_fraction": float(window_sums(valid, 23).max() / 23**2),
        "critic_alignment_max_valid_fractions": critic_alignment(valid),
    }
    if any(quality[key] != candidate[key] for key in quality):
        raise ValueError("Decoded native crop coverage differs from scan evidence")
    return png_bytes(rgb), png_bytes(valid.astype(np.uint8) * 255), quality


def prepare(
    source: Path,
    scan_root: Path,
    output: Path,
    *,
    source_release_sha256: str,
    size: int,
    minimum_valid_fraction: float,
    minimum_critic_fraction: float = 0.75,
    minimum_validation_groups: int = 3,
    max_output_bytes: int = 2 * 1024**3,
    reserve_bytes: int = 1024**3,
    max_shard_bytes: int = 128 * 1024**2,
) -> dict:
    if (
        size not in (128, 256)
        or not 0 < minimum_valid_fraction <= 1
        or not 0 < minimum_critic_fraction <= 1
    ):
        raise ValueError("Explicit valid native crop size/coverage policy required")
    if (
        minimum_validation_groups < 1
        or max_output_bytes < 1
        or reserve_bytes < 0
        or max_shard_bytes < 10240
    ):
        raise ValueError("Invalid group/output budget")
    no_symlinks(output)
    no_symlinks(scan_root)
    if output.exists() or not output.parent.is_dir():
        raise ValueError("New output and existing parent required; preserve prior release")
    release, rows, source_raw = load_source(source, source_release_sha256)
    scan_raw = (scan_root / "scan.json").read_bytes()
    scan = json.loads(scan_raw)
    candidate_raw = (scan_root / "mask-candidates.jsonl").read_bytes()
    if (
        scan.get("status") != "completed"
        or scan["source_release_sha256"] != source_release_sha256
        or scan["source_manifest_sha256"] != digest(source_raw)
        or scan["candidate_sha256"] != digest(candidate_raw)
        or scan["test_payloads_opened"] != 0
        or scan["image_payloads_opened"] != 0
    ):
        raise ValueError("Scan identity/completion mismatch")
    candidates = [json.loads(line) for line in candidate_raw.splitlines()]
    by_id = {row["id"]: row for row in candidates}
    trainval = [row for row in rows if row["split"] != "test"]
    if len(by_id) != len(candidates) or set(by_id) != {row["id"] for row in trainval}:
        raise ValueError("Scan must cover every source train/validation row exactly once")
    selected, excluded, support = {}, [], defaultdict(lambda: defaultdict(set))
    for row in trainval:
        item = by_id[row["id"]]
        for key in ("split", "condition", "group_id", "image_sha256", "mask_sha256"):
            if row[key] != item[key]:
                raise ValueError("Scan source row identity mismatch")
        candidate = item["windows"][str(size)]
        reason = (
            "insufficient_native_valid_fraction"
            if candidate["valid_fraction"] < minimum_valid_fraction
            else "insufficient_valid_critic_neighborhood"
            if candidate["critic_max_valid_fraction"] < minimum_critic_fraction
            else None
        )
        if reason:
            excluded.append(
                {
                    "id": row["id"],
                    "split": row["split"],
                    "condition": row["condition"],
                    "group_id": row["group_id"],
                    "image_sha256": row["image_sha256"],
                    "mask_sha256": row["mask_sha256"],
                    "reason": reason,
                    "best_candidate": candidate,
                }
            )
        else:
            # Qualify the actual sampled RF lattice after every allowed rotation/
            # reflection, not merely the exhaustive sliding-window upper bound.
            mask = decode_mask(read_blob(source, release, row, "mask"))
            x0, y0, x1, y1 = candidate["crop_box_xyxy"]
            valid = mask[y0:y1, x0:x1]
            if valid.shape != (size, size) or int(valid.sum()) != candidate["valid_pixels"]:
                raise ValueError("Scan native crop box/coverage mismatch")
            maxima = critic_alignment(valid)
            if min(maxima) < minimum_critic_fraction:
                excluded.append(
                    {
                        "id": row["id"],
                        "split": row["split"],
                        "condition": row["condition"],
                        "group_id": row["group_id"],
                        "image_sha256": row["image_sha256"],
                        "mask_sha256": row["mask_sha256"],
                        "reason": "insufficient_sampled_critic_coverage_in_at_least_one_d4_variant",
                        "critic_alignment_max_valid_fractions": maxima,
                        "best_candidate": candidate,
                    }
                )
            else:
                selected[row["id"]] = {**candidate, "critic_alignment_max_valid_fractions": maxima}
                support[row["condition"]][row["split"]].add(row["group_id"])
        if (len(selected) + len(excluded)) % 100 == 0:
            print(
                json.dumps(
                    {
                        "qualified_source_masks": len(selected) + len(excluded),
                        "eligible_crops": len(selected),
                    }
                ),
                flush=True,
            )
    for condition in {row["condition"] for row in trainval}:
        if (
            not support[condition]["train"]
            or len(support[condition]["val"]) < minimum_validation_groups
        ):
            raise ValueError(f"Insufficient retained condition/group support: {condition}")
    policy = {
        "version": "native-best-coverage-one-per-parent-v1",
        "native_size": size,
        "minimum_valid_fraction": minimum_valid_fraction,
        "minimum_critic_fraction": minimum_critic_fraction,
        "critic_window_size": 23,
        "minimum_validation_groups": minimum_validation_groups,
        "critic_stride": 4,
        "critic_zero_padding": 11,
        "critic_d4_policy": "Every rot90(k), k=0..3, optionally reflected in x, has at least one sampled RF >= threshold; zeros outside crop count in denominator.",
        "selection": "One native maximum-valid-pixel square per source frame; ties earliest y then x.",
        "resampling": "none",
        "colour_transform": "none",
        "test_policy": "Original metadata only; no test crop selection or payload reads.",
    }
    stage = output.with_name(output.name + ".staging-" + uuid.uuid4().hex[:12])
    stage.mkdir()
    writers = {split: ShardWriter(stage, split, max_shard_bytes) for split in ("train", "val")}
    output_lines, counts, progress = [], Counter(), []
    estimated_bytes = 0
    try:
        for original_line, row in zip(source_raw.splitlines(keepends=True), rows, strict=True):
            if row["split"] == "test":
                output_lines.append((row["split"], original_line))
                continue
            if row["id"] not in selected:
                continue
            candidate = selected[row["id"]]
            mask_raw = read_blob(source, release, row, "mask")
            image_raw = read_blob(source, release, row, "image")
            rgb, mask, quality = crop_native(image_raw, mask_raw, candidate, size)
            estimated_bytes += sum(512 + ((len(blob) + 511) // 512) * 512 for blob in (rgb, mask))
            if estimated_bytes + 1024**2 > max_output_bytes:
                raise ValueError("Native crop output byte budget reached")
            if shutil.disk_usage(stage).free < reserve_bytes + len(rgb) + len(mask) + 10240:
                raise ValueError("Native crop output disk reserve reached")
            x, y, _, _ = candidate["crop_box_xyxy"]
            identifier = row["id"] + f"-native{size}-x{x}-y{y}"
            crop = {
                **row,
                "id": identifier,
                "derivation_parent_sha256": row["image_sha256"],
                "ancestor_sha256": sorted(
                    {
                        value
                        for value in [
                            row.get("derivation_parent_sha256"),
                            *row.get("ancestor_sha256", []),
                        ]
                        if value
                    }
                ),
                "source_original_record_id": row["id"],
                "source_original_row_sha256": digest(original_line),
                "source_image_sha256": row["image_sha256"],
                "source_prepared_mask_sha256": row["mask_sha256"],
                "source_prepared_release_sha256": source_release_sha256,
                "source_quality": row.get("quality"),
                "quality": {**quality, "width": size, "height": size},
                "native_crop": {
                    **policy,
                    "crop_box_xyxy": candidate["crop_box_xyxy"],
                    "source_width": by_id[row["id"]]["shape_hw"][1],
                    "source_height": by_id[row["id"]]["shape_hw"][0],
                },
            }
            for kind, blob in (("image", rgb), ("mask", mask)):
                ref = writers[row["split"]].add(
                    identifier + ("-valid" if kind == "mask" else "") + ".png", blob
                )
                crop.update({f"{kind}_{key}": value for key, value in ref.items()})
            output_lines.append((row["split"], (json.dumps(crop, sort_keys=True) + "\n").encode()))
            counts[row["condition"], row["split"], row["group_id"]] += 1
            if sum(counts.values()) % 100 == 0:
                entry = {
                    "prepared_crops": sum(counts.values()),
                    "estimated_shard_bytes": estimated_bytes,
                }
                progress.append(entry)
                (stage / "progress.json").write_text(json.dumps(entry))
                print(json.dumps(entry), flush=True)
        for writer in writers.values():
            writer.close_current()
        manifests = {}
        for name, subset in [
            ("records", output_lines),
            *[
                (split, [x for x in output_lines if x[0] == split])
                for split in ("train", "val", "test")
            ],
        ]:
            raw = b"".join(line for _, line in subset)
            (stage / f"{name}.jsonl").write_bytes(raw)
            manifests[f"{name}.jsonl"] = {"bytes": len(raw), "sha256": digest(raw)}
        exclusions = (json.dumps(excluded, indent=2, sort_keys=True) + "\n").encode()
        (stage / "exclusions.json").write_bytes(exclusions)
        prepared = {
            **release,
            "preparation_script_sha256": sha256_file(__file__),
            "source_prepared_release_sha256": source_release_sha256,
            "source_prepared_records_sha256": digest(source_raw),
            "source_scan_sha256": digest(scan_raw),
            "preparation_dependencies": {
                name: sha256_file(Path(__file__).with_name(name))
                for name in ("prepare_tissue_v3_dataset.py", "scan_tissue_native_crop_support.py")
            },
            "environment": {"numpy": np.__version__, "pillow": PIL.__version__},
            "native_crop_policy": policy,
            "records": len(output_lines),
            "records_by_split": dict(Counter(split for split, _ in output_lines)),
            "manifests": manifests,
            "shards": [item for writer in writers.values() for item in writer.files]
            + [item for item in release["shards"] if item["split"] == "test"],
            "conditions": {
                condition: {split: sorted(support[condition][split]) for split in ("train", "val")}
                for condition in sorted(support)
            },
            "test_payloads_materialized": False,
            "test_payloads_opened": 0,
            "test_scope": "Original full-frame test metadata/shard declarations retained without reading/copying test files. Native crop test evaluation requires separate frozen-policy preparation; do not pass these original frames to a native-crop loader.",
            "exclusions": {
                "path": "exclusions.json",
                "bytes": len(exclusions),
                "sha256": digest(exclusions),
                "rows": len(excluded),
            },
            "crop_counts_by_condition_split_group": [
                {"condition": key[0], "split": key[1], "group_id": key[2], "samples": n}
                for key, n in sorted(counts.items())
            ],
            "scope": "Native-pixel observed RGB appearance crops; masks qualify coverage, not tissue optical truth or clinical realism.",
        }
        # Preserve all original test-group metadata in the release as well as rows.
        for condition in prepared["conditions"]:
            prepared["conditions"][condition]["test"] = release["conditions"][condition].get(
                "test", []
            )
        total = sum(path.stat().st_size for path in stage.iterdir() if path.is_file())
        release_bytes = (json.dumps(prepared, indent=2, sort_keys=True) + "\n").encode()
        if total + len(release_bytes) > max_output_bytes:
            raise ValueError("Final native crop release exceeds byte budget")
        # Reserve destination exclusively; release.json is the final completion
        # marker. A crash leaves an incomplete directory rather than replacing
        # evidence owned by another process.
        output.mkdir(exist_ok=False)
        for item in stage.iterdir():
            item.rename(output / item.name)
        with (output / "release.json").open("xb") as handle:
            handle.write(release_bytes)
            handle.flush()
            os.fsync(handle.fileno())
        stage.rmdir()
        return {
            "output": str(output),
            "release_sha256": digest(release_bytes),
            "records_by_split": prepared["records_by_split"],
            "excluded_train_val": len(excluded),
            "native_train_val_crops": sum(counts.values()),
            "test_payloads_opened": 0,
        }
    except Exception as error:
        for writer in writers.values():
            writer.close_current()
        (stage / "failure.json").write_text(
            json.dumps({"error": str(error), "prepared_crops": sum(counts.values())})
        )
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--source-release-sha256", required=True)
    parser.add_argument("--scan-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--size", type=int, choices=(128, 256), default=128)
    parser.add_argument("--minimum-valid-fraction", type=float, required=True)
    parser.add_argument("--minimum-critic-fraction", type=float, default=0.75)
    parser.add_argument("--minimum-validation-groups", type=int, default=3)
    parser.add_argument("--max-output-gib", type=float, default=2)
    parser.add_argument("--reserve-gib", type=float, default=1)
    args = parser.parse_args()
    print(
        json.dumps(
            prepare(
                args.source_root,
                args.scan_root,
                args.output,
                source_release_sha256=args.source_release_sha256,
                size=args.size,
                minimum_valid_fraction=args.minimum_valid_fraction,
                minimum_critic_fraction=args.minimum_critic_fraction,
                minimum_validation_groups=args.minimum_validation_groups,
                max_output_bytes=int(args.max_output_gib * 1024**3),
                reserve_bytes=int(args.reserve_gib * 1024**3),
            ),
            indent=2,
        )
    )
