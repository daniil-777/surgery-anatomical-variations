"""Reproducible large wording corpus with declarative, non-parser labels.

This is synthetic language supervision for an authored surface editor. It is
not clinical training data, prevalence data, or a patient anatomy dataset.
Phrase families, not random rows, determine train/validation/audit partitions.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import shutil
from collections import Counter
from pathlib import Path
from typing import Any, Iterator

from .atlas_semantic import (
    CONTROLS,
    DIMENSIONS,
    DISEASE_FIELDS,
    LEGACY_PROFILES,
    MATERIAL_BOUNDS,
    PROFILES,
    SCHEMA_VERSION,
    make_plan,
    operation,
    plan_fingerprint,
    validate_plan,
)

DATASET_VERSION = "atlas-wording-2.0.0"
DEFAULT_ROWS = 240_000
SPLITS = ("train", "val", "audit")
SEED = 20261007

# Each distinct lexical family belongs to exactly one split. Parameter values,
# anatomy context, politeness wrappers and clause order do not change its split.
# Labels below are authored directly from the family operation, never by calling
# parse_semantic or a teacher version of the runtime compiler.
FAMILIES: list[dict[str, str]] = []


def _families(intent: str, train: list[str], val: list[str], audit: list[str]) -> None:
    for split, patterns in (("train", train), ("val", val), ("audit", audit)):
        for i, pattern in enumerate(patterns):
            FAMILIES.append({"id": f"{intent}.{split}.{i:02d}", "intent": intent, "split": split, "pattern": pattern})


_families("healthier", ["make the {organ} {pct}% healthier", "make this specimen {pct}% less diseased", "make the disease appearance {pct}% less severe overall", "reduce both disease strength and color contrast by {pct}%"], ["dial back the overall disease appearance by {pct}%", "bring the disease strength and its color contrast down by {pct}%"], ["decrease both the severity and contrast of this disease by {pct}%", "turn down the authored pathological appearance by {pct}%"])
_families("sicker", ["make the {organ} {pct}% sicker", "make this specimen {pct}% more diseased", "increase both disease strength and color contrast by {pct}%"], ["dial up the overall disease appearance by {pct}%"], ["turn up the authored pathological appearance by {pct}%"])
_families("baseline", ["make the {organ} healthy", "clear disease from this {organ}", "normalise the current disease appearance", "return this specimen to baseline"], ["restore the baseline disease appearance"], ["make the model disease-free"])
_families("lesion_size", ["make the lesions {pct}% {lesion_direction}", "make {pct}% {lesion_direction} lesions", "{size_verb} the lesion size by {pct}%"], ["make the current lesion regions {pct}% {lesion_direction}"], ["adjust the lesion size {size_direction} by {pct}%"])
_families("disease_strength", ["{strength_verb} morphology strength by {pct}%", "make disease strength {pct}% {strength_direction}", "{strength_verb} disease severity by {pct}%"], ["adjust the disease intensity {size_direction} by {pct}%"], ["change morphology severity {size_direction} by {pct}%"])
_families("disease_relative", ["{strength_verb} disease {disease_field} by {pct}%", "make disease {disease_field} {pct}% {strength_direction}"], ["adjust the disease {disease_field} {size_direction} by {pct}%"], ["change the authored {disease_field} of the disease {size_direction} by {pct}%"])
_families("disease_set", ["set {disease_field} to {unit_value}", "disease {disease_field}: {unit_value}", "use {unit_value} for disease {disease_field}"], ["assign disease {disease_field} the value {unit_value}"], ["the disease {disease_field} should equal {unit_value}"])
_families("count", ["set lesion count to {count}", "site count {count}", "use {count} disease pattern sites"], ["set the disease count at {count}"], ["choose a count of {count} authored disease sites"])
_families("profile", ["use {profile}", "show {profile}", "select {profile} as the disease appearance"], ["switch the disease appearance to {profile}"], ["the external disease profile should be {profile}"])
_families("shape_relative", ["make the {organ} {pct}% {shape_direction}", "make this anatomy {pct}% {shape_direction}", "change the {dimension} by {signed_pct}%"], ["adjust the {organ} to be {pct}% {shape_direction}"], ["the {organ} should become {pct}% {shape_direction}"])
_families("shape_absolute", ["set {dimension} to {millimetres} mm", "make the {organ} {millimetres} mm {dimension_adjective}", "{dimension}: {centimetres} cm"], ["the target {dimension} is {millimetres} mm"], ["use a {dimension} of {centimetres} cm for the {organ}"])
_families("control", ["set {control} to {control_value}", "{control} {control_value}", "use {control_value} for {control}"], ["assign {control} the value {control_value}"], ["the {control} control should equal {control_value}"])
_families("material_set", ["set {material_label} to {material_value}", "{material_label}: {material_value}", "use {material_value} for {material_label}"], ["assign the surface {material_label} the value {material_value}"], ["the material {material_label} should equal {material_value}"])
_families("wetness", ["make this surface wetter", "make the {organ} drier", "give this {organ} more sheen", "give the surface less sheen"], ["make the surface more glossy", "make the surface less glossy"], ["make the material more moist", "make the material less moist"])
_families("mottling", ["make the surface more mottled", "make the surface less mottled"], ["increase visible surface mottling"], ["reduce visible surface mottling"])
_families("preserve", ["do not change the {preserve_label}", "preserve the {preserve_label}", "keep the {preserve_label} unchanged"], ["without changing the {preserve_label}"], ["leave the {preserve_label} intact"])
_families("mixed", ["make the {organ} {pct}% healthier and {shape_pct}% {shape_direction}; preserve shape controls except scale", "make the {organ} {pct}% healthier and {shape_pct}% {shape_direction}"], ["make this model {pct}% less diseased while making it {shape_pct}% {shape_direction}"], ["reduce both disease severity and contrast by {pct}% and change {dimension} by {signed_shape_pct}%"])
# The first mixed template below is deliberately a negative constraint example,
# not a silently approximated request. Unsupported exceptions apply no edits.
_families("health_preserve", ["make the {organ} {pct}% healthier but preserve shape controls", "make it {pct}% healthier and keep the material unchanged"], ["make it {pct}% less diseased without changing shape controls"], ["reduce disease severity and contrast by {pct}% while preserving the shape controls"])
_families("shape_preserve", ["make it {pct}% {shape_direction} but preserve the disease", "make the {organ} {pct}% {shape_direction} and preserve the material"], ["make this anatomy {pct}% {shape_direction} without changing the disease"], ["make the {organ} {pct}% {shape_direction} while preserving its material"])
_families("unsupported_topology", ["resect {pct}% of the {organ}", "remove the lesion from the {organ}", "cut away {pct}% of the {organ}"], ["excise the lesion from this {organ}"], ["suture the {organ} after lesion removal"])
_families("unsupported_physics", ["give the {organ} stiffness {millimetres} kPa", "increase perfusion by {pct}%", "add an artery to the {organ}"], ["increase blood flow by {pct}%"], ["change the vascular network by {pct}%"])
_families("unsupported_clinical", ["make the {organ} clinically stage {stage}", "make this tumor grade {stage}", "make the {organ} surgically safe"], ["diagnose the disease in the {organ}"], ["predict prognosis for the {organ}"])
_families("unsupported_lesion_mm", ["make a {millimetres} mm lesion", "set lesion diameter to {millimetres} mm"], ["make this cyst {millimetres} mm"], ["set tumor radius to {centimetres} cm"])
_families("contradiction", ["make the {organ} healthier and sicker", "make the {organ} {pct}% wider and {shape_pct}% narrower", "make it healthier but preserve dimensions", "set severity to {unit_value} and keep severity unchanged"], ["make the organ healthier while preserving its disease"], ["make this anatomy healthier and keep its shape unchanged"])
_families("unknown_clause", ["make the {organ} healthier and {unknown_request}", "make it {pct}% wider and {unknown_request}"], ["make this {organ} wetter and {unknown_request}"], ["make the {organ} less diseased while also {unknown_request}"])
_families("ambiguous", ["make it more realistic", "make the {organ} better for surgery", "make it abnormal"], ["optimise this {organ}"], ["fix this anatomy"])

# Fixed scope statements are part of release provenance, not claims about patients.
SCOPE = {
    "source": "authored_declarative_templates_and_synthetic_recipe_contexts",
    "patient_data": False,
    "clinical_review": "NOT_RUN",
    "population_prevalence": "not represented",
    "clinical_stage_or_diagnosis": "not inferred",
    "clinical_language_policy": "healthier changes severity and contrast multiplicatively; dimensions and materials remain separate authored controls",
    "lesion_size_policy": "relative normalized support only; physical lesion diameters are unsupported",
    "geometry_scope": "external same-topology surface morphology; internal structures and resection are unsupported",
    "training_labels": "authored directly from family intent; runtime parser is never used as label teacher",
    "validation_scope": "heldout lexical families; synthetic paraphrase generalization, not clinical validity",
}


def _sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _context(rng: random.Random, profile: str | None, organ: str, renderer_version: str = "disease-v2") -> dict[str, Any]:
    disease = None if profile is None else {"profile_id": profile, "seed": rng.randrange(2**32), **{key: round(rng.uniform(0.05, .95), 3) for key in DISEASE_FIELDS if key != "count"}, "count": rng.randint(1, 8), "location": [round(rng.uniform(-.8, .8), 3) for _ in range(3)]}
    return {"organ": organ, "renderer_version": renderer_version, "disease": disease, "controls": {field: round(rng.uniform(-.4, .4), 3) for field in CONTROLS}, "material": {"organ": organ, "preset": "balanced", "seed": rng.randrange(2**32), "tint": round(rng.uniform(-.7, .7), 3), "pigment_contrast": round(rng.uniform(.1, .9), 3), "mottle_scale_mm": round(rng.uniform(2, 40), 2), "wetness": round(rng.uniform(.1, .9), 3), "fine_detail": round(rng.uniform(.1, .9), 3), "structure_strength": round(rng.uniform(.1, .9), 3)}, "appearance": "tissue"}


def _example(family: dict[str, str], rng: random.Random, index: int) -> dict[str, Any]:
    supported = sorted(key for key, profile in PROFILES.items() if profile["supported"])
    legacy = sorted(key for key, profile in LEGACY_PROFILES.items() if profile["supported"])
    renderer = rng.choice(("legacy", "disease-v2"))
    profile = rng.choice(legacy if renderer == "legacy" else supported)
    organ = PROFILES[profile]["organ"]
    intent, pattern = family["intent"], family["pattern"]
    # Baseline contexts force clarification for requests that need a selected
    # disease, and a well-defined no-op for healthier. This is intentional
    # counterfactual supervision using the exact same wording.
    active = rng.random() >= .18
    if intent == "profile":
        active = rng.random() > .5
    if intent == "contradiction":
        active = True
    context = _context(rng, profile if active else None, organ, renderer)
    if intent == "profile" and renderer == "legacy" and rng.random() < .2:
        candidates = [key for key in supported if PROFILES[key]["organ"] == organ and key not in legacy]
        profile = rng.choice(candidates) if candidates else profile
    pct, shape_pct = rng.randint(1, 45), rng.randint(1, 15)
    sign = rng.choice((-1, 1))
    dimension = rng.choice(DIMENSIONS)
    direction = {"width": ("narrower", "wider"), "height": ("shorter", "taller"), "depth": ("flatter", "deeper")}[dimension][sign > 0]
    disease_field = rng.choice(("severity", "size", "spread", "irregularity", "contrast"))
    if intent == "disease_relative":
        disease_field = rng.choice(("spread", "irregularity", "contrast"))
    value = round(rng.randint(0, 100) / 100, 2)
    control = rng.choice(CONTROLS)
    control_value = round(rng.randint(-100, 100) / 100, 2)
    material = rng.choice(list(MATERIAL_BOUNDS))
    lo, hi = MATERIAL_BOUNDS[material]
    material_value = round(rng.uniform(lo, hi), 2)
    material_labels = {"pigment_contrast": "pigment contrast", "mottle_scale_mm": "mottle scale", "fine_detail": "fine detail", "structure_strength": "structure strength"}
    preserve = rng.choice(("disease", "material", "shape_controls", "width", "height", "depth", "wetness"))
    count = rng.randint(1, 8)
    mm = round(rng.uniform(20, 280), 1)
    variables = {"organ": organ.replace("-", " "), "pct": pct, "shape_pct": shape_pct, "signed_pct": sign * pct, "signed_shape_pct": sign * shape_pct, "lesion_direction": "smaller" if sign < 0 else "larger", "size_verb": "reduce" if sign < 0 else "increase", "size_direction": "down" if sign < 0 else "up", "strength_verb": "reduce" if sign < 0 else "increase", "strength_direction": "weaker" if sign < 0 else "stronger", "shape_direction": direction, "dimension": dimension, "dimension_adjective": {"width": "wide", "height": "tall", "depth": "deep"}[dimension], "disease_field": disease_field, "unit_value": value, "count": count, "profile": profile, "millimetres": mm, "centimetres": round(mm / 10, 2), "control": control, "control_value": control_value, "material_label": material_labels.get(material, material), "material_value": material_value, "preserve_label": preserve.replace("_", " "), "stage": rng.randint(1, 4), "unknown_request": rng.choice(("add a decorative bow", "make it smell fresh", "turn it into an origami bird", "add a singing voice", "make it transparent to thoughts"))}
    text = pattern.format(**variables)
    # Wrappers do not split a lexical family; all its variants stay together.
    text = rng.choice(("", "Please ", "For this anatomy, ", "In the current model, ", "I would like you to ", "Can you ")) + text
    text += rng.choice(("", ".", " please."))
    ops: list[dict[str, Any]] = []
    status = "accepted"
    message = "Apply the requested authored controls and preserve unspecified fields."
    if intent in ("healthier", "sicker", "mixed", "health_preserve"):
        if active:
            health_sign = 1 if intent == "sicker" else -1
            ops = [operation("disease_relative", "severity", health_sign * pct / 100), operation("disease_relative", "contrast", health_sign * pct / 100)]
            message = "Change authored disease strength and contrast; this does not estimate health or clinical stage."
        elif intent == "sicker":
            status, message = "clarify", "Select a disease profile before increasing its appearance."
        else:
            message = "Already at the authored baseline; there is no active disease to reduce."
        if intent == "mixed":
            if "except scale" in pattern:
                status, ops, message = "clarify", [], "An exception to preservation needs an explicit set of controls."
            else:
                ops.append(operation("shape_relative", dimension, sign * shape_pct / 100))
        if intent == "health_preserve":
            ops.append(operation("preserve", "material" if "material" in pattern else "shape_controls"))
    elif intent == "baseline":
        ops = [operation("disease_clear")]
        message = "Clear the authored disease recipe, preserving shape controls and material."
    elif intent in ("lesion_size", "disease_strength", "disease_relative"):
        field = "size" if intent == "lesion_size" else "severity" if intent == "disease_strength" else disease_field
        ops = [operation("disease_relative", field, sign * pct / 100)]
        if not active:
            status, ops, message = "clarify", [], "Select a disease profile before editing its controls."
    elif intent == "disease_set":
        ops = [operation("disease_set", disease_field, value)]
        if not active:
            status, ops, message = "clarify", [], "Select a disease profile before editing its controls."
    elif intent == "count":
        ops = [operation("disease_set", "count", count)]
        if not active:
            status, ops, message = "clarify", [], "Select a disease profile before choosing its sites."
    elif intent == "profile":
        ops = [operation("disease_set", "profile_id", profile)]
        message = "Select the supported authored external profile for this organ."
        if renderer == "legacy" and profile not in legacy:
            status, ops, message = "clarify", [], "Select the expanded disease model before using this external profile."
    elif intent in ("shape_relative", "shape_preserve"):
        ops = [operation("shape_relative", dimension, sign * pct / 100)]
        if intent == "shape_preserve":
            ops.append(operation("preserve", "disease" if "disease" in pattern else "material"))
    elif intent == "shape_absolute":
        ops = [operation("shape_absolute", dimension, mm)]
        message = "Request a measured organ dimension; apply must reject dimensions outside geometric bounds."
        if active:
            status, ops, message = "clarify", [], "Clear the active disease first; absolute final diseased dimensions cannot currently be solved."
    elif intent == "control":
        ops = [operation("control_set", control, control_value)]
    elif intent == "material_set":
        ops = [operation("material_set", material, material_value)]
    elif intent == "wetness":
        ops = [operation("material_relative", "wetness", -.15 if any(word in pattern for word in ("drier", "less")) else .15)]
    elif intent == "mottling":
        ops = [operation("material_relative", "pigment_contrast", -.15 if any(word in pattern for word in ("less", "reduce")) else .15)]
    elif intent == "preserve":
        ops = [operation("preserve", preserve)]
    elif intent.startswith("unsupported_"):
        status, message = "unsupported", "This request exceeds the implemented external surface controls; apply no edits."
    elif intent == "contradiction":
        status, message = "unsupported", "The requested edits or preservation constraints conflict; apply no edits."
    else:
        status, message = "clarify", "The complete request is not yet precise enough to apply atomically."
    if status != "accepted":
        ops = []
    target = make_plan(ops, status=status, message=message)
    # Contract-only validation is intentionally not text parsing or teacher
    # labeling. Do not quietly replace a wrong authored label with its result.
    checked = validate_plan(target, context)
    if checked["status"] != target["status"] or checked["operations"] != target["operations"]:
        raise ValueError(f"Authored family {family['id']} violates plan schema: {checked}")
    row_id = hashlib.sha256(json.dumps({"text": text, "context": context, "family": family["id"]}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"id": row_id, "split": family["split"], "family_id": family["id"], "text": text, "context": context, "target": target, "provenance": "declarative_family_with_synthetic_recipe_context", "clinical_review": "NOT_RUN"}


def iter_examples(rows: int = DEFAULT_ROWS, seed: int = SEED, *, reserved_texts: set[str] | None = None) -> Iterator[dict[str, Any]]:
    if rows < len(FAMILIES):
        raise ValueError(f"At least {len(FAMILIES)} rows are required to cover every phrase family")
    rng = random.Random(seed)
    by_split = {split: [family for family in FAMILIES if family["split"] == split] for split in SPLITS}
    # Stable 80/10/10 row allocation; family membership is fixed independently.
    sizes = {"train": int(rows * .8), "val": int(rows * .1)}
    sizes["audit"] = rows - sum(sizes.values())
    global_index = 0
    # Normalized exact wording must never leak even if two independently
    # authored families happen to produce a coinciding surface sentence.
    text_splits: dict[str, str] = {text: "challenge" for text in reserved_texts or set()}
    row_ids: set[str] = set()
    for split in SPLITS:
        families = by_split[split]
        for index in range(sizes[split]):
            family = families[index % len(families)]
            for _ in range(1000):
                row = _example(family, rng, global_index)
                normalized = re.sub(r"[^\w%.+-]+", " ", row["text"].lower()).strip()
                if row["id"] not in row_ids and text_splits.get(normalized, split) == split:
                    break
            else:
                raise RuntimeError("Unable to generate a distinct, split-clean example")
            text_splits[normalized] = split
            row_ids.add(row["id"])
            global_index += 1
            yield row


def write_release(output: str | Path, *, rows: int = DEFAULT_ROWS, seed: int = SEED, challenge: str | Path | None = None) -> dict[str, Any]:
    output = Path(output)
    if output.exists() and any(output.iterdir()):
        raise FileExistsError("Dataset release directories are immutable; select a new empty output path")
    output.mkdir(parents=True, exist_ok=True)
    streams = {split: (output / f"{split}.jsonl").open("w", encoding="utf-8", newline="\n") for split in SPLITS}
    counts: Counter[str] = Counter()
    statuses: Counter[str] = Counter()
    organs: Counter[str] = Counter()
    families: dict[str, set[str]] = {split: set() for split in SPLITS}
    unique_texts: dict[str, set[str]] = {split: set() for split in SPLITS}
    active_counts: Counter[str] = Counter()
    renderer_counts: Counter[str] = Counter()
    challenge_rows = [json.loads(line) for line in Path(challenge).read_text().splitlines() if line.strip()] if challenge else []
    reserved_texts = {re.sub(r"[^\w%.+-]+", " ", row["text"].lower()).strip() for row in challenge_rows}
    try:
        for row in iter_examples(rows, seed, reserved_texts=reserved_texts):
            checked = validate_plan(row["target"], row["context"], text=row["text"])
            if plan_fingerprint(checked) != plan_fingerprint(row["target"]):
                raise ValueError(f"Authored gold target does not conform to the runtime contract: {row['text']}: {checked}")
            split = row["split"]
            streams[split].write(json.dumps(row, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n")
            counts[split] += 1
            statuses[f"{split}:{row['target']['status']}"] += 1
            organs[row["context"]["organ"]] += 1
            families[split].add(row["family_id"])
            unique_texts[split].add(re.sub(r"[^\w%.+-]+", " ", row["text"].lower()).strip())
            active_counts["active_disease" if row["context"]["disease"] else "baseline"] += 1
            renderer_counts[row["context"]["renderer_version"]] += 1
    finally:
        for stream in streams.values():
            stream.close()
    for i, split in enumerate(SPLITS):
        for other in SPLITS[i + 1:]:
            assert not families[split] & families[other]
            assert not unique_texts[split] & unique_texts[other]
    (output / "phrase_families.json").write_text(json.dumps(FAMILIES, indent=2) + "\n")
    challenge_metadata = None
    if challenge:
        source = Path(challenge)
        shutil.copyfile(source, output / "challenge.jsonl")
        if any(row.get("split") != "challenge" for row in challenge_rows):
            raise ValueError("Independent challenge rows must use split='challenge'")
        overlaps = sum(re.sub(r"[^\w%.+-]+", " ", row["text"].lower()).strip() in unique_texts["train"] for row in challenge_rows)
        assert overlaps == 0
        challenge_metadata = {"rows": len(challenge_rows), "provenance": "independent_research_agent_authored_not_parser_generated", "used_for_training": False, "exact_text_overlap_with_train": overlaps, "clinical_review": "NOT_RUN", "purpose": "independent_authored_regression_and_post_training_evaluation"}
    (output / "DATASET_CARD.md").write_text("# VISCERA anatomy wording v2\n\n" + f"{rows:,} synthetic prompt/context examples across {len(FAMILIES)} authored lexical families and 12 organs. Labels describe bounded edits of a surface model. They are not clinical advice, diagnosis, patient anatomy or measured tissue properties.\n\n" + "The language release contains no patient data. Clinical review has not been performed. Healthier reduces the active disease's authored severity and contrast; it never predicts biological recovery. Lesion sizes are normalized support controls, not clinical diameters. Shape dimensions are requests and must pass runtime geometric feasibility checks. Internal vessels, resection, physical stiffness and clinical stages are explicitly unsupported.\n\n" + "Train, validation and audit have disjoint lexical families and normalized exact prompts. Contexts vary disease profile, strength, size, spread, irregularity, site count, location, existing shape controls and material parameters. Some prompts intentionally recur with different contexts; release.json reports unique prompt counts separately from prompt/context pairs. The independently authored challenge is never used for training or early stopping. If inspected during development it is a regression set, not a blind clinical validation.\n\n" + "Run: `python -m viscera_core.atlas_semantic_dataset --output <new-directory> --rows 240000 --challenge tests/fixtures/anatomy-wording-challenge.jsonl`. A non-empty output directory is never overwritten.\n")
    # Manifest source identifiers retain checkout keys in installed wheels too.
    sources = [Path(__file__).with_name("atlas_semantic.py"), Path(__file__).with_name("disease_profiles_v2.json"), Path(__file__).with_name("disease_profiles.json")]
    artifacts = {path.name: _sha(path) for path in sorted(output.iterdir()) if path.is_file()}
    manifest = {"dataset_version": DATASET_VERSION, "schema_version": SCHEMA_VERSION, "seed": seed, "rows": rows, "counts": dict(counts), "unique_normalized_texts": {split: len(texts) for split, texts in unique_texts.items()}, "status_counts": dict(statuses), "organ_counts": dict(organs), "context_counts": dict(active_counts), "renderer_counts": dict(renderer_counts), "family_counts": {split: len(ids) for split, ids in families.items()}, "families": {split: sorted(ids) for split, ids in families.items()}, "split_policy": "whole_lexical_family_disjoint_80_10_10_rows_with_no_cross_split_normalized_text_overlap", "scope": SCOPE, "challenge": challenge_metadata, "artifact_hashes": artifacts, "source_hashes": {"py/viscera_core/" + path.name: _sha(path) for path in sources}, "provenance_source_hashes": {"py/viscera_core/" + Path(__file__).name: _sha(Path(__file__))}}
    # Canonical manifest identity is stable: no wall clock timestamp or random UUID.
    manifest["release_sha256"] = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    (output / "release.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--rows", type=int, default=DEFAULT_ROWS)
    parser.add_argument("--seed", type=int, default=SEED)
    parser.add_argument("--challenge", type=Path)
    args = parser.parse_args()
    manifest = write_release(args.output, rows=args.rows, seed=args.seed, challenge=args.challenge)
    print(json.dumps({"output": str(args.output), "rows": manifest["rows"], "release_sha256": manifest["release_sha256"], "counts": manifest["counts"]}, indent=2))


if __name__ == "__main__":
    main()
