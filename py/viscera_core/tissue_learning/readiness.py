"""Derive an explicitly filtered train/val manifest without opening test payloads."""

from __future__ import annotations

import hashlib
import json
import math
import tempfile
from pathlib import Path

import numpy as np
import PIL

from .data import InsufficientCoverageError, TissueDataset
from .portable import complete_result, prepare_result_attempt, sha256


def prepare_training_manifest(manifest: Path, data_root: Path, output: Path, *, patch_size: int,
                              minimum_valid_fraction: float, commercial_only: bool = True,
                              allow_training_only: bool = False, progress=None) -> dict:
    if patch_size not in (16, 32, 64, 128, 256, 512) or not math.isfinite(minimum_valid_fraction) or not 0 < minimum_valid_fraction <= 1:
        raise ValueError("invalid readiness patch size or coverage threshold")
    dataset = TissueDataset(manifest, data_root, commercial_only=commercial_only,
                            allow_training_only=allow_training_only)
    raw = Path(manifest).read_bytes()
    if hashlib.sha256(raw).hexdigest() != dataset.digest:
        raise ValueError("source manifest changed during readiness setup")
    lines = [line for line in raw.splitlines(keepends=True) if line.strip()]
    identity = {"kind": "tissue-training-readiness-v1", "source_manifest_sha256": dataset.digest,
                "source_split_sha256": dataset.split_digest, "patch_size": patch_size,
                "minimum_valid_fraction": minimum_valid_fraction, "commercial_only": commercial_only,
                "allow_training_only": allow_training_only, "numpy": np.__version__, "pillow": PIL.__version__,
                "policy_source_sha256": {name: sha256(Path(__file__).with_name(name))
                                         for name in ("readiness.py", "data.py")}}
    output = Path(output)
    if prepare_result_attempt(output, identity):
        return json.loads((output / "readiness.json").read_text())
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".readiness-", dir=output.parent))
    excluded, kept, scanned = [], [], 0
    try:
        total = len(dataset.splits["train"]) + len(dataset.splits["val"])
        for index, row in enumerate(dataset.records):
            if row["split"] != "test":
                try:
                    dataset.load(index, patch_size, minimum_valid_fraction=minimum_valid_fraction)
                except InsufficientCoverageError as error:
                    excluded.append({"id": row["id"], "split": row["split"], "group_id": row["group_id"],
                        "condition": row["condition"], "image_sha256": row["image_sha256"],
                        "mask_sha256": row.get("mask_sha256"),
                        "original_row_sha256": hashlib.sha256(lines[index]).hexdigest(),
                        "reason": "insufficient_valid_tissue_coverage_after_center_and_mask_bbox_crops",
                        "best_valid_fraction": error.best_valid_fraction,
                        "required_valid_fraction": minimum_valid_fraction})
                else:
                    kept.append(index)
                scanned += 1
                if progress and (scanned % 128 == 0 or scanned == total):
                    progress({"stage": "readiness", "scanned": scanned, "total": total, "excluded": len(excluded)})
            else:
                kept.append(index)  # Retain the original test row bytes; never load its payload.
        derived = stage / "records.jsonl"
        derived.write_bytes(b"".join(lines[index] for index in kept))
        training_conditions = {dataset.records[index]["condition"] for index in kept
                               if dataset.records[index]["split"] == "train"}
        missing = sorted(set(dataset.conditions) - training_conditions)
        if missing:
            raise ValueError(f"readiness removed all training support for conditions: {missing}")
        filtered = TissueDataset(derived, data_root, commercial_only=commercial_only,
                                 allow_training_only=allow_training_only)
        report = {"schema": "viscera.tissue-training-readiness/v1", "identity": identity,
                  "source_summary": dataset.summary(), "derived_summary": filtered.summary(),
                  "derived_manifest_sha256": filtered.digest, "derived_split_sha256": filtered.split_digest,
                  "scanned_train_val_rows": scanned, "test_payloads_opened": 0,
                  "retained_test_rows": len(dataset.splits["test"]), "excluded_count": len(excluded),
                  "excluded_rows": excluded, "exclusions_by_split": {split: sum(r["split"] == split for r in excluded)
                                                                        for split in ("train", "val")},
                  "conditions_without_validation_samples": [name for name in filtered.conditions
                      if not filtered.summary()["per_condition"][name]["val"]["samples"]],
                  "policy": "Exclude only typed insufficient-mask-coverage failures. Original retained JSONL rows are byte-preserved; integrity/decode/schema failures stop the scan. Threshold unchanged.",
                  "test_audit": "Use this exact derived manifest with complete evaluator shards for frozen-checkpoint testing; original test metadata is unchanged."}
        (stage / "readiness.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
        complete_result(stage, identity)
        stage.rename(output)
        return report
    except BaseException as error:
        (stage / "failure.json").write_text(json.dumps({"error": type(error).__name__ + ": " + str(error),
            "identity": identity, "excluded_rows_before_failure": excluded,
            "source_preserved": True, "published": False}, indent=2) + "\n")
        raise
