"""Optional local SAM 2 image segmentation; never downloads or identifies organs.

Uses the installed project checkpoint when present, or VISCERA_SAM2_MODEL for a
local override. VISCERA_SAM2_DEVICE selects cpu (default), mps, or cuda.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import os
import threading
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray
from PIL import Image

_LOCK = threading.Lock()
_MAX_PIXELS = 16_777_216
_MAX_POINTS = 64
_MAX_WEIGHT_BYTES = 2_000_000_000
_DEFAULT_MODEL = (
    Path(__file__).resolve().parents[2] / "artifacts/reference-material/models/sam2.1-hiera-tiny"
)
_CACHE: tuple[tuple[Any, ...], "_Backend"] | None = None


class SegmenterUnavailable(RuntimeError):
    """Local SAM 2 is unconfigured, incompatible, unavailable, or already busy."""


@dataclass
class _Backend:
    processor: Any
    model: Any
    torch: Any
    checkpoint_sha256: str
    device: str


def _model_directory() -> Path:
    configured = os.environ.get("VISCERA_SAM2_MODEL", "").strip()
    if not configured and not _DEFAULT_MODEL.is_dir():
        raise SegmenterUnavailable(
            "SAM 2 is not configured. Set VISCERA_SAM2_MODEL to a local safetensors model."
        )
    directory = Path(configured).expanduser().resolve() if configured else _DEFAULT_MODEL
    if not directory.is_dir():
        raise SegmenterUnavailable("VISCERA_SAM2_MODEL must be an existing local directory.")
    return directory


def _checkpoint_files(directory: Path) -> list[Path]:
    """Only support a single safetensors checkpoint; no pickle or arbitrary code."""
    files = [
        directory / name
        for name in ("config.json", "preprocessor_config.json", "model.safetensors")
    ]
    if any(not path.is_file() for path in files):
        raise SegmenterUnavailable(
            "SAM 2 needs config.json, preprocessor_config.json and model.safetensors locally."
        )
    if not 0 < files[2].stat().st_size <= _MAX_WEIGHT_BYTES:
        raise SegmenterUnavailable("SAM 2 checkpoint is empty or exceeds the 2 GB limit.")
    for path in files[:2]:
        if path.stat().st_size > 1_000_000:
            raise SegmenterUnavailable("SAM 2 configuration is too large.")
    try:
        config = json.loads(files[0].read_text())
        preprocess = json.loads(files[1].read_text())
    except (OSError, ValueError) as error:
        raise SegmenterUnavailable("SAM 2 configuration is unreadable.") from error
    if not isinstance(config, dict) or not isinstance(preprocess, dict):
        raise SegmenterUnavailable("SAM 2 configuration must be a JSON object.")
    if config.get("model_type") not in {"sam2", "sam2_video"}:
        raise SegmenterUnavailable("The configured checkpoint must be a SAM 2 model.")
    if config.get("image_size", 1024) != 1024 or preprocess.get("size") != {
        "height": 1024,
        "width": 1024,
    }:
        raise SegmenterUnavailable("SAM 2 requires the supported 1024-pixel preprocessing.")
    return files


def _load_backend(directory: Path, device: str, files: list[Path]) -> _Backend:
    try:
        import torch
        from transformers import Sam2Config, Sam2Model, Sam2Processor
    except ImportError as error:
        raise SegmenterUnavailable(
            "SAM 2 requires the optional torch, torchvision and transformers dependencies."
        ) from error
    if device == "mps" and not torch.backends.mps.is_available():
        raise SegmenterUnavailable("The configured SAM 2 MPS device is unavailable.")
    if device == "cuda" and not torch.cuda.is_available():
        raise SegmenterUnavailable("The configured SAM 2 CUDA device is unavailable.")
    try:
        # Explicit classes and local_files_only prohibit remote code / request-time downloads.
        # The official checkpoint also contains video weights; use its image subset explicitly.
        config = Sam2Config.from_pretrained(directory, local_files_only=True)
        processor = Sam2Processor.from_pretrained(directory, local_files_only=True)
        model, loading = Sam2Model.from_pretrained(
            directory,
            config=config,
            local_files_only=True,
            use_safetensors=True,
            output_loading_info=True,
        )
        if loading.get("missing_keys") or loading.get("mismatched_keys"):
            raise ValueError("Checkpoint does not cover every required SAM 2 image parameter.")
        model = model.to(device).eval()
        with files[2].open("rb") as checkpoint:
            digest = hashlib.file_digest(checkpoint, "sha256").hexdigest()
    except Exception as error:
        raise SegmenterUnavailable(
            "The local SAM 2 checkpoint could not be loaded; check model files and dependencies."
        ) from error
    return _Backend(processor, model, torch, digest, device)


def _get_backend() -> _Backend:
    global _CACHE
    directory = _model_directory()
    files = _checkpoint_files(directory)
    device = os.environ.get("VISCERA_SAM2_DEVICE", "cpu").strip().lower()
    if device not in {"cpu", "mps", "cuda"}:
        raise SegmenterUnavailable("VISCERA_SAM2_DEVICE must be cpu, mps, or cuda.")
    key = (str(directory), device, *((p.stat().st_size, p.stat().st_mtime_ns) for p in files))
    if _CACHE is None or _CACHE[0] != key:
        _CACHE = (key, _load_backend(directory, device, files))
    return _CACHE[1]


def sam2_status() -> dict[str, Any]:
    """Cheap configuration check; does not load Torch or download any files."""
    try:
        directory = _model_directory()
        _checkpoint_files(directory)
        if any(
            importlib.util.find_spec(name) is None
            for name in ("torch", "torchvision", "transformers", "safetensors")
        ):
            raise SegmenterUnavailable("Install the optional reference-segmentation dependencies.")
        device = os.environ.get("VISCERA_SAM2_DEVICE", "cpu").strip().lower()
        if device not in {"cpu", "mps", "cuda"}:
            raise SegmenterUnavailable("VISCERA_SAM2_DEVICE must be cpu, mps, or cuda.")
    except SegmenterUnavailable as error:
        return {"configured": False, "reason": str(error)}
    return {
        "configured": True,
        "device": device,
        "model": directory.name,
        "loaded": _CACHE is not None and _CACHE[0][:2] == (str(directory), device),
    }


def _coordinate(value: Any) -> float:
    if isinstance(value, (bool, str, bytes)):
        raise ValueError("SAM 2 coordinates must be finite numbers in [0, 1].")
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError("SAM 2 coordinates must be finite numbers in [0, 1].") from error
    if not math.isfinite(result) or not 0 <= result <= 1:
        raise ValueError("SAM 2 coordinates must be finite numbers in [0, 1].")
    return result


def _points(points: Sequence[Sequence[float]], width: int, height: int) -> list[list[float]]:
    if len(points) > _MAX_POINTS:
        raise ValueError("SAM 2 accepts at most 64 total foreground/background points.")
    result = []
    for point in points:
        if len(point) != 2:
            raise ValueError("Each SAM 2 point must contain x and y.")
        # A normalized point at 1 denotes the last pixel, not an out-of-image click.
        result.append([_coordinate(point[0]) * (width - 1), _coordinate(point[1]) * (height - 1)])
    return result


def segment_sam2(
    image: Image.Image,
    box: Sequence[float] | None,
    foreground_points: Sequence[Sequence[float]],
    background_points: Sequence[Sequence[float]],
) -> tuple[NDArray[np.bool_], dict[str, Any]]:
    """Return one full-resolution bool mask and non-semantic provenance.

    Inputs use normalized original-image coordinates. Boxes use image edges,
    while clicks are clamped by definition to the last pixel. Errors never fall
    back to a different algorithm. Only one inference can run at a time.
    """
    if not isinstance(image, Image.Image) or image.mode != "RGB":
        raise ValueError("SAM 2 expects a PIL RGB image.")
    width, height = image.size
    if min(width, height) < 2 or max(width, height) > 8192 or width * height > _MAX_PIXELS:
        raise ValueError("SAM 2 image must be 2–8192 pixels per side and at most 16 megapixels.")
    foreground = _points(foreground_points, width, height)
    background = _points(background_points, width, height)
    if len(foreground) + len(background) > _MAX_POINTS:
        raise ValueError("SAM 2 accepts at most 64 total foreground/background points.")
    pixel_box = None
    if box is not None:
        if len(box) != 4:
            raise ValueError("SAM 2 box must contain x0, y0, x1, y1.")
        x0, y0, x1, y1 = map(_coordinate, box)
        if x0 >= x1 or y0 >= y1:
            raise ValueError("SAM 2 box must have positive width and height.")
        pixel_box = [x0 * width, y0 * height, x1 * width, y1 * height]
    if pixel_box is None and not foreground:
        raise ValueError("SAM 2 needs a foreground point or a bounding box.")
    if not _LOCK.acquire(blocking=False):
        raise SegmenterUnavailable("SAM 2 is busy; retry after the current segmentation.")
    try:
        backend = _get_backend()
        prompts: dict[str, Any] = {"images": image, "return_tensors": "pt"}
        if pixel_box is not None:
            prompts["input_boxes"] = [[pixel_box]]
        if foreground or background:
            prompts["input_points"] = [[foreground + background]]
            prompts["input_labels"] = [[[1] * len(foreground) + [0] * len(background)]]
        try:
            inputs = backend.processor(**prompts).to(backend.device)
            with backend.torch.inference_mode():
                outputs = backend.model(**inputs, multimask_output=False)
            masks = backend.processor.post_process_masks(
                outputs.pred_masks.detach().cpu(), inputs["original_sizes"].cpu()
            )[0]
            mask_data = np.asarray(masks[0, 0].cpu().numpy())
            if not np.isfinite(mask_data).all():
                raise ValueError("Mask contains nonfinite values.")
            mask = np.asarray(mask_data, dtype=np.bool_)
            score = float(outputs.iou_scores.detach().cpu().reshape(-1)[0])
        except Exception as error:
            raise SegmenterUnavailable(
                "Local SAM 2 inference failed; no material was changed."
            ) from error
        if mask.shape != (height, width) or not math.isfinite(score):
            raise SegmenterUnavailable(
                "SAM 2 returned invalid mask dimensions or a nonfinite score."
            )
        if not mask.any():
            raise ValueError(
                "SAM 2 returned an empty region; add foreground points or adjust the box."
            )
        return mask, {
            "method": "sam2",
            "backend": "transformers-sam2",
            "checkpoint_sha256": backend.checkpoint_sha256,
            "device": backend.device,
            "predicted_iou": score,
            "score_meaning": "Uncalibrated mask-quality estimate; not organ-identity confidence.",
            "semantic_identity": "user_assigned",
            "review_required": True,
        }
    finally:
        _LOCK.release()
