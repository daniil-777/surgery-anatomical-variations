#!/usr/bin/env python3
"""Bounded warm-start objective pilot; no automatic continuation past image review."""

import argparse
import json
import sys
from pathlib import Path

from viscera_core.tissue_learning.checkpoint import atomic_json
from viscera_core.tissue_learning_conv.artifact import bake_artifact
from viscera_core.tissue_learning_conv.data import NativePatchDataset
from viscera_core.tissue_learning_conv.readiness import prepare_manifest
from viscera_core.tissue_learning_conv_refine.artifact import export_decoder
from viscera_core.tissue_learning_conv_refine.config import RefineConfig
from viscera_core.tissue_learning_conv_refine.diagnostics import diagnose
from viscera_core.tissue_learning_conv_refine.preflight import preflight
from viscera_core.tissue_learning_conv_refine.trainer import RefineTrainer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("preflight")
    check.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    ready = sub.add_parser("prepare-manifest")
    for key in ("manifest", "data-root", "output"):
        ready.add_argument("--" + key, type=Path, required=True)
    ready.add_argument("--minimum-valid-fraction", type=float, default=0.5)
    ready.add_argument("--critic-minimum-coverage", type=float, default=0.75)
    ready.add_argument("--commercial-only", action="store_true")
    train = sub.add_parser("train")
    for key in ("manifest", "data-root", "config", "output", "warm-start", "parent-model"):
        train.add_argument("--" + key, type=Path, required=True)
    train.add_argument("--expected-parent-model-sha256", required=True)
    for key in ("resume", "mirror", "gate-receipt", "visual-review"):
        train.add_argument("--" + key, type=Path)
    train.add_argument("--stop-after-updates", type=int, default=300)
    export = sub.add_parser("export")
    export.add_argument("checkpoint", type=Path)
    export.add_argument("output", type=Path)
    diagnostic = sub.add_parser("diagnose")
    for key in ("checkpoint", "warm-start", "manifest", "data-root", "model", "output"):
        diagnostic.add_argument("--" + key, type=Path, required=True)
    diagnostic.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    bake = sub.add_parser("bake")
    bake.add_argument("model", type=Path)
    bake.add_argument("output", type=Path)
    bake.add_argument("--condition-index", type=int, required=True)
    bake.add_argument("--seed", default="42")
    bake.add_argument("--resolution", type=int, default=256)
    bake.add_argument("--chunk-pixels", type=int, default=16384)
    bake.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    args = parser.parse_args()
    if args.command == "preflight":
        result = preflight(args.device)
    elif args.command == "prepare-manifest":
        result = prepare_manifest(
            args.manifest,
            args.data_root,
            args.output,
            minimum_valid_fraction=args.minimum_valid_fraction,
            critic_minimum_coverage=args.critic_minimum_coverage,
            commercial_only=args.commercial_only,
            progress=lambda event: print(json.dumps(event), file=sys.stderr, flush=True),
        )
    elif args.command == "export":
        result = export_decoder(args.checkpoint, args.output)
    elif args.command == "bake":
        result = bake_artifact(
            args.model,
            args.output,
            condition_index=args.condition_index,
            seed=args.seed,
            resolution=args.resolution,
            chunk_pixels=args.chunk_pixels,
            device=args.device,
        )
        atomic_json(args.output.with_suffix(".bake.json"), result)
    elif args.command == "diagnose":
        dataset = NativePatchDataset(args.manifest, args.data_root, commercial_only=False)
        result = diagnose(
            args.checkpoint,
            dataset,
            args.model,
            args.output,
            warm_start=args.warm_start,
            device=args.device,
        )
    else:
        config = RefineConfig.from_dict(json.loads(args.config.read_text()))
        dataset = NativePatchDataset(
            args.manifest, args.data_root, commercial_only=config.training.commercial_only
        )
        trainer = RefineTrainer(
            dataset,
            args.output,
            config,
            warm_start=args.warm_start,
            parent_model=args.parent_model,
            expected_parent_model_sha256=args.expected_parent_model_sha256,
            resume_from=args.resume,
            mirror=args.mirror,
        )
        result = trainer.fit(
            stop_after_updates=args.stop_after_updates,
            gate_receipt=args.gate_receipt,
            visual_review=args.visual_review,
        )
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
