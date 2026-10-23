#!/usr/bin/env python3
"""Verify a bounded objective-pilot handoff against its actual trained parent.

This verifier never executes uploaded code or reads training/test image payloads.
Stage300 is a stopped review checkpoint, not completion of the1000-update budget.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
import zipfile
from dataclasses import dataclass, replace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "py"))
sys.path.insert(0, str(ROOT / "scripts"))
import verify_tissue_conv_run as base  # noqa: E402
from verify_tissue_completed_run import (  # noqa: E402
    CONDITIONS,
    RELEASE_SHA,
    canonical,
    checked_sha,
    completion,
    file_sha,
    no_symlinks,
    require,
    sha,
    strict_json,
)

PARENT_BUNDLE_SHA = "1e15cb6cf5880c6ed7f3bed0e3ce86af8adf811e0224f796cbfd696436dd8d3a"
PARENT_MODEL_SHA = "39085f410b1762018e3dff7e0dc47cd7bd973a6217834e3d14ba0fd41d9f5455"
NATIVE_SHA = "26f0dd07b29375249239016e3281c399e3c89fed4c16354a9011f6440a288565"
SEEDS = ("42", "43", "18446744073709551615")
record = base.record


@dataclass(frozen=True)
class Expectations:
    stage_updates: int = 300
    budget_updates: int = 1000
    gate_updates: int = 300
    parent_steps: int = 6000
    parent_model_sha256: str = PARENT_MODEL_SHA
    baseline_bundle_sha256: str = PARENT_BUNDLE_SHA
    native_release_sha256: str = NATIVE_SHA
    source_release_sha256: str = RELEASE_SHA
    conditions: tuple = CONDITIONS
    fixture: bool = False
    device: str = "cuda"


def source_inventory(bundle, bundle_sha, baseline, expected):
    files, modules = base.source_inventory(
        bundle, bundle_sha, baseline, expected.baseline_bundle_sha256
    )
    with zipfile.ZipFile(bundle) as archive:
        manifest = strict_json(archive.read("bundle-manifest.json"))
    require(
        manifest.get("parent_model_sha256") == expected.parent_model_sha256,
        "source bundle parent model differs",
    )
    extra = {
        name.removeprefix("py/viscera_core/"): item["sha256"]
        for name, item in files.items()
        if name.startswith("py/viscera_core/tissue_learning_conv_refine/") and name.endswith(".py")
    }
    require(extra, "missing refinement source modules")
    for name, checksum in extra.items():
        require(
            file_sha(ROOT / "py/viscera_core" / name) == checksum, "local refinement source differs"
        )
    return files, {**modules, **extra}


def read_parent(directory, payloads, expected):
    from viscera_core.tissue_learning.checkpoint import load_checkpoint
    from viscera_core.tissue_learning_conv.artifact import load_artifact
    from viscera_core.tissue_learning_conv.config import ConvConfig

    directory = Path(directory).absolute()
    no_symlinks(directory)
    models = list(directory.glob("*.tissue-model.json"))
    require(
        len(models) == 1 and file_sha(models[0]) == expected.parent_model_sha256,
        "trusted parent model SHA mismatch",
    )
    parent = load_artifact(models[0])
    require(
        parent["provenance"]["training_steps"] == expected.parent_steps
        and "refinement" not in parent["provenance"],
        "parent is not the original trained candidate",
    )
    checkpoint = directory / "checkpoints" / f"step-{expected.parent_steps:09d}"
    no_symlinks(checkpoint)
    require(
        file_sha(checkpoint / "manifest.json")
        == parent["provenance"]["checkpoint_manifest_sha256"],
        "trusted parent checkpoint binding differs",
    )
    state, request = load_checkpoint(checkpoint)
    base.validate_checkpoint(state, request, ConvConfig.from_dict(request["config"]), parent)
    expected_files = {
        "parent/model.tissue-model.json": models[0],
        "parent/manifest.json": checkpoint / "manifest.json",
        "parent/state.json": checkpoint / "state.json",
    }
    for name, source in expected_files.items():
        require(
            payloads.get(name) == source.read_bytes(), "downloaded parent metadata differs: " + name
        )
    binding = {
        "model_sha256": expected.parent_model_sha256,
        "checkpoint_manifest_sha256": file_sha(checkpoint / "manifest.json"),
        "request_sha256": sha(canonical(request)),
        "training_steps": expected.parent_steps,
        "dataset_manifest_sha256": request["data"]["manifest_sha256"],
    }
    return parent, state, request, binding, set(expected_files)


def zero_checkpoint(payloads, stage, request, parent_state, config):
    import torch
    from viscera_core.tissue_learning.checkpoint import load_checkpoint

    prefix = "checkpoints/step-000000000"
    names = {prefix + "/" + name for name in ("manifest.json", "state.json", "tensors.safetensors")}
    require(names <= set(payloads), "full initial checkpoint missing")
    state, saved_request = load_checkpoint(stage / prefix)
    require(
        saved_request == request
        and state["step"] == 0
        and state["cursor"] == 0
        and state["epoch"] == 0
        and state["loss_history"] == [],
        "initial checkpoint is not fresh step zero",
    )
    for label in ("model", "critic"):
        require(
            state[label].keys() == parent_state[label].keys(), "warm-start tensor inventory differs"
        )
        require(
            all(
                torch.equal(state[label][key], value) for key, value in parent_state[label].items()
            ),
            "warm-start model/critic differs from trusted parent",
        )
    for label, lr, betas in (
        ("optimizer", config.lr, (0.9, 0.999)),
        ("critic_optimizer", config.critic_lr, (0.0, 0.9)),
    ):
        value = state[label]
        require(
            value["state"] == {} and len(value["param_groups"]) == 1,
            "warm-start optimizer was not reset",
        )
        group = value["param_groups"][0]
        require(
            group["lr"] == lr
            and tuple(group["betas"]) == betas
            and group["weight_decay"] == config.weight_decay,
            "initial optimizer configuration differs",
        )
    require(
        state["torch_rng"].dtype == torch.uint8 and isinstance(state["sampler_rng"], dict),
        "initial RNG state missing",
    )
    return state, names, sha(payloads[prefix + "/manifest.json"])


def data_contract(payloads, stage, parent_dir, request, parent_request, model, expected):
    from viscera_core.tissue_learning.data import TissueDataset

    names = {
        "release.json",
        "records.jsonl",
        "train.jsonl",
        "val.jsonl",
        "test.jsonl",
        "exclusions.json",
        "completed-result.json",
    }
    for name in names:
        source = Path(parent_dir) / "native-crops" / name
        no_symlinks(source)
        require(
            payloads.get("native-crops/" + name) == source.read_bytes(),
            "native metadata changed from pinned parent: " + name,
        )
    require(
        sha(payloads["native-crops/release.json"]) == expected.native_release_sha256,
        "native release identity differs",
    )
    native = strict_json(payloads["native-crops/release.json"])
    require(
        native["source_prepared_release_sha256"] == expected.source_release_sha256
        and native["test_payloads_opened"] == 0
        and native["test_payloads_materialized"] is False,
        "native ancestry/test isolation differs",
    )
    for name, declared in native["manifests"].items():
        require(
            record(payloads["native-crops/" + name]) == declared, "native manifest hash differs"
        )
    data = TissueDataset(stage / "native-crops/records.jsonl", stage, commercial_only=False)
    summary = data.summary()
    require(
        summary
        == request["data"]
        == parent_request["data"]
        == model["provenance"]["dataset_summary"],
        "pilot data differs from parent",
    )
    require(
        data.digest == model["provenance"]["dataset_manifest_sha256"]
        and data.split_digest == model["provenance"]["split_manifest_sha256"],
        "pilot data/split hash differs",
    )
    require(
        payloads["data-readiness/records.jsonl"] == payloads["native-crops/records.jsonl"],
        "readiness changed native records",
    )
    ready = strict_json(payloads["data-readiness/readiness.json"])
    require(
        ready["source_summary"] == ready["derived_summary"] == summary
        and ready["excluded_count"] == 0
        and ready["test_payloads_opened"] == 0
        and ready["derived_manifest_sha256"] == data.digest
        and ready["derived_split_sha256"] == data.split_digest,
        "pilot readiness differs",
    )
    completion(payloads, "data-readiness", ready["identity"])
    require(
        ready["identity"]
        == {
            "kind": "native-tissue-detail-readiness-v1",
            "source_manifest_sha256": data.digest,
            "source_split_sha256": data.split_digest,
            "patch_size": 128,
            "minimum_valid_fraction": 0.5,
            "critic_minimum_coverage": 0.75,
            "commercial_only": False,
            "policy_source_sha256": {
                name: file_sha(ROOT / "py/viscera_core/tissue_learning_detail" / name)
                for name in ("data.py", "readiness.py", "model.py")
            },
        },
        "readiness source binding differs",
    )
    allowed = {"native-crops/" + name for name in names} | {
        "data-readiness/" + name
        for name in ("records.jsonl", "readiness.json", "completed-result.json")
    }
    return data, allowed


def reference_contract(payloads, data, refinement, objective):
    import numpy as np

    reference = strict_json(payloads["train-reference.json"])
    require(reference == refinement["reference"], "train reference differs from request")
    body = {key: value for key, value in reference.items() if key != "sha256"}
    require(
        sha(canonical(body)) == reference["sha256"] == refinement["reference_sha256"],
        "train reference digest differs",
    )
    require(
        reference["schema"] == "viscera.tissue-refine-train-reference/v1"
        and reference["conditions"] == data.conditions
        and reference["manifest_sha256"] == data.digest
        and reference["objective_sha256"] == refinement["objective_sha256"],
        "train reference identity differs",
    )
    selected = [
        data.records[i] for i in data.evaluation_indices("train", objective.reference_limit)
    ]
    keys = ("id", "split", "group_id", "condition", "image_sha256", "mask_sha256")
    require(
        reference["rows"] == [{key: row[key] for key in keys} for row in selected]
        and all(row["split"] == "train" for row in reference["rows"]),
        "calibration read/selected nontraining or different rows",
    )
    for key, shape in (
        ("neighbor_scale", (len(data.conditions), 3)),
        ("frequency_rms", (len(data.conditions), 3, 3)),
        ("palette_lower", (len(data.conditions), 8)),
        ("palette_upper", (len(data.conditions), 8)),
    ):
        values = np.asarray(reference[key], dtype=np.float64)
        require(
            values.shape == shape and np.isfinite(values).all() and (values >= 0).all(),
            "invalid calibration array: " + key,
        )
    require(
        (np.asarray(reference["neighbor_scale"]) >= objective.scale_floor).all(),
        "calibration denominator below floor",
    )
    lower, upper = np.asarray(reference["palette_lower"]), np.asarray(reference["palette_upper"])
    require((lower <= upper).all() and (upper <= 1).all(), "calibration palette bounds invalid")
    windows = reference["valid_windows_per_scale"]
    require(
        len(windows) == len(data.conditions)
        and all(len(row) == 3 and all(type(n) is int and n > 0 for n in row) for row in windows),
        "calibration support missing",
    )
    return reference


def native_png_matches(raw, model, condition, seed):
    import io

    import numpy as np
    from PIL import Image
    from viscera_core.tissue_learning_conv.artifact import decode_native_numpy, seed_latent

    base.png_size(raw, (128, 128))
    native = decode_native_numpy(
        model, seed_latent(seed, model["architecture"]["latent_dim"]), condition
    )
    predicted = np.rint(np.clip(native, 0, 1) * 255).astype(np.int16)
    with Image.open(io.BytesIO(raw)) as image:
        actual = np.asarray(image, dtype=np.int16)
    maximum = int(np.abs(actual - predicted).max())
    require(maximum <= 1, "native prior pixels differ from bound model")
    return maximum


def snapshots_contract(payloads, request, expected, parent, model, zero_sha, checkpoint_sha):
    steps = (
        (0, expected.gate_updates)
        if expected.stage_updates == expected.gate_updates
        else (0, expected.gate_updates, expected.stage_updates)
    )
    allowed, report = set(), []
    for step in steps:
        prefix = f"prior-snapshots/step-{step:09d}"
        if step == 0:
            checksum = zero_sha
        elif step == expected.stage_updates:
            checksum = checkpoint_sha
        else:
            names, checksum = base.checkpoint_metadata(payloads, step, request)
            allowed |= names
        identity = {
            "kind": "native-conv-prior-snapshot-v1",
            "step": step,
            "checkpoint_manifest_sha256": checksum,
            "request_sha256": sha(canonical(request)),
            "seed": "42",
            "native_resolution": [128, 128],
            "inference_precision": "float32; TF32 disabled",
        }
        names = {f"condition-{i}-seed42-native128.png" for i in range(len(expected.conditions))}
        required = {
            prefix + "/" + name for name in names | {"receipt.json", "completed-result.json"}
        }
        require(required <= set(payloads), "required refinement snapshot missing")
        receipt = strict_json(payloads[prefix + "/receipt.json"])
        require(
            receipt
            == {
                **identity,
                "files": receipt.get("files"),
                "qualification": "engineering_unqualified",
            }
            and set(receipt["files"]) == names,
            "snapshot identity/inventory differs",
        )
        maxima = []
        for index in range(len(expected.conditions)):
            name = f"condition-{index}-seed42-native128.png"
            raw = payloads[prefix + "/" + name]
            require(record(raw) == receipt["files"][name], "snapshot image hash differs")
            base.png_size(raw, (128, 128))
            if step in (0, expected.stage_updates):
                maxima.append(native_png_matches(raw, parent if step == 0 else model, index, "42"))
        completion(payloads, prefix, identity)
        allowed |= required
        report.append(
            {
                "step": step,
                "checkpoint_manifest_sha256": checksum,
                "full_native_pixels_compared": bool(maxima),
                "maximum_absolute_error_bytes": max(maxima) if maxima else None,
                "checkpoint_tensors_reloaded": True,
                "intermediate_pixels_checked_in_continuation": step
                not in (0, expected.stage_updates),
            }
        )
    return allowed, report


def recompute_gate_checks(summaries, ratios):
    import statistics

    def mean(label, key):
        return statistics.mean(row[label][key] for row in summaries.values())

    return {
        "neighbor_error_improves_5_percent": mean("candidate", "neighbor_charbonnier")
        <= 0.95 * mean("parent", "neighbor_charbonnier"),
        "prior_frequency_error_improves_10_percent": mean("candidate", "prior_frequency_error")
        <= 0.90 * mean("parent", "prior_frequency_error"),
        "no_condition_neighbor_error_worsens_10_percent": all(
            row["candidate"]["neighbor_charbonnier"] <= 1.1 * row["parent"]["neighbor_charbonnier"]
            for row in summaries.values()
        ),
        "no_condition_l1_worsens_15_percent": all(
            row["candidate"]["masked_l1"] <= 1.15 * row["parent"]["masked_l1"]
            for row in summaries.values()
        ),
        "palette_violation_not_worse": all(
            row["candidate"]["prior_palette_violation"]
            <= max(0.01, 1.05 * row["parent"]["prior_palette_violation"])
            for row in summaries.values()
        ),
        "detail_gradient_median_ratio_0_01_to_2": 0.01 <= statistics.median(ratios) <= 2,
    }


def diagnostics_contract(
    payloads,
    data,
    config,
    request,
    state,
    model,
    parent,
    model_sha,
    checkpoint_sha,
    run_id,
    *,
    verify_images=True,
):
    import math
    import statistics

    def doc(name):
        return strict_json(payloads["diagnostics/" + name])

    report, gate = doc("diagnostics.json"), doc("objective-gate.json")
    refinement = request["refinement"]
    require(
        report["model_file_sha256"] == model_sha
        and report["checkpoint_manifest_sha256"] == checkpoint_sha
        and report["data_summary"] == data.summary()
        and report["measurement_split"] == "val"
        and report["loss_trace"] == state["loss_history"]
        and report["native_decode_resolution"] == [128, 128]
        and report["qualification"] == "engineering_unqualified",
        "refinement diagnostic identity differs",
    )
    chosen = [
        data.records[i] for i in data.evaluation_indices("val", min(config.validation_limit, 128))
    ]
    fields = ("id", "group_id", "condition")
    require(
        [[row[key] for key in fields] for row in report["evaluated_rows"]]
        == [[row[key] for key in fields] for row in chosen],
        "validation subset changed",
    )
    require(
        all(
            math.isclose(
                row["valid_fraction"], source["quality"]["valid_fraction"], abs_tol=1e-7, rel_tol=0
            )
            for row, source in zip(report["evaluated_rows"], chosen, strict=True)
        ),
        "validation case coverage differs from source metadata",
    )
    extra = report["refinement"]
    require(
        extra["parent"] == refinement["parent"]
        and extra["reference_sha256"] == refinement["reference_sha256"],
        "diagnostic parent/reference differs",
    )
    by_group = {}
    for row in report["evaluated_rows"]:
        by_group.setdefault((row["condition"], row["group_id"]), []).append(row)
    selected = [
        sorted(rows, key=lambda row: (row["valid_fraction"], row["id"]))[(len(rows) - 1) // 2]
        for _, rows in sorted(by_group.items())
    ]
    source_by_id = {row["id"]: row for row in chosen}
    displayed = extra["supplemental_display_cases"]
    require(
        [row["id"] for row in displayed] == [row["id"] for row in selected]
        and extra["supplemental_display_native_pixels"] == [128, 128]
        and extra["supplemental_display_resampling"] == "none"
        and (
            not verify_images
            or extra["supplemental_display_sha256"]
            == sha(payloads["diagnostics/group-balanced-posterior-comparison.png"])
        ),
        "supplemental display selection or image differs",
    )
    for row, selected_row in zip(displayed, selected, strict=True):
        require(
            all(
                row[key] == selected_row[key] for key in ("condition", "group_id", "valid_fraction")
            )
            and all(
                row[key] == source_by_id[row["id"]][key] for key in ("image_sha256", "mask_sha256")
            ),
            "supplemental display source differs",
        )
        require(
            math.isclose(
                row["valid_fraction"],
                source_by_id[row["id"]]["quality"]["valid_fraction"],
                abs_tol=1e-7,
                rel_tol=0,
            ),
            "supplemental selection coverage differs from source metadata",
        )
    paired = extra["paired_rows"]
    keys = (*fields, "image_sha256", "mask_sha256")
    require(
        [[row[key] for key in keys] for row in paired]
        == [[row[key] for key in keys] for row in chosen],
        "paired diagnostic source differs",
    )
    for row in paired:
        for label in ("parent", "candidate"):
            require(
                set(row[label]) == {"neighbor_charbonnier", "masked_l1"}
                and all(
                    type(x) in (int, float) and math.isfinite(x) and x >= 0
                    for x in row[label].values()
                ),
                "invalid paired diagnostic value",
            )
    first_by_group = {}
    for row in chosen:
        first_by_group.setdefault((row["condition"], row["group_id"]), row)
    gradients = extra["objective_gradient_cases"]
    require(
        [[row[key] for key in fields] for row in gradients]
        == [[row[key] for key in fields] for row in first_by_group.values()],
        "gradient cases changed",
    )
    terms = {
        "posterior_l1",
        "normalized_neighbor_charbonnier",
        "kl",
        "prior_adversarial",
        "posterior_adversarial",
        "posterior_feature_matching",
        "prior_frequency_match",
        "prior_palette_bounds",
    }
    for row in gradients:
        require(set(row["terms"]) == terms, "refinement gradient objective inventory differs")
        for value in row["terms"].values():
            require(
                set(value) == {"weighted_scalar", "generator_gradient_l2"}
                and all(type(x) in (int, float) and math.isfinite(x) for x in value.values())
                and value["generator_gradient_l2"] >= 0,
                "invalid gradient diagnostic value",
            )
    priors = extra["prior_samples"]
    require(
        [(row["condition"], row["seed"]) for row in priors]
        == [(condition, seed) for condition in data.conditions for seed in SEEDS],
        "prior condition/seed inventory differs",
    )
    allowed = {
        "diagnostics/" + name
        for name in (
            "diagnostics.json",
            "objective-gate.json",
            "appearance-comparison.png",
            "group-balanced-posterior-comparison.png",
            "loss-trace.png",
            "completed-result.json",
        )
    }
    for index in range(len(data.conditions)) if verify_images else ():
        name = f"diagnostics/condition-{index}-seed42-256.png"
        base.png_size(payloads[name], (256, 256))
        allowed.add(name)
        for seed in SEEDS:
            for label, selected_model in (("parent", parent), ("candidate", model)):
                name = f"diagnostics/{label}-condition-{index}-seed{seed}-native128.png"
                native_png_matches(payloads[name], selected_model, index, seed)
                allowed.add(name)
    summaries = {}
    for condition in data.conditions:
        selected = [row for row in paired if row["condition"] == condition]
        samples = [row for row in priors if row["condition"] == condition]
        for row in samples:
            for label in ("parent", "candidate"):
                for key in ("frequency_error", "palette_violation"):
                    value = row[label][key]
                    require(
                        type(value) in (int, float) and math.isfinite(value) and value >= 0,
                        "invalid prior statistic",
                    )
        summaries[condition] = {
            label: {
                "neighbor_charbonnier": statistics.mean(
                    row[label]["neighbor_charbonnier"] for row in selected
                ),
                "masked_l1": statistics.mean(row[label]["masked_l1"] for row in selected),
                "prior_frequency_error": statistics.mean(
                    row[label]["frequency_error"] for row in samples
                ),
                "prior_palette_violation": statistics.mean(
                    row[label]["palette_violation"] for row in samples
                ),
            }
            for label in ("parent", "candidate")
        }
    ratios = [
        row["terms"]["normalized_neighbor_charbonnier"]["generator_gradient_l2"]
        / max(row["terms"]["posterior_l1"]["generator_gradient_l2"], 1e-12)
        for row in gradients
    ]
    require(
        gate["schema"] == "viscera.tissue-refine-objective-gate/v1"
        and gate["request_sha256"] == sha(canonical(request))
        and gate["checkpoint_manifest_sha256"] == checkpoint_sha
        and gate["model_sha256"] == model_sha
        and gate["step"] == state["step"]
        and gate["parent"] == refinement["parent"]
        and gate["reference_sha256"] == refinement["reference_sha256"]
        and gate["evaluation_rows_sha256"] == sha(canonical(paired))
        and gate["evaluated_rows"] == len(paired)
        and gate["visual_acceptance_required"] is True
        and gate["qualification"] == "engineering_unqualified",
        "objective gate identity differs",
    )
    require(
        gate.get("diagnostics_sha256") == sha(payloads["diagnostics/diagnostics.json"]),
        "objective gate diagnostic evidence differs",
    )
    # Python statistics.mean and NumPy mean may differ in their last bit.
    for condition in summaries:
        for label in ("parent", "candidate"):
            for key, value in summaries[condition][label].items():
                require(
                    math.isclose(
                        gate["condition_summaries"][condition][label][key],
                        value,
                        abs_tol=1e-12,
                        rel_tol=1e-12,
                    ),
                    "objective gate summary differs from rows",
                )
    require(gate["detail_to_l1_gradient_ratios"] == ratios, "objective gate gradient ratios differ")
    checks = recompute_gate_checks(gate["condition_summaries"], ratios)
    require(
        gate["numerical_checks"] == checks and gate["numerical_passed"] is all(checks.values()),
        "objective gate checks were changed",
    )
    if verify_images:
        completion(
            payloads,
            "diagnostics",
            {
                "kind": "tissue-diagnostics",
                "model_sha256": model_sha,
                "checkpoint_manifest_sha256": checkpoint_sha,
                "run_id": run_id,
            },
        )
    return allowed, gate


def checkpoint_template(state, model):
    """Build a tensor-schema template for checking an intermediate full state.

    There is no independently exported intermediate model in the handoff; this
    template only lets the shared validator check architecture and AdamW state.
    """
    import base64
    import copy

    template = copy.deepcopy(model)
    raw = b"".join(
        state["model"]["decoder." + spec["name"]].numpy().astype("<f4").tobytes()
        for spec in template["weights"]["tensors"]
    )
    template["weights"]["data_base64"] = base64.b64encode(raw).decode()
    template["weights"]["sha256"] = sha(raw)
    return template


def continuation_contract(payloads, stage, request, config, expected, model, data=None):
    from viscera_core.tissue_learning.checkpoint import load_checkpoint

    if expected.stage_updates == expected.gate_updates:
        return set(), {"required": False, "authorized_for_further_training": False}
    prefix = f"checkpoints/step-{expected.gate_updates:09d}"
    required = {
        prefix + "/" + name for name in ("manifest.json", "state.json", "tensors.safetensors")
    }
    gate_prefix = f"gate-review/step-{expected.gate_updates:09d}"
    gate_name, visual_name = (
        gate_prefix + "/objective-gate.json",
        gate_prefix + "/visual-review.json",
    )
    diagnostic_name = gate_prefix + "/diagnostics.json"
    required |= {gate_name, visual_name, diagnostic_name, "continuation-review.json"}
    require(required <= set(payloads), "continuation evidence missing")
    state, saved_request = load_checkpoint(stage / prefix)
    require(
        saved_request == request and state["step"] == expected.gate_updates,
        "continuation checkpoint identity differs",
    )
    template = checkpoint_template(state, model)
    base.validate_checkpoint(
        state,
        request,
        replace(config, steps=expected.gate_updates),
        template,
    )
    gate, visual, receipt = (
        strict_json(payloads[name]) for name in (gate_name, visual_name, "continuation-review.json")
    )
    require(
        gate["schema"] == "viscera.tissue-refine-objective-gate/v1"
        and gate["step"] == expected.gate_updates
        and gate["checkpoint_manifest_sha256"] == sha(payloads[prefix + "/manifest.json"])
        and gate["request_sha256"] == sha(canonical(request))
        and gate["reference_sha256"] == request["refinement"]["reference_sha256"]
        and gate["parent"] == request["refinement"]["parent"],
        "continuation gate binding differs",
    )
    require(data is not None, "continuation data metadata required")
    diagnostics_contract(
        {
            "diagnostics/diagnostics.json": payloads[diagnostic_name],
            "diagnostics/objective-gate.json": payloads[gate_name],
        },
        data,
        config,
        request,
        state,
        model,
        None,
        gate["model_sha256"],
        gate["checkpoint_manifest_sha256"],
        "intermediate-gate",
        verify_images=False,
    )
    checks = recompute_gate_checks(
        gate["condition_summaries"], gate["detail_to_l1_gradient_ratios"]
    )
    require(
        gate["numerical_checks"] == checks
        and all(checks.values())
        and gate["numerical_passed"] is True,
        "continuation numerical gate failed",
    )
    require(
        all(visual.get(key) is True for key in ("accepted", "detail_improved", "no_new_artifacts"))
        and visual.get("gate_sha256") == sha(payloads[gate_name])
        and visual.get("checkpoint_manifest_sha256") == gate["checkpoint_manifest_sha256"]
        and isinstance(visual.get("reviewer"), str)
        and visual["reviewer"].strip()
        and isinstance(visual.get("evidence"), str)
        and visual["evidence"].strip(),
        "explicit visual continuation review missing or unbound",
    )
    require(
        receipt
        == {
            "gate_sha256": sha(payloads[gate_name]),
            "visual_review_sha256": sha(payloads[visual_name]),
            "gate": gate,
            "visual_review": visual,
        },
        "saved continuation receipt differs",
    )
    maxima = [
        native_png_matches(
            payloads[
                f"prior-snapshots/step-{expected.gate_updates:09d}/condition-{index}-seed42-native128.png"
            ],
            template,
            index,
            "42",
        )
        for index in range(len(expected.conditions))
    ]
    return required, {
        "required": True,
        "bound_review_verified": True,
        "reviewer": visual["reviewer"],
        "visual_quality_independently_accepted_by_verifier": False,
        "gate_checkpoint_tensors_reloaded": True,
        "gate_snapshot_maximum_absolute_error_bytes": max(maxima),
    }


def validate_graph(
    payloads,
    stage,
    model_sha,
    bundle_sha,
    run_id,
    modules,
    expected_parent_dir,
    expected,
    original_dir,
):
    from viscera_core.tissue_learning.checkpoint import load_checkpoint
    from viscera_core.tissue_learning.portable import experiment_identity
    from viscera_core.tissue_learning_conv.artifact import load_artifact
    from viscera_core.tissue_learning_conv_refine.config import RefineConfig

    def doc(name):
        require(name in payloads, "required file missing: " + name)
        return strict_json(payloads[name])

    names = [name for name in payloads if "/" not in name and name.endswith(".tissue-model.json")]
    require(len(names) == 1, "exactly one root pilot model required")
    model_name = names[0]
    require(sha(payloads[model_name]) == checked_sha(model_sha), "trusted pilot model SHA mismatch")
    model = load_artifact(stage / model_name)
    p, a = model["provenance"], model["architecture"]
    request, run, training = (
        doc("request.json"),
        doc("run-identity.json"),
        doc("training-receipt.json"),
    )
    pilot = RefineConfig.from_dict(doc("training-local/config.json"))
    config = pilot.training
    require(
        expected.stage_updates in (expected.gate_updates, expected.budget_updates)
        and config.steps == expected.budget_updates
        and pilot.objective.gate_step == expected.gate_updates
        and config.fixture is expected.fixture
        and config.device == expected.device
        and config.validation_mode == "heldout"
        and config.commercial_only is False,
        "pilot budget/stage/config differs",
    )
    if not expected.fixture:
        require(
            pilot.to_dict() == RefineConfig().to_dict(),
            "pilot differs from approved default configuration",
        )
    require(
        request["schema"] == "viscera.tissue-conv-training-request/v1"
        and request["model_type"] == model["model_type"] == "masked-rgb-spatial-cvae-gan-v1"
        and canonical(request["config"]) == canonical(config.to_dict())
        and request["config_sha256"] == sha(canonical(config.to_dict())) == p["config_sha256"]
        and request["source_sha256"] == p["source_sha256"] == modules
        and p["request_sha256"] == sha(canonical(request)),
        "pilot request/source/config provenance differs",
    )
    require(
        tuple(zip(a["condition_labels"], a["condition_regions"], a["condition_species"]))
        == expected.conditions
        and a["native_resolution"] == [128, 128]
        and a["latent_dim"] == config.latent_dim
        and a["decoder_channels"] == list(config.decoder_channels)
        and p["training_steps"] == expected.stage_updates
        and p["training_status"] == ("fixture_trained" if expected.fixture else "research_trained")
        and p["qualification"] == "engineering_unqualified",
        "pilot model architecture/training scope differs",
    )
    require(
        model["output"]["kind"] == "observed_rgb_appearance"
        and model["output"]["pbr_ground_truth"] is False
        and model["output"]["clinically_validated"] is False,
        "unsupported pilot claims",
    )
    parent, parent_state, parent_request, binding, allowed = read_parent(
        expected_parent_dir, payloads, expected
    )
    refinement = request["refinement"]
    require(
        refinement["schema"] == "viscera.tissue-conv-objective-refinement/v1"
        and refinement["parent"] == binding
        and p["refinement"] == refinement
        and canonical(refinement["objective"]) == canonical(pilot.to_dict()["objective"])
        and refinement["objective_sha256"] == sha(canonical(pilot.to_dict()["objective"])),
        "pilot objective/parent binding differs",
    )
    require(
        refinement["warm_start_policy"]
        == "model and critic including SN buffers; both optimizers reset; fresh sampler and CPU/CUDA RNG; new step zero"
        and refinement["gate"]
        == {
            "step": expected.gate_updates,
            "maximum_updates": 1000,
            "requires_bound_quantitative_receipt_and_explicit_visual_review": True,
        },
        "warm-start/gate policy differs",
    )
    require(
        run
        == experiment_identity(
            "prepared_group_split",
            bundle_sha,
            expected.native_release_sha256,
            {
                "refinement_config": pilot.to_dict(),
                "parent_model_sha256": expected.parent_model_sha256,
                "parent_checkpoint_sha256": binding["checkpoint_manifest_sha256"],
            },
            run["environment_lock_manifest_sha256"],
            sha(payloads["data-readiness/records.jsonl"]),
        )
        and run["run_id"] == run_id,
        "pilot run identity differs",
    )
    prefix = f"checkpoints/step-{expected.stage_updates:09d}"
    checkpoint_sha = sha(payloads[prefix + "/manifest.json"])
    require(
        doc("checkpoints/latest.json")
        == {"directory": prefix.split("/")[1], "manifest_sha256": checkpoint_sha}
        and p["checkpoint_manifest_sha256"] == checkpoint_sha
        and model_name
        == f"{run_id}-step-{expected.stage_updates:09d}-{checkpoint_sha[:16]}.tissue-model.json",
        "stage checkpoint/model identity differs",
    )
    state, saved_request = load_checkpoint(stage / prefix)
    require(saved_request == request, "stage checkpoint request differs")
    base.validate_checkpoint(state, request, replace(config, steps=expected.stage_updates), model)
    require(
        training["committed_updates"] == expected.stage_updates
        and training["status"]
        == ("completed" if expected.stage_updates == expected.budget_updates else "interrupted")
        and training["checkpoint_manifest_sha256"] == checkpoint_sha
        and training["validation"] == state["validation"] == p["validation"]
        and training["environment"] == request["environment"] == p["environment"]
        and training["fixture"] is expected.fixture
        and training["qualification"] == "engineering_unqualified",
        "stage receipt differs or incorrectly claims completion",
    )
    zero, zero_files, zero_sha = zero_checkpoint(payloads, stage, request, parent_state, config)
    allowed |= zero_files
    data, data_files = data_contract(
        payloads, stage, expected_parent_dir, request, parent_request, model, expected
    )
    allowed |= data_files
    _, original = base.original_metadata(Path(original_dir), expected)
    require(
        payloads["native-crops/test.jsonl"] == original["test.jsonl"],
        "original test metadata changed",
    )
    for saved in (zero, state):
        require(
            all(type(i) is int and i in data.splits["train"] for i in saved["order"]),
            "sampler contains held-out indices",
        )
    reference = reference_contract(payloads, data, refinement, pilot.objective)
    diagnostic_files, gate = diagnostics_contract(
        payloads, data, config, request, state, model, parent, model_sha, checkpoint_sha, run_id
    )
    allowed |= diagnostic_files
    snapshot_files, snapshots = snapshots_contract(
        payloads, request, expected, parent, model, zero_sha, checkpoint_sha
    )
    allowed |= snapshot_files
    continuation_files, continuation = continuation_contract(
        payloads, stage, request, config, expected, model, data
    )
    allowed |= continuation_files
    attempts = {name.split("/")[1] for name in payloads if name.startswith("attempts/")}
    import re

    require(
        len(attempts) == 1 and re.fullmatch("[0-9a-f]{16}", next(iter(attempts))),
        "attempt identity invalid",
    )
    attempt = "attempts/" + next(iter(attempts))
    require(
        doc(attempt + "/training-observation.json") == training,
        "attempt observed a different stage",
    )
    require(
        doc(attempt + "/environment-installation.json")["manifest_sha256"]
        == run["environment_lock_manifest_sha256"],
        "runtime lock differs",
    )
    preflight = doc(attempt + "/gpu-preflight.json")
    require(
        preflight["schema"] == "viscera.tissue-conv-refine-preflight/v1"
        and preflight["passed"] is True
        and preflight["gpu_executed"] is (expected.device == "cuda")
        and preflight["warm_start_reset_verified"] is True
        and preflight["portable_export_reference_checked"] is True
        and {
            "model",
            "critic",
            "optimizer",
            "critic_optimizer",
            "sampler_rng",
            "torch_rng",
            "cuda_rng",
        }
        <= set(preflight["checkpoint_state_compared_exactly"]),
        "refinement preflight missing coverage",
    )
    if expected.device == "cuda":
        require(
            "A100" in preflight["hardware"]["gpu_name"]
            and preflight["hardware"]["torch"] == "2.8.0+cu126"
            and preflight["hardware"]["cuda_runtime"] == "12.6",
            "unexpected GPU runtime",
        )
    bake_report = None
    if any(name.startswith("liver-seed42-4096/") for name in payloads):
        bake = doc("liver-seed42-4096/appearance.bake.json")
        liver = a["condition_regions"].index("liver")
        require(
            bake["model_sha256"] == model_sha
            and bake["sha256"] == sha(payloads["liver-seed42-4096/appearance.png"])
            and bake["resolution"] == [4096, 4096]
            and bake["native_decode_resolution"] == [128, 128]
            and bake["condition_index"] == liver
            and bake["seed"] == "42",
            "pilot4K bake identity differs",
        )
        bake_report = base.verify_bake_samples(
            payloads["liver-seed42-4096/appearance.png"], model, liver, 4096
        )
        completion(
            payloads,
            "liver-seed42-4096",
            {
                "kind": "tissue-appearance-bake",
                "model_sha256": model_sha,
                "condition_index": liver,
                "seed_decimal": "42",
                "resolution": 4096,
            },
        )
        allowed |= {
            "liver-seed42-4096/" + name
            for name in ("appearance.png", "appearance.bake.json", "completed-result.json")
        }
    allowed |= {
        base.INVENTORY,
        model_name,
        "request.json",
        "run-identity.json",
        "training-receipt.json",
        "train-reference.json",
        "training-local/config.json",
        "checkpoints/latest.json",
    }
    allowed |= {
        prefix + "/" + name for name in ("manifest.json", "state.json", "tensors.safetensors")
    }
    allowed |= {
        attempt + "/" + name
        for name in (
            "gpu-preflight.json",
            "environment-installation.json",
            "installed-packages.txt",
            "training-observation.json",
        )
    }
    require(
        set(payloads) in (allowed, allowed | {"training-local/metrics-this-vm-attempt.jsonl"}),
        "missing/unapproved pilot files or raw payloads",
    )
    return {
        "schema": "viscera.tissue-conv-refine-run-verification/v1",
        "passed": True,
        "run_id": run_id,
        "model": model_name,
        "model_sha256": model_sha,
        "source_bundle_sha256": bundle_sha,
        "parent": binding,
        "stage_updates": expected.stage_updates,
        "budget_updates": expected.budget_updates,
        "budget_completed": expected.stage_updates == expected.budget_updates,
        "checkpoint_manifest_sha256": checkpoint_sha,
        "initial_checkpoint_sha256": zero_sha,
        "warm_start_model_and_critic_exact": True,
        "initial_optimizers_empty": True,
        "both_stage_optimizer_states_validated": True,
        "train_reference_rows": len(reference["rows"]),
        "train_reference_payload_statistics_recomputed": False,
        "native_release_sha256": expected.native_release_sha256,
        "test_payloads_opened_locally": 0,
        "raw_native_payloads_rechecked_locally": False,
        "snapshots": snapshots,
        "numerical_gate_passed": gate["numerical_passed"],
        "continuation": continuation,
        "optional_bake_selected_pixels": bake_report,
        "visual_acceptance_by_verifier": False,
        "qualification": "engineering_unqualified",
    }


def verify(
    archive,
    archive_sha,
    model_sha,
    bundle,
    bundle_sha,
    run_id,
    output,
    *,
    expected_parent_dir,
    baseline_bundle,
    original_release_dir,
    expected=Expectations(),
):
    archive, bundle, output = map(lambda p: Path(p).absolute(), (archive, bundle, output))
    no_symlinks(output)
    require(
        not output.exists() and output.parent.is_dir(), "output must be a new exclusive directory"
    )
    payloads = base.read_archive(archive, archive_sha)
    _, modules = source_inventory(bundle, bundle_sha, Path(baseline_bundle), expected)
    stage = Path(tempfile.mkdtemp(prefix=".refine-verify-", dir=output.parent))
    try:
        for name, raw in payloads.items():
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as handle:
                handle.write(raw)
        result = validate_graph(
            payloads,
            stage,
            model_sha,
            bundle_sha,
            run_id,
            modules,
            expected_parent_dir,
            expected,
            original_release_dir,
        )
        result.update(
            archive_sha256=archive_sha,
            archive_bytes=archive.stat().st_size,
            inventory_files=len(payloads) - 1,
            verifier_sha256=file_sha(Path(__file__)),
            shared_verifier_sha256=file_sha(Path(base.__file__)),
            output=str(output),
        )
        (stage / "local-verification.json").write_text(
            json.dumps(result, indent=2, allow_nan=False) + "\n"
        )
        stage.rename(output)
        return result
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    for name in ("archive-sha256", "model-sha256", "bundle-sha256", "run-id"):
        parser.add_argument("--expected-" + name, required=True)
    parser.add_argument("--expected-stage-updates", type=int, choices=(300, 1000), required=True)
    for name in ("bundle", "output", "expected-parent-dir"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument(
        "--baseline-bundle",
        type=Path,
        default=ROOT
        / "artifacts/tissue-colab-2026-10-19/upload-conv-v3-1/viscera-tissue-conv-colab.zip",
    )
    parser.add_argument(
        "--original-release-dir",
        type=Path,
        default=ROOT / "artifacts/tissue-colab-2026-10-19/completed-run-verified/source-release",
    )
    args = parser.parse_args()
    try:
        result = verify(
            args.archive,
            args.expected_archive_sha256,
            args.expected_model_sha256,
            args.bundle,
            args.expected_bundle_sha256,
            args.expected_run_id,
            args.output,
            expected_parent_dir=args.expected_parent_dir,
            baseline_bundle=args.baseline_bundle,
            original_release_dir=args.original_release_dir,
            expected=Expectations(stage_updates=args.expected_stage_updates),
        )
    except (ValueError, KeyError, OSError, TypeError, zipfile.BadZipFile) as error:
        print(json.dumps({"passed": False, "error": str(error)}), file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
