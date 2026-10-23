"""UNet LoRA training on native-scale crops: masked, min-SNR weighted ε-prediction.

The run directory is an immutable experiment identity (config, crop release,
base-model lock). Checkpoints resume exactly; receipts record what actually ran.
"""

from __future__ import annotations

import json
import math
import os
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image

from . import SCHEMA_RUN
from .captions import CAPTION_STYLES, FAMILY_PHRASES, caption
from .data import CropDataset, sha256_bytes, sha256_file
from .model import (
    BASE_MODEL,
    LORA_TARGETS,
    attach_lora,
    default_precision,
    load_components,
    pick_device,
    save_lora,
    set_circular_padding,
    verify_snapshot,
)

NEGATIVE_PROMPT = "blurry, text, watermark, surgical instrument, border, cartoon, illustration"


@dataclass(frozen=True)
class TrainConfig:
    steps: int = 1200
    rank: int = 32
    alpha: int = 32
    learning_rate: float = 1e-4
    weight_decay: float = 1e-2
    warmup_steps: int = 100
    pixel_budget: int = 512 * 512
    max_batch: int = 8
    caption_dropout: float = 0.1
    min_snr_gamma: float = 5.0
    filled_weight: float = 0.0
    exposure_jitter: float = 0.08
    checkpoint_every: int = 300
    validation_every: int = 300
    validation_size: int = 384
    validation_steps: int = 20
    validation_guidance: float = 5.0
    validation_seed: int = 42
    validation_loss_items: int = 32
    families: tuple[str, ...] | None = None
    family_power: float = 0.5
    min_family_crops: int = 24
    caption_style: str = "v1"
    profiles: tuple[str, ...] = ("noncommercial-research", "unrestricted")
    min_sharpness: float = 0.0
    seed: int = 20261021
    device: str | None = None
    precision: str | None = None
    gradient_checkpointing: bool = True
    grad_clip: float = 1.0
    max_items: int | None = None
    log_every: int = 10
    notes: tuple[str, ...] = field(default_factory=tuple)

    def __post_init__(self):
        if type(self.steps) is not int or not 1 <= self.steps <= 100_000:
            raise ValueError("steps must be 1..100000")
        if type(self.rank) is not int or not 1 <= self.rank <= 256 or type(self.alpha) is not int or self.alpha < 1:
            raise ValueError("invalid LoRA rank/alpha")
        if self.alpha != self.rank:
            raise ValueError("alpha must equal rank: the portable diffusers LoRA file carries no alpha, so a reload "
                             "would silently change the effective scale")
        if not 0 < self.learning_rate <= 1e-2 or not 0 <= self.caption_dropout < 1:
            raise ValueError("invalid optimizer policy")
        if self.pixel_budget < 256 * 256 or not 1 <= self.max_batch <= 64 or not 0 <= self.filled_weight <= 1:
            raise ValueError("invalid batching policy")
        if self.checkpoint_every < 1 or self.validation_every < 1 or self.validation_size % 64:
            raise ValueError("invalid checkpoint/validation policy")
        if self.precision is not None and self.precision not in ("fp32", "bf16", "fp16"):
            raise ValueError("precision must be fp32/bf16/fp16")
        if self.families is not None and any(f not in FAMILY_PHRASES for f in self.families):
            raise ValueError("unsupported family in config")
        if not 0 <= self.family_power <= 1 or type(self.min_family_crops) is not int or self.min_family_crops < 1:
            raise ValueError("invalid family sampling policy")
        if self.caption_style not in CAPTION_STYLES:
            raise ValueError("unsupported caption style")
        if (self.log_every < 1 or self.min_snr_gamma <= 0 or not 64 <= self.validation_size <= 1024
                or self.warmup_steps < 0 or self.grad_clip <= 0 or self.weight_decay < 0
                or not 0 <= self.exposure_jitter < 1 or self.validation_steps < 1 or self.validation_guidance < 1
                or self.validation_loss_items < 1 or (self.max_items is not None and self.max_items < 1)):
            raise ValueError("training configuration out of bounds")

    def to_dict(self) -> dict:
        return asdict(self)


def d4(array: np.ndarray, k: int) -> np.ndarray:
    """Dihedral augmentation shared by image and mask (k in 0..7)."""
    out = np.rot90(array, k % 4)
    return np.flip(out, axis=1) if k >= 4 else out


def snr_weights(scheduler, gamma: float):
    import torch

    alphas = scheduler.alphas_cumprod
    snr = alphas / (1 - alphas)
    return (torch.minimum(snr, torch.full_like(snr, gamma)) / snr).float()


def lr_at(step: int, config: TrainConfig) -> float:
    if step < config.warmup_steps:
        return config.learning_rate * (step + 1) / config.warmup_steps
    progress = (step - config.warmup_steps) / max(1, config.steps - config.warmup_steps)
    return config.learning_rate * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * min(1.0, progress))))


class BucketBatches:
    """Family ∝ count^power, then a size bucket (∝ count) within it; batch size from a pixel budget; D4 + exposure jitter.

    Tempered family sampling (power 0.5 by default) keeps thousands of mucosa crops from drowning the exterior
    organs without hammering a family of a few dozen crops. Families below min_family_crops are excluded.
    """

    def __init__(self, dataset: CropDataset, config: TrainConfig, rng: np.random.Generator):
        self.dataset, self.config, self.rng = dataset, config, rng
        self.pools: dict[str, dict[int, list[int]]] = {}
        for index, row in enumerate(dataset.records):
            self.pools.setdefault(row["family"], {}).setdefault(int(row["size"]), []).append(index)
        self.excluded = sorted(f for f, pools in self.pools.items()
                               if sum(len(v) for v in pools.values()) < config.min_family_crops)
        for family in self.excluded:
            del self.pools[family]
        if not self.pools:
            raise ValueError("every family falls below min_family_crops")
        self.families = sorted(self.pools)
        weights = np.array([sum(len(v) for v in self.pools[f].values()) for f in self.families], dtype=np.float64)
        weights = weights ** config.family_power
        self.family_probabilities = weights / weights.sum()
        self.sizes = {family: sorted(pools) for family, pools in self.pools.items()}
        self.probabilities = {family: np.array([len(self.pools[family][s]) for s in sizes], dtype=np.float64)
                              / sum(len(self.pools[family][s]) for s in sizes) for family, sizes in self.sizes.items()}

    def batch_size(self, size: int) -> int:
        return int(max(1, min(self.config.max_batch, self.config.pixel_budget // (size * size))))

    def next(self) -> tuple[np.ndarray, np.ndarray, list[str], int]:
        family = self.families[int(self.rng.choice(len(self.families), p=self.family_probabilities))]
        size = int(self.rng.choice(self.sizes[family], p=self.probabilities[family]))
        pool = self.pools[family][size]
        picks = self.rng.choice(len(pool), size=min(self.batch_size(size), len(pool)), replace=False)
        images, weights, captions = [], [], []
        for pick in picks:
            rgb, valid, row = self.dataset.load(pool[int(pick)])
            k = int(self.rng.integers(0, 8))
            rgb, valid = d4(rgb, k), d4(valid, k)
            gain = 1 + self.rng.uniform(-self.config.exposure_jitter, self.config.exposure_jitter)
            images.append(np.clip(rgb.astype(np.float32) / 255 * gain, 0, 1) * 2 - 1)
            weights.append(np.where(valid, 1.0, self.config.filled_weight).astype(np.float32))
            text = row["caption"] if self.config.caption_style == "v1" else caption(row["family"], row.get("condition"), self.config.caption_style)
            captions.append("" if self.rng.uniform() < self.config.caption_dropout else text)
        return np.stack(images), np.stack(weights), captions, size


class TextCache:
    def __init__(self, tokenizer, text_encoder, device: str):
        self.tokenizer, self.text_encoder, self.device, self.cache = tokenizer, text_encoder, device, {}

    def __call__(self, captions: list[str]):
        import torch

        missing = [text for text in dict.fromkeys(captions) if text not in self.cache]
        if missing:
            tokens = self.tokenizer(missing, padding="max_length", max_length=self.tokenizer.model_max_length,
                                    truncation=True, return_tensors="pt").input_ids.to(self.device)
            with torch.no_grad():
                embeddings = self.text_encoder(tokens)[0]
            for text, embedding in zip(missing, embeddings):
                self.cache[text] = embedding
        return torch.stack([self.cache[text] for text in captions])


def run_identity(dataset: CropDataset, snapshot: Path | None, config: TrainConfig) -> dict:
    base = {**BASE_MODEL, "lock_sha256": verify_snapshot(snapshot)["lock_sha256"]} if snapshot else {"injected": True}
    payload = {"schema": SCHEMA_RUN, "config": config.to_dict(), "crop_release_sha256": dataset.release_sha256,
               "base_model": base}
    digest = sha256_bytes(json.dumps(payload, sort_keys=True).encode())
    return {**payload, "run_id": f"tissue-lora-{digest[:16]}"}


def ensure_run(directory: Path, identity: dict) -> None:
    directory = Path(directory)
    file = directory / "run.json"
    if file.exists():
        existing = json.loads(file.read_text())
        if existing.get("run_id") != identity["run_id"]:
            raise ValueError("run directory belongs to a different experiment identity")
        return
    directory.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps({**identity, "created": datetime.now(timezone.utc).isoformat()}, indent=2) + "\n")


def _save_checkpoint(unet, optimizer, directory: Path, step: int, extra: dict) -> dict:
    import torch

    target = directory / "checkpoints" / f"step-{step:09d}"
    target.mkdir(parents=True, exist_ok=True)
    weights = save_lora(unet, target, {"step": step, **extra})
    torch.save({"optimizer": optimizer.state_dict(), "step": step}, target / "optimizer.pt")
    manifest = {"step": step, "weights_sha256": sha256_file(weights), "weights_bytes": weights.stat().st_size,
                "created": datetime.now(timezone.utc).isoformat(), **extra}
    (target / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    pointer = directory / "checkpoints" / "latest.json"
    pointer.write_text(json.dumps({"directory": target.name, "step": step, "manifest_sha256":
                                   sha256_file(target / "manifest.json")}) + "\n")
    return manifest


def _load_checkpoint(unet, optimizer, directory: Path) -> int:
    import torch
    from peft.utils import set_peft_model_state_dict
    from safetensors.torch import load_file

    pointer = json.loads((directory / "checkpoints" / "latest.json").read_text())
    target = directory / "checkpoints" / pointer["directory"]
    manifest = json.loads((target / "manifest.json").read_text())
    weights = target / "pytorch_lora_weights.safetensors"
    if sha256_file(weights) != manifest["weights_sha256"]:
        raise ValueError("checkpoint weights differ from their manifest")
    from diffusers.utils import convert_unet_state_dict_to_peft

    state = load_file(str(weights))
    # The file uses the portable diffusers naming ("unet.<module>.lora.down.weight");
    # the live adapter expects PEFT naming ("<module>.lora_A.weight").
    renamed = convert_unet_state_dict_to_peft({key.removeprefix("unet."): value for key, value in state.items()})
    result = set_peft_model_state_dict(unet, renamed)
    if getattr(result, "unexpected_keys", None):
        raise ValueError(f"checkpoint has unexpected LoRA keys: {list(result.unexpected_keys)[:3]}")
    optimizer.load_state_dict(torch.load(target / "optimizer.pt", map_location="cpu", weights_only=True)["optimizer"])
    return int(manifest["step"])


def _validation_batch(dataset: CropDataset, config: TrainConfig) -> tuple[np.ndarray, np.ndarray, list[str]] | None:
    if not len(dataset):
        return None
    rng = np.random.default_rng(config.seed + 1)
    size = 256 if 256 in dataset.buckets else min(dataset.buckets)
    pool = dataset.buckets[size]
    picks = rng.choice(len(pool), size=min(config.validation_loss_items, len(pool)), replace=False)
    images, weights, captions = [], [], []
    for pick in picks:
        rgb, valid, row = dataset.load(pool[int(pick)])
        images.append(rgb.astype(np.float32) / 255 * 2 - 1)
        weights.append(np.where(valid, 1.0, config.filled_weight).astype(np.float32))
        captions.append(row["caption"] if config.caption_style == "v1" else caption(row["family"], row.get("condition"), config.caption_style))
    return np.stack(images), np.stack(weights), captions


def _loss(components, text_cache, snr, images, weights, captions, device, autocast, generator=None):
    import torch
    import torch.nn.functional as F

    vae, unet, scheduler = components["vae"], components["unet"], components["scheduler"]
    pixels = torch.from_numpy(images).permute(0, 3, 1, 2).to(device=device, dtype=vae.dtype)
    with torch.no_grad():
        latents = vae.encode(pixels).latent_dist.sample(generator) * vae.config.scaling_factor
    latents = latents.float()
    noise = torch.randn(latents.shape, generator=generator, device="cpu").to(device)
    timesteps = torch.randint(0, scheduler.config.num_train_timesteps, (latents.shape[0],), generator=generator,
                              device="cpu").to(device)
    noisy = scheduler.add_noise(latents, noise, timesteps)
    encoder_states = text_cache(captions)
    with autocast():
        prediction = unet(noisy.to(unet.dtype), timesteps, encoder_hidden_states=encoder_states.to(unet.dtype)).sample
    weight_map = torch.from_numpy(weights).to(device)[:, None]
    weight_map = F.interpolate(weight_map, size=latents.shape[-2:], mode="area")
    per_pixel = ((prediction.float() - noise) ** 2).mean(dim=1, keepdim=True)
    # Masked mean per item first, then the min-SNR weight per item, then the batch mean: dividing by the
    # weighted mask sum would cancel the SNR weight entirely at batch size 1.
    mask_sum = weight_map.sum(dim=(1, 2, 3)).clamp(min=1e-6)
    per_item = (per_pixel * weight_map).sum(dim=(1, 2, 3)) / mask_sum
    return (per_item * snr[timesteps]).mean()


def _sample_validation(components, directory: Path, step: int, config: TrainConfig, device: str, families):
    import torch
    from diffusers import DPMSolverMultistepScheduler, StableDiffusionPipeline

    pipe = StableDiffusionPipeline(vae=components["vae"], text_encoder=components["text_encoder"],
                                   tokenizer=components["tokenizer"], unet=components["unet"],
                                   scheduler=DPMSolverMultistepScheduler.from_config(components["scheduler"].config),
                                   safety_checker=None, feature_extractor=None, requires_safety_checker=False)
    pipe.set_progress_bar_config(disable=True)
    target = directory / "samples" / f"step-{step:09d}"
    target.mkdir(parents=True, exist_ok=True)
    set_circular_padding(components["unet"], True)
    set_circular_padding(components["vae"], True)
    tiles = []
    try:
        components["unet"].eval()
        for family in families:
            generator = torch.Generator("cpu").manual_seed(config.validation_seed)
            with torch.no_grad():
                image = pipe(caption(family, style=config.caption_style), negative_prompt=NEGATIVE_PROMPT, height=config.validation_size,
                             width=config.validation_size, num_inference_steps=config.validation_steps,
                             guidance_scale=config.validation_guidance, generator=generator).images[0]
            image.save(target / f"{family}-seed{config.validation_seed}.png")
            tiles.append((family, image))
    finally:
        set_circular_padding(components["unet"], False)
        set_circular_padding(components["vae"], False)
        components["unet"].train()
    if tiles:
        width = config.validation_size
        sheet = Image.new("RGB", (width * len(tiles), width))
        for index, (_, image) in enumerate(tiles):
            sheet.paste(image, (index * width, 0))
        sheet.save(target / "contact.png")
    return [f"{family}-seed{config.validation_seed}.png" for family, _ in tiles]


def train(dataset_root: Path, snapshot: Path, run_dir: Path, config: TrainConfig, *, resume: bool = True,
          components: dict | None = None) -> dict:
    import torch

    device = pick_device(config.device)
    precision = config.precision or default_precision(device)
    dataset = CropDataset(dataset_root, split="train", families=config.families, profiles=config.profiles,
                          min_sharpness=config.min_sharpness)
    if config.max_items:
        dataset.records = dataset.records[:config.max_items]
        dataset.buckets = {}
        for index, row in enumerate(dataset.records):
            dataset.buckets.setdefault(int(row["size"]), []).append(index)
    if not len(dataset):
        raise ValueError("no training crops match the configuration")
    validation = CropDataset(dataset_root, split="val", families=config.families, profiles=config.profiles)
    identity = run_identity(dataset, None if components is not None else snapshot, config)
    run_dir = Path(run_dir)
    ensure_run(run_dir, identity)
    components = components or load_components(snapshot, device, precision)
    unet = components["unet"]
    torch.manual_seed(config.seed)
    trainable = attach_lora(unet, rank=config.rank, alpha=config.alpha)
    if config.gradient_checkpointing:
        unet.enable_gradient_checkpointing()
    unet.train()
    parameters = [p for p in unet.parameters() if p.requires_grad]
    optimizer = torch.optim.AdamW(parameters, lr=config.learning_rate, weight_decay=config.weight_decay,
                                  betas=(0.9, 0.999))
    step = 0
    if resume and (run_dir / "checkpoints" / "latest.json").exists():
        step = _load_checkpoint(unet, optimizer, run_dir)
        if step >= config.steps and (run_dir / "training-receipt.json").is_file():
            existing = json.loads((run_dir / "training-receipt.json").read_text())
            if existing.get("status") == "completed":
                print(json.dumps({"already_completed": existing["run_id"], "steps": existing["steps_completed"]}), flush=True)
                return existing
    text_cache = TextCache(components["tokenizer"], components["text_encoder"], device)
    snr = snr_weights(components["scheduler"], config.min_snr_gamma).to(device)
    rng = np.random.default_rng([config.seed, step])
    batches = BucketBatches(dataset, config, rng)
    families = [f for f in (config.families or sorted({row["family"] for row in dataset.records})) if f not in batches.excluded]
    if batches.excluded:
        print(json.dumps({"excluded_families": batches.excluded, "min_family_crops": config.min_family_crops}), flush=True)
    autocast = _autocast_factory(device, precision)
    log = (run_dir / "log.jsonl").open("a")
    started, trace, status, peak = time.time(), [], "completed", 0
    checkpoints = []
    validation_batch = _validation_batch(validation, config)
    checkpoint_meta = {"run_id": identity["run_id"], "trainable_parameters": trainable, "families": families,
                       "caption_style": config.caption_style,
                       "rights": sorted({row["training_profile"] for row in dataset.records}),
                       "lora": {"rank": config.rank, "alpha": config.alpha, "targets": list(LORA_TARGETS),
                                "note": "diffusers LoRA files carry no alpha; reloading assumes alpha == rank"}}
    try:
        while step < config.steps:
            for group in optimizer.param_groups:
                group["lr"] = lr_at(step, config)
            images, weights, captions, size = batches.next()
            step_generator = torch.Generator("cpu").manual_seed((config.seed * 1_000_003 + step) % 2**63)
            loss = _loss(components, text_cache, snr, images, weights, captions, device, autocast, step_generator)
            if not torch.isfinite(loss):
                raise RuntimeError(f"non-finite loss at step {step + 1}; stop rather than train on it")
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(parameters, config.grad_clip)
            optimizer.step()
            step += 1
            value = float(loss.detach().cpu())
            if device == "cuda":
                peak = max(peak, int(torch.cuda.max_memory_allocated()))
            elif device == "mps":
                peak = max(peak, int(torch.mps.driver_allocated_memory()))
            entry = {"step": step, "loss": value, "size": size, "batch": int(images.shape[0]),
                     "lr": optimizer.param_groups[0]["lr"], "elapsed": round(time.time() - started, 2)}
            if step % config.log_every == 0 or step == 1:
                trace.append(entry)
                print(json.dumps(entry), flush=True)
            log.write(json.dumps(entry) + "\n")
            log.flush()
            if step % config.validation_every == 0 or step == config.steps:
                record = {"step": step}
                if validation_batch is not None:
                    unet.eval()
                    with torch.no_grad():
                        generator = torch.Generator("cpu").manual_seed(config.seed + 2)
                        record["val_loss"] = float(_loss(components, text_cache, snr, *validation_batch, device,
                                                         autocast, generator).cpu())
                    unet.train()
                record["samples"] = _sample_validation(components, run_dir, step, config, device, families)
                print(json.dumps({"validation": record}), flush=True)
                log.write(json.dumps({"validation": record}) + "\n")
                log.flush()
            if step % config.checkpoint_every == 0 or step == config.steps:
                checkpoints.append(_save_checkpoint(unet, optimizer, run_dir, step, checkpoint_meta))
    except KeyboardInterrupt:
        status = "interrupted"
        checkpoints.append(_save_checkpoint(unet, optimizer, run_dir, step, checkpoint_meta))
    finally:
        log.close()
    receipt = {"schema": SCHEMA_RUN, "run_id": identity["run_id"], "status": status, "steps_completed": step,
               "requested_steps": config.steps, "seconds": round(time.time() - started, 2), "device": device,
               "precision": precision, "config": config.to_dict(), "trainable_parameters": trainable,
               "dataset": {"crop_release_sha256": dataset.release_sha256, "training_crops": len(dataset),
                           "validation_crops": len(validation), "sizes": {str(k): len(v) for k, v in dataset.buckets.items()},
                           "families": families, "excluded_families": batches.excluded,
                           "family_probabilities": dict(zip(batches.families, map(float, batches.family_probabilities))),
                           "rights": sorted({row["training_profile"] for row in dataset.records})},
               "base_model": identity["base_model"], "peak_memory_bytes": peak, "loss_trace": trace,
               "checkpoints": checkpoints, "qualification": "engineering_unqualified; visual and held-out review required",
               "finished": datetime.now(timezone.utc).isoformat(), "pid": os.getpid(), "attempt": uuid.uuid4().hex[:8]}
    (run_dir / "training-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


class _NullContext:
    def __enter__(self):
        return None

    def __exit__(self, *exc):
        return False


def _autocast_factory(device: str, precision: str):
    import torch

    if device in ("cuda", "mps") and precision in ("bf16", "fp16"):
        dtype = torch.bfloat16 if precision == "bf16" else torch.float16
        return lambda: torch.autocast(device_type=device, dtype=dtype)
    return lambda: _NullContext()
