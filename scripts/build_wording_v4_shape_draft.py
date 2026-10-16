"""Separate unpromotable draft correcting eight known v3 shape-label families.

Canonical frozen-parser probes supply magnitudes. This does not establish general
paraphrase agreement or repair the independent composition failures.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import shutil
import sys
from collections import Counter
from pathlib import Path

PARENT_SHA256 = "7e93065b7dd7133f1890857665a6e65e24f2171ff2e6983488d85b973e5dcb2f"
AFFECTED_FAMILIES = {
    "width_up_default": "wider",
    "width_down_default": "narrower",
    "height_up_default": "taller",
    "height_down_default": "shorter",
    "depth_up_default": "deeper",
    "depth_down_default": "flatter",
    "shape_preserve_disease": "wider",
    "shape_preserve_material": "wider",
}
DIRECTIONS = {"wider", "broader", "narrower", "taller", "shorter", "deeper", "flatter"}
QUALIFIERS = {"", "slightly", "a little"}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def qualitative_shape_operation(direction, qualifier, context):
    from viscera_core.atlas_semantic import parse_semantic

    if direction not in DIRECTIONS or qualifier not in QUALIFIERS:
        raise ValueError("Unsupported qualitative shape contract probe")
    clause = "make it " + (qualifier + " " if qualifier else "") + direction
    plan = parse_semantic(clause, context)
    if (
        plan["status"] != "accepted"
        or len(plan["operations"]) != 1
        or plan["operations"][0]["op"] != "shape_relative"
    ):
        raise ValueError("Frozen canonical shape contract no longer matches the probe")
    return copy.deepcopy(plan["operations"][0])


def revise_row(row):
    """Copy a row; correct only explicitly identified v3 qualitative families."""
    from viscera_core.atlas_semantic import plan_fingerprint, validate_plan

    result = copy.deepcopy(row)
    name = row["family_id"].split(".")[-1]
    correction = None
    if name in AFFECTED_FAMILIES:
        operation = qualitative_shape_operation(AFFECTED_FAMILIES[name], "", row["context"])
        edits = [item for item in result["target"]["operations"] if item["op"] == "shape_relative"]
        if (
            len(edits) != 1
            or edits[0]["field"] != operation["field"]
            or abs(edits[0]["value"]) != 0.1
        ):
            raise ValueError("Unexpected parent label in an identified defect family")
        before = copy.deepcopy(edits[0])
        edits[0].update(operation)
        correction = {
            "family": name,
            "before": before,
            "after": copy.deepcopy(operation),
            "method": "frozen_parser_canonical_qualitative_shape_clause",
        }
    checked = validate_plan(result["target"], result["context"], text=result["text"])
    if plan_fingerprint(checked) != plan_fingerprint(result["target"]):
        raise ValueError("Corrected target violates the frozen runtime contract")
    result["parent_row_id"] = row["id"]
    result["family_id"] = "v4.shape-contract." + row["family_id"]
    result["provenance"] = "v4_draft_known_shape_default_label_correction_after_exposed_v3_failure"
    if correction:
        result["label_correction"] = correction
    result["id"] = hashlib.sha256(
        canonical(
            {
                key: result[key]
                for key in ("context", "text", "family_id", "target", "parent_row_id")
            }
        ).encode()
    ).hexdigest()
    return result, correction


def normalize(text):
    return re.sub(r"[^\w%.+-]+", " ", text.lower()).strip()


def composition_examples(context, split):
    """Small explicit cross-domain/refusal supplement; not independent test data."""
    from viscera_core.atlas_semantic import parse_semantic, plan_fingerprint, validate_plan

    organ = context["organ"].replace("-", " ")
    prefix = f"make the {organ}" if split == "train" else f"please make this {organ}"
    phrases = [
        (
            "shape_material",
            prefix + " 7% wider and wetter"
            if split == "train"
            else prefix + " wetter and 7% wider",
            "accepted",
        ),
        (
            "shape_disease",
            prefix + " 7% wider and healthier"
            if split == "train"
            else prefix + " healthier and 7% wider",
            "accepted",
        ),
        ("conflicting_dimensions", prefix + " 7% wider but preserve dimensions", "unsupported"),
        ("conflicting_material", prefix + " wetter but preserve the material", "unsupported"),
        ("grain_up", prefix + " show more tissue grain", "accepted"),
        ("grain_down", prefix + " show less tissue grain", "accepted"),
        ("tint_up", prefix + " warmer", "accepted"),
        ("tint_down", prefix + " cooler", "accepted"),
    ]
    result = []
    for family, text, expected_status in phrases:
        target = parse_semantic(text, context)
        checked = validate_plan(target, context, text=text)
        if target["status"] != expected_status or plan_fingerprint(checked) != plan_fingerprint(
            target
        ):
            raise ValueError("Draft composition violates the frozen contract: " + text)
        result.append(
            {
                "split": split,
                "family_id": f"v4.draft.{split}.{family}",
                "text": text,
                "context": copy.deepcopy(context),
                "target": target,
                "provenance": "authored_supported_composition_draft_after_exposed_v3_failure",
                "clinical_review": "NOT_RUN",
                "coverage_family": family,
            }
        )
    for row in result:
        row["id"] = hashlib.sha256(canonical(row).encode()).hexdigest()
    return result


def build(source, parent, output):
    sys.path.insert(0, str(source / "py"))
    if output.exists() and any(output.iterdir()):
        raise ValueError("Draft output is immutable; choose a new empty directory")
    if digest(parent / "release.json") != PARENT_SHA256:
        raise ValueError("Expected the exact frozen v3 release")
    release = json.loads((parent / "release.json").read_text())
    for name, expected in release["artifact_hashes"].items():
        path = parent / name
        if (
            not path.resolve().is_relative_to(parent.resolve())
            or path.is_symlink()
            or digest(path) != expected
        ):
            raise ValueError("Parent artifact changed: " + name)
    for name, expected in release["source_hashes"].items():
        if digest(source / name) != expected:
            raise ValueError("Frozen runtime source changed: " + name)
    output.mkdir(parents=True, exist_ok=True)
    counts, corrections, identities, families, texts = {}, {}, {}, {}, {}
    supplement_coverage = {}
    excluded = set()
    for name in (
        "audit.jsonl",
        "challenge.jsonl",
        "exposed_v2_audit.jsonl",
        "exposed_v2_challenge.jsonl",
    ):
        with (parent / name).open() as stream:
            excluded.update(normalize(json.loads(line)["text"]) for line in stream)
    for split in ("train", "val"):
        correction_counts = Counter()
        identities[split], families[split], texts[split] = set(), set(), set()
        count = 0
        representative_contexts = {}
        with (
            (parent / (split + ".jsonl")).open() as rows,
            (output / (split + ".jsonl")).open("x") as target,
        ):
            for line in rows:
                old = json.loads(line)
                if old["split"] != split:
                    raise ValueError("Parent split identity mismatch")
                key = (
                    old["context"]["organ"],
                    old["context"]["renderer_version"],
                    bool(old["context"].get("disease")),
                )
                representative_contexts.setdefault(key, old["context"])
                row, correction = revise_row(old)
                if row["id"] in identities[split]:
                    raise ValueError("Duplicate draft row")
                identities[split].add(row["id"])
                families[split].add(row["family_id"])
                texts[split].add(row["text"].strip().casefold())
                if correction:
                    correction_counts[correction["family"]] += 1
                target.write(canonical(row) + "\n")
                count += 1
        coverage = Counter()
        with (output / (split + ".jsonl")).open("a") as target:
            for context in representative_contexts.values():
                for row in composition_examples(context, split):
                    if normalize(row["text"]) in excluded:
                        raise ValueError(
                            "Draft must not reuse exposed evaluation text: " + row["text"]
                        )
                    if row["id"] in identities[split]:
                        raise ValueError("Duplicate composition row")
                    identities[split].add(row["id"])
                    families[split].add(row["family_id"])
                    texts[split].add(row["text"].strip().casefold())
                    coverage[row["coverage_family"]] += 1
                    target.write(canonical(row) + "\n")
                    count += 1
        supplement_coverage[split] = dict(coverage)
        counts[split], corrections[split] = count, dict(correction_counts)
    for values in (identities, families, texts):
        if values["train"] & values["val"]:
            raise ValueError("Draft partition leakage")
    if sum(corrections["train"].values()) != 3072 or sum(corrections["val"].values()) != 768:
        raise ValueError("Unexpected known-defect coverage; unrelated labels must remain preserved")
    for name in ("audit", "challenge"):
        shutil.copyfile(parent / (name + ".jsonl"), output / ("exposed_v3_" + name + ".jsonl"))
        shutil.copyfile(
            parent / ("exposed_v2_" + name + ".jsonl"), output / ("exposed_v2_" + name + ".jsonl")
        )
    report = {
        "status": "draft_known_label_contract_repair",
        "counts": counts,
        "corrections": corrections,
        "composition_supplement": supplement_coverage,
        "parent_release_sha256": PARENT_SHA256,
        "source_hashes": release["source_hashes"],
        "builder_sha256": digest(Path(__file__)),
        "promotion_eligible": False,
        "training_executed": False,
        "new_independent_audit": "REQUIRED_NOT_CREATED",
        "remaining_limitations": [
            "Composition and preservation generalization remain unresolved",
            "This repairs eight known families, not every possible authored-label defect",
            "Existing v2/v3 audits are exposed regression evidence only",
            "Template/context multiplication does not establish broad language understanding",
        ],
    }
    (output / "correction_report.json").write_text(json.dumps(report, indent=2) + "\n")
    (output / "DATASET_CARD.md").write_text(
        "# V4 qualitative shape-contract draft\n\n"
        "This untrained, unpromotable draft corrects 3,072 training and 768 validation "
        "labels in eight identified v3 families. Default qualitative width/height/depth "
        "changes use the unchanged parser's ±5%, including width plus preservation. "
        "Separate tests establish ±3% for slightly/a little; those tests do not claim "
        "these variants were added to every family. Other labels, prompts and contexts "
        "are preserved. Original v3 files are unchanged. A small additional authored supplement "
        "covers shape+material, shape+disease, conflicting preservation and relative "
        "grain/tint edits across all organ/renderer/baseline-active contexts. These are "
        "compiler-validated training examples, not new independent evaluation data.\n\n"
        "At most 41 of the 279 incorrect v3 audit cases were in directly affected shape "
        "families. This defect does not explain the complete failure. Supported compound "
        "requests also failed; that generalization remains unresolved. A new independent "
        "holdout and broader reviewed instruction construction remain required. Exposed "
        "v2/v3 tests are regression evidence only. No audit.jsonl/challenge.jsonl, training "
        "or automatic export is supplied.\n"
    )
    draft_release = {
        "dataset_version": "atlas-wording-4.0.0-shape-contract-draft",
        "counts": counts,
        "parent_release_sha256": PARENT_SHA256,
        "source_hashes": release["source_hashes"],
        "construction_source_sha256": digest(Path(__file__)),
        "promotion_eligible": False,
        "training_executed": False,
        "evaluation_policy": "new_independent_evaluation_required_after_exposed_v3_failure",
        "artifact_hashes": {p.name: digest(p) for p in sorted(output.iterdir()) if p.is_file()},
    }
    (output / "release.json").write_text(canonical(draft_release) + "\n")
    if digest(parent / "release.json") != PARENT_SHA256:
        raise ValueError("Parent release changed during construction")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--parent", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    print(
        json.dumps(
            build(args.source_root.resolve(), args.parent.resolve(), args.out.resolve()), indent=2
        )
    )
