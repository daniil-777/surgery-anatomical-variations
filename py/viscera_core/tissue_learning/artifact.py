"""Single-file, data-only browser decoder format and independent NumPy inference."""

from __future__ import annotations

import base64
import hashlib
import json
import math
import time
from pathlib import Path

import numpy as np
from PIL import Image

from .config import ExperimentConfig

SCHEMA = "viscera.tissue-appearance-decoder/v1"


def seed_latent(seed: int | str, dimensions: int) -> np.ndarray:
    if isinstance(seed, bool) or not isinstance(seed, (int, str)):
        raise ValueError("seed must be a uint64 integer or canonical decimal string")
    value = int(seed)
    if not 0 <= value < 2**64 or str(value) != str(seed):
        raise ValueError("seed must be a canonical uint64 decimal")
    result = []
    for index in range((dimensions + 1) // 2):
        raw = hashlib.sha256(f"viscera-tissue-latent-v1:{value}:{index}".encode()).digest()
        a, b = (int.from_bytes(raw[offset:offset + 4], "big") for offset in (0, 4))
        u, v = (a + .5) / 2**32, (b + .5) / 2**32
        radius, angle = math.sqrt(-2 * math.log(u)), 2 * math.pi * v
        result.extend((radius * math.cos(angle), radius * math.sin(angle)))
    return np.asarray(result[:dimensions], dtype=np.float32)


def validate_artifact(value: dict) -> tuple[dict, list[tuple[np.ndarray, np.ndarray]]]:
    if value.get("schema") != SCHEMA or value.get("model_type") != "masked-rgb-periodic-cvae-v1":
        raise ValueError("unsupported appearance decoder")
    architecture = value["architecture"]
    config = ExperimentConfig(patch_size=512, latent_dim=architecture["latent_dim"], hidden_width=architecture["hidden_width"],
                              frequencies=tuple(architecture["frequencies"]))
    labels = architecture["condition_labels"]
    if (not isinstance(labels, list) or not 1 <= len(labels) <= 64 or len(set(labels)) != len(labels)
            or any(not isinstance(x, str) or not x for x in labels)):
        raise ValueError("invalid decoder condition labels")
    for key in ("condition_regions", "condition_species"):
        if len(architecture[key]) != len(labels) or any(not isinstance(x, str) or not x for x in architecture[key]):
            raise ValueError("invalid explicit condition mapping")
    if (architecture.get("hidden_layers") != 3 or architecture.get("activation") != "silu"
            or architecture.get("output_activation") != "sigmoid"
            or architecture.get("input_order") != "latent,condition_one_hot,uv_fourier"):
        raise ValueError("unsupported decoder operations")
    weights = value["weights"]
    if weights.get("encoding") != "base64-f32le" or not 0 < weights["byte_length"] <= 16_000_000:
        raise ValueError("unsupported/bounded weight encoding")
    raw = base64.b64decode(weights["data_base64"], validate=True)
    if len(raw) != weights["byte_length"] or hashlib.sha256(raw).hexdigest() != weights["sha256"]:
        raise ValueError("decoder weight integrity failure")
    widths = [config.latent_dim + len(labels) + 4 * len(config.frequencies),
              config.hidden_width, config.hidden_width, config.hidden_width, 3]
    specs = weights["tensors"]
    if len(specs) != 8:
        raise ValueError("decoder must contain exactly eight weight/bias tensors")
    offset, layers = 0, []
    for index, (inputs, outputs) in enumerate(zip(widths, widths[1:])):
        arrays = []
        for suffix, shape in (("weight", [outputs, inputs]), ("bias", [outputs])):
            spec = specs[2 * index + int(suffix == "bias")]
            length = math.prod(shape) * 4
            if spec != {"name": f"layers.{index}.{suffix}", "shape": shape,
                        "offset_bytes": offset, "length_bytes": length}:
                raise ValueError("decoder tensor shape/order/offset mismatch")
            array = np.frombuffer(raw, dtype="<f4", count=math.prod(shape), offset=offset).reshape(shape)
            if not np.isfinite(array).all():
                raise ValueError("nonfinite decoder weights")
            arrays.append(array)
            offset += length
        layers.append(tuple(arrays))
    if offset != len(raw):
        raise ValueError("unreferenced decoder bytes")
    return architecture, layers


def decode_numpy(value: dict, latent: np.ndarray, condition_index: int,
                 uv: np.ndarray, *, validated=None) -> np.ndarray:
    architecture, layers = validated or validate_artifact(value)
    latent, uv = np.asarray(latent, dtype=np.float32), np.asarray(uv, dtype=np.float32)
    count = len(architecture["condition_labels"])
    if (latent.shape != (architecture["latent_dim"],) or uv.ndim != 2 or uv.shape[1] != 2
            or not np.isfinite(latent).all() or not np.isfinite(uv).all()
            or type(condition_index) is not int or not 0 <= condition_index < count):
        raise ValueError("invalid decoder latent, condition or UV")
    features = []
    for frequency in architecture["frequencies"]:
        angle = uv * np.float32(2 * math.pi * frequency)
        features.extend((np.sin(angle[:, 0]), np.cos(angle[:, 0]),
                         np.sin(angle[:, 1]), np.cos(angle[:, 1])))
    one_hot = np.zeros(count, dtype=np.float32)
    one_hot[condition_index] = 1
    prefix = np.concatenate((latent, one_hot))
    result = np.concatenate((np.broadcast_to(prefix, (len(uv), len(prefix))),
                             np.stack(features, axis=1)), axis=1)
    for index, (weight, bias) in enumerate(layers):
        result = result @ weight.T + bias
        sigmoid = 1 / (1 + np.exp(-np.clip(result, -80, 80)))
        result = sigmoid if index == len(layers) - 1 else result * sigmoid
    if not np.isfinite(result).all():
        raise ValueError("nonfinite inference output")
    return result.astype(np.float32)


def export_decoder(checkpoint: Path, output: Path) -> dict:
    import torch

    from .checkpoint import digest, load_checkpoint
    from .model import TissueAppearanceVAE

    state, request = load_checkpoint(checkpoint)
    if state["step"] <= 0:
        raise ValueError("untrained initialized weights are not a trained artifact")
    config = ExperimentConfig.from_dict(request["config"])
    labels = request["data"]["conditions"]
    model = TissueAppearanceVAE(config, len(labels)).eval()
    model.load_state_dict(state["model"], strict=True)
    raw, tensors = bytearray(), []
    for name, tensor in model.decoder.state_dict().items():
        array = tensor.detach().cpu().numpy().astype("<f4")
        if not np.isfinite(array).all():
            raise ValueError("nonfinite trained decoder")
        payload = array.tobytes(order="C")
        tensors.append({"name": name, "shape": list(array.shape),
                        "offset_bytes": len(raw), "length_bytes": len(payload)})
        raw.extend(payload)
    latent = seed_latent(2**64 - 1, config.latent_dim)
    uv = np.array([[0, 0], [.1234, .9876], [.25, .75], [.5, .5], [1, 1]], dtype=np.float32)
    condition_index = len(labels) - 1
    condition = torch.zeros((1, len(labels)))
    condition[0, condition_index] = 1
    with torch.no_grad():
        reference = model.decoder(torch.from_numpy(latent[None]), condition, torch.from_numpy(uv[None])).numpy()[0]
    value = {
        "schema": SCHEMA, "model_type": "masked-rgb-periodic-cvae-v1",
        "architecture": {"latent_dim": config.latent_dim, "hidden_width": config.hidden_width,
            "hidden_layers": 3, "frequencies": list(config.frequencies),
            "condition_labels": labels, "condition_regions": request["condition_regions"],
            "condition_species": request["condition_species"],
            "input_order": "latent,condition_one_hot,uv_fourier", "activation": "silu",
            "output_activation": "sigmoid", "fourier_order": "frequency-major:sin(2pi*f*u),cos(2pi*f*u),sin(2pi*f*v),cos(2pi*f*v)",
            "uv": "u right, v down; periodic unit square; bake at pixel centers"},
        "weights": {"encoding": "base64-f32le", "sha256": hashlib.sha256(raw).hexdigest(),
            "byte_length": len(raw), "data_base64": base64.b64encode(raw).decode(), "tensors": tensors},
        "output": {"kind": "observed_rgb_appearance", "color_space": "srgb", "channels": ["r", "g", "b"],
                   "binding": "fixed-rest-uv", "pbr_ground_truth": False, "clinically_validated": False},
        "provenance": {"training_steps": state["step"],
            "training_status": "fixture_trained" if config.fixture else "research_trained",
            "qualification": "engineering_unqualified", "training_native_patch_size": config.patch_size,
            "dataset_manifest_sha256": request["data"]["manifest_sha256"],
            "split_manifest_sha256": request["data"]["split_sha256"],
            "config_sha256": request["config_sha256"], "source_sha256": request["source_sha256"],
            "checkpoint_manifest_sha256": digest(Path(checkpoint) / "manifest.json"),
            "environment": request["environment"], "dataset_summary": request["data"],
            "validation": state["validation"], "licence_note": "training-source permissions still govern use; this file grants no additional rights"},
        "seed_algorithm": "sha256-box-muller-f32-v1",
        "seed_reference": {"seed": str(2**64 - 1), "latent": latent.tolist()},
        "reference": {"latent": latent.tolist(), "condition_index": condition_index,
                      "uv": uv.tolist(), "rgb": reference.tolist()},
    }
    decoded = decode_numpy(value, latent, condition_index, uv)
    error = float(np.max(np.abs(decoded - reference)))
    if error > 2e-5:
        raise ValueError(f"portable decoder parity failure: {error}")
    value["export_validation"] = {"numpy_vs_torch_max_absolute_error": error,
                                  "tolerance": 2e-5, "gpu_execution_claim": False}
    payload = json.dumps(value, indent=2, allow_nan=False).encode() + b"\n"
    if len(payload) > 20_000_000:
        raise ValueError("portable decoder exceeds 20 MB export bound")
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("xb") as handle:
        handle.write(payload)
    return {"path": str(output), "sha256": hashlib.sha256(payload).hexdigest(),
            "bytes": len(payload), "training_steps": state["step"], "qualification": "engineering_unqualified"}


def load_artifact(path: Path) -> dict:
    if Path(path).stat().st_size > 20_000_000:
        raise ValueError("artifact exceeds size bound")
    value = json.loads(Path(path).read_text())
    validate_artifact(value)
    reference = value["reference"]
    expected_seed = seed_latent(value["seed_reference"]["seed"], value["architecture"]["latent_dim"])
    if not np.allclose(expected_seed, value["seed_reference"]["latent"], atol=1e-6, rtol=0):
        raise ValueError("seed reference mismatch")
    actual = decode_numpy(value, reference["latent"], reference["condition_index"], reference["uv"])
    if not np.allclose(actual, reference["rgb"], atol=2e-5, rtol=0):
        raise ValueError("decoder reference mismatch")
    return value


def bake_artifact(path: Path, output: Path, *, seed: int | str, condition_index: int,
                  resolution: int = 4096, chunk_pixels: int = 16384, device: str = "cpu") -> dict:
    if type(resolution) is not int or not 16 <= resolution <= 8192 or not 1 <= chunk_pixels <= 262144:
        raise ValueError("invalid bounded bake size")
    if Path(output).exists():
        raise FileExistsError("bake output already exists")
    value = load_artifact(path)
    validated = validate_artifact(value)
    latent = seed_latent(seed, value["architecture"]["latent_dim"])
    decoder = None
    if device == "cuda":
        import torch

        from .model import PeriodicDecoder

        if not torch.cuda.is_available():
            raise ValueError("CUDA bake requested but unavailable")
        architecture = value["architecture"]
        config = ExperimentConfig(patch_size=512, latent_dim=architecture["latent_dim"], hidden_width=architecture["hidden_width"],
                                  frequencies=tuple(architecture["frequencies"]))
        decoder = PeriodicDecoder(config, len(architecture["condition_labels"])).cuda().eval()
        decoder.load_state_dict({spec["name"]: torch.from_numpy(array.copy())
            for pair_index, pair in enumerate(validated[1]) for spec, array in
            zip(value["weights"]["tensors"][pair_index * 2:pair_index * 2 + 2], pair)}, strict=True)
        z = torch.from_numpy(latent[None]).cuda()
        c = torch.zeros((1, len(architecture["condition_labels"])), device="cuda")
        if not 0 <= condition_index < c.shape[1]:
            raise ValueError("unsupported condition index")
        c[0, condition_index] = 1
        torch.cuda.synchronize()
    elif device != "cpu":
        raise ValueError("unsupported bake device")
    start = time.perf_counter()
    pixels = np.empty((resolution * resolution, 3), dtype=np.uint8)
    for offset in range(0, len(pixels), chunk_pixels):
        indices = np.arange(offset, min(offset + chunk_pixels, len(pixels)))
        uv = np.stack(((indices % resolution + .5) / resolution,
                       (indices // resolution + .5) / resolution), axis=1).astype(np.float32)
        if decoder is None:
            rgb = decode_numpy(value, latent, condition_index, uv, validated=validated)
        else:
            with torch.no_grad():
                rgb = decoder(z, c, torch.from_numpy(uv[None]).cuda()).cpu().numpy()[0]
        pixels[offset:offset + len(indices)] = np.rint(np.clip(rgb, 0, 1) * 255).astype(np.uint8)
    Image.fromarray(pixels.reshape(resolution, resolution, 3)).save(output)
    return {"resolution": [resolution, resolution], "device": device,
            "wall_seconds": time.perf_counter() - start, "chunk_pixels": chunk_pixels,
            "seed_decimal": str(seed), "condition_index": condition_index,
            "training_native_patch_size": value["provenance"]["training_native_patch_size"],
            "interpretation": "coordinate decoder output sampling; not evidence of learned native 4K detail",
            "sha256": hashlib.sha256(Path(output).read_bytes()).hexdigest()}
