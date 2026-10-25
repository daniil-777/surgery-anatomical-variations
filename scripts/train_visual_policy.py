#!/usr/bin/env python3
"""Fine-tune the pinned visual action expert on episode-grouped simulator data.

Raw RGB and observed instrument state are inputs. Teacher phase/labels and
privileged organ geometry are excluded from model inputs. Geometry signatures
are used only to prevent scene leakage across the training/evaluation split.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py"))
import numpy as np
import torch
from PIL import Image
from viscera_core.visual_policy.contract import INSTRUCTIONS, SKILLS, decode_action
from viscera_core.visual_policy.model import (
    BASE_REVISION,
    VLM_REVISION,
    build_policy,
    make_batch,
    predict,
    save_adapter,
    sha256,
)


def load_data(directory: Path, seed: int):
    episodes = []
    for path in sorted(directory.glob("episode-*/episode.json")):
        value = json.loads(path.read_text())
        if not value.get("success"):
            continue
        signatures = tuple(o["geometrySignature"] for o in value["evidence"]["organs"])
        episodes.append((path, value, signatures))
    groups = sorted(set(group for _, _, group in episodes))
    if len(groups) < 5:
        raise ValueError(f"Need at least five distinct scene groups; found {len(groups)}")
    random.Random(seed).shuffle(groups)
    validation_count = max(1, round(len(groups) * 0.15))
    test_count = max(2, round(len(groups) * 0.2))
    val_groups, test_groups = (
        set(groups[:validation_count]),
        set(groups[validation_count : validation_count + test_count]),
    )
    data = {"train": [], "validation": [], "test": []}
    manifest = []
    for path, episode, group in episodes:
        split = "validation" if group in val_groups else "test" if group in test_groups else "train"
        for row in episode["rows"]:
            # Keep only the first frame at each decision boundary. Neighbouring
            # temporal frames are retained on disk, never counted as independent trials.
            if not row["image"].endswith("-0.jpg"):
                continue
            image_path = path.parent / row["image"]
            image = Image.open(image_path).convert("RGB")
            instructions = INSTRUCTIONS[:2] if split == "train" else INSTRUCTIONS
            for instruction in instructions:
                data[split].append(
                    {
                        "image": image,
                        "state": row["state"],
                        "instruction": instruction,
                        "label": SKILLS.index(row["label"]),
                        "episode": episode["episode"],
                        "corrupt": False,
                    }
                )
            # A missing/black video feed must abstain despite otherwise plausible
            # proprioception. These are synthetic corruption examples, labelled as such.
            data[split].append(
                {
                    "image": Image.new("RGB", (256, 256)),
                    "state": row["state"],
                    "instruction": INSTRUCTIONS[0],
                    "label": 4,
                    "episode": episode["episode"],
                    "corrupt": True,
                }
            )
            manifest.append(
                {
                    "episode": episode["episode"],
                    "split": split,
                    "image": str(image_path.relative_to(directory)),
                    "sha256": sha256(image_path),
                    "label": row["label"],
                }
            )
    if any(not values for values in data.values()):
        raise ValueError("Every dataset partition must contain complete episodes")
    return data, manifest, {name: len({r["episode"] for r in rows}) for name, rows in data.items()}


def evaluate(policy, rows, device, batch_size=8):
    outputs = []
    for start in range(0, len(rows), batch_size):
        batch = rows[start : start + batch_size]
        predictions = predict(policy, make_batch(policy, batch, device))
        for row, scores in zip(batch, predictions, strict=True):
            decision = decode_action(scores)
            outputs.append(
                {
                    "episode": row["episode"],
                    "label": SKILLS[row["label"]],
                    "corrupt": row["corrupt"],
                    **decision,
                }
            )
    def correct(r):
        return r["skill"] == r["label"]
    return {
        "accuracy": sum(map(correct, outputs)) / len(outputs),
        "acceptedAccuracy": sum(correct(r) and r["accepted"] for r in outputs)
        / max(1, sum(r["accepted"] for r in outputs)),
        "coverage": sum(r["accepted"] for r in outputs) / len(outputs),
        "wrongAccepted": sum(r["accepted"] and not correct(r) for r in outputs),
        "perSkill": {
            skill: sum(correct(r) for r in outputs if r["label"] == skill)
            / max(1, sum(r["label"] == skill for r in outputs))
            for skill in SKILLS
        },
        "predictions": outputs,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--steps", type=int, default=800)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--batch-size", type=int, default=8)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    random.seed(args.seed)
    torch.set_num_threads(4)
    device = (
        "mps"
        if torch.backends.mps.is_available()
        else "cuda"
        if torch.cuda.is_available()
        else "cpu"
    )
    data, manifest, episodes = load_data(args.data, args.seed)
    (args.out / "dataset-manifest.json").write_text(json.dumps(manifest, indent=2))
    policy = build_policy(args.models, device)
    print("dataset", episodes, {k: len(v) for k, v in data.items()}, flush=True)
    baseline = evaluate(policy, data["validation"], device)
    (args.out / "baseline.json").write_text(json.dumps(baseline))
    optimizer = torch.optim.AdamW(
        [p for p in policy.parameters() if p.requires_grad], lr=2e-4, weight_decay=0.001
    )
    # The vision encoder is frozen. Cache only its deterministic image embeddings;
    # state projection and the multimodal/action layers still execute during training.
    expert = policy.model.vlm_with_expert
    original_embed = expert.embed_image
    cache = []
    with torch.no_grad():
        for start in range(0, len(data["train"]), 8):
            batch = make_batch(policy, data["train"][start : start + 8], device)
            cache.append(original_embed(batch["observation.images.camera1"] * 2 - 1).cpu())
    cache = torch.cat(cache)
    rng = random.Random(args.seed)
    curve = []
    best = (-1.0, -1.0)
    began = time.perf_counter()
    for step in range(1, args.steps + 1):
        indices = [rng.randrange(len(data["train"])) for _ in range(args.batch_size)]
        rows = [data["train"][i] for i in indices]
        batch = make_batch(policy, rows, device)
        batch["action"] = torch.zeros(len(rows), 1, 5, device=device)
        batch["action"][
            torch.arange(len(rows), device=device),
            0,
            torch.tensor([r["label"] for r in rows], device=device),
        ] = 1
        embedding = cache[indices].to(device)
        expert.embed_image = lambda image: embedding
        policy.train()
        optimizer.zero_grad(set_to_none=True)
        loss, _ = policy(batch)
        loss.backward()
        torch.nn.utils.clip_grad_norm_([p for p in policy.parameters() if p.requires_grad], 1.0)
        optimizer.step()
        expert.embed_image = original_embed
        if not torch.isfinite(loss):
            raise ValueError("Nonfinite training loss")
        if step % 25 == 0:
            entry = {
                "step": step,
                "loss": float(loss.detach().cpu()),
                "seconds": time.perf_counter() - began,
            }
            curve.append(entry)
            print(json.dumps(entry), flush=True)
        if step % 100 == 0 or step == args.steps:
            metrics = evaluate(policy, data["validation"], device)
            score = (metrics["accuracy"], metrics["coverage"])
            print(
                "validation",
                step,
                {k: v for k, v in metrics.items() if k != "predictions"},
                flush=True,
            )
            if score > best:
                best = score
                save_adapter(policy, args.out / "adapter.safetensors")
                (args.out / "validation.json").write_text(json.dumps({"step": step, **metrics}))
    # Frozen final test: never used for checkpoint selection.
    del optimizer, policy
    if device == "mps":
        torch.mps.empty_cache()
    policy = build_policy(args.models, device, args.out / "adapter.safetensors")
    test = evaluate(policy, data["test"], device)
    timings = []
    for index in range(32):
        batch = make_batch(policy, [data["test"][index % len(data["test"])]], device)
        started = time.perf_counter()
        predict(policy, batch)
        timings.append((time.perf_counter() - started) * 1000)
    latency = {f"p{q}Ms": float(np.percentile(timings[2:], q)) for q in (50, 95, 99)}
    accepted = (
        episodes["train"] >= 12
        and episodes["validation"] >= 3
        and episodes["test"] >= 5
        and test["accuracy"] >= 0.98
        and test["coverage"] >= 0.95
        and test["wrongAccepted"] == 0
        and latency["p95Ms"] <= 1500
    )
    result = {
        "schema": "viscera.visual-skills/1",
        "modelId": "visual-policy-1-" + sha256(args.out / "adapter.safetensors")[:12],
        "base": "lerobot/smolvla_base",
        "baseRevision": BASE_REVISION,
        "vlmRevision": VLM_REVISION,
        "baseSha256": sha256(args.models / "base/model.safetensors"),
        "adapterSha256": sha256(args.out / "adapter.safetensors"),
        "training": {
            "seed": args.seed,
            "steps": args.steps,
            "seconds": time.perf_counter() - began,
            "episodes": episodes,
            "curve": curve,
            "trainableParameters": sum(p.numel() for p in policy.parameters() if p.requires_grad),
        },
        "test": test,
        "latency": latency,
        "ready": accepted,
        "scope": "Simulation-only visual skill selection; authored guarded controllers execute motion; corruption negatives are synthetic; no hardware or clinical evaluation.",
    }
    (args.out / "manifest.json").write_text(json.dumps(result, indent=2))
    print(
        "FINISHED",
        {"ready": accepted, "accuracy": test["accuracy"], "coverage": test["coverage"], **latency},
        flush=True,
    )


if __name__ == "__main__":
    main()
