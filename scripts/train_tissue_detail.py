#!/usr/bin/env python3
"""Thin CLI for the isolated native tissue-detail candidate; no implicit downloads."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from viscera_core.tissue_learning.checkpoint import atomic_json, load_checkpoint
from viscera_core.tissue_learning_detail.artifact import bake_artifact, export_decoder
from viscera_core.tissue_learning_detail.config import DetailConfig
from viscera_core.tissue_learning_detail.data import NativePatchDataset
from viscera_core.tissue_learning_detail.diagnostics import diagnose
from viscera_core.tissue_learning_detail.fixture import build_fixture
from viscera_core.tissue_learning_detail.preflight import preflight
from viscera_core.tissue_learning_detail.readiness import prepare_manifest
from viscera_core.tissue_learning_detail.trainer import DetailTrainer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    fixture = sub.add_parser("fixture")
    fixture.add_argument("output", type=Path)
    check = sub.add_parser("preflight")
    check.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    readiness = sub.add_parser("prepare-manifest")
    for name in ("manifest", "data-root", "output"):
        readiness.add_argument("--" + name, type=Path, required=True)
    readiness.add_argument("--minimum-valid-fraction", type=float, default=.5)
    readiness.add_argument("--critic-minimum-coverage", type=float, default=.75)
    readiness.add_argument("--commercial-only", action="store_true")
    train = sub.add_parser("train")
    for name in ("manifest", "data-root", "config", "output"):
        train.add_argument("--" + name, type=Path, required=True)
    train.add_argument("--resume", type=Path)
    train.add_argument("--mirror", type=Path)
    train.add_argument("--stop-after-updates", type=int)
    export = sub.add_parser("export")
    export.add_argument("checkpoint", type=Path)
    export.add_argument("output", type=Path)
    diagnostic = sub.add_parser("diagnose")
    for name in ("checkpoint", "manifest", "data-root", "model", "output"):
        diagnostic.add_argument("--" + name, type=Path, required=True)
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
    if args.command == "fixture":
        print(build_fixture(args.output))
        return
    if args.command == "preflight":
        result = preflight(args.device)
    elif args.command == "prepare-manifest":
        result = prepare_manifest(args.manifest, args.data_root, args.output,
            minimum_valid_fraction=args.minimum_valid_fraction,
            critic_minimum_coverage=args.critic_minimum_coverage, commercial_only=args.commercial_only,
            progress=lambda event: print(json.dumps(event), file=sys.stderr, flush=True))
    elif args.command == "export":
        result = export_decoder(args.checkpoint, args.output)
    elif args.command == "bake":
        result = bake_artifact(args.model, args.output, seed=args.seed, condition_index=args.condition_index,
            resolution=args.resolution, chunk_pixels=args.chunk_pixels, device=args.device)
        atomic_json(args.output.with_suffix(".bake.json"), result)
    elif args.command == "diagnose":
        _, request = load_checkpoint(args.checkpoint)
        config = DetailConfig.from_dict(request["config"])
        dataset = NativePatchDataset(args.manifest, args.data_root, commercial_only=config.commercial_only)
        result = diagnose(args.checkpoint, dataset, args.model, args.output, device=args.device)
    else:
        config = DetailConfig.from_dict(json.loads(args.config.read_text()))
        dataset = NativePatchDataset(args.manifest, args.data_root, commercial_only=config.commercial_only,
                                     allow_training_only=config.validation_mode == "training_only")
        result = DetailTrainer(dataset, args.output, config, resume_from=args.resume,
            mirror=args.mirror).fit(stop_after_updates=args.stop_after_updates)
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
