"""Saved image comparisons and explicit quality limitations for a trained candidate."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont
from torch.nn import functional as F

from viscera_core.tissue_learning.checkpoint import atomic_json, digest, load_checkpoint

from .artifact import bake_artifact, load_artifact, seed_latent
from .config import DetailConfig
from .data import NativePatchDataset
from .model import DetailVAE


def diagnose(checkpoint: Path, dataset: NativePatchDataset, model_path: Path,
             output: Path, *, device: str = "cpu") -> dict:
    state, request = load_checkpoint(checkpoint)
    artifact = load_artifact(model_path)
    if (request["data"]["manifest_sha256"] != dataset.digest
            or artifact["provenance"]["checkpoint_manifest_sha256"] != digest(checkpoint / "manifest.json")):
        raise ValueError("diagnostic data/model/checkpoint identity mismatch")
    config = DetailConfig.from_dict(request["config"])
    if device not in ("cpu", "cuda") or device == "cuda" and not torch.cuda.is_available():
        raise ValueError("requested diagnostic device unavailable")
    model = DetailVAE(config, len(dataset.conditions)).to(device).eval()
    model.load_state_dict(state["model"], strict=True)
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False)
    split = "train" if config.validation_mode == "training_only" else "val"
    candidates = dataset.evaluation_indices(split, min(config.validation_limit, 128))
    rows = []
    selected: dict[str, tuple] = {}
    means, logvars = [], []
    with torch.no_grad():
        for index in candidates:
            rgb, mask, condition_index = dataset.load(index, config.patch_size,
                minimum_valid_fraction=config.minimum_valid_fraction)
            x, m = torch.from_numpy(rgb[None]).to(device), torch.from_numpy(mask[None]).to(device)
            condition = F.one_hot(torch.tensor([condition_index], device=device), len(dataset.conditions)).float()
            prediction, mu, logvar = model(x, m, condition, sample=False)
            predicted = prediction.cpu().numpy()[0]
            baseline = np.asarray(state["baseline"]["rgb"][condition_index], dtype=np.float32)[:, None, None]
            rows.append({"id": dataset.records[index]["id"], "condition": dataset.conditions[condition_index],
                "group_id": dataset.records[index]["group_id"], "valid_fraction": float(mask.mean()),
                "posterior_masked_mse": float(((predicted - rgb)**2 * mask).sum() / (3 * mask.sum())),
                "train_mean_masked_mse": float(((baseline - rgb)**2 * mask).sum() / (3 * mask.sum()))})
            means.append(mu.cpu().numpy()[0])
            logvars.append(logvar.cpu().numpy()[0])
            name = dataset.conditions[condition_index]
            # Display the most covered patch in the bounded evaluated subset;
            # this selection is disclosed and is not an unbiased quality score.
            if name not in selected or mask.mean() > selected[name][1].mean():
                selected[name] = (rgb, mask, predicted, baseline, condition_index)
    per_condition = {name: {metric: float(np.mean([row[metric] for row in rows if row["condition"] == name]))
        for metric in ("posterior_masked_mse", "train_mean_masked_mse")}
        for name in sorted({row["condition"] for row in rows})}
    uv_values = (torch.arange(32, device=device, dtype=torch.float32) + .5) / 32
    v, u = torch.meshgrid(uv_values, uv_values, indexing="ij")
    uv = torch.stack((u, v), -1).reshape(1, -1, 2).expand(8, -1, -1)
    latent = torch.from_numpy(np.stack([seed_latent(seed, config.latent_dim) for seed in range(8)])).to(device)
    diversity = {}
    with torch.no_grad():
        for index, name in enumerate(dataset.conditions):
            condition = F.one_hot(torch.full((8,), index, device=device), len(dataset.conditions)).float()
            diversity[name] = float(model.decoder(latent, condition, uv).std(0).mean().item())
    report = {"measurement_split": split, "evaluated_samples": len(rows),
        "evaluated_groups": len({row["group_id"] for row in rows}), "per_condition": per_condition,
        "evaluated_rows": rows, "last_training_event": state["loss_history"][-1],
        "macro_posterior_masked_mse": float(np.mean([r["posterior_masked_mse"] for r in per_condition.values()])),
        "macro_train_mean_masked_mse": float(np.mean([r["train_mean_masked_mse"] for r in per_condition.values()])),
        "prior_rgb_std_eight_seeds": diversity,
        "posterior_mu_variance": float(np.var(np.stack(means), axis=0).mean()),
        "posterior_mean_logvar": float(np.mean(logvars)),
        "last_training_kl": state["loss_history"][-1]["kl"],
        "loss_trace": state["loss_history"], "loss_trace_scope": "last up to 4000 committed updates",
        "data_summary": dataset.summary(), "model_file_sha256": digest(model_path),
        "checkpoint_manifest_sha256": digest(checkpoint / "manifest.json"),
        "training_native_patch_size": config.patch_size, "training_source_crop_size": 128,
        "qualification": "engineering_unqualified",
        "limits": ["Posterior reconstruction is not realism of generated prior samples.",
                   "No physical-material ground truth; RGB includes lighting and camera effects.",
                   "Native-crop metrics cannot be compared directly with the earlier full-frame-resize metrics.",
                   "The compact periodic decoder can produce blurred low-frequency appearance.",
                   "No patient-specific anatomy, all-organ coverage or clinical qualification.",
                   "Training-only mode has no held-out generalization evidence." if split == "train" else
                   "Held-out group semantics are exactly those supplied in the data manifest."],
        "display_selection": "largest mask coverage per condition in bounded evaluated subset; at most eight conditions"}
    report["beats_train_mean_baseline"] = report["macro_posterior_masked_mse"] < report["macro_train_mean_masked_mse"]
    report["quality_decision"] = "not_qualified; inspect images; never enable as a default photoreal model"
    thumb, header = 160, 58
    displayed = list(sorted(selected))[:8]
    canvas = Image.new("RGB", (5 * thumb, header + len(displayed) * (thumb + 42)), "#15151b")
    draw, font = ImageDraw.Draw(canvas), ImageFont.load_default(size=13)
    for column, label in enumerate(("Observed RGB patch", "Validity mask", "Posterior reconstruction", "Prior seed42", "Train-mean baseline")):
        draw.text((column * thumb + 4, 8), label, font=font, fill="white")
    for row_index, name in enumerate(displayed):
        rgb, mask, predicted, baseline, condition_index = selected[name]
        preview = output / f"condition-{condition_index}-seed42-256.png"
        bake_artifact(model_path, preview, seed="42", condition_index=condition_index,
                      resolution=256, device=device)
        tiles = [np.moveaxis(rgb, 0, -1), np.repeat(np.moveaxis(mask, 0, -1), 3, -1),
                 np.moveaxis(predicted, 0, -1), None,
                 np.broadcast_to(baseline[:, 0, 0], (config.patch_size, config.patch_size, 3))]
        y = header + row_index * (thumb + 42)
        draw.text((4, y - 22), name[:100], font=font, fill="#dec8a8")
        for column, tile in enumerate(tiles):
            if tile is None:
                image = Image.open(preview).convert("RGB")
            else:
                image = Image.fromarray(np.rint(np.clip(tile, 0, 1) * 255).astype(np.uint8))
            canvas.paste(image.resize((thumb, thumb), Image.Resampling.NEAREST), (column * thumb, y))
        draw.text((4, y + thumb + 3), f"{split} only; native training {config.patch_size}²; prior output sampling256²", font=font, fill="#cccccc")
    canvas.save(output / "appearance-comparison.png")
    trace = state["loss_history"]
    plot = Image.new("RGB", (800, 240), "white")
    draw = ImageDraw.Draw(plot)
    values = [row["loss"] for row in trace]
    low, high = min(values), max(values)
    points = [(30 + i * 740 / max(1, len(values) - 1), 200 - (value - low) * 150 / max(high - low, 1e-9))
              for i, value in enumerate(values)]
    if len(points) > 1:
        draw.line(points, fill="#773449", width=2)
    draw.text((20, 12), f"Training objective (not realism): first retained={values[0]:.6g}, last={values[-1]:.6g}", font=font, fill="black")
    plot.save(output / "loss-trace.png")
    atomic_json(output / "diagnostics.json", report)
    return report
