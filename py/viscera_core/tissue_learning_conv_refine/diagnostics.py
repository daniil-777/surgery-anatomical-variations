"""Paired same-case pilot gate; statistics never substitute for visual acceptance."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import torch
from torch.nn import functional as F

from viscera_core.tissue_learning.artifact import seed_latent
from viscera_core.tissue_learning.checkpoint import atomic_json, digest, load_checkpoint
from viscera_core.tissue_learning.config import identity
from viscera_core.tissue_learning.model import objective
from viscera_core.tissue_learning_conv.config import ConvConfig
from viscera_core.tissue_learning_conv.diagnostics import diagnose as original_diagnose
from viscera_core.tissue_learning_conv.model import (
    ConvVAE,
    ProjectionPatchCritic,
    critic_weights,
    masked_feature_matching,
    weighted_scores,
)

from .config import RefineObjective
from .losses import neighbor_charbonnier, prior_matching


def objective_terms(model, critic, x, mask, ci, reference, config, objective_config, seed="42"):
    c = F.one_hot(torch.tensor([ci], device=x.device), len(reference["conditions"])).float()
    prediction, mu, logvar = model(x, mask, c, sample=False)
    z = torch.from_numpy(seed_latent(seed, config.latent_dim)[None]).to(x.device)
    prior = model.decoder(z, c)
    scales = torch.as_tensor(reference["neighbor_scale"], device=x.device)[[ci]]
    base = objective(prediction, x, mask, mu, logvar, config)
    weights = critic_weights(mask, config.critic_minimum_coverage)
    with torch.no_grad():
        real_score, real_features = critic(x, mask, c)
    post_score, post_features = critic(prediction, mask, c)
    prior_score, _ = critic(prior, mask, c)
    frequency, palette, _ = prior_matching(
        prior, mask, torch.tensor([ci], device=x.device), reference, objective_config
    )
    return {
        "posterior_l1": ((prediction - x).abs() * mask).sum() / (3 * mask.sum()),
        "normalized_neighbor_charbonnier": objective_config.neighbor_weight
        * neighbor_charbonnier(prediction, x, mask, scales, objective_config.charbonnier_epsilon),
        "kl": config.beta_kl * base["kl"],
        "prior_adversarial": -config.prior_adversarial_weight
        * weighted_scores(prior_score, weights),
        "posterior_adversarial": -config.posterior_adversarial_weight
        * weighted_scores(post_score, weights),
        "posterior_feature_matching": config.feature_matching_weight
        * masked_feature_matching(
            post_features, real_features, mask, config.critic_minimum_coverage
        ),
        "prior_frequency_match": objective_config.prior_frequency_weight * frequency,
        "prior_palette_bounds": objective_config.prior_palette_weight * palette,
    }


def continuation_checks(summaries, ratios):
    def mean(label, key):
        return float(np.mean([s[label][key] for s in summaries.values()]))

    return {
        "neighbor_error_improves_5_percent": mean("candidate", "neighbor_charbonnier")
        <= 0.95 * mean("parent", "neighbor_charbonnier"),
        "prior_frequency_error_improves_10_percent": mean("candidate", "prior_frequency_error")
        <= 0.90 * mean("parent", "prior_frequency_error"),
        "no_condition_neighbor_error_worsens_10_percent": all(
            s["candidate"]["neighbor_charbonnier"] <= 1.1 * s["parent"]["neighbor_charbonnier"]
            for s in summaries.values()
        ),
        "no_condition_l1_worsens_15_percent": all(
            s["candidate"]["masked_l1"] <= 1.15 * s["parent"]["masked_l1"]
            for s in summaries.values()
        ),
        "palette_violation_not_worse": all(
            s["candidate"]["prior_palette_violation"]
            <= max(0.01, 1.05 * s["parent"]["prior_palette_violation"])
            for s in summaries.values()
        ),
        "detail_gradient_median_ratio_0_01_to_2": 0.01 <= float(np.median(ratios)) <= 2,
    }


def summarize_evidence(rows, priors, gradients, conditions):
    summaries = {}
    for condition in conditions:
        selected = [r for r in rows if r["condition"] == condition]
        p = [r for r in priors if r["condition"] == condition]
        summaries[condition] = {
            label: {
                "neighbor_charbonnier": float(
                    np.mean([r[label]["neighbor_charbonnier"] for r in selected])
                ),
                "masked_l1": float(np.mean([r[label]["masked_l1"] for r in selected])),
                "prior_frequency_error": float(np.mean([r[label]["frequency_error"] for r in p])),
                "prior_palette_violation": float(
                    np.mean([r[label]["palette_violation"] for r in p])
                ),
            }
            for label in ("parent", "candidate")
        }
    ratios = [
        r["terms"]["normalized_neighbor_charbonnier"]["generator_gradient_l2"]
        / max(r["terms"]["posterior_l1"]["generator_gradient_l2"], 1e-12)
        for r in gradients
    ]
    return summaries, ratios


def select_display_cases(rows):
    """Predeclared lower-median coverage per condition/surgery, ties by ID."""
    buckets = {}
    for row in rows:
        buckets.setdefault((row["condition"], row["group_id"]), []).append(row)
    selected = []
    for key in sorted(buckets):
        choices = sorted(buckets[key], key=lambda row: (row["valid_fraction"], row["id"]))
        row = choices[(len(choices) - 1) // 2]
        selected.append(
            {
                "id": row["id"],
                "condition": key[0],
                "group_id": key[1],
                "valid_fraction": row["valid_fraction"],
                "candidates": len(choices),
                "selection": "lower median valid coverage; ties lexical ID; independent of model outputs",
            }
        )
    return selected


def save_group_comparison(path, selected, displayed):
    from PIL import Image, ImageDraw

    rows_per_column = (len(selected) + 1) // 2
    block_width, row_height = 528, 153
    image = Image.new("RGB", (2 * block_width, 28 + rows_per_column * row_height), (24, 24, 28))
    draw = ImageDraw.Draw(image)
    for column in range(2):
        draw.text(
            (column * block_width + 4, 6),
            "Observed RGB       Valid mask       Parent posterior    Candidate posterior",
            fill="white",
        )
    for offset, metadata in enumerate(selected):
        column, row = divmod(offset, rows_per_column)
        x, y = column * block_width + 4, 28 + row * row_height
        draw.text((x, y), metadata["id"], fill="white")
        for index, array in enumerate(displayed[metadata["id"]]):
            image.paste(Image.fromarray(array), (x + index * 128, y + 18))
    image.save(path)


def diagnose(checkpoint, dataset, model_path, output, *, warm_start, device="cpu"):
    state, request = load_checkpoint(checkpoint)
    parent_state, parent_request = load_checkpoint(warm_start)
    refinement = request["refinement"]
    if (
        digest(Path(warm_start) / "manifest.json")
        != refinement["parent"]["checkpoint_manifest_sha256"]
        or identity(parent_request) != refinement["parent"]["request_sha256"]
    ):
        raise ValueError("diagnostic warm-start parent differs")
    config = ConvConfig.from_dict(request["config"])
    objective_config = RefineObjective(
        **{**refinement["objective"], "kernels": tuple(refinement["objective"]["kernels"])}
    )
    reference = refinement["reference"]
    output = Path(output)
    report = original_diagnose(checkpoint, dataset, model_path, output, device=device)
    # The inherited calculation is labelled legacy, not the changed training loss.
    if "fixed_batch_objective_gradient_diagnostic" in report:
        report["legacy_objective_gradient_comparison"] = report.pop(
            "fixed_batch_objective_gradient_diagnostic"
        )
    torch.backends.cudnn.allow_tf32 = False
    torch.backends.cuda.matmul.allow_tf32 = False
    models = []
    for value in (parent_state, state):
        model = ConvVAE(config, len(dataset.conditions)).to(device).eval()
        model.load_state_dict(value["model"], strict=True)
        models.append(model)
    indices = dataset.evaluation_indices("val", min(config.validation_limit, 128))
    display_cases = select_display_cases(report["evaluated_rows"])
    display_ids = {row["id"] for row in display_cases}
    displayed = {}
    rows, gradients, seen = [], [], set()
    critic = ProjectionPatchCritic(len(dataset.conditions), config.critic_width).to(device).eval()
    critic.load_state_dict(state["critic"], strict=True)
    critic.requires_grad_(False)
    for index in indices:
        row = dataset.records[index]
        rgb, mask, ci = dataset.load(
            index, 128, minimum_valid_fraction=config.minimum_valid_fraction
        )
        x, m = torch.from_numpy(rgb[None]).to(device), torch.from_numpy(mask[None]).to(device)
        c = F.one_hot(torch.tensor([ci], device=device), len(dataset.conditions)).float()
        scales = torch.as_tensor(reference["neighbor_scale"], device=device)[[ci]]
        values = []
        thumbnails = []
        if row["id"] in display_ids:
            thumbnails = [
                np.rint(rgb.transpose(1, 2, 0) * 255).clip(0, 255).astype(np.uint8),
                np.repeat(np.rint(mask.transpose(1, 2, 0) * 255).astype(np.uint8), 3, axis=2),
            ]
        with torch.no_grad():
            for model in models:
                prediction, _, _ = model(x, m, c, sample=False)
                if row["id"] in display_ids:
                    thumbnails.append(
                        np.rint(prediction[0].permute(1, 2, 0).cpu().numpy() * 255)
                        .clip(0, 255)
                        .astype(np.uint8)
                    )
                values.append(
                    {
                        "neighbor_charbonnier": float(
                            neighbor_charbonnier(
                                prediction, x, m, scales, objective_config.charbonnier_epsilon
                            )
                        ),
                        "masked_l1": float(((prediction - x).abs() * m).sum() / (3 * m.sum())),
                    }
                )
        if thumbnails:
            displayed[row["id"]] = thumbnails
        rows.append(
            {
                "id": row["id"],
                "group_id": row["group_id"],
                "condition": row["condition"],
                "image_sha256": row["image_sha256"],
                "mask_sha256": row["mask_sha256"],
                "parent": values[0],
                "candidate": values[1],
            }
        )
        key = (row["condition"], row["group_id"])
        if key not in seen:
            seen.add(key)
            terms = objective_terms(
                models[1], critic, x, m, ci, reference, config, objective_config
            )
            measured = {}
            for name, term in terms.items():
                grads = torch.autograd.grad(
                    term, tuple(models[1].parameters()), retain_graph=True, allow_unused=True
                )
                norm = sum(
                    (g.detach().float().square().sum() for g in grads if g is not None),
                    torch.zeros((), device=device),
                ).sqrt()
                if not torch.isfinite(norm):
                    raise ValueError("nonfinite diagnostic gradient")
                measured[name] = {
                    "weighted_scalar": float(term.detach()),
                    "generator_gradient_l2": float(norm),
                }
            gradients.append(
                {
                    "id": row["id"],
                    "condition": row["condition"],
                    "group_id": row["group_id"],
                    "terms": measured,
                }
            )
    priors = []
    with torch.no_grad():
        for ci, condition in enumerate(dataset.conditions):
            for seed in ("42", "43", str(2**64 - 1)):
                z = torch.from_numpy(seed_latent(seed, config.latent_dim)[None]).to(device)
                c = F.one_hot(torch.tensor([ci], device=device), len(dataset.conditions)).float()
                values = []
                for label, model in zip(("parent", "candidate"), models):
                    prior = model.decoder(z, c)
                    frequency, palette, stats = prior_matching(
                        prior,
                        torch.ones_like(prior[:, :1]),
                        torch.tensor([ci], device=device),
                        reference,
                        objective_config,
                    )
                    values.append(
                        {
                            "frequency_error": float(frequency),
                            "palette_violation": float(palette),
                            "frequency_rms": stats["frequency"][0].tolist(),
                            "rgb_mean": stats["mean"][0].tolist(),
                            "rgb_std": stats["std"][0].tolist(),
                            "soft_dark_bright_fraction": stats["tails"][0].tolist(),
                        }
                    )
                    from PIL import Image

                    rgb8 = (
                        np.rint(prior[0].permute(1, 2, 0).cpu().numpy() * 255)
                        .clip(0, 255)
                        .astype(np.uint8)
                    )
                    Image.fromarray(rgb8).save(
                        output / f"{label}-condition-{ci}-seed{seed}-native128.png"
                    )
                priors.append(
                    {
                        "condition": condition,
                        "seed": seed,
                        "parent": values[0],
                        "candidate": values[1],
                    }
                )
    summaries, ratios = summarize_evidence(rows, priors, gradients, dataset.conditions)
    checks = continuation_checks(summaries, ratios)
    gate = {
        "schema": "viscera.tissue-refine-objective-gate/v1",
        "request_sha256": identity(request),
        "checkpoint_manifest_sha256": digest(Path(checkpoint) / "manifest.json"),
        "model_sha256": digest(model_path),
        "step": state["step"],
        "parent": refinement["parent"],
        "reference_sha256": reference["sha256"],
        "evaluation_rows_sha256": identity(rows),
        "evaluated_rows": len(rows),
        "condition_summaries": summaries,
        "detail_to_l1_gradient_ratios": ratios,
        "numerical_checks": checks,
        "numerical_passed": all(checks.values()),
        "prior_metric_mask": "all-valid whole tile; train targets use supplied source masks, not identically masked paired pixels",
        "visual_acceptance_required": True,
        "qualification": "engineering_unqualified",
        "warning": "Moments can be matched by noise, grids or halos. Numerical improvement is not realism; reject such artifacts visually.",
    }
    source_by_id = {row["id"]: row for row in rows}
    for row in display_cases:
        row["image_sha256"] = source_by_id[row["id"]]["image_sha256"]
        row["mask_sha256"] = source_by_id[row["id"]]["mask_sha256"]
    save_group_comparison(
        output / "group-balanced-posterior-comparison.png", display_cases, displayed
    )
    report["refinement"] = {
        "supplemental_display_cases": display_cases,
        "supplemental_display_native_pixels": [128, 128],
        "supplemental_display_resampling": "none",
        "supplemental_display_sha256": digest(output / "group-balanced-posterior-comparison.png"),
        "parent": refinement["parent"],
        "reference_sha256": reference["sha256"],
        "paired_rows": rows,
        "prior_samples": priors,
        "objective_gradient_cases": gradients,
        "gradient_scope": "one fixed case per evaluated condition/surgery; not training-averaged gradient dominance",
    }
    atomic_json(output / "diagnostics.json", report)
    gate["diagnostics_sha256"] = digest(output / "diagnostics.json")
    atomic_json(output / "objective-gate.json", gate)
    return report


def validate_continuation(trainer, gate_path, visual_path):
    if gate_path is None or visual_path is None:
        raise ValueError(
            "explicit quantitative gate and visual review required before continuation"
        )
    gate_path, visual_path = Path(gate_path), Path(visual_path)
    if max(gate_path.stat().st_size, visual_path.stat().st_size) > 2_000_000:
        raise ValueError("gate/review exceeds bound")
    gate, review = json.loads(gate_path.read_text()), json.loads(visual_path.read_text())
    if (
        gate.get("schema") != "viscera.tissue-refine-objective-gate/v1"
        or gate.get("request_sha256") != identity(trainer.request)
        or gate.get("step") != trainer.pilot.objective.gate_step
        or gate.get("reference_sha256") != trainer.reference["sha256"]
        or gate.get("numerical_passed") is not True
        or not gate.get("numerical_checks")
        or not all(v is True for v in gate["numerical_checks"].values())
    ):
        raise ValueError("quantitative continuation gate failed or identity differs")
    expected_checks = continuation_checks(
        gate["condition_summaries"], gate["detail_to_l1_gradient_ratios"]
    )
    if (
        gate["numerical_checks"] != expected_checks
        or not all(expected_checks.values())
        or set(gate["condition_summaries"]) != set(trainer.dataset.conditions)
    ):
        raise ValueError("numerical guards were changed or failed")
    diagnostic_path = gate_path.parent / "diagnostics.json"
    if (
        not diagnostic_path.is_file()
        or diagnostic_path.stat().st_size > 32_000_000
        or digest(diagnostic_path) != gate.get("diagnostics_sha256")
    ):
        raise ValueError("gate diagnostic evidence missing or altered")
    diagnostics = json.loads(diagnostic_path.read_text())
    # JSON accepts NaN by default; evidence must be finite before any comparisons.
    json.dumps(diagnostics, allow_nan=False)
    json.dumps(gate, allow_nan=False)
    evidence = diagnostics["refinement"]
    if (
        diagnostics["model_file_sha256"] != gate["model_sha256"]
        or diagnostics["checkpoint_manifest_sha256"] != gate["checkpoint_manifest_sha256"]
        or evidence["parent"] != trainer.request["refinement"]["parent"]
        or evidence["reference_sha256"] != trainer.reference["sha256"]
    ):
        raise ValueError("diagnostic model/parent binding differs")
    rows = evidence["paired_rows"]
    summaries, ratios = summarize_evidence(
        rows,
        evidence["prior_samples"],
        evidence["objective_gradient_cases"],
        trainer.dataset.conditions,
    )
    if summaries != gate["condition_summaries"] or ratios != gate["detail_to_l1_gradient_ratios"]:
        raise ValueError("gate summaries differ from detailed evidence")
    if identity(rows) != gate["evaluation_rows_sha256"]:
        raise ValueError("paired diagnostic rows differ")
    expected_ids = [
        trainer.dataset.records[i]["id"]
        for i in trainer.dataset.evaluation_indices(
            "val", min(trainer.config.validation_limit, 128)
        )
    ]
    if [row["id"] for row in rows] != expected_ids or gate["evaluated_rows"] != len(rows):
        raise ValueError("gate validation cases differ")
    for key in ("accepted", "detail_improved", "no_new_artifacts"):
        if review.get(key) is not True:
            raise ValueError("explicit positive visual review required")
    if (
        review.get("gate_sha256") != digest(gate_path)
        or review.get("checkpoint_manifest_sha256") != gate["checkpoint_manifest_sha256"]
        or not isinstance(review.get("reviewer"), str)
        or not review["reviewer"].strip()
        or not isinstance(review.get("evidence"), str)
        or not review["evidence"].strip()
    ):
        raise ValueError("visual review binding/evidence missing")
    # Independently bind the gate to the committed milestone, including fresh-VM resumes.
    candidates = [trainer.output / "checkpoints" / f"step-{trainer.pilot.objective.gate_step:09d}"]
    if trainer.mirror:
        candidates.append(trainer.mirror / "checkpoints" / candidates[0].name)
    found = False
    for checkpoint in candidates:
        if (checkpoint / "manifest.json").exists():
            _, request = load_checkpoint(checkpoint)
            if (
                identity(request) != identity(trainer.request)
                or digest(checkpoint / "manifest.json") != gate["checkpoint_manifest_sha256"]
            ):
                raise ValueError("committed gate checkpoint differs")
            found = True
    if not found:
        raise ValueError("committed gate checkpoint is required for continuation")
    receipt = {
        "gate_sha256": digest(gate_path),
        "visual_review_sha256": digest(visual_path),
        "gate": gate,
        "visual_review": review,
    }
    for path in [
        trainer.output / "continuation-review.json",
        *([trainer.mirror / "continuation-review.json"] if trainer.mirror else []),
    ]:
        if path.exists() and json.loads(path.read_text()) != receipt:
            raise ValueError("existing continuation review differs; preserve prior evidence")
    return receipt
