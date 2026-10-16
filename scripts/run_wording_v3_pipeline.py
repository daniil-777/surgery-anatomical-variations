"""Fresh coverage training plus unchanged evaluation/export; no legacy run writes."""

import argparse
import fcntl
import gc
import json
from dataclasses import asdict
from pathlib import Path

import torch
from wording_batched_evaluation import evaluate as evaluate_batched

from pipelines.train.viscera_train import atlas_wording as trainer

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--data", type=Path, required=True)
parser.add_argument("--run", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
args.run.mkdir(parents=True, exist_ok=True)
with (args.run / ".pipeline.lock").open("a") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    release = json.loads((args.data / "release.json").read_text())
    assert release.get("promotion_eligible") is True, (
        "A fresh independently frozen evaluation is required"
    )
    assert (
        torch.cuda.is_available()
        and torch.cuda.get_device_properties(0).total_memory >= 35 * 1024**3
    ), "Prepared microbatch16 run requires A100 40GB or larger"
    cfg = trainer.WordingConfig(
        epochs=1,
        learning_rate=3e-5,
        max_steps=None,
        batch_size=16,
        accumulation=2,
        validation_limit=32,
        device="cuda",
        seed=20261008,
    )
    trainer.atomic_json(
        args.run / "pipeline_status.json", {"status": "training", "production_exported": False}
    )
    try:
        report_path = args.run / "training_report.json"
        if report_path.exists():
            report = trainer.strict_json(report_path.read_text())
            identity = report["identity"]
            assert identity["config"] == asdict(cfg), "Completed run configuration changed"
            assert identity["source_hashes"] == trainer.source_hashes(), "Frozen source changed"
            assert identity["dataset_release_sha256"] == trainer.digest(
                args.data / "release.json"
            ), "Dataset release changed"
            assert report["pretrained_base_loaded"] and report["steps"] == report["required_steps"]
            trainer.verify_adapter(args.run, require_promoted=False)
            print(
                "Reusing checksum-verified completed training; no new optimizer updates.",
                flush=True,
            )
        else:
            if not (args.run / "checkpoint.pt").exists():
                trial = trainer.train(args.data, args.run, cfg, stop_after=1)
                assert trial == {"status": "interrupted", "step": 1}
                gc.collect()
                torch.cuda.empty_cache()
                print(
                    "Real pretrained one-step check passed; resuming identical configuration.",
                    flush=True,
                )
            report = trainer.train(
                args.data, args.run, cfg, resume=(args.run / "checkpoint.pt").exists()
            )
            assert report["pretrained_base_loaded"] and report["steps"] == report["required_steps"]
        trainer.atomic_json(
            args.run / "pipeline_status.json",
            {"status": "evaluating", "steps": report["steps"], "production_exported": False},
        )
        evaluation_path = args.run / "evaluation.json"
        if evaluation_path.exists():
            result = trainer.strict_json(evaluation_path.read_text())
            assert result["dataset_release_sha256"] == trainer.digest(args.data / "release.json")
            assert result["training_report_sha256"] == trainer.digest(report_path)
            print("Preserving existing evaluation; no second exposure or rerun.", flush=True)
        else:
            result = evaluate_batched(
                args.data, args.run, limit=512, device="cuda", batch_size=8, parity_count=16
            )
        if not result["passed"]:
            trainer.atomic_json(
                args.run / "pipeline_status.json",
                {
                    "status": "evaluation_failed",
                    "production_exported": False,
                    "gates": result["gates"],
                },
            )
            raise RuntimeError("Original raw/runtime generation gates failed; no weights promoted")
        trainer.export(args.run, args.output)
        trainer.atomic_json(
            args.run / "pipeline_status.json",
            {
                "status": "complete",
                "production_exported": True,
                "weights": str(args.output),
                "sha256": trainer.digest(args.output),
            },
        )
    except Exception as error:
        previous = trainer.strict_json((args.run / "pipeline_status.json").read_text())
        trainer.atomic_json(
            args.run / "pipeline_status.json",
            {
                **previous,
                "status": "evaluation_failed"
                if previous.get("status") == "evaluation_failed"
                else "failed",
                "production_exported": False,
                "error": type(error).__name__ + ": " + str(error),
            },
        )
        print(
            json.dumps(
                {"pipeline_error": type(error).__name__ + ": " + str(error), "run": str(args.run)}
            ),
            flush=True,
        )
        raise
