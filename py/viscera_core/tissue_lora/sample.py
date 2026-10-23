"""Seamless tile sampling: circular padding in the UNet and VAE, CPU-seeded noise, receipts."""

from __future__ import annotations

import json
import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image

from . import SCHEMA_SAMPLE
from .captions import FAMILY_PHRASES, caption
from .data import sha256_file
from .model import (
    default_precision,
    pick_device,
    seam_ratio,
    set_circular_padding,
    verify_snapshot,
    weight_dtype,
)
from .train import NEGATIVE_PROMPT


def json_safe(value):
    """Strict-JSON view of a receipt: non-finite floats become strings, unknown objects their repr."""
    import math

    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return repr(value)


def lora_rights(lora_dir: Path) -> dict:
    """Data rights travel with the weights: from the checkpoint sidecar, else the run's training receipt.

    Any research-only training source makes the whole model research-only.
    """
    sidecar = lora_dir / "lora.json"
    meta = json.loads(sidecar.read_text()) if sidecar.is_file() else {}
    rights = meta.get("rights")
    if rights is None:
        receipt = lora_dir.parent.parent / "training-receipt.json"
        rights = json.loads(receipt.read_text())["dataset"]["rights"] if receipt.is_file() else None
    if not rights:
        return {"training_profile": "noncommercial-research", "rights": ["unknown"], "run_id": meta.get("run_id"),
                "note": "rights unknown; treated as research-only"}
    profile = "noncommercial-research" if any(r != "unrestricted" for r in rights) else "unrestricted"
    return {"training_profile": profile, "rights": sorted(rights), "run_id": meta.get("run_id")}


SCHEDULERS = ("dpmpp-2m", "dpmpp-2m-karras")
CLEAN_MODES = ("clean", "clean-colour", "delit-colour")
_PIPELINES: dict = {}


def load_pipeline(snapshot: Path, lora_dir: Path | None, device: str, precision: str):
    import torch
    from diffusers import DPMSolverMultistepScheduler, StableDiffusionPipeline

    verify_snapshot(snapshot)
    pipe = StableDiffusionPipeline.from_pretrained(str(snapshot), torch_dtype=weight_dtype(device, precision), variant="fp16",
                                                   use_safetensors=True, safety_checker=None,
                                                   requires_safety_checker=False)
    if lora_dir is not None:
        pipe.load_lora_weights(str(lora_dir), weight_name="pytorch_lora_weights.safetensors")
    pipe.viscera_scheduler_config = dict(pipe.scheduler.config)
    pipe.scheduler = DPMSolverMultistepScheduler.from_config(pipe.viscera_scheduler_config)
    pipe.set_progress_bar_config(disable=True)
    pipe.to(torch.device(device))
    return pipe


def get_pipeline(snapshot: Path, lora_dir: Path | None, device: str, precision: str):
    """Process-wide cache: one loaded pipeline per (snapshot, LoRA bytes, device, precision)."""
    lora_sha = sha256_file(Path(lora_dir) / "pytorch_lora_weights.safetensors") if lora_dir else None
    key = (str(Path(snapshot).resolve()), lora_sha, device, precision)
    if key not in _PIPELINES:
        _PIPELINES.clear()  # one model in memory at a time on a shared machine
        _PIPELINES[key] = load_pipeline(snapshot, lora_dir, device, precision)
    return _PIPELINES[key]


def set_scheduler(pipe, name: str) -> None:
    from diffusers import DPMSolverMultistepScheduler

    if name not in SCHEDULERS:
        raise ValueError(f"unsupported scheduler: {name}")
    base = getattr(pipe, "viscera_scheduler_config", None) or dict(pipe.scheduler.config)
    pipe.scheduler = DPMSolverMultistepScheduler.from_config(base, use_karras_sigmas=name.endswith("karras"))


def _img2img(pipe):
    from diffusers import StableDiffusionImg2ImgPipeline

    second = StableDiffusionImg2ImgPipeline(vae=pipe.vae, text_encoder=pipe.text_encoder, tokenizer=pipe.tokenizer,
                                            unet=pipe.unet, scheduler=pipe.scheduler, safety_checker=None,
                                            feature_extractor=None, requires_safety_checker=False)
    second.set_progress_bar_config(disable=True)
    return second


def authored_guide(family: str, seed: int, size: int, tile_mm: float) -> tuple[Image.Image, dict]:
    """The authored procedural tile of the same family and seed, at the learned working scale."""
    import tempfile

    from viscera_core.tissue_materials import TissueRecipe, export_material

    recipe = TissueRecipe(organ=family, seed=seed, tile_size_mm=tile_mm)
    with tempfile.TemporaryDirectory(prefix="viscera-guide-") as folder:
        manifest = export_material(recipe, Path(folder) / "guide", resolution=size)
        with Image.open(Path(folder) / "guide" / manifest["channels"]["base_color"]["file"]) as image:
            guide = image.convert("RGB").copy()
    return guide, {"generator": manifest.get("generator"), "recipe": json_safe(recipe.to_dict()), "tile_mm": tile_mm,
                   "channel": "base_color"}


def sample_tiles(snapshot: Path, lora_dir: Path | None, output: Path, *, families: list[str], seeds: list[int],
                 size: int = 512, steps: int = 30, guidance: float = 5.0, device: str | None = None,
                 precision: str | None = None, hires: bool = False, hires_strength: float = 0.45,
                 conditions: list[str] | None = None, negative_prompt: str = NEGATIVE_PROMPT,
                 pipeline=None, caption_style: str | None = None, scheduler: str = "dpmpp-2m",
                 guide: str | None = None, guide_strength: float = 0.6, guide_tile_mm: float = 51.2,
                 clean: str | None = None, colour_stats: dict | None = None, batch_size: int = 1) -> dict:
    """One directory per (family, condition, seed) with tile.png and sample.json; never overwrites a finished tile.

    guide="authored": img2img from the authored procedural tile of the same family and seed (structure and
    organ colour from the authored generator, micro-appearance from the LoRA). clean="clean"|"clean-colour":
    the raw model output is kept as raw.png and the cleaned tile becomes tile.png (see postprocess.py).
    Seeds are processed in batches of batch_size; each image keeps its own CPU generator.
    """
    import torch

    from . import postprocess

    if size % 64 or not 256 <= size <= 2048 or not 1 <= steps <= 100 or not 1 <= guidance <= 20:
        raise ValueError("invalid sampling request")
    if scheduler not in SCHEDULERS or guide not in (None, "authored") or clean not in (None, *CLEAN_MODES):
        raise ValueError("invalid scheduler/guide/clean option")
    if not 0.2 <= guide_strength <= 0.95 or not 10 <= guide_tile_mm <= 500 or not 1 <= batch_size <= 8:
        raise ValueError("invalid guide strength/tile size/batch size")
    if guide and hires:
        raise ValueError("guided sampling and the hires pass are not combined")
    if clean and postprocess.MODES[clean]["colour"] and not colour_stats:
        raise ValueError(f"{clean} needs family colour statistics")
    for family in families:
        if family not in FAMILY_PHRASES:
            raise ValueError(f"unsupported family: {family}")
        if clean and postprocess.MODES[clean]["colour"] and family not in colour_stats["families"]:
            raise ValueError(f"no colour statistics for {family}")
    for seed in seeds:
        if type(seed) is not int or not 0 <= seed < 2**64:
            raise ValueError("seeds must be unsigned 64-bit integers")
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    device = pick_device(device)
    precision = precision or default_precision(device)
    started = time.time()
    pipe = pipeline or get_pipeline(snapshot, lora_dir, device, precision)
    set_scheduler(pipe, scheduler)
    lora_sha = sha256_file(Path(lora_dir) / "pytorch_lora_weights.safetensors") if lora_dir else None
    rights = lora_rights(Path(lora_dir)) if lora_dir else {"training_profile": "base-model-only", "rights": [], "run_id": None}
    set_circular_padding(pipe.unet, True)
    set_circular_padding(pipe.vae, True)
    second = _img2img(pipe) if (hires or guide) else None
    tiles = []
    style = caption_style or (json.loads((Path(lora_dir) / "lora.json").read_text()).get("caption_style", "v1")
                              if lora_dir and (Path(lora_dir) / "lora.json").is_file() else "v1")
    cases = [(family, condition) for family in families for condition in (conditions or [None])]
    try:
        for family, condition in cases:
            prompt = caption(family, condition, style)
            pending = []
            for seed in seeds:
                stem = f"{family}{'-' + condition.replace(' ', '_') if condition else ''}-seed{seed}"
                if (output / stem / "sample.json").exists():
                    raise FileExistsError(f"tile exists: {output / stem}")
                pending.append((seed, stem))
            for start in range(0, len(pending), batch_size):
                chunk = pending[start:start + batch_size]
                works = []
                for seed, stem in chunk:
                    if (output / stem).exists():
                        shutil.rmtree(output / stem)  # an interrupted attempt without its receipt
                    work = output / f".tmp-{stem}"
                    if work.exists():
                        shutil.rmtree(work)
                    work.mkdir()
                    works.append(work)
                tick = time.time()
                generators = [torch.Generator("cpu").manual_seed(seed) for seed, _ in chunk]
                guides = []
                if guide == "authored":
                    for (seed, _), work in zip(chunk, works):
                        image, meta = authored_guide(family, seed, size, guide_tile_mm)
                        image.save(work / "guide.png")
                        guides.append((image, meta))
                with torch.no_grad():
                    if guide == "authored":
                        images = second([prompt] * len(chunk), negative_prompt=[negative_prompt] * len(chunk),
                                        image=[g for g, _ in guides], strength=guide_strength, num_inference_steps=steps,
                                        guidance_scale=guidance, generator=generators).images
                    else:
                        images = pipe([prompt] * len(chunk), negative_prompt=[negative_prompt] * len(chunk), height=size,
                                      width=size, num_inference_steps=steps, guidance_scale=guidance,
                                      generator=generators).images
                elapsed = (time.time() - tick) / len(chunk)
                for index, ((seed, stem), work, image) in enumerate(zip(chunk, works, images)):
                    native = image
                    receipt_hires = None
                    if hires:
                        upscaled = image.resize((size * 2, size * 2), Image.Resampling.BICUBIC)
                        generator = torch.Generator("cpu").manual_seed((seed + 1) % 2**64)
                        with torch.no_grad():
                            image = second(prompt, negative_prompt=negative_prompt, image=upscaled,
                                           strength=hires_strength, num_inference_steps=steps,
                                           guidance_scale=guidance, generator=generator).images[0]
                        native.save(work / "native.png")
                        receipt_hires = {"strength": hires_strength, "size": size * 2, "seed": str((seed + 1) % 2**64),
                                         "meaning": "second denoising pass over a bicubic 2x upscale; adds detail consistent with the native tile, not new measured structure"}
                    array = np.asarray(image.convert("RGB"))
                    post = None
                    if clean:
                        Image.fromarray(array).save(work / "raw.png")
                        policy = postprocess.MODES[clean]
                        target_stats = colour_stats["families"][family] if policy["colour"] else None
                        array, post = postprocess.clean_tile(array, colour_target=target_stats, sheen=policy["sheen"],
                                                             shading=policy["shading"])
                        post = {"mode": clean, **post, "raw_sha256": sha256_file(work / "raw.png")}
                    Image.fromarray(array).save(work / "tile.png")
                    receipt = {"schema": SCHEMA_SAMPLE, "family": family, "condition": condition, "prompt": prompt,
                               "negative_prompt": negative_prompt, "seed": str(seed), "native_size": size,
                               "size": array.shape[0], "steps": steps, "guidance": guidance,
                               "scheduler": scheduler, "scheduler_config": dict(pipe.scheduler.config),
                               "batch": {"size": len(chunk), "index": index},
                               "device": device, "precision": precision, "seamless": "circular padding in all padded UNet/VAE convolutions",
                               "seam_ratio": seam_ratio(array), "lora_sha256": lora_sha, "hires": receipt_hires,
                               "guide": ({"mode": "authored", "strength": guide_strength, **guides[index][1],
                                          "guide_sha256": sha256_file(work / "guide.png")} if guide else None),
                               "postprocess": post,
                               "training_profile": rights["training_profile"], "rights": rights["rights"], "run_id": rights["run_id"],
                               "caption_style": style,
                               "tile_sha256": sha256_file(work / "tile.png"), "seconds": round(elapsed, 2),
                               "created": datetime.now(timezone.utc).isoformat(),
                               "meaning": "learned appearance sample (illumination-flattened observed RGB distribution); not measured albedo, not patient anatomy"}
                    receipt = json_safe(receipt)
                    (work / "sample.json").write_text(json.dumps(receipt, indent=2, allow_nan=False) + "\n")
                    os.replace(work, output / stem)
                    tiles.append({"directory": stem, **{k: receipt[k] for k in ("family", "condition", "seed", "size", "seam_ratio", "tile_sha256")}})
                    print(json.dumps({"tile": stem, "seam_ratio": round(receipt["seam_ratio"], 3), "seconds": receipt["seconds"]}), flush=True)
    finally:
        set_circular_padding(pipe.unet, False)
        set_circular_padding(pipe.vae, False)
    summary = {"schema": SCHEMA_SAMPLE, "tiles": tiles, "seconds": round(time.time() - started, 2), "device": device,
               "precision": precision, "lora_sha256": lora_sha, "size": size, "hires": hires, "scheduler": scheduler,
               "guide": guide, "clean": clean, "batch_size": batch_size, "created": datetime.now(timezone.utc).isoformat()}
    (output / f"samples-{summary['created'][:19].replace(':', '')}.json").write_text(json.dumps(json_safe(summary), indent=2, allow_nan=False) + "\n")
    contact_sheet(output)
    return summary


def contact_sheet(output: Path, tile: int = 256) -> Path | None:
    """Grid of all tiles under output (rows = family/condition, columns = seeds)."""
    output = Path(output)
    rows: dict[str, list[tuple[int, Path]]] = {}
    for receipt in sorted(output.glob("*/sample.json")):
        data = json.loads(receipt.read_text())
        key = data["family"] + (f" · {data['condition']}" if data.get("condition") else "")
        rows.setdefault(key, []).append((int(data["seed"]), receipt.parent / "tile.png"))
    if not rows:
        return None
    columns = max(len(items) for items in rows.values())
    sheet = Image.new("RGB", (columns * tile, len(rows) * tile), (20, 20, 20))
    for r, (key, items) in enumerate(sorted(rows.items())):
        for c, (_, path) in enumerate(sorted(items)):
            with Image.open(path) as image:
                sheet.paste(image.convert("RGB").resize((tile, tile), Image.Resampling.LANCZOS), (c * tile, r * tile))
    path = output / "contact.png"
    sheet.save(path)
    (output / "contact.json").write_text(json.dumps({"rows": sorted(rows), "columns": columns, "tile": tile}) + "\n")
    return path
