#!/usr/bin/env python3
"""Compare actual Torch, NumPy and Studio decoder textures without a browser.

Run from any directory with the project Python environment. Output must not exist.
The default scope requires the six human DSAD exterior conditions and an expected
model SHA256 from the download receipt. Retained-pilot proof is a separate scope.
No training, held-out evaluation, browser rendering or photorealism is established.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import subprocess
import sys
import time
import traceback
from pathlib import Path

# Local source imports and CPU limits must be established before NumPy/Torch.
# ruff: noqa: E402

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "py"))
# Bound CPU contention; this is a correctness check, not a throughput benchmark.
for _name in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ[_name] = "1"

import numpy as np
import torch
from PIL import Image
from viscera_core.tissue_learning.artifact import (
    decode_numpy,
    load_artifact,
    seed_latent,
    validate_artifact,
)
from viscera_core.tissue_learning.config import ExperimentConfig
from viscera_core.tissue_learning.model import PeriodicDecoder

RESOLUTION = 256
BYTE_TOLERANCE = 1
SEEDS = ("42", "43", "18446744073709551615", "42")
EXPECTED_CONDITIONS = {
    (f"human:laparoscopic_exterior:{label}", region, "human")
    for label, region in (("colon", "large_bowel"), ("liver", "liver"),
                          ("pancreas", "pancreas"), ("small_intestine", "small_bowel"),
                          ("spleen", "spleen"), ("stomach", "stomach"))
}


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def byte_metrics(left: np.ndarray, right: np.ndarray) -> dict:
    if left.shape != right.shape or left.dtype != np.uint8 or right.dtype != np.uint8:
        raise ValueError("byte comparison requires equal uint8 arrays")
    difference = np.abs(left.astype(np.int16) - right.astype(np.int16))
    maximum = int(difference.max())
    return {"maximum_absolute_error_bytes": maximum,
            "mean_absolute_error_bytes": float(difference.mean()),
            "different_channels": int(np.count_nonzero(difference)),
            "compared_channels": int(difference.size),
            "tolerance_bytes": BYTE_TOLERANCE, "passed": maximum <= BYTE_TOLERANCE}


def comparison_self_test() -> dict:
    value = np.array([0, 127, 255], dtype=np.uint8)
    if not byte_metrics(value, value)["passed"]:
        raise RuntimeError("identical-byte self-test failed")
    if not byte_metrics(value, np.array([1, 128, 254], dtype=np.uint8))["passed"]:
        raise RuntimeError("inclusive one-byte tolerance self-test failed")
    if byte_metrics(value, np.array([2, 127, 255], dtype=np.uint8))["passed"]:
        raise RuntimeError("two-byte rejection self-test failed")
    if byte_metrics(np.array([0], dtype=np.uint8), np.array([255], dtype=np.uint8))["maximum_absolute_error_bytes"] != 255:
        raise RuntimeError("unsigned subtraction self-test failed")
    try:
        byte_metrics(value, value[:2])
    except ValueError:
        pass
    else:
        raise RuntimeError("shape mismatch self-test failed")
    return {"passed": True, "cases": 5, "checks": ["exact", "one-byte-inclusive", "two-byte-rejected", "no-uint8-wrap", "shape-rejected"]}


def construct_torch(value: dict, architecture: dict, layers: list) -> torch.nn.Module:
    if value["schema"] == "viscera.tissue-appearance-decoder/v3":
        from viscera_core.tissue_learning_conv.config import ConvConfig
        from viscera_core.tissue_learning_conv.model import SpatialDecoder
        config = ConvConfig(device="cpu", precision="float32",
                            latent_channels=architecture["latent_shape"][0],
                            latent_resolution=architecture["latent_shape"][1],
                            decoder_channels=tuple(architecture["decoder_channels"]))
        model = SpatialDecoder(config, len(architecture["condition_labels"])).cpu().eval()
    elif value["schema"] == "viscera.tissue-appearance-decoder/v2":
        from viscera_core.tissue_learning_detail.config import DetailConfig
        from viscera_core.tissue_learning_detail.model import DirectionalDecoder
        config = DetailConfig(device="cpu", precision="float32", latent_dim=architecture["latent_dim"],
                              hidden_width=architecture["hidden_width"],
                              fourier_vectors=tuple(tuple(v) for v in architecture["fourier_vectors"]))
        model = DirectionalDecoder(config, len(architecture["condition_labels"])).cpu().eval()
    else:
        config = ExperimentConfig(patch_size=512, latent_dim=architecture["latent_dim"],
                                  hidden_width=architecture["hidden_width"],
                                  frequencies=tuple(architecture["frequencies"]))
        model = PeriodicDecoder(config, len(architecture["condition_labels"])).cpu().eval()
    model.load_state_dict({
        spec["name"]: torch.from_numpy(array.copy())
        for pair_index, pair in enumerate(layers)
        for spec, array in zip(value["weights"]["tensors"][pair_index * 2:pair_index * 2 + 2], pair)
    }, strict=True)
    return model


def sample_periodic_torch(native: torch.Tensor, uv: torch.Tensor) -> torch.Tensor:
    """Independent Torch implementation of wrapped pixel-center bilinear sampling.

    Native is HWC. Explicit indexing avoids sharing the NumPy sampling code and
    avoids edge-clamping behavior from an ordinary image-resize operation.
    """
    if native.ndim != 3 or native.shape[2] != 3 or uv.ndim != 2 or uv.shape[1] != 2:
        raise ValueError("expected native HWC RGB and N2 texture coordinates")
    height, width = native.shape[:2]
    xy = torch.remainder(uv, 1) * uv.new_tensor((width, height)) - 0.5
    lower = torch.floor(xy).to(torch.int64)
    fraction = xy - lower.to(xy.dtype)
    x0, y0 = lower[:, 0] % width, lower[:, 1] % height
    x1, y1 = (x0 + 1) % width, (y0 + 1) % height
    fx, fy = fraction[:, :1], fraction[:, 1:]
    top = native[y0, x0] * (1 - fx) + native[y0, x1] * fx
    bottom = native[y1, x0] * (1 - fx) + native[y1, x1] * fx
    return top * (1 - fy) + bottom * fy


def torch_reference(value: dict, decoder: torch.nn.Module) -> np.ndarray:
    reference = value["reference"]
    condition = torch.zeros((1, len(value["architecture"]["condition_labels"])))
    condition[0, reference["condition_index"]] = 1
    latent = torch.tensor([reference["latent"]], dtype=torch.float32)
    with torch.inference_mode():
        if value["schema"] == "viscera.tissue-appearance-decoder/v3":
            native = decoder(latent, condition)[0].permute(1, 2, 0)
            pixels = torch.tensor(reference["pixels_xy"], dtype=torch.int64)
            return native[pixels[:, 1], pixels[:, 0]].numpy()
        return decoder(latent, condition,
                       torch.tensor([reference["uv"]], dtype=torch.float32)).numpy()[0]


def textures(value: dict, validated: tuple, decoder: torch.nn.Module, latent: np.ndarray,
             condition_index: int) -> tuple[np.ndarray, np.ndarray]:
    numpy_decode = decode_numpy
    if value["schema"] == "viscera.tissue-appearance-decoder/v2":
        from viscera_core.tissue_learning_detail.artifact import decode_numpy as numpy_decode
    numpy_rgb = np.empty((RESOLUTION * RESOLUTION, 3), dtype=np.float32)
    torch_rgb = np.empty_like(numpy_rgb)
    condition = torch.zeros((1, len(validated[0]["condition_labels"])), dtype=torch.float32)
    condition[0, condition_index] = 1
    z = torch.from_numpy(latent[None])
    with torch.inference_mode():
        if value["schema"] == "viscera.tissue-appearance-decoder/v3":
            from viscera_core.tissue_learning_conv.artifact import (
                decode_native_numpy,
                sample_periodic_numpy,
            )
            # Infer each native128 image once; the 256 output is explicitly
            # sampled from that image, not independently inferred detail.
            native_numpy = decode_native_numpy(value, latent, condition_index, validated=validated)
            native_torch = decoder(z, condition)[0].permute(1, 2, 0)
            if native_numpy.shape != (128, 128, 3) or native_torch.shape != (128, 128, 3):
                raise ValueError("v3 decoder must produce native128 RGB")
        for offset in range(0, len(numpy_rgb), 4096):
            indices = np.arange(offset, min(offset + 4096, len(numpy_rgb)))
            uv = np.stack(((indices % RESOLUTION + .5) / RESOLUTION,
                           (indices // RESOLUTION + .5) / RESOLUTION), axis=1).astype(np.float32)
            if value["schema"] == "viscera.tissue-appearance-decoder/v3":
                numpy_rgb[offset:offset + len(indices)] = sample_periodic_numpy(native_numpy, uv)
                torch_rgb[offset:offset + len(indices)] = sample_periodic_torch(native_torch, torch.from_numpy(uv)).numpy()
            else:
                numpy_rgb[offset:offset + len(indices)] = numpy_decode(value, latent, condition_index, uv, validated=validated)
                torch_rgb[offset:offset + len(indices)] = decoder(z, condition, torch.from_numpy(uv[None])).numpy()[0]
    for rgb in (numpy_rgb, torch_rgb):
        if not np.isfinite(rgb).all() or rgb.min() < 0 or rgb.max() > 1:
            raise ValueError("nonfinite or out-of-range full texture")
    return numpy_rgb, torch_rgb


def save_rgb(path: Path, rgb: np.ndarray) -> np.ndarray:
    # Match the existing Python artifact bake; TS uses Math.round. A boundary
    # rounding difference may be one byte, never a larger implicit tolerance.
    pixels = np.rint(np.clip(rgb, 0, 1) * 255).astype(np.uint8)
    Image.fromarray(pixels.reshape(RESOLUTION, RESOLUTION, 3)).save(path)
    return pixels


def run_node(model: Path, output: Path, seed: str | None) -> dict:
    command = ["node", str(ROOT / "scripts/check_tissue_decoder.mjs"), str(model), str(output), str(RESOLUTION)]
    if seed is not None:
        command.append(seed)
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=1200, check=False)
    log = output.parent / (output.name + ".log")
    log.write_text(result.stdout[-100_000:] + "\nSTDERR\n" + result.stderr[-20_000:])
    if result.returncode != 0:
        raise RuntimeError(f"Studio Node decoder exited {result.returncode}; see {log}")
    return json.loads((output / "receipt.json").read_text())


def invalid_seed_checks(model: Path, output: Path) -> list[dict]:
    checks = []
    for index, seed in enumerate(("-1", "01", "1.5", "18446744073709551616")):
        destination = output / f"must-not-exist-invalid-seed-{index}"
        command = ["node", str(ROOT / "scripts/check_tissue_decoder.mjs"), str(model), str(destination), "256", seed]
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=60, check=False)
        passed = (result.returncode != 0 and not destination.exists()
                  and "seed must be an unsigned 64-bit decimal integer" in result.stderr)
        check = {"seed": seed, "returncode": result.returncode,
                 "output_created": destination.exists(), "passed": passed}
        checks.append(check)
        if not passed:
            raise RuntimeError(f"invalid seed was not rejected before output creation: {seed}")
    return checks


def validate(args: argparse.Namespace, receipt: dict) -> None:
    model_path, output = args.model.resolve(), args.output.resolve()
    model_sha = digest(model_path)
    receipt["model"] = {"path": str(model_path), "sha256": model_sha, "bytes": model_path.stat().st_size}
    if args.expected_model_sha256 and model_sha != args.expected_model_sha256:
        raise ValueError("model file does not match the expected downloaded SHA256")
    schema = json.loads(model_path.read_text())["schema"]
    if schema == "viscera.tissue-appearance-decoder/v3":
        from viscera_core.tissue_learning_conv.artifact import load_artifact as load_conv
        from viscera_core.tissue_learning_conv.artifact import validate_artifact as validate_conv
        value = load_conv(model_path)
        validated = validate_conv(value)
    elif schema == "viscera.tissue-appearance-decoder/v2":
        from viscera_core.tissue_learning_detail.artifact import load_artifact as load_detail
        from viscera_core.tissue_learning_detail.artifact import (
            validate_artifact as validate_detail,
        )
        value = load_detail(model_path)
        validated = validate_detail(value)
    else:
        value = load_artifact(model_path)
        validated = validate_artifact(value)
    receipt["artifact_schema"] = schema
    architecture, layers = validated
    conditions = list(zip(architecture["condition_labels"], architecture["condition_regions"], architecture["condition_species"]))
    receipt["conditions"] = [{"index": index, "label": label, "region": region, "species": species}
                             for index, (label, region, species) in enumerate(conditions)]
    receipt["provenance"] = value["provenance"]
    receipt["weights_sha256"] = value["weights"]["sha256"]
    required_status = "fixture_trained" if args.scope == "directional-fixture-proof" else "research_trained"
    if args.scope == "directional-fixture-proof" and schema != "viscera.tissue-appearance-decoder/v2":
        raise ValueError("directional fixture proof requires a v2 artifact")
    if value["provenance"].get("training_status") != required_status or value["provenance"].get("training_steps", 0) <= 0:
        raise ValueError("requires an actually trained research artifact, not an initialized fixture")
    if args.scope == "incoming-six-condition" and (len(conditions) != 6 or set(conditions) != EXPECTED_CONDITIONS):
        raise ValueError("incoming artifact must map exactly the six human DSAD exterior conditions")
    if args.expected_training_steps is not None and value["provenance"]["training_steps"] != args.expected_training_steps:
        raise ValueError("trained update count differs from expected receipt")
    torch.set_num_threads(1)
    torch.use_deterministic_algorithms(True)
    decoder = construct_torch(value, architecture, layers)
    receipt["claims"]["torch_forward"] = f"Existing {type(decoder).__name__} with validated artifact tensors; no checkpoint file was loaded."
    reference = value["reference"]
    reference_actual = torch_reference(value, decoder)
    reference_error = float(np.max(np.abs(reference_actual - np.asarray(reference["rgb"], dtype=np.float32))))
    if reference_error > 2e-5:
        raise ValueError("actual Torch forward differs from exported training-time reference")
    receipt["exported_reference"] = {"numpy_parser_passed": True, "torch_max_absolute_error": reference_error,
                                     "torch_float_tolerance": 2e-5, "seed": value["seed_reference"]["seed"]}
    if schema == "viscera.tissue-appearance-decoder/v3":
        receipt["sampling"] = {"native_resolution": [128, 128], "output_resolution": [RESOLUTION, RESOLUTION],
                               "method": "periodic-bilinear-pixel-centers", "native_inference_per_seed_condition": 1,
                               "independent_torch_sampler": True, "independent_high_resolution_detail": False,
                               "reference_coordinate_kind": "native_pixels_xy"}
    receipt["invalid_seed_checks"] = invalid_seed_checks(model_path, output)
    first, diversity = {}, {}
    receipt["samples"], receipt["node_runs"] = [], []
    for run_index, seed in enumerate(SEEDS):
        run_dir = output / f"run-{run_index + 1}-seed-{seed}"
        node_receipt = run_node(model_path, run_dir, None if run_index == 0 else seed)
        if (node_receipt["seed"] != seed or node_receipt["resolution"] != RESOLUTION
                or node_receipt["modelId"] != model_sha or len(node_receipt["samples"]) != len(conditions)):
            raise ValueError("Studio receipt model/seed/resolution/condition count mismatch")
        latent = seed_latent(seed, architecture["latent_dim"])
        latent_error = float(np.max(np.abs(latent - np.asarray(node_receipt["latent"], dtype=np.float32))))
        if latent_error > 1e-6:
            raise ValueError("Studio/Python latent mismatch")
        receipt["node_runs"].append({"directory": run_dir.name, "seed": seed, "latent_max_absolute_error": latent_error,
                                     "receipt_sha256": digest(run_dir / "receipt.json"), "runtime": node_receipt["runtime"]})
        for index, node_sample in enumerate(node_receipt["samples"]):
            if node_sample["condition"] != index or node_sample["label"] != conditions[index][0]:
                raise ValueError("Studio condition order mismatch")
            filename = f"condition-{index}-seed{seed}-{RESOLUTION}.rgba"
            if node_sample["file"] != filename:
                raise ValueError("unexpected Studio sample path")
            raw = run_dir / filename
            if digest(raw) != node_sample["sha256"] or raw.stat().st_size != RESOLUTION * RESOLUTION * 4:
                raise ValueError("Studio sample bytes/hash mismatch")
            rgba = np.fromfile(raw, dtype=np.uint8).reshape(-1, 4)
            if not np.all(rgba[:, 3] == 255):
                raise ValueError("Studio alpha must remain opaque")
            numpy_rgb, torch_rgb = textures(value, validated, decoder, latent, index)
            numpy_path, torch_path = run_dir / f"condition-{index}-numpy.png", run_dir / f"condition-{index}-torch.png"
            numpy_pixels, torch_pixels = save_rgb(numpy_path, numpy_rgb), save_rgb(torch_path, torch_rgb)
            ts_pixels = rgba[:, :3].copy()
            Image.fromarray(ts_pixels.reshape(RESOLUTION, RESOLUTION, 3)).save(run_dir / f"condition-{index}-studio.png")
            metrics = {"torch_vs_numpy": byte_metrics(torch_pixels, numpy_pixels),
                       "studio_vs_numpy": byte_metrics(ts_pixels, numpy_pixels),
                       "studio_vs_torch": byte_metrics(ts_pixels, torch_pixels)}
            if run_index == 0:
                first[index] = (numpy_rgb.copy(), torch_rgb.copy(), ts_pixels.copy())
                diversity[index] = numpy_pixels.copy()
            replay = None
            if run_index == len(SEEDS) - 1:
                replay = {name: bool(np.array_equal(actual, previous)) for name, actual, previous in
                          zip(("numpy_float32", "torch_float32", "studio_rgb8"),
                              (numpy_rgb, torch_rgb, ts_pixels), first[index])}
            sample = {"run": run_index + 1, "seed": seed, "condition": index, "label": conditions[index][0],
                      "metrics": metrics, "numpy_vs_torch_float_max_absolute_error": float(np.max(np.abs(numpy_rgb - torch_rgb))),
                      "studio_rgba_sha256": digest(raw), "numpy_png_sha256": digest(numpy_path),
                      "torch_png_sha256": digest(torch_path), "deterministic_replay": replay}
            if run_index == 1:
                sample["seed42_vs43_diagnostic"] = byte_metrics(numpy_pixels, diversity[index])
                sample["seed42_vs43_diagnostic"]["passed"] = None
            receipt["samples"].append(sample)
            if not all(metric["passed"] for metric in metrics.values()) or (replay is not None and not all(replay.values())):
                raise ValueError(f"texture parity/replay failed at seed {seed}, condition {index}")
        print(f"Completed seed {seed}, run {run_index + 1}/4, {len(conditions)} full 256x256 textures", flush=True)
    if digest(model_path) != model_sha:
        raise ValueError("model changed during validation")
    receipt["summary"] = {"conditions": len(conditions), "unique_seeds": 3, "replay_seed": "42",
                          "full_texture_samples": len(receipt["samples"]),
                          "pairwise_full_texture_comparisons": len(receipt["samples"]) * 3,
                          "maximum_absolute_error_bytes": max(metric["maximum_absolute_error_bytes"]
                              for sample in receipt["samples"] for metric in sample["metrics"].values()),
                          "all_replays_exact": True}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--scope", choices=("incoming-six-condition", "retained-pilot-proof", "directional-fixture-proof"), default="incoming-six-condition")
    parser.add_argument("--expected-model-sha256")
    parser.add_argument("--expected-training-steps", type=int)
    args = parser.parse_args()
    if args.expected_model_sha256 and not re.fullmatch(r"[0-9a-f]{64}", args.expected_model_sha256):
        parser.error("expected model SHA256 must be 64 lowercase hexadecimal digits")
    if args.scope == "incoming-six-condition" and not args.expected_model_sha256:
        parser.error("incoming validation requires --expected-model-sha256 from the download receipt")
    args.output.mkdir(parents=True, exist_ok=False)
    source_paths = [Path(__file__).resolve(), ROOT / "scripts/check_tissue_decoder.mjs",
                    ROOT / "apps/studio/src/tissues/neuralAppearance.ts",
                    ROOT / "apps/studio/src/tissues/neuralAppearanceConv.ts",
                    *[ROOT / "py/viscera_core/tissue_learning" / name for name in ("artifact.py", "model.py", "config.py")]]
    schema = json.loads(args.model.read_text()).get("schema")
    if schema in ("viscera.tissue-appearance-decoder/v2", "viscera.tissue-appearance-decoder/v3"):
        source_paths.extend(ROOT / "py/viscera_core/tissue_learning_detail" / name for name in ("artifact.py", "model.py", "config.py"))
    if schema == "viscera.tissue-appearance-decoder/v3":
        source_paths.extend(ROOT / "py/viscera_core/tissue_learning_conv" / name for name in ("artifact.py", "model.py", "config.py"))
    hashes = {str(path.relative_to(ROOT)): digest(path) for path in source_paths}
    start = time.perf_counter()
    receipt = {"schema": "viscera.tissue-full-decoder-parity/v1", "status": "running", "scope": args.scope,
               "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "model": str(args.model.resolve()), "source_sha256": hashes,
               "resolution": RESOLUTION, "seeds_in_order": list(SEEDS), "byte_tolerance": BYTE_TOLERANCE,
               "runtime": {"python": platform.python_version(), "numpy": np.__version__, "torch": torch.__version__,
                           "device": "cpu", "torch_threads": 1, "deterministic_algorithms": True},
               "claims": {"incoming_numerical_parity_validated": False, "browser_executed": False, "gpu_executed": False,
                          "photorealism_validated": False, "clinical_validation": False,
                          "torch_forward": "Existing PeriodicDecoder with validated artifact tensors; no checkpoint file was loaded.",
                          "scope_note": ("Trained synthetic v2 fixture proves decoder engineering only; it is not the next real-data model."
                              if args.scope == "directional-fixture-proof" else "Retained pilot proves this harness only; it is not the incoming model."
                              if args.scope == "retained-pilot-proof" else "Numerical decoder parity only; browser integration and visual acceptance are separate.")}}
    status = 1
    try:
        receipt["comparison_self_test"] = comparison_self_test()
        validate(args, receipt)
        if any(digest(ROOT / name) != expected for name, expected in hashes.items()):
            raise ValueError("validation source changed during this run")
        receipt["status"] = "passed"
        receipt["claims"]["incoming_numerical_parity_validated"] = args.scope == "incoming-six-condition"
        status = 0
    except Exception as error:
        receipt["status"] = "failed"
        receipt["failure"] = {"type": type(error).__name__, "message": str(error)}
        (args.output / "failure.log").write_text(traceback.format_exc())
    except KeyboardInterrupt:
        receipt["status"] = "interrupted"
        receipt["failure"] = {"type": "KeyboardInterrupt", "message": "Validation interrupted; no successful parity claim."}
        status = 130
    finally:
        receipt["elapsed_seconds"] = time.perf_counter() - start
        receipt["finished_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        (args.output / "receipt.json").write_text(json.dumps(receipt, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"status": receipt["status"], "scope": args.scope, "receipt": str(args.output / "receipt.json"),
                      "summary": receipt.get("summary"), "failure": receipt.get("failure")}, indent=2))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
