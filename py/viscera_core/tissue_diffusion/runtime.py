"""Pinned, reviewed StableMaterials execution in a standalone process only.

No automatic fallback model/device, pickle loading, mutable remote-code revision,
or weight download during inference. Upstream convolution monkeypatches and RNG
state are restored on failure. Model files must pass the embedded exact lock.
"""

from __future__ import annotations

import contextlib
import errno
import hashlib
import importlib.metadata
import importlib.util
import json
import os
import platform
import shutil
import sys
import time
import urllib.request
from pathlib import Path, PurePosixPath

from .contract import NATIVE_RESOLUTION, SCHEMA, PilotRequest, export_material_bundle, preserve_rejected_sample, sha256_file

REVISION = "4d452731535bd5c74261d6645623a573326f6f36"
PIPELINE_SHA256 = "0e0a5cd721d4abadd2ceb2e46fc3ee876b93e720fb63caf8bb74784ede5a55be"


def model_lock() -> dict:
    value = json.loads(Path(__file__).with_name("stablematerials-lock.json").read_text())
    if value.get("revision") != REVISION or value.get("repository") != "gvecchio/StableMaterials":
        raise ValueError("unsupported model lock identity")
    paths = set()
    for item in value["files"]:
        name = item["path"]
        if name in paths or PurePosixPath(name).is_absolute() or any(p in ("", ".", "..") for p in name.split("/")):
            raise ValueError("invalid model-lock path")
        if "\\" in name or type(item["bytes"]) is not int or item["bytes"] < 1 or len(item["sha256"]) != 64:
            raise ValueError("invalid model-lock record")
        paths.add(name)
    if next(item["sha256"] for item in value["files"] if item["path"] == "pipeline.py") != PIPELINE_SHA256:
        raise ValueError("custom pipeline differs from reviewed source")
    return value


def plan() -> dict:
    lock = model_lock()
    return {"schema": SCHEMA, "repository": lock["repository"], "revision": REVISION,
        "download_bytes": sum(item["bytes"] for item in lock["files"]), "native_resolution": [512, 512],
        "pipeline_sha256": PIPELINE_SHA256, "weight_format": "safetensors only", "device": "explicit cuda/mps/cpu; no fallback",
        "selection": lock["selection"], "extra_dependency": "diffusers==0.35.1",
        "minimum_free_download_bytes": sum(item["bytes"] for item in lock["files"]) + 256 * 1024**2,
        "restrictions": ["No tissue-specific fine-tuning", "OpenRAIL tag without full license text in upstream snapshot",
                         "No public weight redistribution", "No released native4K refiner", "Qualify appearance before promotion"]}


def _safe_file(root: Path, relative: str) -> Path:
    path = root / relative
    if root.is_symlink() or any(part.is_symlink() for part in [path, *path.parents] if part != root.parent):
        # Explicit model snapshot, not a mutable hub symlink cache.
        raise ValueError("snapshot symlinks are not accepted")
    return path


def verify_snapshot(root: Path, *, metadata_only=False) -> dict:
    root = Path(root).absolute()
    checks = []
    for item in model_lock()["files"]:
        if metadata_only and item["path"].endswith(".safetensors"):
            continue
        path = _safe_file(root, item["path"])
        if not path.is_file() or path.stat().st_size != item["bytes"] or sha256_file(path) != item["sha256"]:
            raise ValueError(f"missing or corrupt pinned model file: {item['path']}")
        checks.append(item)
    return {"revision": REVISION, "verified_files": len(checks), "verified_bytes": sum(item["bytes"] for item in checks),
        "metadata_only": metadata_only, "pipeline_sha256": PIPELINE_SHA256}


def download_snapshot(root: Path, *, allow_weights=False) -> dict:
    """Explicit allowlist download, verify partial bytes before atomic publication."""
    root = Path(root).absolute()
    root.mkdir(parents=True, exist_ok=True)
    selected = [item for item in model_lock()["files"] if allow_weights or not item["path"].endswith(".safetensors")]
    missing = [item for item in selected if not (root / item["path"]).exists()]
    needed = sum(item["bytes"] for item in missing) + 128 * 1024**2
    if shutil.disk_usage(root).free < needed:
        raise OSError(f"insufficient free space: need at least {needed} bytes on snapshot volume")
    for item in selected:
        path = _safe_file(root, item["path"])
        if path.exists():
            if not path.is_file() or path.stat().st_size != item["bytes"] or sha256_file(path) != item["sha256"]:
                raise ValueError(f"existing file differs from pinned source: {path}; preserve it and choose a fresh snapshot")
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_name(path.name + ".partial")
        if partial.exists():
            if partial.is_symlink() or not partial.is_file() or partial.stat().st_size != item["bytes"] or sha256_file(partial) != item["sha256"]:
                raise FileExistsError(f"unfinished or changed download retained at {partial}; inspect it before retry")
            # A fully verified download can outlive a filesystem publication
            # failure. Reuse it without downloading another multi-GB checkpoint.
            _publish_verified(partial, path)
            continue
        url = f"https://huggingface.co/gvecchio/StableMaterials/resolve/{REVISION}/{item['path']}"
        print(f"Downloading {item['path']} ({item['bytes']:,} bytes)", file=sys.stderr, flush=True)
        digest, size = hashlib.sha256(), 0
        request = urllib.request.Request(url, headers={"User-Agent": "VISCERA-tissue-diffusion-pilot/1"})
        with urllib.request.urlopen(request, timeout=90) as response, partial.open("xb") as stream:
            while block := response.read(1024 * 1024):
                size += len(block)
                if size > item["bytes"]:
                    raise ValueError("download exceeded the pinned byte count")
                digest.update(block)
                stream.write(block)
            stream.flush()
            os.fsync(stream.fileno())
        if size != item["bytes"] or digest.hexdigest() != item["sha256"]:
            raise ValueError(f"download digest/size mismatch: {partial}")
        # Another process cannot replace a previously published file.
        _publish_verified(partial, path)
    receipt = verify_snapshot(root, metadata_only=not allow_weights)
    (root / "viscera-download-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


def _publish_verified(partial: Path, path: Path) -> None:
    """No-overwrite publication on APFS and external exFAT volumes.

    Prefer atomic hard-link publication. exFAT has no hard links; an exclusive
    copy is safe because every inference verifies all declared bytes beforehand.
    A failed copy remains visibly incomplete, and its verified source survives.
    """
    try:
        os.link(partial, path)
    except OSError as error:
        if error.errno not in (errno.EOPNOTSUPP, errno.ENOTSUP, errno.EXDEV, errno.EPERM):
            raise
        with partial.open("rb") as source, path.open("xb") as target:
            shutil.copyfileobj(source, target, length=1024 * 1024)
            target.flush()
            os.fsync(target.fileno())
        if path.stat().st_size != partial.stat().st_size or sha256_file(path) != sha256_file(partial):
            raise ValueError("snapshot publication copy failed verification")
    partial.unlink()


def _load_reviewed_module(root: Path):
    source = _safe_file(root, "pipeline.py")
    if sha256_file(source) != PIPELINE_SHA256:
        raise ValueError("refusing unreviewed custom pipeline")
    name = "viscera_reviewed_stablematerials_4d452731"
    spec = importlib.util.spec_from_file_location(name, source)
    if spec is None or spec.loader is None:
        raise ImportError("cannot load reviewed pipeline")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module  # dataclass resolves the module during its definition.
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(name, None)
        raise
    return module


@contextlib.contextmanager
def isolated_upstream_state(torch, transformer_class, seed: int):
    """Upstream rolling uses global CPU RNG and monkeypatches classes globally.

    This is intentionally a serial CLI worker, not a concurrent web-server job.
    """
    cpu_rng = torch.get_rng_state()
    conv_forward, attn_forward = torch.nn.Conv2d.forward, transformer_class.forward
    had_multiplier = hasattr(transformer_class, "scale_multiplier")
    multiplier = getattr(transformer_class, "scale_multiplier", None)
    try:
        # Only CPU global RNG is used by upstream roll(); latent noise also uses
        # a dedicated CPU generator. Avoid perturbing other device RNG streams.
        torch.random.default_generator.manual_seed(seed)
        yield
    finally:
        torch.nn.Conv2d.forward = conv_forward
        transformer_class.forward = attn_forward
        if had_multiplier:
            transformer_class.scale_multiplier = multiplier
        elif hasattr(transformer_class, "scale_multiplier"):
            del transformer_class.scale_multiplier
        torch.set_rng_state(cpu_rng)


def run_pilot(snapshot: Path, output: Path, request: PilotRequest, *, device: str) -> dict:
    """One actual 512-square sample, with all heavyweight imports deferred."""
    if device not in ("cuda", "mps", "cpu"):
        raise ValueError("select cuda, mps or cpu explicitly")
    if Path(output).exists():
        raise FileExistsError("output must be a new directory")
    verified = verify_snapshot(snapshot)
    import torch
    from diffusers import AutoencoderKL, DDIMScheduler, UNet2DConditionModel
    from diffusers.models.transformers import Transformer2DModel
    from transformers import CLIPTextModelWithProjection, CLIPTokenizerFast

    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA requested but unavailable; no fallback")
    if device == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("Metal requested but unavailable; no fallback")
    if os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK") == "1":
        raise RuntimeError("disable PYTORCH_ENABLE_MPS_FALLBACK so device failures stay visible")
    root = Path(snapshot).absolute()
    module = _load_reviewed_module(root)
    # fp32 on MPS avoids silently accepting fp16 overflow/black samples. This
    # profile is independent of CUDA's float16 A100 profile and records its dtype.
    dtype = torch.float16 if device == "cuda" else torch.float32
    options = {"local_files_only": True, "use_safetensors": True, "torch_dtype": dtype}
    started = time.perf_counter()
    pipe = module.StableMaterialsPipeline(
        vae=AutoencoderKL.from_pretrained(root / "vae", **options),
        unet=UNet2DConditionModel.from_pretrained(root / "unet", **options),
        scheduler=DDIMScheduler.from_pretrained(root / "scheduler", local_files_only=True),
        text_encoder=CLIPTextModelWithProjection.from_pretrained(root / "text_encoder", **options),
        tokenizer=CLIPTokenizerFast.from_pretrained(root / "tokenizer", local_files_only=True),
        vision_encoder=None, processor=None,
    )
    pipe.to(device)
    pipe.enable_attention_slicing("auto")  # bounded VRAM/RAM; no xformers install.
    pipe.enable_vae_slicing()
    load_seconds = time.perf_counter() - started
    def sync():
        if device == "cuda":
            torch.cuda.synchronize()
        elif device == "mps":
            torch.mps.synchronize()
    sync()
    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()
    with isolated_upstream_state(torch, Transformer2DModel, request.seed), torch.inference_mode():
        result = pipe(prompt=request.prompt, negative_prompt=request.negative_prompt,
            height=512, width=512, num_inference_steps=request.steps, guidance_scale=request.guidance,
            num_images_per_prompt=1, tileable=True, patched=False,
            generator=torch.Generator(device="cpu").manual_seed(request.seed), output_type="pt")
    sync()
    seconds = time.perf_counter() - started
    if len(result.images) != 1:
        raise RuntimeError("unexpected model result count")
    sample = result.images[0]
    maps = {name: getattr(sample, name).float().detach().cpu().permute(1, 2, 0).numpy()
            for name in ("basecolor", "normal", "height", "roughness", "metallic")}
    versions = {name: importlib.metadata.version(name) for name in
        ("torch", "torchvision", "diffusers", "transformers", "safetensors", "numpy", "Pillow")}
    provenance = {"schema": SCHEMA, "executed": True, "native_resolution": [NATIVE_RESOLUTION] * 2,
        "model_repository": "gvecchio/StableMaterials", "model_revision": REVISION,
        "snapshot_verification": verified, "pipeline_sha256": PIPELINE_SHA256,
        "weights": [item for item in model_lock()["files"] if item["path"].endswith(".safetensors")],
        "runtime": {"python": platform.python_version(), "packages": versions, "device": device, "dtype": str(dtype),
            "hardware": torch.cuda.get_device_name() if device == "cuda" else platform.machine(),
            "load_seconds": load_seconds, "inference_seconds": seconds,
            "peak_cuda_allocated_bytes": torch.cuda.max_memory_allocated() if device == "cuda" else None,
            "attention_slicing": "auto", "seed_scope": "CPU latent Generator and global feature-rolling RNG; same-runtime replay only"},
        "source": {"runtime_py_sha256": sha256_file(Path(__file__)),
                   "contract_py_sha256": sha256_file(Path(__file__).with_name("contract.py"))}}
    try:
        return export_material_bundle(maps, request, output, provenance)
    except ValueError as error:
        failed = preserve_rejected_sample(maps, request, output, provenance, str(error))
        raise ValueError(f"{error}; rejected raw outputs retained at {failed}") from error
