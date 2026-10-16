"""Separate, provenance-bound 10k wording candidate; frozen trainer stays unchanged.

This is an optional time-budgeted experiment, not completion of the 192k-row run.
Production promotion thresholds are never modified. Construction does not parse
audit/challenge examples; their bytes and original partition membership survive.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import heapq
import json
import math
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time
import zipfile

BUNDLE_SHA = "83a631a7564c5cc2a6a2c3f2b9196e2be9a0be03ed2028172b5a7451f2ea8ddb"
PARENT_SHA = "80d70d5c002ba1ea82ffc7d240b8d74c25f23594a4dfe9ea48070de14602cd44"
PREFIX = "viscera-wording-training"
SEED = 20261008
COUNT = 10_000
AUDIT_LIMIT = 512
RUN_CONFIG = {"epochs": 2, "checkpoint_every": 25, "seed": SEED, "device": "cuda"}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path, value):
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(canonical(value) + "\n")
    os.replace(temporary, path)


def verify_files(directory, hashes):
    for name, expected in hashes.items():
        path = directory / name
        if (not path.resolve().is_relative_to(directory.resolve())
                or path.is_symlink() or digest(path) != expected):
            raise ValueError("Changed artifact: " + name)


def verify_parent(root, archive):
    if digest(archive) != BUNDLE_SHA:
        raise ValueError("Expected the original frozen wording training ZIP")
    with zipfile.ZipFile(archive) as bundle:
        frozen_manifest = bundle.read(PREFIX + "/bundle_manifest.json")
    if (root / "bundle_manifest.json").read_bytes() != frozen_manifest:
        raise ValueError("Extracted bundle manifest differs from the pinned ZIP")
    manifest = json.loads(frozen_manifest)
    if (manifest["format"] != "viscera-wording-training-bundle-v2"
            or manifest["dataset_release_sha256"] != PARENT_SHA):
        raise ValueError("Unexpected wording parent release")
    verify_files(root, manifest["artifact_hashes"])
    data = root / "dataset"
    if digest(data / "release.json") != PARENT_SHA:
        raise ValueError("Parent release changed")
    release = json.loads((data / "release.json").read_text())
    verify_files(data, release["artifact_hashes"])
    return data, release, manifest


def bucket(row):
    context = row["context"]
    return (row["target"]["status"], row["family_id"], context["organ"],
            context["renderer_version"], bool(context.get("disease")))


def row_stats(rows):
    stats = {key: collections.Counter() for key in ("organ", "renderer", "context", "status")}
    for row in rows:
        context = row["context"]
        stats["organ"][context["organ"]] += 1
        stats["renderer"][context["renderer_version"]] += 1
        stats["context"]["active_disease" if context.get("disease") else "baseline"] += 1
        stats["status"][row["target"]["status"]] += 1
    return stats


def lines(path):
    with path.open("rb") as handle:
        for line in handle:
            if line.strip():
                yield line, json.loads(line)


def select_training(parent):
    """Proportional statuses, equal round-robin coverage within each status.

    A bucket preserves phrase family, organ, renderer and disease/baseline state.
    Within each bucket, retain the smallest SHA256(seed:id) ranks. No label is
    generated or changed, and no held-out row participates in sampling.
    """
    counts, status_counts = collections.Counter(), collections.Counter()
    original = {key: collections.Counter() for key in ("organ", "renderer", "context", "status")}
    seen_ids = set()
    for _, row in lines(parent / "train.jsonl"):
        if row["split"] != "train" or row["id"] in seen_ids:
            raise ValueError("Invalid or duplicate parent training row")
        seen_ids.add(row["id"])
        key = bucket(row)
        counts[key] += 1
        status_counts[key[0]] += 1
        for name, values in row_stats([row]).items():
            original[name].update(values)
    total = sum(status_counts.values())
    quotas = {s: COUNT * n // total for s, n in status_counts.items()}
    remaining = COUNT - sum(quotas.values())
    for status in sorted(status_counts, key=lambda s: (-(COUNT * status_counts[s] % total), s))[:remaining]:
        quotas[status] += 1
    allocation = {key: 0 for key in counts}
    for status, amount in sorted(quotas.items()):
        keys = sorted(key for key in counts if key[0] == status)
        while amount:
            progressed = False
            for key in keys:
                if amount and allocation[key] < counts[key]:
                    allocation[key] += 1
                    amount -= 1
                    progressed = True
            if not progressed:
                raise ValueError("Insufficient training rows for status quota")
    heaps = {key: [] for key in counts}
    for line, row in lines(parent / "train.jsonl"):
        key = bucket(row)
        rank = int(hashlib.sha256(f"{SEED}:{row['id']}".encode()).hexdigest(), 16)
        candidate = (-rank, row["id"], line)
        if len(heaps[key]) < allocation[key]:
            heapq.heappush(heaps[key], candidate)
        elif allocation[key] and candidate > heaps[key][0]:
            heapq.heapreplace(heaps[key], candidate)
    selected = sorted((item for heap in heaps.values() for item in heap), key=lambda item: (-item[0], item[1]))
    rows = [json.loads(item[2]) for item in selected]
    if (len(rows) != COUNT or len({r["family_id"] for r in rows}) != 75
            or len({r["context"]["organ"] for r in rows}) != 12
            or len({r["context"]["renderer_version"] for r in rows}) != 2):
        raise ValueError("Candidate lost required family/organ/renderer coverage")
    return b"".join(item[2] for item in selected), rows, original, {
        "method": "status_proportional_then_family_organ_renderer_disease_round_robin_sha256_rank",
        "seed": SEED, "status_quotas": quotas, "parent_buckets": len(counts),
        "represented_buckets": sum(bool(value) for value in allocation.values()),
        "training_rows": len(rows), "phrase_families": 75, "organs": 12, "renderers": 2,
    }


def prepare(root, archive, output):
    parent, original_release, manifest = verify_parent(root, archive)
    payload, selected, original_stats, selection = select_training(parent)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".wording-candidate-", dir=output.parent) as tmp:
        stage = Path(tmp) / "dataset"
        stage.mkdir()
        for name in ("val.jsonl", "audit.jsonl", "challenge.jsonl", "phrase_families.json"):
            shutil.copyfile(parent / name, stage / name)
        shutil.copyfile(parent / "DATASET_CARD.md", stage / "PARENT_DATASET_CARD.md")
        (stage / "train.jsonl").write_bytes(payload)
        selection.update({
            "parent_release_file_sha256": PARENT_SHA, "parent_bundle_sha256": BUNDLE_SHA,
            "wrapper_sha256": digest(Path(__file__)), "train_sha256": digest(stage / "train.jsonl"),
            "predeclared_audit_limit": AUDIT_LIMIT, "production_gates": "unchanged",
            "training_config_overrides": RUN_CONFIG, "expected_optimizer_steps": 625,
            "heldout_partitions_byte_identical": True,
            "audit_and_challenge_examples_parsed_during_construction": False,
            "frozen_trainer_sha256": manifest["artifact_hashes"]["source/pipelines/train/viscera_train/atlas_wording.py"],
        })
        write_json(stage / "selection.json", selection)
        (stage / "DATASET_CARD.md").write_text(
            "# VISCERA wording 10k expedited candidate\n\n"
            "A separate 10,000-row training subset of the frozen 2026-10-07 release. "
            "This is not completion of the original 192,000-row training run. "
            "All 75 training phrase families, 12 organs, both renderers and "
            "disease/baseline contexts remain represented. Status proportions are "
            "retained; within status, available family/organ/renderer/context buckets "
            "receive deterministic round-robin quotas. Rows and targets are unchanged.\n\n"
            "Original validation (24,000), audit (24,000) and challenge (81) files "
            "are copied byte-for-byte. No audit/challenge example is parsed while "
            "constructing this subset. Final evaluation is predeclared at 512 "
            "stratified audit examples and the full challenge. All existing promotion "
            "thresholds apply. Quality and completion time are not guaranteed.\n\n"
            "Supervision is synthetic authored visual-design intent, not patient "
            "observations or clinically reviewed anatomy. Parent scope/limitations "
            "remain applicable; see PARENT_DATASET_CARD.md and selection.json.\n"
        )
        release = json.loads(canonical(original_release))
        release.pop("release_sha256", None)
        release["dataset_version"] = "atlas-wording-2.0.0-expedited-10k-2026-10-08"
        release["counts"]["train"] = COUNT
        release["rows"] = sum(release["counts"].values())
        release["seed"] = SEED
        release["split_policy"] = "parent_partitions_retained; deterministic_balanced_train_subset_only"
        release["derivative"] = selection
        updated = row_stats(selected)
        for short, name in (("organ", "organ_counts"), ("renderer", "renderer_counts"), ("context", "context_counts")):
            release[name] = {key: value - original_stats[short][key] + updated[short][key]
                             for key, value in original_release[name].items()}
        for status, count in updated["status"].items():
            release["status_counts"]["train:" + status] = count
        release["unique_normalized_texts"]["train"] = len({
            re.sub(r"[^\w%.+-]+", " ", row["text"].lower()).strip() for row in selected
        })
        release["artifact_hashes"] = {p.name: digest(p) for p in sorted(stage.iterdir())}
        release["release_sha256"] = hashlib.sha256(canonical(release).encode()).hexdigest()
        write_json(stage / "release.json", release)
        if output.exists():
            if (output / "release.json").read_bytes() != (stage / "release.json").read_bytes():
                raise ValueError("Existing candidate differs; preserve it and choose another output")
            verify_files(output, release["artifact_hashes"])
        else:
            os.replace(stage, output)
    result = {**selection, "dataset_release_file_sha256": digest(output / "release.json"), "dataset": str(output)}
    print(canonical(result), flush=True)
    return result


def verify_candidate(data):
    release = json.loads((data / "release.json").read_text())
    selected = release["derivative"]
    if (selected["parent_release_file_sha256"] != PARENT_SHA
            or selected["wrapper_sha256"] != digest(Path(__file__))
            or selected["training_config_overrides"] != RUN_CONFIG
            or selected["predeclared_audit_limit"] != AUDIT_LIMIT
            or selected["training_rows"] != COUNT):
        raise ValueError("Candidate configuration/provenance changed")
    verify_files(data, release["artifact_hashes"])


def worker(action, data, run):
    verify_candidate(data)
    from pipelines.train.viscera_train.atlas_wording import WordingConfig, evaluate, train
    if action == "worker-train":
        config = WordingConfig(**RUN_CONFIG)
        train(data, run, config, resume=(run / "checkpoint.pt").is_file())
    else:
        if (run / "evaluation.json").exists():
            raise ValueError("Audit already exists; inspect its result, do not silently repeat or tune")
        result = evaluate(data, run, limit=AUDIT_LIMIT, device="cuda")
        print(canonical({"passed": result["passed"], "gates": result["gates"]}), flush=True)
        if not result["passed"]:
            raise RuntimeError("Original production gates failed; no export or activation")


def monitored(action, python, root, data, run, budget):
    verify_candidate(data)
    run.mkdir(parents=True, exist_ok=True)
    environment = dict(os.environ, PYTHONPATH=str(root / "source/py") + os.pathsep + str(root / "source"), TOKENIZERS_PARALLELISM="false")
    command = [str(python), "-u", str(Path(__file__).resolve()), "worker-" + action,
               "--data", str(data), "--run", str(run)]
    process = subprocess.Popen(command, cwd=root / "source", env=environment,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    messages = queue.Queue()

    def read_output():
        for line in process.stdout:
            messages.put(line)
        messages.put(None)

    threading.Thread(target=read_output, daemon=True).start()
    started, first, warned = time.monotonic(), None, False
    log = run / (action + "-candidate.log")
    try:
        with log.open("a") as handle:
            while True:
                try:
                    line = messages.get(timeout=1)
                except queue.Empty:
                    elapsed = time.monotonic() - started
                    if elapsed > budget and not warned:
                        print("Soft time budget reached; run remains active and checkpoints are preserved. No quality gates are bypassed.", flush=True)
                        warned = True
                    continue
                if line is None:
                    break
                print(line, end="", flush=True)
                handle.write(line)
                handle.flush()
                match = re.search(r"Step (\d+)/(\d+);", line)
                if match:
                    step, total = map(int, match.groups())
                    now = time.monotonic()
                    if first is None:
                        first = (step, now)
                    rate = (step - first[0]) / (now - first[1]) if step > first[0] else None
                    elapsed = now - started
                    telemetry = {"step": step, "total_steps": total, "elapsed_seconds": elapsed,
                                 "observed_optimizer_steps_per_second": rate,
                                 "estimated_training_seconds_remaining": (total-step)/rate if rate else None,
                                 "soft_budget_seconds_remaining": max(0, budget-elapsed),
                                 "estimate_excludes_final_validation_and_audit": True}
                    write_json(run / "candidate-timing.json", telemetry)
                    print("TIMING " + canonical(telemetry), flush=True)
        code = process.wait()
        if code:
            raise subprocess.CalledProcessError(code, command)
    except BaseException:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=30)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "train", "evaluate", "worker-train", "worker-evaluate"))
    parser.add_argument("--root", type=Path)
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--run", type=Path)
    parser.add_argument("--python", type=Path)
    parser.add_argument("--budget-seconds", type=float, default=2400)
    args = parser.parse_args()
    if args.action == "prepare":
        if args.root is None or args.archive is None:
            parser.error("prepare requires --root and --archive")
        prepare(args.root.resolve(), args.archive.resolve(), args.data.resolve())
    elif args.action.startswith("worker-"):
        worker(args.action, args.data.resolve(), args.run.resolve())
    else:
        if None in (args.root, args.python, args.run):
            parser.error("training/evaluation requires --root, --python and --run")
        if args.budget_seconds <= 0 or not math.isfinite(args.budget_seconds):
            parser.error("budget must be finite and positive")
        monitored(args.action, args.python.absolute(), args.root.resolve(), args.data.resolve(), args.run.resolve(), args.budget_seconds)


if __name__ == "__main__":
    main()
