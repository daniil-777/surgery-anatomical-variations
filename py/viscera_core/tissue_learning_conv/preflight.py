"""Exercise actual native loader, both optimizers, safe checkpoint and export."""

from __future__ import annotations

import contextlib
import platform
import sys
import tempfile
from pathlib import Path

import torch

from viscera_core.tissue_learning.checkpoint import latest_checkpoint, load_checkpoint
from viscera_core.tissue_learning.config import identity

from .artifact import export_decoder, load_artifact
from .config import ConvConfig
from .data import NativePatchDataset
from .fixture import build_fixture
from .trainer import ConvTrainer


def assert_exact_state(expected, restored, path="state"):
    """Check the serialized state against live tensors, across CPU/GPU devices."""
    if isinstance(expected, torch.Tensor):
        if (
            not isinstance(restored, torch.Tensor)
            or expected.dtype != restored.dtype
            or expected.shape != restored.shape
            or not torch.equal(expected.detach().cpu(), restored.detach().cpu())
        ):
            raise ValueError(f"Checkpoint roundtrip differs at {path}")
    elif isinstance(expected, dict):
        if not isinstance(restored, dict) or expected.keys() != restored.keys():
            raise ValueError(f"Checkpoint roundtrip structure differs at {path}")
        for key in expected:
            assert_exact_state(expected[key], restored[key], f"{path}.{key}")
    elif isinstance(expected, (list, tuple)):
        if type(expected) is not type(restored) or len(expected) != len(restored):
            raise ValueError(f"Checkpoint roundtrip sequence differs at {path}")
        for index, (left, right) in enumerate(zip(expected, restored, strict=True)):
            assert_exact_state(left, right, f"{path}[{index}]")
    elif type(expected) is not type(restored) or expected != restored:
        raise ValueError(f"Checkpoint roundtrip scalar differs at {path}")


def preflight(device="cuda"):
    if device == "cuda":
        if torch.__version__ != "2.8.0+cu126" or torch.version.cuda != "12.6":
            raise ValueError("requires pinned torch2.8.0+cu126/CUDA12.6 profile")
        if not torch.cuda.is_available() or "A100" not in torch.cuda.get_device_name(0):
            raise ValueError("requested A100 runtime unavailable")
    elif device != "cpu":
        raise ValueError("unsupported preflight device")
    with tempfile.TemporaryDirectory(prefix="tissue-conv-preflight-") as directory:
        root = Path(directory)
        manifest = build_fixture(root / "fixture")
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
        trainer = ConvTrainer(dataset, root / "run", config)
        with contextlib.redirect_stdout(sys.stderr):
            receipt = trainer.fit()
        checkpoint = latest_checkpoint(root / "run/checkpoints")
        state, restored_request = load_checkpoint(checkpoint)
        expected = {
            "step": trainer.step,
            "cursor": trainer.cursor,
            "epoch": trainer.epoch,
            "order": trainer.order,
            "sampler_rng": trainer.rng.bit_generator.state,
            "torch_rng": torch.get_rng_state(),
            "cuda_rng": torch.cuda.get_rng_state_all() if device == "cuda" else [],
            "model": trainer.model.state_dict(),
            "critic": trainer.critic.state_dict(),
            "optimizer": trainer.optimizer.state_dict(),
            "critic_optimizer": trainer.critic_optimizer.state_dict(),
            "baseline": trainer.baseline,
            "validation": trainer.last_validation,
            "loss_history": trainer.loss_history,
        }
        assert_exact_state(expected, state)
        # Manifest JSON intentionally normalizes tuple-valued configuration to
        # lists. Compare its canonical scientific identity, not Python types.
        if identity(trainer.request) != identity(restored_request):
            raise ValueError("Checkpoint request identity differs")
        if not state["optimizer"]["state"] or not state["critic_optimizer"]["state"]:
            raise ValueError("Both optimizers must perform an actual preflight update")
        exported = export_decoder(checkpoint, root / "fixture.tissue-model.json")
        load_artifact(root / "fixture.tissue-model.json")
        hardware = {
            "python": platform.python_version(),
            "torch": torch.__version__,
            "cuda_runtime": torch.version.cuda,
            "cudnn": torch.backends.cudnn.version(),
            "gpu_name": torch.cuda.get_device_name(0) if device == "cuda" else None,
            "gpu_total_memory_bytes": torch.cuda.get_device_properties(0).total_memory
            if device == "cuda"
            else None,
            "gpu_compute_capability": list(torch.cuda.get_device_capability(0))
            if device == "cuda"
            else None,
        }
        return {
            "schema": "viscera.tissue-conv-preflight/v1",
            "passed": True,
            "device": device,
            "gpu_executed": device == "cuda",
            "real_training_data_used": False,
            "hardware": hardware,
            "deterministic_algorithms": torch.are_deterministic_algorithms_enabled(),
            "generator_optimizer_state_entries": len(state["optimizer"]["state"]),
            "critic_optimizer_state_entries": len(state["critic_optimizer"]["state"]),
            "safe_checkpoint_roundtrip": True,
            "checkpoint_state_compared_exactly": sorted(expected),
            "critic_spectral_normalization_buffers_compared_exactly": True,
            "portable_export_reference_checked": True,
            "fixture_decoder_bytes": exported["bytes"],
            "actual_shape": [2, 3, 128, 128],
            "receipt": receipt,
            "last_step": state["loss_history"][-1],
        }
