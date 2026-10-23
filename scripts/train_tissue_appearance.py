#!/usr/bin/env python3
"""Thin CLI for the optional masked-RGB tissue research pipeline."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from viscera_core.tissue_learning.artifact import bake_artifact, export_decoder
from viscera_core.tissue_learning.checkpoint import atomic_json, latest_checkpoint
from viscera_core.tissue_learning.config import ExperimentConfig
from viscera_core.tissue_learning.data import TissueDataset
from viscera_core.tissue_learning.diagnostics import diagnose
from viscera_core.tissue_learning.fixture import build_fixture
from viscera_core.tissue_learning.readiness import prepare_training_manifest
from viscera_core.tissue_learning.trainer import Trainer, freeze_checkpoint


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    fixture = sub.add_parser("fixture")
    fixture.add_argument("output", type=Path)
    readiness = sub.add_parser("prepare-manifest")
    for name in ("manifest", "data-root", "output"):
        readiness.add_argument(f"--{name}", type=Path, required=True)
    readiness.add_argument("--patch-size", type=int, required=True)
    readiness.add_argument("--minimum-valid-fraction", type=float, required=True)
    readiness.add_argument("--research-only", action="store_true")
    readiness.add_argument("--training-only", action="store_true")
    train = sub.add_parser("train")
    for name in ("manifest", "data-root", "config", "output"):
        train.add_argument(f"--{name}", type=Path, required=True)
    train.add_argument("--resume", type=Path, help="verified checkpoint directory, including a Drive copy")
    train.add_argument("--mirror", type=Path, help="persistent Drive run folder; publishes verified checkpoints")
    train.add_argument("--stop-after-updates", type=int)
    export = sub.add_parser("export")
    export.add_argument("checkpoint", type=Path)
    export.add_argument("output", type=Path)
    bake = sub.add_parser("bake")
    bake.add_argument("model", type=Path)
    bake.add_argument("output", type=Path)
    bake.add_argument("--condition-index", type=int, required=True)
    bake.add_argument("--seed", default="42")
    bake.add_argument("--resolution", type=int, default=4096)
    bake.add_argument("--chunk-pixels", type=int, default=16384)
    bake.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    audit = sub.add_parser("evaluate-test")
    for name in ("manifest", "data-root", "config", "run"):
        audit.add_argument(f"--{name}", type=Path, required=True)
    audit.add_argument("--freeze", action="store_true", help="explicitly close tuning before opening test payloads")
    diagnostic = sub.add_parser("diagnose")
    for name in ("checkpoint", "manifest", "data-root", "model", "output"):
        diagnostic.add_argument(f"--{name}", type=Path, required=True)
    diagnostic.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    args = parser.parse_args()
    if args.command == "fixture":
        print(build_fixture(args.output))
    elif args.command == "prepare-manifest":
        result = prepare_training_manifest(args.manifest, args.data_root, args.output,
            patch_size=args.patch_size, minimum_valid_fraction=args.minimum_valid_fraction,
            commercial_only=not args.research_only, allow_training_only=args.training_only,
            progress=lambda row: print(json.dumps(row), file=sys.stderr, flush=True))
        print(json.dumps({key: value for key, value in result.items() if key != "excluded_rows"}, indent=2))
    elif args.command == "export":
        print(json.dumps(export_decoder(args.checkpoint, args.output), indent=2))
    elif args.command == "bake":
        result = bake_artifact(args.model, args.output, seed=args.seed, condition_index=args.condition_index,
            resolution=args.resolution, chunk_pixels=args.chunk_pixels, device=args.device)
        atomic_json(args.output.with_suffix(".bake.json"), result)
        print(json.dumps(result, indent=2))
    elif args.command == "diagnose":
        from viscera_core.tissue_learning.checkpoint import load_checkpoint

        _, request = load_checkpoint(args.checkpoint)
        config = ExperimentConfig.from_dict(request["config"])
        dataset = TissueDataset(args.manifest, args.data_root, commercial_only=config.commercial_only,
                               allow_training_only=config.validation_mode == "training_only")
        result = diagnose(args.checkpoint, dataset, args.model, args.output, device=args.device)
        print(json.dumps({k: v for k, v in result.items() if k != "loss_trace"}, indent=2))
    else:
        config = ExperimentConfig.from_dict(json.loads(args.config.read_text()))
        dataset = TissueDataset(args.manifest, args.data_root, commercial_only=config.commercial_only,
                               allow_training_only=config.validation_mode == "training_only")
        if args.command == "train":
            trainer = Trainer(dataset, args.output, config, resume_from=args.resume, mirror=args.mirror)
            print(json.dumps(trainer.fit(stop_after_updates=args.stop_after_updates), indent=2))
        else:
            if args.freeze:
                freeze_checkpoint(args.run, dataset)
            result_path = args.run / "test-evaluation.json"
            if result_path.exists():
                raise FileExistsError("test evaluation already exists; preserve the one-time audit")
            trainer = Trainer(dataset, args.run, config,
                              resume_from=latest_checkpoint(args.run / "checkpoints"))
            result = trainer.evaluate("test", freeze=args.run / "freeze.json")
            atomic_json(result_path, result)
            print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
