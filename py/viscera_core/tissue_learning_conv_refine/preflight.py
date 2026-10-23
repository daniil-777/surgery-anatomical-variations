"""Actual warm-start, changed objectives, both optimizer steps and exact checkpoint."""

import contextlib
import platform
import sys
import tempfile
from dataclasses import replace
from pathlib import Path

import torch

from viscera_core.tissue_learning.checkpoint import latest_checkpoint, load_checkpoint
from viscera_core.tissue_learning_conv.artifact import export_decoder as original_export
from viscera_core.tissue_learning_conv.config import ConvConfig
from viscera_core.tissue_learning_conv.data import NativePatchDataset
from viscera_core.tissue_learning_conv.fixture import build_fixture
from viscera_core.tissue_learning_conv.preflight import assert_exact_state
from viscera_core.tissue_learning_conv.trainer import ConvTrainer

from .artifact import export_decoder
from .config import RefineConfig, RefineObjective
from .diagnostics import diagnose, validate_continuation
from .trainer import RefineTrainer


def preflight(device="cuda"):
    if device == "cuda":
        if torch.__version__ != "2.8.0+cu126" or torch.version.cuda != "12.6":
            raise ValueError("requires pinned torch2.8.0+cu126/CUDA12.6")
        if not torch.cuda.is_available() or "A100" not in torch.cuda.get_device_name(0):
            raise ValueError("requires actual A100 runtime")
    elif device != "cpu":
        raise ValueError("unsupported preflight device")
    with tempfile.TemporaryDirectory(prefix="tissue-refine-preflight-") as directory:
        root = Path(directory).resolve()
        manifest = build_fixture(root / "data")
        dataset = NativePatchDataset(manifest, manifest.parent, commercial_only=False)
        config = ConvConfig(
            device=device,
            precision="bfloat16" if device == "cuda" else "float32",
            steps=1,
            batch_size=2,
            fixture=True,
            critic_warmup_updates=0,
            latent_channels=8 if device == "cuda" else 2,
            decoder_channels=(64, 48, 32, 16, 8) if device == "cuda" else (8, 8, 8, 8, 4),
            encoder_channels=(32, 64, 96, 96) if device == "cuda" else (8, 8, 8, 8),
            critic_width=32 if device == "cuda" else 4,
            validation_limit=2,
            baseline_limit_per_condition=1,
        )
        with contextlib.redirect_stdout(sys.stderr):
            parent = ConvTrainer(dataset, root / "parent", config)
            parent.fit()
        parent_checkpoint = latest_checkpoint(root / "parent/checkpoints")
        parent_export = original_export(parent_checkpoint, root / "parent.json")
        pilot = RefineConfig(
            replace(config, steps=2, seed=20261020, lr=5e-5, critic_lr=5e-5),
            RefineObjective(reference_limit=4, gate_step=2),
        )
        trainer = RefineTrainer(
            dataset,
            root / "pilot",
            pilot,
            warm_start=parent_checkpoint,
            parent_model=root / "parent.json",
            expected_parent_model_sha256=parent_export["sha256"],
        )
        if trainer.optimizer.state or trainer.critic_optimizer.state or trainer.step:
            raise ValueError("warm start must reset optimizer/cursor")
        with contextlib.redirect_stdout(sys.stderr):
            result = trainer.fit(stop_after_updates=1)
        first_checkpoint = latest_checkpoint(root / "pilot/checkpoints")
        first_state, _ = load_checkpoint(first_checkpoint)
        trainer = RefineTrainer(
            dataset,
            root / "resumed",
            pilot,
            warm_start=parent_checkpoint,
            parent_model=root / "parent.json",
            expected_parent_model_sha256=parent_export["sha256"],
            resume_from=first_checkpoint,
        )
        for key, value in {
            "model": trainer.model.state_dict(),
            "critic": trainer.critic.state_dict(),
            "optimizer": trainer.optimizer.state_dict(),
            "critic_optimizer": trainer.critic_optimizer.state_dict(),
            "sampler_rng": trainer.rng.bit_generator.state,
            "torch_rng": torch.get_rng_state(),
            "cuda_rng": torch.cuda.get_rng_state_all() if device == "cuda" else [],
        }.items():
            assert_exact_state(first_state[key], value)
        with contextlib.redirect_stdout(sys.stderr):
            result = trainer.fit(stop_after_updates=2)
        checkpoint = latest_checkpoint(root / "resumed/checkpoints")
        state, _ = load_checkpoint(checkpoint)
        expected = {
            "model": trainer.model.state_dict(),
            "critic": trainer.critic.state_dict(),
            "optimizer": trainer.optimizer.state_dict(),
            "critic_optimizer": trainer.critic_optimizer.state_dict(),
            "sampler_rng": trainer.rng.bit_generator.state,
            "torch_rng": torch.get_rng_state(),
            "cuda_rng": torch.cuda.get_rng_state_all() if device == "cuda" else [],
        }
        for key, value in expected.items():
            assert_exact_state(value, state[key])
        if not state["optimizer"]["state"] or not state["critic_optimizer"]["state"]:
            raise ValueError("both optimizers must update")
        exported = export_decoder(checkpoint, root / "refined.json")
        diagnostic = diagnose(
            checkpoint,
            dataset,
            root / "refined.json",
            root / "diagnostics",
            warm_start=parent_checkpoint,
            device=device,
        )
        try:
            validate_continuation(trainer, root / "diagnostics/objective-gate.json", None)
        except ValueError:
            gate_refusal = True
        else:
            raise ValueError("missing visual review must refuse continuation")
        return {
            "schema": "viscera.tissue-conv-refine-preflight/v1",
            "passed": True,
            "device": device,
            "gpu_executed": device == "cuda",
            "real_training_data_used": False,
            "hardware": {
                "python": platform.python_version(),
                "torch": torch.__version__,
                "cuda_runtime": torch.version.cuda,
                "cudnn": torch.backends.cudnn.version(),
                "gpu_name": torch.cuda.get_device_name(0) if device == "cuda" else None,
            },
            "deterministic_algorithms": torch.are_deterministic_algorithms_enabled(),
            "warm_start_reset_verified": True,
            "resume_state_checked_exactly": True,
            "changed_objective_diagnostic_cases": len(
                diagnostic["refinement"]["objective_gradient_cases"]
            ),
            "unreviewed_continuation_refused": gate_refusal,
            "checkpoint_state_compared_exactly": sorted(expected),
            "portable_export_reference_checked": True,
            "fixture_decoder_bytes": exported["bytes"],
            "last_step": state["loss_history"][-1],
            "receipt": result,
        }
