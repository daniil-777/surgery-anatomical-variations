#!/usr/bin/env python3
"""Verify an exact downloaded review ZIP before publishing its audit files.

Use hashes copied from the trusted Colab download receipt, not hashes supplied by
the ZIP. No dataset payloads or checkpoint tensors are executed or extracted.
The output is exclusive: an existing path is never reused or overwritten.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "py"))

BUNDLE_SHA = "8a0774e90b453408519bf054c95baf54558e2be554e037d262e45acc95df5313"
RELEASE_SHA = "2a21780ad302b0224cfa0d356c7dd888ff8bf6db30ab721fef69d2699b79f485"
RUN_ID = "prepared_group_split-fbb1f0815680319f0fd829f9"
LIMIT = 65 * 1024**2  # Original selected payloads <64 MiB, plus small inventory.
INVENTORY = "download-inventory.json"
RECEIPT = "local-verification.json"
CONDITIONS = tuple((f"human:laparoscopic_exterior:{label}", region, "human")
                   for label, region in (("colon", "large_bowel"), ("liver", "liver"),
                       ("pancreas", "pancreas"), ("small_intestine", "small_bowel"),
                       ("spleen", "spleen"), ("stomach", "stomach")))


@dataclass(frozen=True)
class Expectations:
    run_id: str = RUN_ID
    bundle_sha256: str = BUNDLE_SHA
    release_sha256: str = RELEASE_SHA
    steps: int = 2000
    patch_size: int = 128
    source_counts: tuple[int, int, int] = (4443, 1048, 1868)
    conditions: tuple[tuple[str, str, str], ...] = CONDITIONS


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def file_sha(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def require(condition, message: str) -> None:
    if not condition:
        raise ValueError(message)


def checked_sha(value: object) -> str:
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value), "invalid SHA256")
    return value


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def strict_json(raw: bytes):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, f"duplicate JSON key: {key}")
            result[key] = value
        return result

    def invalid_constant(value):
        raise ValueError(f"nonfinite JSON number: {value}")

    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)


def safe_name(name: str) -> None:
    require(isinstance(name, str) and len(name) <= 400
            and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", name)
            and all(part not in ("", ".", "..") for part in name.split("/")),
            f"unsafe archive name: {name!r}")


def no_symlinks(path: Path) -> None:
    for part in (path, *path.parents):
        require(not part.is_symlink(), f"symlink path is forbidden: {part}")


def read_archive(path: Path, expected_sha256: str) -> dict[str, bytes]:
    checked_sha(expected_sha256)
    no_symlinks(path)
    require(path.is_file() and path.stat().st_size <= LIMIT + 1024**2,
            "archive missing, nonregular or oversized")
    # Hash and ZIP operations share an open descriptor, then hash it again after
    # verification. No dependence on an attacker-replaced path between reads.
    with path.open("rb") as stream:
        require(hashlib.file_digest(stream, "sha256").hexdigest() == expected_sha256,
                "trusted archive SHA256 mismatch")
        stream.seek(0)
        with zipfile.ZipFile(stream) as archive:
            infos = archive.infolist()
            require(1 < len(infos) <= 256, "archive member count outside bound")
            names = set()
            for info in infos:
                safe_name(info.orig_filename)
                require(info.orig_filename == info.filename, "truncated archive member name")
                require(info.filename not in names, "duplicate archive member")
                names.add(info.filename)
                kind = stat.S_IFMT(info.external_attr >> 16)
                require(not info.is_dir() and kind in (0, stat.S_IFREG),
                        "archive members must be regular files; symlinks are forbidden")
                require(not info.flag_bits & 1 and info.compress_type in
                        (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), "unsupported ZIP encoding")
                require(0 <= info.file_size <= LIMIT, "oversized archive member")
            require(sum(info.file_size for info in infos) <= LIMIT, "archive exceeds expanded bound")
            require(INVENTORY in names, "archive inventory missing")
            require(archive.getinfo(INVENTORY).file_size <= 1024**2, "inventory oversized")
            inventory_raw = archive.read(INVENTORY)
            inventory = strict_json(inventory_raw)
            require(isinstance(inventory, dict) and set(inventory) == names - {INVENTORY},
                    "archive inventory is not exact")
            payloads = {INVENTORY: inventory_raw}
            for name, record in inventory.items():
                require(isinstance(record, dict) and set(record) == {"bytes", "sha256"},
                        "invalid inventory record")
                checked_sha(record["sha256"])
                require(type(record["bytes"]) is int and record["bytes"] >= 0
                        and record["bytes"] == archive.getinfo(name).file_size,
                        "inventory byte count mismatch")
                raw = archive.read(name)  # ZipFile checks CRC and advertised stream size.
                require(len(raw) == record["bytes"] and sha(raw) == record["sha256"],
                        f"inventory SHA256 mismatch: {name}")
                payloads[name] = raw
        stream.seek(0)
        require(hashlib.file_digest(stream, "sha256").hexdigest() == expected_sha256,
                "archive changed during verification")
    return payloads


def completion(payloads: dict[str, bytes], prefix: str, identity: dict) -> None:
    marker = strict_json(payloads[prefix + "/completed-result.json"])
    require(marker.get("identity") == identity, f"completion identity mismatch: {prefix}")
    actual = {name[len(prefix) + 1:] for name in payloads
              if name.startswith(prefix + "/") and name != prefix + "/completed-result.json"}
    require(isinstance(marker.get("files"), dict) and set(marker["files"]) == actual,
            f"completion inventory mismatch: {prefix}")
    for name, record in marker["files"].items():
        raw = payloads[prefix + "/" + name]
        require(record == {"bytes": len(raw), "sha256": sha(raw)},
                f"completion hash mismatch: {prefix}/{name}")


def source_modules(bundle: Path, expected_sha256: str) -> dict[str, str]:
    no_symlinks(bundle)
    require(file_sha(bundle) == expected_sha256, "trusted source bundle SHA256 mismatch")
    with zipfile.ZipFile(bundle) as archive:
        prefix = "py/viscera_core/tissue_learning/"
        return {Path(name).name: sha(archive.read(name)) for name in archive.namelist()
                if name.startswith(prefix) and name.endswith(".py")}


def validate_graph(payloads: dict[str, bytes], stage: Path, expected_model_sha256: str,
                   expected: Expectations, modules: dict[str, str]) -> dict:
    # Imports are local reviewed code. Data-only model loading checks float32
    # tensor bounds, SHA, shape/order, deterministic seed and reference inference.
    from viscera_core.tissue_learning.artifact import load_artifact
    from viscera_core.tissue_learning.data import TissueDataset

    def document(name):
        require(name in payloads, f"required file missing: {name}")
        return strict_json(payloads[name])

    models = [name for name in payloads if name.endswith(".tissue-model.json")]
    require(len(models) == 1 and "/" not in models[0], "exactly one root model is required")
    model_name = models[0]
    require(sha(payloads[model_name]) == checked_sha(expected_model_sha256),
            "trusted whole-model SHA256 mismatch")
    document(model_name)  # Reject duplicate JSON keys before the existing loader.
    model = load_artifact(stage / model_name)
    provenance, architecture = model["provenance"], model["architecture"]
    require(tuple(zip(architecture["condition_labels"], architecture["condition_regions"],
                      architecture["condition_species"])) == expected.conditions,
            "condition scope differs from expected research run")
    require(provenance["training_steps"] == expected.steps
            and provenance["training_native_patch_size"] == expected.patch_size
            and provenance["training_status"] == "research_trained"
            and provenance["qualification"] == "engineering_unqualified", "model training identity mismatch")
    require(model["output"]["kind"] == "observed_rgb_appearance"
            and model["output"]["pbr_ground_truth"] is False
            and model["output"]["clinically_validated"] is False, "unsupported model output claim")
    run = document("run-identity.json")
    require(run["schema"] == "viscera.tissue-notebook-run/v1"
            and run["run_id"] == expected.run_id
            and run["data_mode"] == "prepared_group_split"
            and run["source_bundle_sha256"] == expected.bundle_sha256
            and run["dataset_release_sha256"] == expected.release_sha256, "run identity mismatch")
    run_payload = {key: value for key, value in run.items() if key != "run_id"}
    require(run["run_id"] == run["data_mode"] + "-" + sha(canonical(run_payload))[:24],
            "run ID does not match canonical experiment identity")
    request = document("request.json")
    config = request["config"]
    require(request["schema"] == "viscera.tissue-training-request/v1"
            and config == run["config"] and sha(canonical(config)) == request["config_sha256"]
            and provenance["config_sha256"] == request["config_sha256"], "training config identity mismatch")
    require(config["steps"] == expected.steps and config["patch_size"] == expected.patch_size
            and config["fixture"] is False and config["commercial_only"] is False
            and config["validation_mode"] == "heldout" and config["device"] == "cuda"
            and config["precision"] == "bfloat16", "unexpected training configuration")
    require(request["source_sha256"] == provenance["source_sha256"] == modules,
            "training module hashes differ from trusted source bundle")
    require(request["environment"] == provenance["environment"], "training environment mismatch")
    require(request["condition_regions"] == architecture["condition_regions"]
            and request["condition_species"] == architecture["condition_species"],
            "request condition mapping mismatch")
    pointer = document("checkpoints/latest.json")
    directory = f"step-{expected.steps:09d}"
    checkpoint_name = f"checkpoints/{directory}/manifest.json"
    checkpoint = document(checkpoint_name)
    checkpoint_sha = sha(payloads[checkpoint_name])
    require(pointer == {"directory": directory, "manifest_sha256": checkpoint_sha},
            "checkpoint pointer mismatch")
    require(checkpoint["schema"] == "viscera.tissue-checkpoint/v1"
            and checkpoint["request"] == request
            and set(checkpoint["files"]) == {"state.json", "tensors.safetensors"},
            "checkpoint training request mismatch")
    for record in checkpoint["files"].values():
        checked_sha(record["sha256"])
        require(type(record["bytes"]) is int and record["bytes"] > 0,
                "invalid checkpoint file declaration")
    require(provenance["checkpoint_manifest_sha256"] == checkpoint_sha,
            "model/checkpoint identity mismatch")
    require(model_name == f"{expected.run_id}-{directory}-{checkpoint_sha[:16]}.tissue-model.json",
            "model filename differs from selected checkpoint")
    training = document("training-receipt.json")
    require(training["status"] == "completed" and training["committed_updates"] == expected.steps
            and training["checkpoint_manifest_sha256"] == checkpoint_sha
            and training["qualification"] == "engineering_unqualified"
            and training["fixture"] is False, "training completion receipt mismatch")
    readiness = document("data-readiness/readiness.json")
    derived_sha = sha(payloads["data-readiness/records.jsonl"])
    require(derived_sha == readiness["derived_manifest_sha256"]
            == run["training_manifest_sha256"] == provenance["dataset_manifest_sha256"],
            "derived training manifest identity mismatch")
    require(readiness["schema"] == "viscera.tissue-training-readiness/v1"
            and readiness["test_payloads_opened"] == 0, "invalid readiness/test isolation claim")
    require(readiness["identity"]["patch_size"] == expected.patch_size
            and readiness["identity"]["minimum_valid_fraction"] == config["minimum_valid_fraction"]
            and readiness["identity"]["policy_source_sha256"] ==
            {name: modules[name] for name in ("readiness.py", "data.py")}, "readiness policy mismatch")
    completion(payloads, "data-readiness", readiness["identity"])
    release = document("source-release/release.json")
    require(sha(payloads["source-release/release.json"]) == expected.release_sha256,
            "trusted source release identity mismatch")
    require(release["schema"] == "viscera.observed-rgb-dataset/v3" and release["dataset_id"] == "dsad"
            and set(release["manifests"]) == {"records.jsonl", "train.jsonl", "val.jsonl", "test.jsonl"},
            "source release schema/inventory mismatch")
    for name, record in release["manifests"].items():
        raw = payloads["source-release/" + name]
        require(record == {"bytes": len(raw), "sha256": sha(raw)}, "source manifest hash mismatch")
    source = TissueDataset(stage / "source-release/records.jsonl", stage, commercial_only=False)
    derived = TissueDataset(stage / "data-readiness/records.jsonl", stage, commercial_only=False)
    require(source.summary() == readiness["source_summary"]
            and source.digest == readiness["identity"]["source_manifest_sha256"]
            and source.split_digest == readiness["identity"]["source_split_sha256"],
            "source summary/split identity mismatch")
    require(derived.summary() == readiness["derived_summary"] == request["data"]
            == provenance["dataset_summary"] and derived.split_digest
            == readiness["derived_split_sha256"] == provenance["split_manifest_sha256"],
            "derived summary/split identity mismatch")
    require(source.conditions == architecture["condition_labels"], "source condition vocabulary mismatch")
    source_lines = payloads["source-release/records.jsonl"].splitlines(keepends=True)
    require(all(line.strip() for line in source_lines), "unexpected blank source record")
    counts = {split: len(source.splits[split]) for split in ("train", "val", "test")}
    require(tuple(counts.values()) == expected.source_counts
            and release["records_by_split"] == counts and release["records"] == sum(counts.values()),
            "source record counts mismatch")
    for split in counts:
        require(payloads[f"source-release/{split}.jsonl"] == b"".join(
            source_lines[index] for index in source.splits[split]), "source split rows not byte-preserved")
    excluded = readiness["excluded_rows"]
    excluded_by_id = {row["id"]: row for row in excluded}
    require(len(excluded_by_id) == len(excluded) == readiness["excluded_count"], "duplicate/count exclusion mismatch")
    kept, matched = [], set()
    for raw, row in zip(source_lines, source.records, strict=True):
        if row["id"] not in excluded_by_id:
            kept.append(raw)
            continue
        item = excluded_by_id[row["id"]]
        require(row["split"] in ("train", "val") and all(item[key] == row.get(key)
                for key in ("split", "group_id", "condition", "image_sha256", "mask_sha256"))
                and item["original_row_sha256"] == sha(raw)
                and item["reason"] == "insufficient_valid_tissue_coverage_after_center_and_mask_bbox_crops"
                and item["required_valid_fraction"] == config["minimum_valid_fraction"]
                and 0 <= item["best_valid_fraction"] < item["required_valid_fraction"],
                "readiness exclusion is not a matching coverage-only source row")
        matched.add(row["id"])
    require(matched == set(excluded_by_id) and b"".join(kept) == payloads["data-readiness/records.jsonl"],
            "derived manifest is not exactly retained original rows")
    require(readiness["retained_test_rows"] == counts["test"]
            and readiness["scanned_train_val_rows"] == counts["train"] + counts["val"]
            and readiness["exclusions_by_split"] == {split: sum(row["split"] == split for row in excluded)
                                                     for split in ("train", "val")}, "readiness accounting mismatch")
    diagnostic_prefix = "diagnostics-" + expected_model_sha256[:16]
    diagnostic = document(diagnostic_prefix + "/diagnostics.json")
    require(diagnostic["model_file_sha256"] == expected_model_sha256
            and diagnostic["checkpoint_manifest_sha256"] == checkpoint_sha
            and diagnostic["data_summary"] == derived.summary()
            and diagnostic["measurement_split"] == "val"
            and diagnostic["qualification"] == "engineering_unqualified"
            and diagnostic["training_native_patch_size"] == expected.patch_size,
            "diagnostic model/data/checkpoint identity mismatch")
    completion(payloads, diagnostic_prefix, {"kind": "tissue-diagnostics",
        "model_sha256": expected_model_sha256, "checkpoint_manifest_sha256": checkpoint_sha,
        "run_id": expected.run_id})
    attempts = {name.split("/")[1] for name in payloads if name.startswith("attempts/")}
    require(len(attempts) == 1 and re.fullmatch(r"[0-9a-f]{16}", next(iter(attempts))),
            "exactly one bounded attempt identity is required")
    attempt = "attempts/" + next(iter(attempts))
    environment = document(attempt + "/environment-installation.json")
    require(environment["manifest_sha256"] == run["environment_lock_manifest_sha256"],
            "environment lock identity mismatch")
    document(attempt + "/gpu-preflight.json")
    allowed = {INVENTORY, model_name, checkpoint_name, "checkpoints/latest.json", "request.json",
        "training-receipt.json", "run-identity.json", "data-readiness/readiness.json",
        "data-readiness/records.jsonl", "data-readiness/completed-result.json",
        *["source-release/" + name for name in ("release.json", "records.jsonl", "train.jsonl", "val.jsonl", "test.jsonl")],
        *[attempt + "/" + name for name in ("gpu-preflight.json", "environment-installation.json", "installed-packages.txt")],
        *[diagnostic_prefix + "/" + name for name in ("diagnostics.json", "appearance-comparison.png", "loss-trace.png", "completed-result.json")],
        *[f"{diagnostic_prefix}/condition-{index}-seed42-256.png" for index in range(len(expected.conditions))]}
    require(set(payloads) == allowed, "review archive includes missing or unapproved files")
    return {"schema": "viscera.completed-run-local-verification/v1", "passed": True,
        "run_id": expected.run_id, "model": model_name, "model_sha256": expected_model_sha256,
        "checkpoint_manifest_sha256": checkpoint_sha, "source_bundle_sha256": expected.bundle_sha256,
        "source_release_sha256": expected.release_sha256, "training_manifest_sha256": derived_sha,
        "source_counts": counts, "retained_counts": {key: len(value) for key, value in derived.splits.items()},
        "excluded_count": len(excluded), "training_steps": expected.steps,
        "metadata_split_isolation_verified": True, "test_payloads_opened_locally": 0,
        "decoder_reference_and_seed_verified": True, "checkpoint_tensors_reloaded": False,
        "photorealism_evaluated": False, "qualification": "engineering_unqualified"}


def verify(archive: Path, expected_archive_sha256: str, expected_model_sha256: str,
           output: Path, bundle: Path, *, expected: Expectations = Expectations()) -> dict:
    archive, output, bundle = Path(archive).absolute(), Path(output).absolute(), Path(bundle).absolute()
    no_symlinks(output)
    require(not output.exists(), "output already exists; use a new exclusive directory")
    require(output.parent.is_dir(), "output parent must already exist")
    payloads = read_archive(archive, expected_archive_sha256)
    modules = source_modules(bundle, expected.bundle_sha256)
    temporary = Path(tempfile.mkdtemp(prefix=".review-verification-", dir=output.parent))
    try:
        for name, raw in payloads.items():
            path = temporary / name
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("xb") as stream:
                stream.write(raw)
        receipt = validate_graph(payloads, temporary, expected_model_sha256, expected, modules)
        receipt.update(archive_sha256=expected_archive_sha256, archive_bytes=archive.stat().st_size,
            inventory_files=len(payloads) - 1, verifier_sha256=file_sha(Path(__file__)), output=str(output))
        # Exclusive reservation prevents a rename from replacing another process's
        # destination. The final receipt is the publication marker, written last.
        output.mkdir(exist_ok=False)
        for child in temporary.iterdir():
            child.rename(output / child.name)
        with (output / RECEIPT).open("x") as stream:
            json.dump(receipt, stream, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        return receipt
    finally:
        shutil.rmtree(temporary)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--expected-archive-sha256", required=True)
    parser.add_argument("--expected-model-sha256", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, default=ROOT / "artifacts/colab/viscera-tissue-learning-colab.zip")
    args = parser.parse_args()
    try:
        result = verify(args.archive, args.expected_archive_sha256, args.expected_model_sha256,
                        args.output, args.bundle)
    except (ValueError, KeyError, TypeError, OSError, zipfile.BadZipFile) as error:
        parser.exit(1, f"Verification failed; original archive preserved: {error}\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
