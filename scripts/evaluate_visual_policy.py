#!/usr/bin/env python3
"""Evaluate untouched geometry groups recorded after the training snapshot."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
from PIL import Image
from train_visual_policy import evaluate
from viscera_core.visual_policy.contract import INSTRUCTIONS, SKILLS
from viscera_core.visual_policy.model import build_policy


def main():
    parser = argparse.ArgumentParser()
    for name in ("models", "data", "run", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    used = {r["episode"] for r in json.loads((args.run / "dataset-manifest.json").read_text())}
    episodes = [(p, json.loads(p.read_text())) for p in sorted(args.data.glob("*/episode.json"))]

    def signature(episode):
        return tuple(o["geometrySignature"] for o in episode["evidence"]["organs"])

    known = {signature(e) for _, e in episodes if e["episode"] in used}
    rows = []
    for path, episode in episodes:
        if episode["episode"] in used or signature(episode) in known:
            continue
        for row in episode["rows"]:
            if not row["image"].endswith("-0.jpg"):
                continue
            image = Image.open(path.parent / row["image"]).convert("RGB")
            for instruction in INSTRUCTIONS:
                rows.append(
                    {
                        "image": image,
                        "state": row["state"],
                        "instruction": instruction,
                        "label": SKILLS.index(row["label"]),
                        "episode": episode["episode"],
                        "corrupt": False,
                    }
                )
            rows.append(
                {
                    "image": Image.new("RGB", (256, 256)),
                    "state": row["state"],
                    "instruction": INSTRUCTIONS[0],
                    "label": 4,
                    "episode": episode["episode"],
                    "corrupt": True,
                }
            )
    if len({r["episode"] for r in rows}) < 5:
        raise ValueError("Need at least five untouched geometry episodes")
    torch.set_num_threads(4)
    device = (
        "mps"
        if torch.backends.mps.is_available()
        else "cuda"
        if torch.cuda.is_available()
        else "cpu"
    )
    policy = build_policy(args.models, device, args.run / "adapter.safetensors")
    metrics = evaluate(policy, rows, device)
    result = {"episodes": sorted({r["episode"] for r in rows}), **metrics}
    args.out.write_text(json.dumps(result, indent=2))
    print(json.dumps({k: v for k, v in result.items() if k != "predictions"}), flush=True)
    if metrics["accuracy"] < 0.98 or metrics["coverage"] < 0.95 or metrics["wrongAccepted"]:
        raise SystemExit("Untouched-scene evaluation did not pass")


if __name__ == "__main__":
    main()
