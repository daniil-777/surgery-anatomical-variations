"""Build a separate qualitative/context coverage repair; never alter frozen v2.

Authored plans are checked against the existing semantic validator. Previously
examined v2 audit/challenge bytes are retained as exposed regression evidence,
not relabelled as an independent promotion audit. A fresh audit is still needed.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import random
import re
import shutil
import sys

SEED = 20261008
FAMILIES = [
    ("health_down_default", "make the {organ} healthier", "make this {organ} look less diseased", "health", -.2),
    ("health_up_default", "make the {organ} sicker", "make this {organ} look more diseased", "health", .2),
    ("health_down_slight", "make the {organ} slightly healthier", "make this {organ} a little less diseased", "health", -.1),
    ("health_up_slight", "make the {organ} slightly sicker", "make this {organ} a little more diseased", "health", .1),
    ("health_down_percent", "make the {organ} {pct}% healthier", "make this {organ} {pct}% less diseased", "health_pct", -1),
    ("health_up_percent", "make the {organ} {pct}% sicker", "make this {organ} {pct}% more diseased", "health_pct", 1),
    ("lesion_smaller_default", "make the lesions smaller", "reduce lesion size", "size", -.2),
    ("lesion_larger_default", "make the lesions larger", "increase lesion size", "size", .2),
    ("severity_down_default", "reduce disease severity", "make disease severity weaker", "severity", -.2),
    ("severity_up_default", "increase disease severity", "make disease severity stronger", "severity", .2),
    ("contrast_down_default", "reduce disease contrast", "make disease contrast weaker", "contrast", -.2),
    ("contrast_up_default", "increase disease contrast", "make disease contrast stronger", "contrast", .2),
    ("width_up_default", "make the {organ} wider", "make this anatomy wider", "shape:width", .1),
    ("width_down_default", "make the {organ} narrower", "make this anatomy narrower", "shape:width", -.1),
    ("height_up_default", "make the {organ} taller", "make this anatomy taller", "shape:height", .1),
    ("height_down_default", "make the {organ} shorter", "make this anatomy shorter", "shape:height", -.1),
    ("depth_up_default", "make the {organ} deeper", "make this anatomy deeper", "shape:depth", .1),
    ("depth_down_default", "make the {organ} flatter", "make this anatomy flatter", "shape:depth", -.1),
    ("wetness_up", "make the {organ} wetter", "give this surface more sheen", "material:wetness", .15),
    ("wetness_down", "make the {organ} drier", "give this surface less sheen", "material:wetness", -.15),
    ("mottle_up", "make the surface more mottled", "give this surface more mottling", "material:pigment_contrast", .15),
    ("mottle_down", "make the surface less mottled", "give this surface less mottling", "material:pigment_contrast", -.15),
    ("baseline", "clear disease from the {organ}", "return this {organ} to baseline", "clear", 0),
    ("width_up_percent", "make the {organ} {pct}% wider", "change the width by {pct}%", "shape_pct:width", 1),
    ("height_down_percent", "make the {organ} {pct}% shorter", "change the height by -{pct}%", "shape_pct:height", -1),
    ("lesion_down_percent", "make the lesions {pct}% smaller", "reduce the lesion size by {pct}%", "disease_pct:size", -1),
    ("severity_up_percent", "increase disease severity by {pct}%", "make disease severity {pct}% stronger", "disease_pct:severity", 1),
    ("ambiguous", "make the {organ} more realistic", "make this {organ} abnormal", "clarify", 0),
    ("unsupported_topology", "cut away {pct}% of the {organ}", "resect {pct}% of this {organ}", "unsupported", 0),
    ("unsupported_physics", "give the {organ} stiffness {pct} kPa", "increase perfusion by {pct}%", "unsupported", 0),
    ("unsupported_clinical", "make the {organ} clinically stage 2", "make this tumor grade 3", "unsupported", 0),
    ("contradiction", "make the {organ} healthier and sicker", "make this {organ} wider and narrower", "unsupported", 0),
    ("health_preserve_shape", "make the {organ} healthier but preserve shape controls", "make this {organ} less diseased and keep shape controls unchanged", "health_preserve:shape_controls", -.2),
    ("health_preserve_material", "make the {organ} healthier but preserve the material", "make this {organ} less diseased and keep the material unchanged", "health_preserve:material", -.2),
    ("shape_preserve_disease", "make the {organ} wider but preserve the disease", "make this anatomy wider without changing the disease", "shape_preserve:disease", .1),
    ("shape_preserve_material", "make the {organ} wider but preserve the material", "make this anatomy wider without changing the material", "shape_preserve:material", .1),
    ("preserve_disease", "preserve the disease", "keep the disease unchanged", "preserve:disease", 0),
    ("preserve_material", "preserve the material", "keep the material unchanged", "preserve:material", 0),
    ("numeric_twist", "set twist to {value}", "use {value} for twist", "control_pct:twist", 1),
    ("numeric_bend", "set bend to {value}", "use {value} for bend", "control_pct:bend", 1),
    ("numeric_wetness", "set wetness to {value}", "use {value} for wetness", "material_set_pct:wetness", 1),
    ("numeric_tint", "set tint to {value}", "use {value} for tint", "material_set_pct:tint", 1),
    ("numeric_count", "set lesion count to {count}", "use {count} disease pattern sites", "count", 0),
    ("profile_choice", "select {profile} as the disease appearance", "use {profile}", "profile", 0),
    ("unsupported_function", "restore normal {organ} function", "improve the physiological function of the {organ}", "unsupported", 0),
    ("unsupported_treatment", "choose treatment for the {organ}", "recommend therapy for this {organ}", "unsupported", 0),
    ("unsupported_vessels", "add an artery to the {organ}", "reconstruct the vascular network of the {organ}", "unsupported", 0),
    ("unsupported_physical_lesion", "make a {pct} mm lesion", "set lesion diameter to {pct} mm", "unsupported", 0),
]


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def normalize(text):
    return re.sub(r"[^\w%.+-]+", " ", text.lower()).strip()


def build(source, parent, output):
    sys.path.insert(0, str(source / "py"))
    from viscera_core.atlas_semantic import make_plan, operation, plan_fingerprint, validate_plan
    from viscera_core.atlas_semantic_dataset import LEGACY_PROFILES, PROFILES, _context
    if output.exists() and any(output.iterdir()):
        raise ValueError("Release is immutable: choose a new empty output directory")
    parent_release = json.loads((parent / "release.json").read_text())
    parent_sha = digest(parent / "release.json")
    if parent_sha != "80d70d5c002ba1ea82ffc7d240b8d74c25f23594a4dfe9ea48070de14602cd44":
        raise ValueError("Unexpected frozen v2 parent")
    for name, expected in parent_release["artifact_hashes"].items():
        if digest(parent / name) != expected:
            raise ValueError("Parent artifact changed: " + name)
    for name, expected in parent_release["source_hashes"].items():
        if digest(source / name) != expected:
            raise ValueError("Frozen semantic source changed: " + name)
    organs = sorted({p["organ"] for p in PROFILES.values() if p["supported"]})
    assert len(organs) == 12
    all_rows, seen_text = {}, {}
    coverage = Counter()
    for split, repetitions in (("train", 8), ("val", 2)):
        rows = []
        rng = random.Random(SEED + (split == "val"))
        for name, train_phrase, val_phrase, kind, amount in FAMILIES:
            pattern = train_phrase if split == "train" else val_phrase
            for organ in organs:
                for renderer, profiles in (("legacy", LEGACY_PROFILES), ("disease-v2", PROFILES)):
                    available = sorted(k for k, p in profiles.items() if p["supported"] and p["organ"] == organ)
                    assert available, (organ, renderer)
                    for active in (False, True):
                        for repeat in range(repetitions):
                            profile = available[(repeat + len(name)) % len(available)]
                            context = _context(rng, profile if active else None, organ, renderer)
                            # Reserved exclusively for independently authored v3 holdouts.
                            for section in (context["material"], context.get("disease")):
                                if section and 3_100_000_000 <= section["seed"] < 3_200_000_000:
                                    section["seed"] = 4_000_000_000 + section["seed"] % 100_000_000
                            # Include common UI defaults as well as random continuous recipes.
                            if repeat % 2 == 0:
                                context["controls"].update(scale_x=0., scale_y=0., scale_z=0., bend=0., taper=0., twist=0., asymmetry=0.)
                                context["material"]["seed"] = 42
                                if context["disease"]:
                                    context["disease"].update(severity=.6, contrast=.5, size=.5, count=3, seed=42)
                            pct = (5, 10, 15, 20, 25, 30, 35, 40)[repeat]
                            text = pattern.format(organ=organ.replace("-", " "), pct=pct,
                                                  value=pct/100, count=repeat % 8 + 1, profile=profile)
                            wrappers = ("", "Please ", "Can you ", "For this anatomy, ", "In the current model, ", "I would like you to ")
                            text = wrappers[repeat % len(wrappers)] + text + ("." if repeat % 3 == 0 else "")
                            status, ops = "accepted", []
                            value = amount * pct / 100 if "pct" in kind else amount
                            if kind.startswith("health"):
                                if active:
                                    ops = [operation("disease_relative", field, value) for field in ("severity", "contrast")]
                                elif value > 0:
                                    status = "clarify"
                                if kind.startswith("health_preserve:"):
                                    ops.append(operation("preserve", kind.split(":")[-1]))
                            elif kind in ("size", "severity", "contrast") or kind.startswith("disease_pct:"):
                                if active:
                                    ops = [operation("disease_relative", kind.split(":")[-1], value)]
                                else:
                                    status = "clarify"
                            elif kind.startswith("shape_preserve:"):
                                ops = [operation("shape_relative", "width", value), operation("preserve", kind.split(":")[-1])]
                            elif kind.startswith("shape"):
                                ops = [operation("shape_relative", kind.split(":")[-1], value)]
                            elif kind.startswith("control_pct:"):
                                ops = [operation("control_set", kind.split(":")[-1], value)]
                            elif kind.startswith("material_set_pct:"):
                                ops = [operation("material_set", kind.split(":")[-1], value)]
                            elif kind.startswith("material:"):
                                ops = [operation("material_relative", kind.split(":")[-1], value)]
                            elif kind.startswith("preserve:"):
                                ops = [operation("preserve", kind.split(":")[-1])]
                            elif kind == "count":
                                ops = [operation("disease_set", "count", repeat % 8 + 1)] if active else []
                                if not active:
                                    status = "clarify"
                            elif kind == "profile":
                                ops = [operation("disease_set", "profile_id", profile)]
                            elif kind == "clear":
                                ops = [operation("disease_clear")]
                            else:
                                status = kind
                            target = make_plan(ops, status=status, message="Preserve unmentioned settings; apply only the requested supported visual edit." if status == "accepted" else "No edit: the request needs clarification or exceeds supported visual controls.")
                            checked = validate_plan(target, context, text=text)
                            if plan_fingerprint(checked) != plan_fingerprint(target):
                                raise ValueError(f"Invalid authored coverage target {split}/{name}: {text}: {checked}")
                            normalized = normalize(text)
                            if seen_text.get(normalized, split) != split:
                                raise ValueError("Cross-split wording collision: " + text)
                            seen_text[normalized] = split
                            family = f"v3.{split}.{name}"
                            identifier = hashlib.sha256(canonical({"context": context, "text": text, "family": family}).encode()).hexdigest()
                            rows.append({"id": identifier, "split": split, "family_id": family, "text": text, "context": context, "target": target,
                                         "provenance": "authored_v3_qualitative_coverage_patch_after_disclosed_v2_failure", "clinical_review": "NOT_RUN"})
                            coverage[(split, name, organ, renderer, "active" if active else "baseline")] += 1
        assert len({r["id"] for r in rows}) == len(rows)
        all_rows[split] = rows
    expected_buckets = 2 * len(FAMILIES) * len(organs) * 2 * 2
    assert len(coverage) == expected_buckets and min(coverage.values()) >= 2
    assert not {r["family_id"] for r in all_rows["train"]} & {r["family_id"] for r in all_rows["val"]}
    output.mkdir(parents=True, exist_ok=True)
    for split, rows in all_rows.items():
        (output / f"{split}.jsonl").write_text("".join(canonical(row) + "\n" for row in rows))
    for split in ("audit", "challenge"):
        shutil.copyfile(parent / f"{split}.jsonl", output / f"exposed_v2_{split}.jsonl")
    report = {"passed": True, "counts": {s: len(r) for s, r in all_rows.items()}, "seed": SEED,
              "families_per_split": len(FAMILIES), "organs": len(organs), "renderers": 2,
              "contexts": ["baseline", "active"], "expected_coverage_buckets": expected_buckets,
              "observed_coverage_buckets": len(coverage), "minimum_rows_per_bucket": min(coverage.values()),
              "missing_qualitative_buckets": 0, "gold_validator_conformance": 1.,
              "train_val_normalized_wording_disjoint": True, "train_val_family_ids_disjoint": True,
              "parent_release_file_sha256": parent_sha, "new_independent_audit": "REQUIRED_NOT_YET_CREATED",
              "promotion_eligible": False, "trained_model": "NOT_RUN"}
    (output / "coverage.json").write_text(json.dumps(report, indent=2) + "\n")
    (output / "DATASET_CARD.md").write_text(
        "# Wording v3 qualitative coverage repair\n\n"
        "This separate release repairs missing qualitative/default-magnitude and UI-default contexts. "
        "It is an authored synthetic coverage patch, not proof of language generalization. "
        f"{len(FAMILIES)} declarative intent families per split cover all 12 organs, both renderers and baseline/active "
        "disease, using qualitative/slight/default edits, percentages, ambiguity and unsupported controls. "
        "All labels pass the frozen semantic validator; original v2 sources remain unchanged.\n\n"
        "The original v2 audit and challenge were inspected after the failed model. Their exact bytes are "
        "preserved as exposed_v2_* regression files. They are not a fresh blind holdout and must not drive "
        "checkpoint selection or be presented as independent promotion evidence. No audit.jsonl or "
        "challenge.jsonl is supplied: a newly frozen independent evaluation release is required before "
        "promotion. No model has been trained or activated from this patch. This is not a comprehensive "
        "replacement for all original numeric-control/profile-selection tasks; broader coverage is a "
        "subsequent release requirement. Lexical diversity remains limited and must be expanded beyond "
        "template/context multiplication before making general language quality claims.\n"
    )
    release = {"dataset_version": "atlas-wording-3.0.0-coverage-draft", "schema_version": "atlas-semantic-1",
               "seed": SEED, "counts": report["counts"], "rows": sum(report["counts"].values()),
               "source_hashes": parent_release["source_hashes"], "parent_release_file_sha256": parent_sha,
               "construction_source_sha256": digest(Path(__file__)), "promotion_eligible": False,
               "evaluation_policy": "exposed_v2_regressions_only_new_independent_audit_required",
               "artifact_hashes": {p.name: digest(p) for p in sorted(output.iterdir())}}
    (output / "release.json").write_text(canonical(release) + "\n")
    print(json.dumps({**report, "release_file_sha256": digest(output / "release.json"), "output": str(output)}, indent=2))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--parent", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    arguments = parser.parse_args()
    build(arguments.source_root.resolve(), arguments.parent.resolve(), arguments.out.resolve())
