"""Check application serialization before data work, then actual A100 training shapes."""

from __future__ import annotations

import argparse
import json
import os
import runpy
import tempfile
from importlib.metadata import version
from pathlib import Path

import torch

from .config import ExperimentConfig
from .model import TissueAppearanceVAE, objective


def _assert_equal_state(expected, actual) -> None:
    """Require exact tensor values/types and nested optimizer state on reload."""
    if type(expected) is not type(actual) and not (isinstance(expected, dict) and isinstance(actual, dict)):
        raise RuntimeError("Application preflight checkpoint changed a state type")
    if isinstance(expected, torch.Tensor):
        if expected.dtype != actual.dtype or not torch.equal(expected, actual):
            raise RuntimeError("Application preflight checkpoint changed a tensor")
    elif isinstance(expected, dict):
        if expected.keys() != actual.keys():
            raise RuntimeError("Application preflight checkpoint changed dictionary keys")
        for key in expected:
            _assert_equal_state(expected[key], actual[key])
    elif isinstance(expected, (list, tuple)):
        if len(expected) != len(actual):
            raise RuntimeError("Application preflight checkpoint changed sequence length")
        for before, after in zip(expected, actual, strict=True):
            _assert_equal_state(before, after)
    elif expected != actual:
        raise RuntimeError("Application preflight checkpoint changed a scalar")


def application_preflight() -> dict:
    """Use real CLI imports and checkpoint code; no data, network or GPU is needed.

    Distribution metadata alone misses undeclared runtime imports, such as the
    packaging.version import in safetensors 0.6.2's PyTorch adapter. Run this before
    acquisition so a working model-only GPU probe cannot hide that failure.
    """
    cli_path = Path(__file__).resolve().parents[3] / "scripts/train_tissue_appearance.py"
    # run_name is deliberately not __main__: import the actual CLI without running it.
    cli = runpy.run_path(str(cli_path), run_name="viscera_application_preflight")
    for name in ("Trainer", "prepare_training_manifest", "export_decoder", "diagnose"):
        if not callable(cli.get(name)):
            raise RuntimeError(f"Application preflight CLI import is missing {name}")
    from .checkpoint import digest, latest_checkpoint, load_checkpoint, save_checkpoint

    with torch.random.fork_rng(devices=[]), tempfile.TemporaryDirectory(prefix="viscera-application-preflight-") as directory:
        torch.manual_seed(1923)
        model = torch.nn.Linear(4, 3)
        optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3)
        loss = model(torch.tensor([[.25, -.5, .75, 1.0]])).square().mean()
        loss.backward()
        optimizer.step()  # Populate real optimizer tensor/scalar state before serialization.
        state = {"step": 1, "model": model.state_dict(), "optimizer": optimizer.state_dict(),
                 "torch_rng": torch.get_rng_state(),
                 "bfloat16_probe": torch.tensor([-.5, 0., .25, 1.], dtype=torch.bfloat16),
                 "nested_probe": (None, True, 1.25, ["checkpoint", 7])}
        request = {"scope": "application_dependency_preflight", "training_data_used": False}
        checkpoint = save_checkpoint(Path(directory), state, request)
        if latest_checkpoint(Path(directory)) != checkpoint:
            raise RuntimeError("Application preflight checkpoint pointer changed")
        restored, restored_request = load_checkpoint(checkpoint)
        _assert_equal_state(state, restored)
        _assert_equal_state(request, restored_request)
        return {"schema": "viscera.tissue-application-preflight/v1",
                "cli_sha256": digest(cli_path), "actual_cli_imports": True,
                "checkpoint_roundtrip_exact": True, "bfloat16_roundtrip_exact": True,
                "optimizer_state_entries": len(restored["optimizer"]["state"]),
                "packages": {name: version(name) for name in ("torch", "safetensors", "packaging")},
                "training_data_used": False, "gpu_executed": False}


def cuda_training_preflight() -> dict:
    application = application_preflight()
    if torch.__version__ != "2.8.0+cu126" or torch.version.cuda != "12.6":
        raise RuntimeError("Wrong explicit CUDA profile; require torch2.8.0+cu126 / CUDA12.6")
    if not torch.cuda.is_available() or "A100" not in torch.cuda.get_device_name(0):
        raise RuntimeError("Select an available A100; no silent CPU/device fallback")
    if not torch.cuda.is_bf16_supported():
        raise RuntimeError("Selected device does not support bfloat16")
    if os.environ.get("CUBLAS_WORKSPACE_CONFIG") not in (":4096:8", ":16:8"):
        raise RuntimeError("Set CUBLAS_WORKSPACE_CONFIG before launching the preflight process")
    torch.use_deterministic_algorithms(True)
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = True
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.manual_seed(1923)
    results = []
    for size in (64, 128):
        config = ExperimentConfig(patch_size=size, frequencies=(1, 2, 4, 8, 16) if size == 64 else (1, 2, 4, 8, 16, 32),
                                  device="cuda", precision="bfloat16")
        model = TissueAppearanceVAE(config, 3).cuda()
        optimizer = torch.optim.AdamW(model.parameters(), lr=config.lr, weight_decay=config.weight_decay)
        rgb = torch.rand((2, 3, size, size), device="cuda")
        mask = torch.ones((2, 1, size, size), device="cuda")
        mask[:, :, :size // 4] = 0
        condition = torch.eye(3, device="cuda")[:2]
        with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
            prediction, mu, logvar = model(rgb, mask, condition)
            loss = objective(prediction, rgb, mask, mu, logvar, config)["loss"]
        loss.backward()
        torch.cuda.synchronize()
        gradients = {name: parameter.grad for name, parameter in model.named_parameters()}
        if not torch.isfinite(loss) or any(grad is None or not torch.isfinite(grad).all() for grad in gradients.values()):
            raise RuntimeError("Nonfinite or missing actual-model CUDA training gradients")
        for prefix in ("encoder.", "posterior.", "decoder."):
            if not any(grad.abs().sum() > 0 for name, grad in gradients.items() if name.startswith(prefix)):
                raise RuntimeError(f"No actual-model gradient in {prefix}")
        norm = torch.nn.utils.clip_grad_norm_(model.parameters(), config.clip_grad, error_if_nonfinite=True)
        optimizer.step()
        torch.cuda.synchronize()
        if not all(torch.isfinite(parameter).all() for parameter in model.parameters()):
            raise RuntimeError("Nonfinite actual-model CUDA optimizer update")
        results.append({"patch_size": size, "precision": "bfloat16", "loss": loss.item(),
                        "gradient_norm_before_clip": norm.item(),
                        "forward_backward_finite": True, "optimizer_step_finite": True})
        del model, optimizer, rgb, mask, condition, prediction, mu, logvar, loss, gradients, norm
    return {"torch": torch.__version__, "cuda": torch.version.cuda,
            "gpu": torch.cuda.get_device_name(0), "deterministic_algorithms": True,
            "total_vram_bytes": torch.cuda.get_device_properties(0).total_memory,
            "actual_training_shape_checks": results, "gpu_executed": True,
            "application_preflight": application}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--application-only", action="store_true",
                        help="Check actual CLI imports/checkpoint round trip without CUDA or data")
    args = parser.parse_args()
    print(json.dumps(application_preflight() if args.application_only else cuda_training_preflight(), indent=2))
