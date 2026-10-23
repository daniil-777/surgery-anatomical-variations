#!/usr/bin/env python3
"""Learned tissue tiles: prepare crops, train a LoRA, sample seamless tiles, export, evaluate, publish.

Every subcommand writes receipts beside its outputs. Nothing promotes a result
into the public library without the explicit `library` step and its rights check.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "py"))


def cmd_plan(args: argparse.Namespace) -> int:
    from viscera_core.tissue_lora import captions, data, model

    print(json.dumps({
        "base_model": model.BASE_MODEL, "crop_policy": data.POLICY,
        "families": sorted(captions.FAMILY_PHRASES), "rights": captions.RIGHTS_PROFILES,
        "notes": ["DSAD-derived weights and tiles stay research-only until the licence conflict is resolved",
                  "Native learned scale is the source pixel scale (about 10 px/mm); nothing is upsampled in training",
                  "Outputs are illumination-flattened appearance, not measured albedo"]}, indent=2))
    return 0


def cmd_prepare(args: argparse.Namespace) -> int:
    from viscera_core.tissue_lora import data

    sources = []
    if args.dsad:
        sources.append(("dsad", args.dsad, {}))
    if args.hyperkvasir:
        sources.append(("hyperkvasir", args.hyperkvasir, {"include_pathology": bool(args.include_pathology)}))
    if not sources:
        raise SystemExit("at least one source is required")
    policy = data.policy_with(min_size=args.min_size, min_valid=args.min_valid, version=args.policy_version,
                              glint_local_contrast=args.glint_local_contrast)
    release = data.prepare_release(sources, args.output, workers=args.workers, limit_per_source=args.limit, policy=policy)
    print(json.dumps({k: release[k] for k in ("records", "counts", "groups", "rights", "records_sha256")}, indent=2))
    return 0


def cmd_subset(args: argparse.Namespace) -> int:
    from viscera_core.tissue_lora import data

    release = data.subset_release(args.dataset, args.output, max_train_per_family=args.max_train_per_family,
                                  seed=args.seed, zip_path=args.zip)
    print(json.dumps({k: release[k] for k in ("records", "counts", "records_sha256", "subset_of")
                      if k in release} | {"zip": release.get("zip")}, indent=2))
    return 0


def cmd_train(args: argparse.Namespace) -> int:
    from viscera_core.tissue_lora import train

    config = train.TrainConfig(**json.loads(args.config_json)) if args.config_json else train.TrainConfig()
    receipt = train.train(args.dataset, args.model, args.output, config, resume=not args.no_resume)
    print(json.dumps({k: receipt[k] for k in ("status", "steps_completed", "seconds", "run_id")}, indent=2))
    return 0


def cmd_sample(args: argparse.Namespace) -> int:
    from viscera_core.tissue_lora import postprocess, sample

    seeds = [int(s) for s in args.seeds.split(",")]
    receipt = sample.sample_tiles(args.model, args.lora, args.output, families=args.families, seeds=seeds,
                                  size=args.size, steps=args.steps, guidance=args.guidance, device=args.device,
                                  hires=args.hires, conditions=args.conditions, caption_style=args.caption_style,
                                  scheduler=args.scheduler, guide=args.guide, guide_strength=args.guide_strength,
                                  clean=args.clean, batch_size=args.batch_size,
                                  colour_stats=postprocess.load_colour_stats(args.colour_stats) if args.colour_stats else None)
    print(json.dumps({"tiles": len(receipt["tiles"]), "seconds": receipt["seconds"]}, indent=2))
    return 0


def cmd_clean(args: argparse.Namespace) -> int:
    from viscera_core.tissue_lora import postprocess

    stats = postprocess.load_colour_stats(args.colour_stats) if args.colour_stats else None
    print(json.dumps(postprocess.clean_samples(args.samples, args.output, mode=args.mode, colour_stats=stats,
                                               reclean=args.reclean), indent=2))
    return 0


def cmd_colour_stats(args: argparse.Namespace) -> int:
    from viscera_core.tissue_lora import postprocess

    stats = postprocess.family_colour_stats(args.dataset, max_per_family=args.max_per_family)
    args.output.write_text(json.dumps(stats, indent=1) + "\n")
    print(json.dumps({family: [round(x, 1) for x in value["mean"]] for family, value in stats["families"].items()}, indent=1))
    return 0


def cmd_export(args: argparse.Namespace) -> int:
    from viscera_core.tissue_lora import pbr

    manifest = pbr.export_study(args.sample_dir, args.output, wetness=args.wetness)
    print(json.dumps({"label": manifest["label"], "resolution": manifest["resolution"]}, indent=2))
    return 0


def cmd_evaluate(args: argparse.Namespace) -> int:
    from viscera_core.tissue_lora import evaluate

    report = evaluate.evaluate(args.dataset, args.samples, args.output, extractor=args.extractor,
                               device=args.device, baselines=args.baseline or [], cache=args.cache,
                               tile_name=args.tile_name, reference_transform=args.reference_transform)
    print(json.dumps(report["summary"], indent=2))
    return 0


def cmd_library(args: argparse.Namespace) -> int:
    from viscera_core.tissue_lora import library

    receipt = library.build_library(args.samples, args.public, run_label=args.run_label,
                                    allow_research_only=args.allow_research_only, wetness=args.wetness,
                                    remove=args.remove)
    print(json.dumps({k: receipt[k] for k in ("studies", "catalog_entries", "rights")}, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("plan").set_defaults(func=cmd_plan)

    sub = commands.add_parser("prepare", help="build a hash-locked crop release from lawful sources")
    sub.add_argument("--dsad", type=Path, help="prepared DSAD exterior release directory")
    sub.add_argument("--hyperkvasir", type=Path, help="original HyperKvasir labelled-images ZIP")
    sub.add_argument("--include-pathology", action="store_true")
    sub.add_argument("--output", type=Path, required=True)
    sub.add_argument("--workers", type=int, default=4)
    sub.add_argument("--limit", type=int, help="frames per source (smoke runs)")
    sub.add_argument("--min-size", type=int, help="smallest native window (multiple of 64; default 256)")
    sub.add_argument("--min-valid", type=float, help="minimum valid fraction per window (default 0.92)")
    sub.add_argument("--policy-version", help="label for a policy variant, e.g. tissue-crops-v1.1")
    sub.add_argument("--glint-local-contrast", action="store_true", help="glint-v2: also exclude small wet specks")
    sub.set_defaults(func=cmd_prepare)

    sub = commands.add_parser("subset", help="family-capped subset of a release (plus optional ZIP for Drive)")
    sub.add_argument("--dataset", type=Path, required=True)
    sub.add_argument("--output", type=Path, required=True)
    sub.add_argument("--max-train-per-family", type=int)
    sub.add_argument("--seed", type=int, default=0)
    sub.add_argument("--zip", type=Path)
    sub.set_defaults(func=cmd_subset)

    sub = commands.add_parser("train", help="train a UNet LoRA on the crop release")
    sub.add_argument("--dataset", type=Path, required=True)
    sub.add_argument("--model", type=Path, required=True, help="pinned base-model snapshot")
    sub.add_argument("--output", type=Path, required=True, help="run directory (new or resumable)")
    sub.add_argument("--config-json", help="TrainConfig overrides as JSON")
    sub.add_argument("--no-resume", action="store_true")
    sub.set_defaults(func=cmd_train)

    sub = commands.add_parser("sample", help="sample seamless tiles with circular padding")
    sub.add_argument("--model", type=Path, required=True)
    sub.add_argument("--lora", type=Path, required=True, help="checkpoint directory with the LoRA weights")
    sub.add_argument("--output", type=Path, required=True)
    sub.add_argument("--families", nargs="+", required=True)
    sub.add_argument("--conditions", nargs="*", default=None)
    sub.add_argument("--seeds", default="42")
    sub.add_argument("--size", type=int, default=512)
    sub.add_argument("--steps", type=int, default=20)
    sub.add_argument("--guidance", type=float, default=5.0)
    sub.add_argument("--device", default=None)
    sub.add_argument("--hires", action="store_true", help="second img2img pass at twice the size")
    sub.add_argument("--caption-style", choices=["v1", "v2"], help="override the checkpoint's caption style")
    sub.add_argument("--scheduler", choices=["dpmpp-2m", "dpmpp-2m-karras"], default="dpmpp-2m")
    sub.add_argument("--guide", choices=["authored"], help="img2img from the authored tile of the same family and seed")
    sub.add_argument("--guide-strength", type=float, default=0.6)
    sub.add_argument("--clean", choices=["clean", "clean-colour", "delit-colour"], help="post-process each tile (raw.png kept)")
    sub.add_argument("--colour-stats", type=Path, help="family colour statistics for --clean clean-colour")
    sub.add_argument("--batch-size", type=int, default=1)
    sub.set_defaults(func=cmd_sample)

    sub = commands.add_parser("clean", help="remove baked glints/specks/shading (and match family colour) in sampled tiles")
    sub.add_argument("--samples", type=Path, required=True)
    sub.add_argument("--output", type=Path, required=True)
    sub.add_argument("--mode", choices=["clean", "clean-colour", "delit-colour"], default="clean-colour")
    sub.add_argument("--colour-stats", type=Path)
    sub.add_argument("--reclean", action="store_true", help="re-derive already cleaned tiles from their raw.png")
    sub.set_defaults(func=cmd_clean)

    sub = commands.add_parser("colour-stats", help="CIELAB statistics of real crops per family (for colour matching)")
    sub.add_argument("--dataset", type=Path, required=True)
    sub.add_argument("--output", type=Path, required=True)
    sub.add_argument("--max-per-family", type=int, default=300)
    sub.set_defaults(func=cmd_colour_stats)

    sub = commands.add_parser("export", help="derive material maps from one sampled tile")
    sub.add_argument("sample_dir", type=Path)
    sub.add_argument("output", type=Path)
    sub.add_argument("--wetness", type=float, default=0.6)
    sub.set_defaults(func=cmd_export)

    sub = commands.add_parser("evaluate", help="held-out statistics for sampled tiles")
    sub.add_argument("--dataset", type=Path, required=True)
    sub.add_argument("--samples", type=Path, required=True)
    sub.add_argument("--output", type=Path, required=True)
    sub.add_argument("--extractor", type=Path, required=True, help="pinned DINOv2 snapshot")
    sub.add_argument("--device", default=None)
    sub.add_argument("--baseline", action="append", help="label=directory of PNG tiles to compare")
    sub.add_argument("--cache", type=Path, help="directory for cached real-crop features (keyed by release + extractor)")
    sub.add_argument("--tile-name", default="tile.png", help="image inside each sample directory to evaluate (e.g. clean.png)")
    sub.add_argument("--reference-transform", choices=["clean"], help="apply the same glint clean-up to real reference windows (like-for-like control)")
    sub.set_defaults(func=cmd_evaluate)

    sub = commands.add_parser("library", help="assemble learned studies into the Studio catalog")
    sub.add_argument("--samples", type=Path, required=True)
    sub.add_argument("--public", type=Path, required=True, help="apps/studio/public/tissue-materials")
    sub.add_argument("--run-label", required=True)
    sub.add_argument("--wetness", type=float, default=0.6)
    sub.add_argument("--allow-research-only", action="store_true")
    sub.add_argument("--remove", action="store_true")
    sub.set_defaults(func=cmd_library)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
