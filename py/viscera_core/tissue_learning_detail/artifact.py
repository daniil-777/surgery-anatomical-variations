"""Data-only v2 directional decoder; no discriminator or executable graph exported."""

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

from .config import DetailConfig

SCHEMA = "viscera.tissue-appearance-decoder/v2"
MODEL_TYPE = "masked-rgb-directional-cvae-gan-v1"
FOURIER_ORDER = "vector-major:sin(2pi*(kx*u+ky*v)),cos(2pi*(kx*u+ky*v))"


def validate_artifact(value):
    if value.get("schema") != SCHEMA or value.get("model_type") != MODEL_TYPE:
        raise ValueError("unsupported directional appearance model")
    architecture = value["architecture"]
    config = DetailConfig(device="cpu", precision="float32", latent_dim=architecture["latent_dim"],
        hidden_width=architecture["hidden_width"], fourier_vectors=tuple(tuple(v) for v in architecture["fourier_vectors"]))
    labels = architecture["condition_labels"]
    if (not isinstance(labels, list) or not 1 <= len(labels) <= 64 or len(set(labels)) != len(labels)
            or any(not isinstance(label, str) or not label for label in labels)):
        raise ValueError("invalid condition labels")
    if any(len(architecture[key]) != len(labels) or any(not isinstance(v, str) or not v for v in architecture[key])
           for key in ("condition_regions", "condition_species")):
        raise ValueError("invalid condition mapping")
    if (architecture.get("hidden_layers") != 3 or architecture.get("activation") != "silu"
            or architecture.get("output_activation") != "sigmoid"
            or architecture.get("input_order") != "latent,condition_one_hot,uv_fourier"
            or architecture.get("fourier_order") != FOURIER_ORDER):
        raise ValueError("unsupported decoder operations")
    weights = value["weights"]
    if weights.get("encoding") != "base64-f32le" or type(weights["byte_length"]) is not int or not 0 < weights["byte_length"] <= 16_000_000:
        raise ValueError("unsupported weight encoding/bound")
    raw = base64.b64decode(weights["data_base64"], validate=True)
    if len(raw) != weights["byte_length"] or hashlib.sha256(raw).hexdigest() != weights["sha256"]:
        raise ValueError("decoder weight integrity failure")
    widths = [config.latent_dim + len(labels) + 2 * len(config.fourier_vectors),
              config.hidden_width, config.hidden_width, config.hidden_width, 3]
    specs = weights["tensors"]
    if len(specs) != 8:
        raise ValueError("exactly eight dense tensors are required")
    offset, layers = 0, []
    for index, (inputs, outputs) in enumerate(zip(widths, widths[1:])):
        arrays = []
        for suffix, shape in (("weight", [outputs, inputs]), ("bias", [outputs])):
            spec = specs[2 * index + int(suffix == "bias")]
            length = math.prod(shape) * 4
            if spec != {"name": f"layers.{index}.{suffix}", "shape": shape,
                        "offset_bytes": offset, "length_bytes": length}:
                raise ValueError("tensor order/shape/offset mismatch")
            array = np.frombuffer(raw, dtype="<f4", count=math.prod(shape), offset=offset).reshape(shape)
            if not np.isfinite(array).all():
                raise ValueError("nonfinite weights")
            arrays.append(array)
            offset += length
        layers.append(tuple(arrays))
    if offset != len(raw):
        raise ValueError("unreferenced decoder bytes")
    return architecture, layers


def decode_numpy(value, latent, condition_index, uv, *, validated=None):
    architecture, layers = validated or validate_artifact(value)
    latent, uv = np.asarray(latent, dtype=np.float32), np.asarray(uv, dtype=np.float32)
    count = len(architecture["condition_labels"])
    if (latent.shape != (architecture["latent_dim"],) or uv.ndim != 2 or uv.shape[1] != 2
            or not np.isfinite(latent).all() or not np.isfinite(uv).all()
            or type(condition_index) is not int or not 0 <= condition_index < count):
        raise ValueError("invalid latent/condition/UV")
    features = []
    for kx, ky in architecture["fourier_vectors"]:
        angle = (np.float32(kx) * uv[:, 0] + np.float32(ky) * uv[:, 1]) * np.float32(2 * math.pi)
        features.extend((np.sin(angle), np.cos(angle)))
    one_hot = np.zeros(count, dtype=np.float32)
    one_hot[condition_index] = 1
    prefix = np.concatenate((latent, one_hot))
    result = np.concatenate((np.broadcast_to(prefix, (len(uv), len(prefix))), np.stack(features, -1)), -1)
    for index, (weight, bias) in enumerate(layers):
        result = result @ weight.T + bias
        sigmoid = 1 / (1 + np.exp(-np.clip(result, -80, 80)))
        result = sigmoid if index == len(layers) - 1 else result * sigmoid
    if not np.isfinite(result).all():
        raise ValueError("nonfinite inference output")
    return result.astype(np.float32)


def export_decoder(checkpoint: Path, output: Path):
    import torch

    from viscera_core.tissue_learning.checkpoint import digest, load_checkpoint

    from .model import DetailVAE

    state, request = load_checkpoint(checkpoint)
    if request.get("schema") != "viscera.tissue-detail-training-request/v1" or state["step"] <= 0:
        raise ValueError("a trained detail checkpoint is required")
    config = DetailConfig.from_dict(request["config"])
    labels = request["data"]["conditions"]
    model = DetailVAE(config, len(labels)).eval()
    model.load_state_dict(state["model"], strict=True)
    raw, tensors = bytearray(), []
    for name, tensor in model.decoder.state_dict().items():
        array = tensor.detach().cpu().numpy().astype("<f4")
        if not np.isfinite(array).all():
            raise ValueError("nonfinite trained decoder")
        data = array.tobytes(order="C")
        tensors.append({"name": name, "shape": list(array.shape), "offset_bytes": len(raw), "length_bytes": len(data)})
        raw.extend(data)
    latent = seed_latent(2**64 - 1, config.latent_dim)
    uv = np.array([[0, 0], [.1234, .9876], [.25, .75], [.5, .5], [1, 1]], dtype=np.float32)
    condition_index = len(labels) - 1
    condition = torch.zeros(1, len(labels))
    condition[0, condition_index] = 1
    with torch.no_grad():
        reference = model.decoder(torch.from_numpy(latent[None]), condition, torch.from_numpy(uv[None])).numpy()[0]
    value = {"schema": SCHEMA, "model_type": MODEL_TYPE,
        "architecture": {"latent_dim": config.latent_dim, "hidden_width": config.hidden_width,
            "hidden_layers": 3, "fourier_vectors": [list(v) for v in config.fourier_vectors],
            "condition_labels": labels, "condition_regions": request["condition_regions"],
            "condition_species": request["condition_species"], "input_order": "latent,condition_one_hot,uv_fourier",
            "activation": "silu", "output_activation": "sigmoid", "fourier_order": FOURIER_ORDER,
            "uv": "u right, v down; periodic unit square; bake at pixel centers"},
        "weights": {"encoding": "base64-f32le", "sha256": hashlib.sha256(raw).hexdigest(),
            "byte_length": len(raw), "data_base64": base64.b64encode(raw).decode(), "tensors": tensors},
        "output": {"kind": "observed_rgb_appearance", "color_space": "srgb", "channels": ["r", "g", "b"],
            "binding": "fixed-rest-uv", "pbr_ground_truth": False, "clinically_validated": False},
        "provenance": {"training_steps": state["step"],
            "training_status": "fixture_trained" if config.fixture else "research_trained",
            "qualification": "engineering_unqualified", "training_native_patch_size": 128,
            "training_source_crop_size": 128, "dataset_manifest_sha256": request["data"]["manifest_sha256"],
            "split_manifest_sha256": request["data"]["split_sha256"], "config_sha256": request["config_sha256"],
            "source_sha256": request["source_sha256"], "checkpoint_manifest_sha256": digest(Path(checkpoint) / "manifest.json"),
            "environment": request["environment"], "dataset_summary": request["data"],
            "validation": state["validation"], "training_objectives": request["objectives"],
            "critic_exported": False, "licence_note": "source permissions still govern use; no additional rights granted"},
        "seed_algorithm": "sha256-box-muller-f32-v1",
        "seed_reference": {"seed": str(2**64 - 1), "latent": latent.tolist()},
        "reference": {"latent": latent.tolist(), "condition_index": condition_index, "uv": uv.tolist(), "rgb": reference.tolist()}}
    result = decode_numpy(value, latent, condition_index, uv)
    error = float(np.max(np.abs(result - reference)))
    if error > 2e-5:
        raise ValueError(f"directional decoder parity failure: {error}")
    value["export_validation"] = {"numpy_vs_torch_max_absolute_error": error, "tolerance": 2e-5,
                                  "gpu_execution_claim": False}
    payload = json.dumps(value, indent=2, allow_nan=False).encode() + b"\n"
    if len(payload) > 20_000_000:
        raise ValueError("export exceeds 20MB bound")
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("xb") as stream:
        stream.write(payload)
    return {"path": str(output), "sha256": hashlib.sha256(payload).hexdigest(), "bytes": len(payload),
            "training_steps": state["step"], "qualification": "engineering_unqualified"}


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
    if not np.allclose(decode_numpy(value, ref["latent"], ref["condition_index"], ref["uv"]),
                       ref["rgb"], atol=2e-5, rtol=0):
        raise ValueError("decoder reference mismatch")
    return value


def bake_artifact(path, output, *, seed, condition_index, resolution=256, chunk_pixels=16384, device="cpu"):
    if type(resolution) is not int or not 16 <= resolution <= 8192 or type(chunk_pixels) is not int or not 1 <= chunk_pixels <= 262144:
        raise ValueError("invalid bounded bake resolution/chunk")
    path, output = Path(path), Path(output)
    if output.exists():
        raise FileExistsError("bake output exists")
    value = load_artifact(path)
    validated = validate_artifact(value)
    architecture = value["architecture"]
    latent = seed_latent(seed, architecture["latent_dim"])
    if type(condition_index) is not int or not 0 <= condition_index < len(architecture["condition_labels"]):
        raise ValueError("invalid condition")
    decoder = None
    if device == "cuda":
        import torch

        from .model import DirectionalDecoder

        if not torch.cuda.is_available():
            raise ValueError("CUDA unavailable")
        config = DetailConfig(latent_dim=architecture["latent_dim"], hidden_width=architecture["hidden_width"],
                              fourier_vectors=tuple(tuple(v) for v in architecture["fourier_vectors"]))
        decoder = DirectionalDecoder(config, len(architecture["condition_labels"])).cuda().eval()
        decoder.load_state_dict({spec["name"]: torch.from_numpy(array.copy())
            for pair_index, pair in enumerate(validated[1]) for spec, array in
            zip(value["weights"]["tensors"][pair_index * 2:pair_index * 2 + 2], pair)}, strict=True)
        z = torch.from_numpy(latent[None]).cuda()
        c = torch.zeros(1, len(architecture["condition_labels"]), device="cuda")
        c[0, condition_index] = 1
        torch.cuda.synchronize()
    elif device != "cpu":
        raise ValueError("unsupported bake device")
    started = time.perf_counter()
    pixels = np.empty((resolution * resolution, 3), dtype=np.uint8)
    for offset in range(0, len(pixels), chunk_pixels):
        indices = np.arange(offset, min(offset + chunk_pixels, len(pixels)))
        uv = np.stack(((indices % resolution + .5) / resolution, (indices // resolution + .5) / resolution), -1).astype(np.float32)
        if decoder is None:
            rgb = decode_numpy(value, latent, condition_index, uv, validated=validated)
        else:
            with torch.no_grad():
                rgb = decoder(z, c, torch.from_numpy(uv[None]).cuda()).cpu().numpy()[0]
        pixels[offset:offset + len(indices)] = np.rint(np.clip(rgb, 0, 1) * 255).astype(np.uint8)
    if decoder is not None:
        torch.cuda.synchronize()
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("xb") as stream:
        Image.fromarray(pixels.reshape(resolution, resolution, 3)).save(stream, format="PNG")
    return {"path": str(output), "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "model_sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "resolution": [resolution, resolution],
        "training_native_patch_size": 128, "seed": str(seed), "condition_index": condition_index,
        "wall_seconds": time.perf_counter() - started, "device": device,
        "qualification": "engineering_unqualified", "detail_claim": "output sampling is not independently learned 4K detail"}
