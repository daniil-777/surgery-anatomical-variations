"""Pinned base model, LoRA attachment and the seamless (circular) convolution switch.

Heavy imports (torch, diffusers, peft, transformers) are deferred so the data
and export contracts stay importable without them.
"""

from __future__ import annotations

import json
from pathlib import Path, PurePosixPath

BASE_MODEL = {"repository": "stable-diffusion-v1-5/stable-diffusion-v1-5",
              "revision": "451f4fe16113bff5a5d2269ed5ad43b0592e9a14", "license": "creativeml-openrail-m",
              "native_resolution": 512, "prediction_type": "epsilon"}
LOCK_NAME = "sd15-lock.json"
REQUIRED = ("model_index.json", "unet/config.json", "unet/diffusion_pytorch_model.fp16.safetensors",
            "vae/config.json", "vae/diffusion_pytorch_model.fp16.safetensors", "text_encoder/config.json",
            "text_encoder/model.fp16.safetensors", "tokenizer/vocab.json", "tokenizer/merges.txt",
            "scheduler/scheduler_config.json")
LORA_TARGETS = ("to_q", "to_k", "to_v", "to_out.0", "ff.net.0.proj", "ff.net.2")


def verify_snapshot(snapshot: Path, *, full_hash: bool = False) -> dict:
    """Check the lock identity and file inventory; sizes always, SHA-256 on request."""
    from .data import sha256_file

    snapshot = Path(snapshot)
    lock = json.loads((snapshot / LOCK_NAME).read_text())
    if lock.get("repository") != BASE_MODEL["repository"] or lock.get("revision") != BASE_MODEL["revision"]:
        raise ValueError("base-model lock identity differs from the reviewed pin")
    paths = {}
    for item in lock["files"]:
        name = item["path"]
        if (PurePosixPath(name).is_absolute() or "\\" in name or name in paths
                or any(p in ("", ".", "..") for p in name.split("/")) or PurePosixPath(name).name.startswith("._")):
            raise ValueError(f"invalid lock path: {name!r}")
        if not name.endswith((".safetensors", ".json", ".txt")):
            raise ValueError(f"unexpected file type in lock: {name}")
        paths[name] = item
    missing = [name for name in REQUIRED if name not in paths]
    if missing:
        raise ValueError(f"lock lacks required files: {missing}")
    for name, item in paths.items():
        file = snapshot / name
        if file.is_symlink() or not file.is_file() or file.stat().st_size != item["bytes"]:
            raise ValueError(f"snapshot file missing or size differs: {name}")
        if full_hash and sha256_file(file) != item["sha256"]:
            raise ValueError(f"snapshot digest differs: {name}")
    return {"repository": lock["repository"], "revision": lock["revision"], "license": lock.get("license"),
            "files": len(paths), "bytes": sum(item["bytes"] for item in paths.values()),
            "lock_sha256": sha256_file(snapshot / LOCK_NAME), "full_hash": full_hash}


def pick_device(requested: str | None = None) -> str:
    import torch

    if requested:
        if requested == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("CUDA requested but unavailable; no silent fallback")
        if requested == "mps" and not torch.backends.mps.is_available():
            raise RuntimeError("Metal requested but unavailable; no silent fallback")
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def default_precision(device: str) -> str:
    return {"cuda": "bf16", "mps": "bf16", "cpu": "fp32"}[device]  # bf16 keeps fp32's exponent range: no loss scaler needed


def torch_dtype(precision: str):
    import torch

    return {"fp32": torch.float32, "bf16": torch.bfloat16, "fp16": torch.float16}[precision]


def weight_dtype(device: str, precision: str):
    """Frozen weights follow the requested precision on CUDA and Metal; CPU stays fp32.

    Reduced-precision frozen weights halve the footprint (the 36 GB shared Mac swapped with fp32
    weights). LoRA parameters are always upcast to fp32 by attach_lora; autocast covers the forward.
    """
    import torch

    return torch_dtype(precision) if device in ("cuda", "mps") else torch.float32


def load_components(snapshot: Path, device: str, precision: str):
    """UNet, VAE, text encoder, tokenizer and the training noise scheduler from the verified snapshot."""
    import torch
    from diffusers import AutoencoderKL, DDPMScheduler, UNet2DConditionModel
    from transformers import CLIPTextModel, CLIPTokenizer

    verify_snapshot(snapshot)
    dtype = weight_dtype(device, precision)
    snapshot = str(snapshot)
    tokenizer = CLIPTokenizer.from_pretrained(snapshot, subfolder="tokenizer")
    text_encoder = CLIPTextModel.from_pretrained(snapshot, subfolder="text_encoder", variant="fp16",
                                                 torch_dtype=dtype, use_safetensors=True)
    vae = AutoencoderKL.from_pretrained(snapshot, subfolder="vae", variant="fp16", torch_dtype=dtype,
                                        use_safetensors=True)
    unet = UNet2DConditionModel.from_pretrained(snapshot, subfolder="unet", variant="fp16", torch_dtype=dtype,
                                                use_safetensors=True)
    scheduler = DDPMScheduler.from_pretrained(snapshot, subfolder="scheduler")
    if scheduler.config.prediction_type != BASE_MODEL["prediction_type"]:
        raise ValueError("unexpected scheduler prediction type")
    for module in (text_encoder, vae, unet):
        module.requires_grad_(False)
        module.to(torch.device(device))
    return {"tokenizer": tokenizer, "text_encoder": text_encoder, "vae": vae, "unet": unet, "scheduler": scheduler}


def attach_lora(unet, *, rank: int, alpha: int, dropout: float = 0.0, targets=LORA_TARGETS) -> int:
    """Add a fresh LoRA adapter to the UNet; returns the number of trainable parameters (kept in fp32)."""
    import torch
    from peft import LoraConfig

    unet.add_adapter(LoraConfig(r=rank, lora_alpha=alpha, lora_dropout=dropout, init_lora_weights="gaussian",
                                target_modules=list(targets)))
    count = 0
    for parameter in unet.parameters():
        if parameter.requires_grad:
            parameter.data = parameter.data.to(torch.float32)
            count += parameter.numel()
    return count


def lora_state(unet) -> dict:
    from peft.utils import get_peft_model_state_dict

    return {key: value.detach().cpu().contiguous() for key, value in get_peft_model_state_dict(unet).items()}


def save_lora(unet, directory: Path, metadata: dict) -> Path:
    """diffusers-compatible LoRA file (pytorch_lora_weights.safetensors) plus a JSON sidecar."""
    from diffusers import StableDiffusionPipeline
    from diffusers.utils import convert_state_dict_to_diffusers

    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    StableDiffusionPipeline.save_lora_weights(save_directory=str(directory),
                                              unet_lora_layers=convert_state_dict_to_diffusers(lora_state(unet)),
                                              safe_serialization=True)
    (directory / "lora.json").write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n")
    return directory / "pytorch_lora_weights.safetensors"


def set_circular_padding(module, enabled: bool = True) -> int:
    """Switch every padded 2-D convolution to circular padding (seamless tiles). Returns the count."""
    import torch

    count = 0
    for child in module.modules():
        if isinstance(child, torch.nn.Conv2d) and any(p > 0 for p in child.padding):
            child.padding_mode = "circular" if enabled else "zeros"
            count += 1
    return count


def seam_ratio(image) -> float:
    """Wrap-around difference relative to interior neighbour difference; about 1.0 means seamless."""
    import numpy as np

    value = np.asarray(image, dtype=np.float32)
    interior = np.concatenate((np.abs(np.diff(value, axis=0)).ravel(), np.abs(np.diff(value, axis=1)).ravel()))
    seam = np.concatenate((np.abs(value[0] - value[-1]).ravel(), np.abs(value[:, 0] - value[:, -1]).ravel()))
    return float(seam.mean() / max(float(interior.mean()), 1e-8))
