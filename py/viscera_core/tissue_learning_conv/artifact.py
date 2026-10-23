"""Fixed data-only circular resize-convolution decoder, native128 RGB output."""

from __future__ import annotations

import base64
import hashlib
import json
import math
import time
from pathlib import Path

import numpy as np
from PIL import Image

from viscera_core.tissue_learning.artifact import seed_latent

from .config import ConvConfig

SCHEMA = "viscera.tissue-appearance-decoder/v3"
MODEL_TYPE = "masked-rgb-spatial-cvae-gan-v1"


def decoder_widths(channels, latent_channels, conditions):
    widths = [latent_channels + conditions, channels[0]]
    for width in channels[1:]:
        widths.extend((width, width))
    return [*widths, 3]


def validate_artifact(value):
    if value.get("schema") != SCHEMA or value.get("model_type") != MODEL_TYPE:
        raise ValueError("unsupported spatial appearance model")
    architecture = value["architecture"]
    shape = architecture["latent_shape"]
    if not isinstance(shape, list) or len(shape) != 3 or shape[1:] != [8, 8]:
        raise ValueError("invalid spatial latent shape")
    config = ConvConfig(
        device="cpu",
        precision="float32",
        latent_channels=shape[0],
        decoder_channels=tuple(architecture["decoder_channels"]),
    )
    labels = architecture["condition_labels"]
    if (
        not isinstance(labels, list)
        or not 1 <= len(labels) <= 64
        or len(set(labels)) != len(labels)
        or any(not isinstance(label, str) or not label for label in labels)
    ):
        raise ValueError("invalid condition labels")
    if any(
        len(architecture[key]) != len(labels)
        or any(not isinstance(v, str) or not v for v in architecture[key])
        for key in ("condition_regions", "condition_species")
    ):
        raise ValueError("invalid condition mapping")
    expected = {
        "latent_dim": config.latent_dim,
        "native_resolution": [128, 128],
        "input_order": "latent_chw,condition_one_hot_broadcast",
        "padding": "circular",
        "upsample": "nearest-repeat-2",
        "upsample_before_layers": [1, 3, 5, 7],
        "activation": "silu",
        "output_activation": "sigmoid",
        "weight_layout": "OIHW",
        "kernel_size": 3,
        "output_sampling": "periodic-bilinear-pixel-centers",
    }
    if any(architecture.get(key) != val for key, val in expected.items()):
        raise ValueError("unsupported spatial decoder operations")
    weights = value["weights"]
    if (
        weights.get("encoding") != "base64-f32le"
        or type(weights["byte_length"]) is not int
        or not 0 < weights["byte_length"] <= 16_000_000
    ):
        raise ValueError("unsupported weight encoding/bound")
    raw = base64.b64decode(weights["data_base64"], validate=True)
    if len(raw) != weights["byte_length"] or hashlib.sha256(raw).hexdigest() != weights["sha256"]:
        raise ValueError("decoder weight integrity failure")
    widths = decoder_widths(config.decoder_channels, config.latent_channels, len(labels))
    specs = weights["tensors"]
    if len(specs) != 20:
        raise ValueError("exactly twenty convolution tensors are required")
    offset, layers = 0, []
    for index, (inputs, outputs) in enumerate(zip(widths, widths[1:])):
        arrays = []
        for suffix, shape in (("weight", [outputs, inputs, 3, 3]), ("bias", [outputs])):
            spec = specs[2 * index + int(suffix == "bias")]
            length = math.prod(shape) * 4
            if spec != {
                "name": f"layers.{index}.{suffix}",
                "shape": shape,
                "offset_bytes": offset,
                "length_bytes": length,
            }:
                raise ValueError("tensor order/shape/offset mismatch")
            array = np.frombuffer(raw, dtype="<f4", count=math.prod(shape), offset=offset).reshape(
                shape
            )
            if not np.isfinite(array).all():
                raise ValueError("nonfinite weights")
            arrays.append(array)
            offset += length
        layers.append(tuple(arrays))
    if offset != len(raw):
        raise ValueError("unreferenced decoder bytes")
    return architecture, layers


def decode_native_numpy(value, latent, condition_index, *, validated=None):
    architecture, layers = validated or validate_artifact(value)
    latent = np.asarray(latent, dtype=np.float32)
    count = len(architecture["condition_labels"])
    if (
        latent.shape != (architecture["latent_dim"],)
        or not np.isfinite(latent).all()
        or type(condition_index) is not int
        or not 0 <= condition_index < count
    ):
        raise ValueError("invalid latent/condition")
    one_hot = np.zeros((count, 8, 8), dtype=np.float32)
    one_hot[condition_index] = 1
    result = np.concatenate((latent.reshape(architecture["latent_shape"]), one_hot))
    for index, (weight, bias) in enumerate(layers):
        if index in (1, 3, 5, 7):
            result = result.repeat(2, 1).repeat(2, 2)
        padded = np.pad(result, ((0, 0), (1, 1), (1, 1)), mode="wrap")
        windows = np.lib.stride_tricks.sliding_window_view(padded, (3, 3), axis=(1, 2))
        # Independent NumPy cross-correlation, OIHW weights, no Torch execution.
        size = result.shape[-1]
        columns = windows.transpose(1, 2, 0, 3, 4).reshape(size * size, -1)
        result = (columns @ weight.reshape(weight.shape[0], -1).T + bias).T.reshape(-1, size, size)
        sigmoid = 1 / (1 + np.exp(-np.clip(result, -80, 80)))
        result = sigmoid if index == 9 else result * sigmoid
    if not np.isfinite(result).all():
        raise ValueError("nonfinite inference output")
    return np.moveaxis(result.astype(np.float32), 0, -1)


def sample_periodic_numpy(native, uv):
    native, uv = np.asarray(native, dtype=np.float32), np.asarray(uv, dtype=np.float32)
    if (
        native.shape != (128, 128, 3)
        or uv.ndim != 2
        or uv.shape[1] != 2
        or not np.isfinite(uv).all()
    ):
        raise ValueError("invalid native texture/UV sampling")
    xy = (uv - np.floor(uv)) * np.float32(128) - np.float32(0.5)
    lower = np.floor(xy).astype(np.int64)
    blend = xy - lower.astype(np.float32)
    x, y = lower[:, 0] % 128, lower[:, 1] % 128
    dx, dy = blend[:, 0, None], blend[:, 1, None]
    top = native[y, x] * (1 - dx) + native[y, (x + 1) % 128] * dx
    bottom = native[(y + 1) % 128, x] * (1 - dx) + native[(y + 1) % 128, (x + 1) % 128] * dx
    return top * (1 - dy) + bottom * dy


def decode_numpy(value, latent, condition_index, uv=None, *, validated=None):
    native = decode_native_numpy(value, latent, condition_index, validated=validated)
    return native if uv is None else sample_periodic_numpy(native, uv)


def export_decoder(checkpoint: Path, output: Path):
    import torch

    from viscera_core.tissue_learning.checkpoint import digest, load_checkpoint

    from .model import ConvVAE

    state, request = load_checkpoint(checkpoint)
    if request.get("schema") != "viscera.tissue-conv-training-request/v1" or state["step"] <= 0:
        raise ValueError("a trained convolutional checkpoint is required")
    config = ConvConfig.from_dict(request["config"])
    labels = request["data"]["conditions"]
    model = ConvVAE(config, len(labels)).eval()
    model.load_state_dict(state["model"], strict=True)
    raw, tensors = bytearray(), []
    for name, tensor in model.decoder.state_dict().items():
        array = tensor.detach().cpu().numpy().astype("<f4")
        if not np.isfinite(array).all():
            raise ValueError("nonfinite trained decoder")
        data = array.tobytes(order="C")
        tensors.append(
            {
                "name": name,
                "shape": list(array.shape),
                "offset_bytes": len(raw),
                "length_bytes": len(data),
            }
        )
        raw.extend(data)
    latent = seed_latent(2**64 - 1, config.latent_dim)
    pixels = np.array(
        [[0, 0], [127, 0], [0, 127], [127, 127], [15, 103], [32, 96], [64, 64]], dtype=np.int64
    )
    condition_index = len(labels) - 1
    condition = torch.zeros(1, len(labels))
    condition[0, condition_index] = 1
    with torch.no_grad():
        native = (
            model.decoder(torch.from_numpy(latent[None]), condition).numpy()[0].transpose(1, 2, 0)
        )
    reference = native[pixels[:, 1], pixels[:, 0]]
    value = {
        "schema": SCHEMA,
        "model_type": MODEL_TYPE,
        "architecture": {
            "latent_shape": [config.latent_channels, 8, 8],
            "latent_dim": config.latent_dim,
            "decoder_channels": list(config.decoder_channels),
            "native_resolution": [128, 128],
            "condition_labels": labels,
            "condition_regions": request["condition_regions"],
            "condition_species": request["condition_species"],
            "input_order": "latent_chw,condition_one_hot_broadcast",
            "padding": "circular",
            "upsample": "nearest-repeat-2",
            "upsample_before_layers": [1, 3, 5, 7],
            "activation": "silu",
            "output_activation": "sigmoid",
            "weight_layout": "OIHW",
            "kernel_size": 3,
            "output_sampling": "periodic-bilinear-pixel-centers",
        },
        "weights": {
            "encoding": "base64-f32le",
            "sha256": hashlib.sha256(raw).hexdigest(),
            "byte_length": len(raw),
            "data_base64": base64.b64encode(raw).decode(),
            "tensors": tensors,
        },
        "output": {
            "kind": "observed_rgb_appearance",
            "color_space": "srgb",
            "channels": ["r", "g", "b"],
            "binding": "fixed-rest-uv",
            "native_resolution": [128, 128],
            "pbr_ground_truth": False,
            "clinically_validated": False,
        },
        "provenance": {
            "training_steps": state["step"],
            "training_status": "fixture_trained" if config.fixture else "research_trained",
            "qualification": "engineering_unqualified",
            "training_native_patch_size": 128,
            "training_source_crop_size": 128,
            "native_decode_resolution": [128, 128],
            "dataset_manifest_sha256": request["data"]["manifest_sha256"],
            "split_manifest_sha256": request["data"]["split_sha256"],
            "config_sha256": request["config_sha256"],
            "source_sha256": request["source_sha256"],
            "checkpoint_manifest_sha256": digest(Path(checkpoint) / "manifest.json"),
            "environment": request["environment"],
            "dataset_summary": request["data"],
            "validation": state["validation"],
            "training_objectives": request["objectives"],
            "critic_exported": False,
            "licence_note": "source permissions still govern use; no additional rights granted",
        },
        "seed_algorithm": "sha256-box-muller-f32-v1",
        "seed_reference": {"seed": str(2**64 - 1), "latent": latent.tolist()},
        "reference": {
            "latent": latent.tolist(),
            "condition_index": condition_index,
            "pixels_xy": pixels.tolist(),
            "rgb": reference.tolist(),
        },
    }
    result = decode_native_numpy(value, latent, condition_index)
    error = float(np.max(np.abs(result - native)))
    if error > 3e-5:
        raise ValueError(f"native convolution decoder parity failure: {error}")
    value["export_validation"] = {
        "numpy_vs_torch_max_absolute_error": error,
        "tolerance": 3e-5,
        "compared_native_pixels": 128 * 128,
        "gpu_execution_claim": False,
    }
    payload = json.dumps(value, indent=2, allow_nan=False).encode() + b"\n"
    if len(payload) > 20_000_000:
        raise ValueError("export exceeds 20MB bound")
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("xb") as stream:
        stream.write(payload)
    return {
        "path": str(output),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "bytes": len(payload),
        "training_steps": state["step"],
        "qualification": "engineering_unqualified",
    }


def load_artifact(path):
    path = Path(path)
    if path.stat().st_size > 20_000_000:
        raise ValueError("artifact exceeds bound")
    value = json.loads(path.read_text())
    validate_artifact(value)
    expected = seed_latent(value["seed_reference"]["seed"], value["architecture"]["latent_dim"])
    if not np.allclose(expected, value["seed_reference"]["latent"], atol=1e-6, rtol=0):
        raise ValueError("seed reference mismatch")
    ref = value["reference"]
    pixels = np.asarray(ref["pixels_xy"])
    if (
        pixels.ndim != 2
        or pixels.shape[1] != 2
        or not np.issubdtype(pixels.dtype, np.integer)
        or not ((pixels >= 0) & (pixels < 128)).all()
    ):
        raise ValueError("invalid native reference coordinates")
    native = decode_native_numpy(value, ref["latent"], ref["condition_index"])
    if not np.allclose(native[pixels[:, 1], pixels[:, 0]], ref["rgb"], atol=3e-5, rtol=0):
        raise ValueError("decoder reference mismatch")
    return value


def bake_artifact(
    path, output, *, seed, condition_index, resolution=256, chunk_pixels=16384, device="cpu"
):
    if (
        type(resolution) is not int
        or not 16 <= resolution <= 8192
        or type(chunk_pixels) is not int
        or not 1 <= chunk_pixels <= 262144
    ):
        raise ValueError("invalid bounded bake resolution/chunk")
    path, output = Path(path), Path(output)
    if output.exists():
        raise FileExistsError("bake output exists")
    value = load_artifact(path)
    validated = validate_artifact(value)
    architecture = value["architecture"]
    latent = seed_latent(seed, architecture["latent_dim"])
    if type(condition_index) is not int or not 0 <= condition_index < len(
        architecture["condition_labels"]
    ):
        raise ValueError("invalid condition")
    started = time.perf_counter()
    if device == "cpu":
        native = decode_native_numpy(value, latent, condition_index, validated=validated)
    elif device == "cuda":
        import torch

        from .model import SpatialDecoder

        if not torch.cuda.is_available():
            raise ValueError("CUDA unavailable")
        # Portable NumPy/JS reference uses full float32. TF32 convolution
        # changes arithmetic precision even when input tensors are float32.
        torch.backends.cudnn.allow_tf32 = False
        torch.backends.cuda.matmul.allow_tf32 = False
        config = ConvConfig(
            latent_channels=architecture["latent_shape"][0],
            decoder_channels=tuple(architecture["decoder_channels"]),
        )
        decoder = SpatialDecoder(config, len(architecture["condition_labels"])).cuda().eval()
        decoder.load_state_dict(
            {
                spec["name"]: torch.from_numpy(array.copy())
                for i, pair in enumerate(validated[1])
                for spec, array in zip(value["weights"]["tensors"][i * 2 : i * 2 + 2], pair)
            },
            strict=True,
        )
        z = torch.from_numpy(latent[None]).cuda()
        c = torch.zeros(1, len(architecture["condition_labels"]), device="cuda")
        c[0, condition_index] = 1
        with torch.no_grad():
            native = decoder(z, c)[0].permute(1, 2, 0).cpu().numpy()
        torch.cuda.synchronize()
    else:
        raise ValueError("unsupported bake device")
    pixels = np.empty((resolution * resolution, 3), dtype=np.uint8)
    for offset in range(0, len(pixels), chunk_pixels):
        indices = np.arange(offset, min(offset + chunk_pixels, len(pixels)))
        uv = np.stack(
            ((indices % resolution + 0.5) / resolution, (indices // resolution + 0.5) / resolution),
            -1,
        ).astype(np.float32)
        rgb = sample_periodic_numpy(native, uv)
        pixels[offset : offset + len(indices)] = np.rint(np.clip(rgb, 0, 1) * 255).astype(np.uint8)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("xb") as stream:
        Image.fromarray(pixels.reshape(resolution, resolution, 3)).save(stream, format="PNG")
    return {
        "path": str(output),
        "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "model_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "resolution": [resolution, resolution],
        "training_native_patch_size": 128,
        "native_decode_resolution": [128, 128],
        "inference_precision": "float32; TF32 disabled for CUDA convolution",
        "seed": str(seed),
        "condition_index": condition_index,
        "wall_seconds": time.perf_counter() - started,
        "device": device,
        "qualification": "engineering_unqualified",
        "detail_claim": "periodic bilinear upsampling of learned128px texture; no independently learned 4K detail",
    }
