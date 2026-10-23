"""Validate native crop transport and every allowed augmentation before training."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import numpy as np

from viscera_core.tissue_learning.portable import complete_result, prepare_result_attempt, sha256

from .data import NativePatchDataset


def minimum_critic_fields(mask, threshold):
    counts = []
    for turns in range(4):
        for flip in (False, True):
            transformed = np.rot90(mask, turns)
            if flip:
                transformed = transformed[:, ::-1]
            padded = np.pad(transformed, 11)
            sums = np.pad(padded.astype(np.int64).cumsum(0).cumsum(1), ((1, 0), (1, 0)))
            left = np.arange(0, 128, 4)
            right = left + 23
            area = (sums[np.ix_(right, right)] - sums[np.ix_(left, right)]
                    - sums[np.ix_(right, left)] + sums[np.ix_(left, left)])
            counts.append(int(np.count_nonzero(area / 529 >= threshold)))
    return min(counts)


def prepare_manifest(manifest, data_root, output, *, minimum_valid_fraction=.5,
                     critic_minimum_coverage=.75, commercial_only=False, progress=None):
    if not 0 < minimum_valid_fraction <= 1 or not 0 < critic_minimum_coverage <= 1:
        raise ValueError("invalid native readiness threshold")
    dataset = NativePatchDataset(manifest, data_root, commercial_only=commercial_only)
    identity = {"kind": "native-tissue-detail-readiness-v1", "source_manifest_sha256": dataset.digest,
        "source_split_sha256": dataset.split_digest, "patch_size": 128,
        "minimum_valid_fraction": minimum_valid_fraction, "critic_minimum_coverage": critic_minimum_coverage,
        "commercial_only": commercial_only, "policy_source_sha256": {
            name: sha256(Path(__file__).with_name(name)) for name in ("data.py", "readiness.py", "model.py")}}
    output = Path(output)
    if prepare_result_attempt(output, identity):
        return json.loads((output / "readiness.json").read_text())
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".detail-readiness-", dir=output.parent))
    scanned, minimum_fields = 0, 1024
    try:
        indices = dataset.splits["train"] + dataset.splits["val"]
        for index in indices:
            _, mask, _ = dataset.load(index, 128, minimum_valid_fraction=minimum_valid_fraction)
            fields = minimum_critic_fields(mask[0], critic_minimum_coverage)
            if fields < 1:
                raise ValueError(f"native crop lacks critic support under augmentation: {dataset.records[index]['id']}")
            minimum_fields = min(minimum_fields, fields)
            scanned += 1
            if progress and (scanned % 128 == 0 or scanned == len(indices)):
                progress({"stage": "native-readiness", "scanned": scanned, "total": len(indices)})
        raw = Path(manifest).read_bytes()
        if sha256(Path(manifest)) != dataset.digest:
            raise ValueError("source native manifest changed during readiness")
        (stage / "records.jsonl").write_bytes(raw)
        report = {"schema": "viscera.native-tissue-detail-readiness/v1", "identity": identity,
            "derived_manifest_sha256": dataset.digest, "derived_split_sha256": dataset.split_digest,
            "source_summary": dataset.summary(), "derived_summary": dataset.summary(),
            "scanned_train_val_rows": scanned, "test_payloads_opened": 0,
            "retained_test_rows": len(dataset.splits["test"]), "excluded_count": 0,
            "minimum_critic_fields_over_all_augmentations": minimum_fields,
            "policy": "Prepared native128 crops must all pass; no hidden additional filtering or resizing."}
        (stage / "readiness.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
        complete_result(stage, identity)
        stage.rename(output)
        return report
    except BaseException as error:
        (stage / "failure.json").write_text(json.dumps({"error": str(error), "scanned": scanned,
            "identity": identity, "source_preserved": True, "published": False}, indent=2) + "\n")
        raise
