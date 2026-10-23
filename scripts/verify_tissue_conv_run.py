#!/usr/bin/env python3
"""Verify a downloaded candidate archive without executing uploaded model code.

Hashes must come from the trusted Colab receipt. Raw training/test images are not
part of this handoff; their declared hashes are checked, not claimed re-read.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "py"))
sys.path.insert(0, str(ROOT / "scripts"))
from verify_tissue_completed_run import (  # noqa: E402
    CONDITIONS,
    RELEASE_SHA,
    canonical,
    checked_sha,
    completion,
    file_sha,
    no_symlinks,
    require,
    safe_name,
    sha,
    strict_json,
)

LIMIT = 129 * 1024**2
INVENTORY = "download-inventory.json"


@dataclass(frozen=True)
class Expectations:
    steps: int = 6000
    batch_size: int = 16
    native_release_sha256: str = "26f0dd07b29375249239016e3281c399e3c89fed4c16354a9011f6440a288565"
    baseline_bundle_sha256: str = "ef15a31f9b812ed7445187e3def49f07ed7396a7ead0134d787c6435cd923163"
    source_release_sha256: str = RELEASE_SHA
    source_counts: tuple[int, int, int] = (4443, 1048, 1868)
    conditions: tuple[tuple[str, str, str], ...] = CONDITIONS
    fixture: bool = False
    device: str = "cuda"
    minimum_validation_groups: int = 3
    snapshot_steps: tuple[int, ...] = (1000, 3000, 6000)
    probe_updates: int = 300


def record(raw):
    return {"bytes": len(raw), "sha256": sha(raw)}


def read_archive(path, expected_sha256):
    checked_sha(expected_sha256)
    no_symlinks(path)
    require(path.is_file() and path.stat().st_size <= LIMIT, "archive file/size invalid")
    with path.open("rb") as stream:
        require(
            hashlib.file_digest(stream, "sha256").hexdigest() == expected_sha256,
            "trusted archive SHA256 mismatch",
        )
        stream.seek(0)
        with zipfile.ZipFile(stream) as archive:
            infos = archive.infolist()
            require(1 < len(infos) <= 128, "archive member count invalid")
            names = set()
            for info in infos:
                safe_name(info.orig_filename)
                require(
                    info.orig_filename == info.filename and info.filename not in names,
                    "duplicate/truncated ZIP member",
                )
                names.add(info.filename)
                require(
                    not info.is_dir()
                    and stat.S_IFMT(info.external_attr >> 16) in (0, stat.S_IFREG),
                    "nonregular/symlink ZIP member",
                )
                require(
                    not info.flag_bits & 1
                    and info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
                    "unsupported ZIP encoding",
                )
                require(0 <= info.file_size <= LIMIT, "oversized ZIP member")
            require(sum(i.file_size for i in infos) <= LIMIT, "expanded archive exceeds bound")
            require(
                INVENTORY in names and archive.getinfo(INVENTORY).file_size <= 1024**2,
                "missing/oversized inventory",
            )
            inventory_raw = archive.read(INVENTORY)
            inventory = strict_json(inventory_raw)
            require(
                isinstance(inventory, dict) and set(inventory) == names - {INVENTORY},
                "inventory is not exact",
            )
            payloads = {INVENTORY: inventory_raw}
            for name, declared in inventory.items():
                require(
                    isinstance(declared, dict) and set(declared) == {"bytes", "sha256"},
                    "invalid inventory declaration",
                )
                checked_sha(declared["sha256"])
                require(
                    type(declared["bytes"]) is int
                    and declared["bytes"] == archive.getinfo(name).file_size,
                    "inventory size mismatch",
                )
                raw = archive.read(name)
                require(record(raw) == declared, "inventory hash mismatch: " + name)
                payloads[name] = raw
        stream.seek(0)
        require(
            hashlib.file_digest(stream, "sha256").hexdigest() == expected_sha256,
            "archive changed during verification",
        )
    return payloads


def source_inventory(path, expected_sha256, baseline, expected_baseline_sha256):
    no_symlinks(path)
    require(file_sha(path) == checked_sha(expected_sha256), "trusted source bundle SHA256 mismatch")
    with zipfile.ZipFile(path) as archive:
        manifest = strict_json(archive.read("bundle-manifest.json"))
        names = archive.namelist()
        require(
            len(names) == len(set(names))
            and set(names) == set(manifest["files"]) | {"bundle-manifest.json"},
            "source bundle inventory mismatch",
        )
        for name, declared in manifest["files"].items():
            safe_name(name)
            require(record(archive.read(name)) == declared, "source bundle member mismatch")
    no_symlinks(baseline)
    require(
        file_sha(baseline) == checked_sha(expected_baseline_sha256),
        "trusted frozen v2 baseline SHA256 mismatch",
    )
    require(
        manifest.get("baseline_bundle_sha256") == expected_baseline_sha256,
        "v3 source bundle does not declare its exact frozen v2 ancestor",
    )
    with zipfile.ZipFile(baseline) as archive:
        prior = strict_json(archive.read("bundle-manifest.json"))
        names = archive.namelist()
        require(
            len(names) == len(set(names))
            and set(names) == set(prior["files"]) | {"bundle-manifest.json"},
            "frozen baseline inventory mismatch",
        )
        for name, declared in prior["files"].items():
            safe_name(name)
            require(record(archive.read(name)) == declared, "frozen baseline member mismatch")
            require(
                manifest["files"].get(name) == declared,
                "v3 bundle changed or omitted frozen v2 member: " + name,
            )
    modules = {
        name.removeprefix("py/viscera_core/"): item["sha256"]
        for name, item in manifest["files"].items()
        if name.startswith(
            (
                "py/viscera_core/tissue_learning/",
                "py/viscera_core/tissue_learning_detail/",
                "py/viscera_core/tissue_learning_conv/",
            )
        )
        and name.endswith(".py")
    }
    # Auditing uses local reviewed modules, never executable code from the ZIP.
    for name, checksum in modules.items():
        require(
            file_sha(ROOT / "py/viscera_core" / name) == checksum,
            "local verifier dependency differs from trusted source",
        )
    return manifest["files"], modules


def original_metadata(directory, expected):
    no_symlinks(directory)
    release_raw = (directory / "release.json").read_bytes()
    require(
        sha(release_raw) == expected.source_release_sha256,
        "original source release SHA256 mismatch",
    )
    release = strict_json(release_raw)
    require(
        release["schema"] == "viscera.observed-rgb-dataset/v3" and release["dataset_id"] == "dsad",
        "original source schema mismatch",
    )
    names = {"records.jsonl", "train.jsonl", "val.jsonl", "test.jsonl"}
    require(set(release["manifests"]) == names, "original manifest inventory mismatch")
    metadata = {}
    for name in names:
        path = directory / name
        no_symlinks(path)
        require(path.stat().st_size <= 32 * 1024**2, "original metadata exceeds bound")
        metadata[name] = path.read_bytes()
        require(
            record(metadata[name]) == release["manifests"][name], "original metadata hash mismatch"
        )
    return release, metadata


def png_size(raw, size):
    from PIL import Image

    with Image.open(io.BytesIO(raw)) as image:
        require(
            image.format == "PNG" and image.mode == "RGB" and image.size == size,
            "PNG format/dimensions mismatch",
        )
        image.verify()


def checkpoint_metadata(payloads, step, request):
    """Verify early checkpoint metadata only; its tensor payload is not present."""
    prefix = f"checkpoints/step-{step:09d}"
    names = {prefix + "/manifest.json", prefix + "/state.json"}
    require(names <= set(payloads), "early checkpoint metadata missing")
    manifest = strict_json(payloads[prefix + "/manifest.json"])
    require(
        manifest.get("schema") == "viscera.tissue-checkpoint/v1"
        and manifest.get("request") == request
        and set(manifest.get("files", {})) == {"state.json", "tensors.safetensors"},
        "early checkpoint request/schema mismatch",
    )
    for declared in manifest["files"].values():
        require(
            isinstance(declared, dict)
            and set(declared) == {"bytes", "sha256"}
            and type(declared["bytes"]) is int
            and 0 < declared["bytes"] <= LIMIT,
            "early checkpoint declaration invalid",
        )
        checked_sha(declared["sha256"])
    require(
        manifest["files"]["state.json"] == record(payloads[prefix + "/state.json"]),
        "early checkpoint state hash/size mismatch",
    )
    packed = strict_json(payloads[prefix + "/state.json"])
    require(
        isinstance(packed, dict)
        and packed.get("type") == "dict"
        and isinstance(packed.get("items"), list),
        "early checkpoint packed state invalid",
    )
    entries = {}
    for pair in packed["items"]:
        require(isinstance(pair, list) and len(pair) == 2, "early checkpoint packed entry invalid")
        key, value = pair
        require(
            isinstance(key, dict)
            and key.get("type") == "scalar"
            and type(key.get("value")) is str
            and key["value"] not in entries,
            "early checkpoint duplicate/invalid state key",
        )
        entries[key["value"]] = value
    require(
        entries.get("step") == {"type": "scalar", "value": step}
        and type(entries["step"]["value"]) is int,
        "early checkpoint committed step mismatch",
    )
    return names, sha(payloads[prefix + "/manifest.json"])


def verify_snapshots(payloads, request, expected, final_checkpoint_sha, model):
    """Bind each fixed prior milestone to its checkpoint and verify final pixels."""
    import numpy as np
    from PIL import Image
    from viscera_core.tissue_learning_conv.artifact import decode_native_numpy, seed_latent

    steps = expected.snapshot_steps
    require(
        steps
        and tuple(sorted(set(steps))) == steps
        and steps[-1] == expected.steps
        and all(type(step) is int and step > 0 for step in steps),
        "snapshot milestone contract invalid",
    )
    allowed, reports = set(), []
    for step in steps:
        prefix = f"prior-snapshots/step-{step:09d}"
        names = {
            f"condition-{index}-seed42-native128.png" for index in range(len(expected.conditions))
        }
        required = {
            prefix + "/" + name for name in names | {"receipt.json", "completed-result.json"}
        }
        require(required <= set(payloads), "required prior snapshot missing")
        allowed |= required
        if step == expected.steps:
            checkpoint_sha = final_checkpoint_sha
        else:
            checkpoint_names, checkpoint_sha = checkpoint_metadata(payloads, step, request)
            allowed |= checkpoint_names
        identity = {
            "kind": "native-conv-prior-snapshot-v1",
            "step": step,
            "checkpoint_manifest_sha256": checkpoint_sha,
            "request_sha256": sha(canonical(request)),
            "seed": "42",
            "native_resolution": [128, 128],
            "inference_precision": "float32; TF32 disabled",
        }
        receipt = strict_json(payloads[prefix + "/receipt.json"])
        require(
            receipt
            == {
                **identity,
                "files": receipt.get("files"),
                "qualification": "engineering_unqualified",
            }
            and isinstance(receipt["files"], dict)
            and set(receipt["files"]) == names,
            "prior snapshot identity/inventory mismatch",
        )
        maxima = []
        for index in range(len(expected.conditions)):
            name = f"condition-{index}-seed42-native128.png"
            raw = payloads[prefix + "/" + name]
            require(record(raw) == receipt["files"][name], "prior snapshot PNG hash/size mismatch")
            png_size(raw, (128, 128))
            if step == expected.steps:
                native = decode_native_numpy(
                    model, seed_latent("42", model["architecture"]["latent_dim"]), index
                )
                prediction = np.rint(np.clip(native, 0, 1) * 255).astype(np.int16)
                with Image.open(io.BytesIO(raw)) as image:
                    observed = np.asarray(image, dtype=np.int16)
                maximum = int(np.abs(prediction - observed).max())
                require(maximum <= 1, "final prior snapshot pixels differ from exported decoder")
                maxima.append(maximum)
        completion(payloads, prefix, identity)
        reports.append(
            {
                "step": step,
                "checkpoint_manifest_sha256": checkpoint_sha,
                "images": len(names),
                "metadata_hashes_verified": True,
                "checkpoint_tensors_reloaded": step == expected.steps,
                "final_decoder_pixels_compared": bool(maxima),
                "final_maximum_absolute_error_bytes": max(maxima) if maxima else None,
            }
        )
    return allowed, reports


def verify_bake_samples(raw, model, condition_index, resolution):
    """Bind selected output pixels to native inference and declared interpolation."""
    import numpy as np
    from PIL import Image
    from viscera_core.tissue_learning_conv.artifact import (
        decode_native_numpy,
        sample_periodic_numpy,
        seed_latent,
    )

    native = decode_native_numpy(
        model, seed_latent("42", model["architecture"]["latent_dim"]), condition_index
    )
    coordinates = np.unique(
        np.r_[
            0,
            1,
            resolution - 2,
            resolution - 1,
            np.linspace(0, resolution - 1, 17).astype(np.int64),
        ]
    )
    x, y = np.meshgrid(coordinates, coordinates)
    uv = np.stack(((x.ravel() + 0.5) / resolution, (y.ravel() + 0.5) / resolution), -1)
    predicted = np.rint(np.clip(sample_periodic_numpy(native, uv), 0, 1) * 255).astype(np.int16)
    with Image.open(io.BytesIO(raw)) as image:
        require(
            image.mode == "RGB" and image.size == (resolution, resolution),
            "PNG format/dimensions mismatch",
        )
        observed = np.asarray(
            [image.getpixel((int(a), int(b))) for a, b in zip(x.ravel(), y.ravel(), strict=True)],
            dtype=np.int16,
        )
    maximum = int(np.abs(observed - predicted).max())
    require(maximum <= 1, "bake pixels differ from exported native decoder/interpolation")
    return {
        "pixels": len(predicted),
        "maximum_absolute_byte_error": maximum,
        "tolerance_bytes": 1,
        "scope": "selected deterministic pixels, not every output pixel",
    }


def validate_checkpoint(state, request, config, model):
    import torch
    from viscera_core.tissue_learning_conv.artifact import validate_artifact
    from viscera_core.tissue_learning_conv.model import ConvVAE, ProjectionPatchCritic

    require(state["step"] == config.steps, "checkpoint step mismatch")
    with torch.random.fork_rng(devices=[]):
        generator = ConvVAE(config, len(model["architecture"]["condition_labels"]))
        critic = ProjectionPatchCritic(
            len(model["architecture"]["condition_labels"]), config.critic_width
        )
    generator.load_state_dict(state["model"], strict=True)
    critic.load_state_dict(state["critic"], strict=True)
    _, layers = validate_artifact(model)
    for index, (weight, bias) in enumerate(layers):
        for suffix, array in (("weight", weight), ("bias", bias)):
            actual = state["model"][f"decoder.layers.{index}.{suffix}"]
            require(
                torch.equal(actual, torch.from_numpy(array.copy())),
                "exported decoder differs from checkpoint tensors",
            )
    for label, module, steps, lr, betas in (
        ("optimizer", generator, config.steps, config.lr, (0.9, 0.999)),
        (
            "critic_optimizer",
            critic,
            config.steps - config.critic_warmup_updates,
            config.critic_lr,
            (0.0, 0.9),
        ),
    ):
        saved = state[label]
        require(len(saved["param_groups"]) == 1, "unexpected optimizer groups")
        group = saved["param_groups"][0]
        parameters = list(module.parameters())
        require(
            len(group["params"]) == len(parameters)
            and len(set(group["params"])) == len(parameters)
            and set(saved["state"]) == set(group["params"]),
            "optimizer state coverage mismatch",
        )
        require(
            group["lr"] == lr
            and tuple(group["betas"]) == betas
            and group["weight_decay"] == config.weight_decay,
            "optimizer configuration mismatch",
        )
        for key, parameter in zip(group["params"], parameters, strict=True):
            values = saved["state"][key]
            require(
                set(values) == {"step", "exp_avg", "exp_avg_sq"}
                and values["step"].numel() == 1
                and values["step"].item() == steps,
                "optimizer update count mismatch",
            )
            require(
                all(
                    values[name].shape == parameter.shape and values[name].dtype == parameter.dtype
                    for name in ("exp_avg", "exp_avg_sq")
                ),
                "optimizer tensor shape mismatch",
            )
    require(
        isinstance(state["torch_rng"], torch.Tensor)
        and state["torch_rng"].dtype == torch.uint8
        and state["torch_rng"].ndim == 1
        and isinstance(state["sampler_rng"], dict),
        "missing checkpoint RNG state",
    )
    require(
        isinstance(state["order"], list)
        and len(state["order"]) > 0
        and type(state["cursor"]) is int
        and 0 <= state["cursor"] <= len(state["order"]),
        "sampler cursor invalid",
    )
    if config.device == "cuda":
        require(
            len(state["cuda_rng"]) >= 1
            and all(x.dtype == torch.uint8 and x.ndim == 1 for x in state["cuda_rng"]),
            "missing CUDA RNG state",
        )
    history = state["loss_history"]
    require(
        len(history) == min(config.steps, 10000)
        and [event["step"] for event in history]
        == list(range(max(1, config.steps - 9999), config.steps + 1)),
        "committed loss history incomplete",
    )
    require(
        all(
            event["critic_active"] is (event["step"] > config.critic_warmup_updates)
            for event in history
        ),
        "critic warmup history mismatch",
    )
    require(
        request["data"]["conditions"] == model["architecture"]["condition_labels"],
        "checkpoint vocabulary mismatch",
    )


def validate_graph(
    payloads,
    stage,
    expected_model_sha256,
    expected_bundle_sha256,
    expected_run_id,
    bundle_files,
    modules,
    original_release,
    original,
    expected,
):
    from viscera_core.tissue_learning.checkpoint import load_checkpoint
    from viscera_core.tissue_learning.data import TissueDataset
    from viscera_core.tissue_learning.portable import experiment_identity
    from viscera_core.tissue_learning_conv.artifact import load_artifact
    from viscera_core.tissue_learning_conv.config import ConvConfig

    def doc(name):
        require(name in payloads, "required file missing: " + name)
        return strict_json(payloads[name])

    models = [name for name in payloads if name.endswith(".tissue-model.json")]
    require(len(models) == 1 and "/" not in models[0], "exactly one root model required")
    model_name = models[0]
    require(
        sha(payloads[model_name]) == checked_sha(expected_model_sha256),
        "trusted whole-model SHA256 mismatch",
    )
    doc(model_name)
    model = load_artifact(stage / model_name)
    p, a = model["provenance"], model["architecture"]
    require(
        tuple(zip(a["condition_labels"], a["condition_regions"], a["condition_species"]))
        == expected.conditions,
        "condition scope mismatch",
    )
    require(
        p["training_steps"] == expected.steps
        and p["training_status"] == ("fixture_trained" if expected.fixture else "research_trained")
        and p["qualification"] == "engineering_unqualified"
        and p["training_native_patch_size"] == p["training_source_crop_size"] == 128
        and p["critic_exported"] is False,
        "model training/qualification mismatch",
    )
    require(
        model["output"]["kind"] == "observed_rgb_appearance"
        and model["output"]["pbr_ground_truth"] is False
        and model["output"]["clinically_validated"] is False,
        "unsupported model claims",
    )
    run, request, training = (
        doc("run-identity.json"),
        doc("request.json"),
        doc("training-receipt.json"),
    )
    config = ConvConfig.from_dict(request["config"])
    require(
        a["latent_dim"] == config.latent_dim
        and a["latent_shape"] == [config.latent_channels, 8, 8]
        and a["decoder_channels"] == list(config.decoder_channels)
        and a["native_resolution"] == [128, 128]
        and p["native_decode_resolution"] == [128, 128],
        "decoder/config architecture mismatch",
    )
    require(
        config.steps == expected.steps
        and config.batch_size == expected.batch_size
        and config.fixture is expected.fixture
        and config.device == expected.device
        and config.precision == ("bfloat16" if expected.device == "cuda" else "float32")
        and config.commercial_only is False
        and config.validation_mode == "heldout"
        and config.minimum_valid_fraction == 0.5
        and config.critic_minimum_coverage == 0.75,
        "unexpected training configuration",
    )
    if not expected.fixture:
        approved = ConvConfig()
        require(
            config.to_dict() == approved.to_dict(),
            "production spatial candidate differs from the approved default configuration",
        )
    require(
        request["schema"] == "viscera.tissue-conv-training-request/v1"
        and request["model_type"] == "masked-rgb-spatial-cvae-gan-v1"
        and request["config"] == run["config"] == doc("training-local/config.json")
        and sha(canonical(request["config"])) == request["config_sha256"] == p["config_sha256"],
        "config identity mismatch",
    )
    require(request["source_sha256"] == p["source_sha256"] == modules, "module provenance mismatch")
    require(
        request["environment"] == p["environment"] == training["environment"],
        "environment identity mismatch",
    )
    require(
        p["training_objectives"] == request["objectives"], "training objective provenance mismatch"
    )
    require(
        request["condition_regions"] == a["condition_regions"]
        and request["condition_species"] == a["condition_species"],
        "request condition mapping mismatch",
    )
    require(
        run
        == experiment_identity(
            "prepared_group_split",
            expected_bundle_sha256,
            sha(payloads["native-crops/release.json"]),
            request["config"],
            run["environment_lock_manifest_sha256"],
            sha(payloads["data-readiness/records.jsonl"]),
        )
        and run["run_id"] == expected_run_id,
        "run identity mismatch",
    )
    pointer = doc("checkpoints/latest.json")
    directory = f"step-{expected.steps:09d}"
    prefix = "checkpoints/" + directory
    manifest = doc(prefix + "/manifest.json")
    checkpoint_sha = sha(payloads[prefix + "/manifest.json"])
    require(
        pointer == {"directory": directory, "manifest_sha256": checkpoint_sha}
        and manifest["request"] == request
        and p["checkpoint_manifest_sha256"] == checkpoint_sha,
        "checkpoint identity mismatch",
    )
    require(
        model_name == f"{expected_run_id}-{directory}-{checkpoint_sha[:16]}.tissue-model.json",
        "model filename mismatch",
    )
    doc(prefix + "/state.json")
    state, loaded_request = load_checkpoint(stage / prefix)
    require(loaded_request == request, "loaded checkpoint request mismatch")
    validate_checkpoint(state, request, config, model)
    require(
        training["status"] == "completed"
        and training["committed_updates"] == expected.steps
        and training["checkpoint_manifest_sha256"] == checkpoint_sha
        and training["fixture"] is expected.fixture
        and training["qualification"] == "engineering_unqualified"
        and training["validation"] == state["validation"] == p["validation"],
        "training completion mismatch",
    )
    snapshot_files, snapshots = verify_snapshots(payloads, request, expected, checkpoint_sha, model)
    native, readiness = doc("native-crops/release.json"), doc("data-readiness/readiness.json")
    require(
        sha(payloads["native-crops/release.json"]) == expected.native_release_sha256
        and native["schema"] == "viscera.observed-rgb-dataset/v3"
        and native["dataset_id"] == "dsad"
        and native["source_prepared_release_sha256"] == expected.source_release_sha256
        and native["source_prepared_records_sha256"] == sha(original["records.jsonl"])
        and native["test_payloads_opened"] == 0
        and native["test_payloads_materialized"] is False,
        "native release ancestry/test isolation mismatch",
    )
    require(
        native["preparation_script_sha256"]
        == bundle_files["scripts/prepare_tissue_native_crops.py"]["sha256"]
        and native["preparation_dependencies"]
        == {
            name: bundle_files["scripts/" + name]["sha256"]
            for name in ("prepare_tissue_v3_dataset.py", "scan_tissue_native_crop_support.py")
        },
        "native preparation source mismatch",
    )
    require(
        set(native["manifests"]) == {"records.jsonl", "train.jsonl", "val.jsonl", "test.jsonl"},
        "native manifest inventory mismatch",
    )
    for name, declared in native["manifests"].items():
        require(
            record(payloads["native-crops/" + name]) == declared, "native manifest hash mismatch"
        )
    raw = payloads["native-crops/records.jsonl"]
    require(
        raw == payloads["data-readiness/records.jsonl"],
        "readiness unexpectedly changed native rows",
    )
    data = TissueDataset(stage / "native-crops/records.jsonl", stage, commercial_only=False)
    summary = data.summary()
    require(
        summary
        == request["data"]
        == p["dataset_summary"]
        == readiness["source_summary"]
        == readiness["derived_summary"],
        "data summary mismatch",
    )
    require(
        sha(raw) == p["dataset_manifest_sha256"] == readiness["derived_manifest_sha256"]
        and data.split_digest == p["split_manifest_sha256"] == readiness["derived_split_sha256"],
        "data/split digest mismatch",
    )
    counts = {key: len(data.splits[key]) for key in ("train", "val", "test")}
    require(
        counts == native["records_by_split"] and native["records"] == len(data.records),
        "native record count mismatch",
    )
    require(
        type(state["epoch"]) is int
        and state["epoch"] >= 0
        and all(type(index) is int and index in data.splits["train"] for index in state["order"]),
        "sampler references nontraining rows",
    )
    lines = raw.splitlines(keepends=True)
    for split in counts:
        require(
            payloads[f"native-crops/{split}.jsonl"]
            == b"".join(lines[i] for i in data.splits[split]),
            "native split not byte-preserved",
        )
    require(payloads["native-crops/test.jsonl"] == original["test.jsonl"], "test metadata changed")
    require(
        [x for x in native["shards"] if x["split"] == "test"]
        == [x for x in original_release.get("shards", []) if x["split"] == "test"],
        "test shard declarations changed",
    )
    policy = native["native_crop_policy"]
    require(
        all(
            policy[key] == value
            for key, value in {
                "native_size": 128,
                "minimum_valid_fraction": 0.5,
                "minimum_critic_fraction": 0.75,
                "minimum_validation_groups": expected.minimum_validation_groups,
                "critic_stride": 4,
                "critic_window_size": 23,
                "critic_zero_padding": 11,
                "resampling": "none",
                "colour_transform": "none",
            }.items()
        ),
        "native crop policy mismatch",
    )
    originals = [strict_json(line) for line in original["records.jsonl"].splitlines()]
    source_by_id = {
        row["id"]: (row, line)
        for row, line in zip(
            originals, original["records.jsonl"].splitlines(keepends=True), strict=True
        )
    }
    require(
        len(source_by_id) == len(originals)
        and tuple(sum(r["split"] == s for r in originals) for s in ("train", "val", "test"))
        == expected.source_counts,
        "original source counts mismatch",
    )
    exclusions = doc("native-crops/exclusions.json")
    require(
        native["exclusions"]
        == {
            "path": "exclusions.json",
            **record(payloads["native-crops/exclusions.json"]),
            "rows": len(exclusions),
        },
        "exclusion declaration mismatch",
    )
    kept = set()
    for row in data.records:
        if row["split"] == "test":
            continue
        parent, parent_raw = source_by_id[row["source_original_record_id"]]
        require(
            parent["id"] not in kept and parent["split"] in ("train", "val"),
            "duplicate/held-out crop parent",
        )
        kept.add(parent["id"])
        require(
            row["source_original_row_sha256"] == sha(parent_raw)
            and row["source_prepared_release_sha256"] == expected.source_release_sha256
            and row["source_image_sha256"]
            == row["derivation_parent_sha256"]
            == parent["image_sha256"]
            and row["source_prepared_mask_sha256"] == parent["mask_sha256"],
            "crop parent hash mismatch",
        )
        require(
            all(
                row.get(key) == parent.get(key)
                for key in (
                    "split",
                    "group_id",
                    "group_level",
                    "group_provenance",
                    "condition",
                    "condition_region",
                    "species",
                    "licence_spdx",
                    "commercial_eligibility",
                    "training_eligible",
                    "mask_semantics",
                    "mask_policy",
                )
            ),
            "crop split/group/rights changed",
        )
        require(
            row["native_crop"]["native_size"] == 128
            and row["quality"]["width"] == row["quality"]["height"] == 128
            and row["quality"]["valid_fraction"] >= 0.5
            and min(row["quality"]["critic_alignment_max_valid_fractions"]) >= 0.75,
            "unqualified crop declaration",
        )
    excluded_ids = set()
    for item in exclusions:
        parent, _ = source_by_id[item["id"]]
        require(
            item["id"] not in kept | excluded_ids
            and parent["split"] in ("train", "val")
            and all(
                item[key] == parent[key]
                for key in ("split", "condition", "group_id", "image_sha256", "mask_sha256")
            ),
            "exclusion parent mismatch",
        )
        reason = item["reason"]
        require(
            reason
            in (
                "insufficient_native_valid_fraction",
                "insufficient_valid_critic_neighborhood",
                "insufficient_sampled_critic_coverage_in_at_least_one_d4_variant",
            ),
            "unsupported exclusion reason",
        )
        candidate = item["best_candidate"]
        if reason == "insufficient_native_valid_fraction":
            require(0 <= candidate["valid_fraction"] < 0.5, "invalid coverage exclusion")
        elif reason == "insufficient_valid_critic_neighborhood":
            require(
                candidate["valid_fraction"] >= 0.5
                and 0 <= candidate["critic_max_valid_fraction"] < 0.75,
                "invalid critic exclusion",
            )
        else:
            require(
                candidate["valid_fraction"] >= 0.5
                and candidate["critic_max_valid_fraction"] >= 0.75
                and min(item["critic_alignment_max_valid_fractions"]) < 0.75,
                "invalid D4 exclusion",
            )
        excluded_ids.add(item["id"])
    require(
        kept | excluded_ids == {r["id"] for r in originals if r["split"] != "test"},
        "incomplete crop/exclusion accounting",
    )
    for condition in data.conditions:
        groups = {
            split: sorted(
                {
                    r["group_id"]
                    for r in data.records
                    if r["condition"] == condition and r["split"] == split
                }
            )
            for split in counts
        }
        require(
            groups == native["conditions"][condition]
            and len(groups["val"]) >= expected.minimum_validation_groups,
            "condition group support mismatch",
        )
    identity = readiness["identity"]
    require(
        readiness["schema"] == "viscera.native-tissue-detail-readiness/v1"
        and readiness["excluded_count"] == 0
        and readiness["test_payloads_opened"] == 0
        and readiness["retained_test_rows"] == counts["test"]
        and readiness["scanned_train_val_rows"] == counts["train"] + counts["val"]
        and readiness["minimum_critic_fields_over_all_augmentations"] > 0,
        "readiness accounting mismatch",
    )
    require(
        identity["source_manifest_sha256"] == sha(raw)
        and identity["source_split_sha256"] == data.split_digest
        and identity["patch_size"] == 128
        and identity["minimum_valid_fraction"] == 0.5
        and identity["critic_minimum_coverage"] == 0.75
        and identity["policy_source_sha256"]
        == {
            name: modules["tissue_learning_detail/" + name]
            for name in ("data.py", "readiness.py", "model.py")
        },
        "readiness identity mismatch",
    )
    completion(payloads, "data-readiness", identity)
    crop_marker = doc("native-crops/completed-result.json")
    crop_identity = {
        "kind": "native-tissue-crops-v2",
        "pipeline_sha256": {
            name: bundle_files["scripts/" + name]["sha256"]
            for name in (
                "scan_tissue_native_crop_support.py",
                "prepare_tissue_native_crops.py",
                "prepare_tissue_v3_dataset.py",
            )
        },
        "source_release_sha256": expected.source_release_sha256,
        "policy": {
            "native_size": 128,
            "minimum_valid_fraction": 0.5,
            "minimum_critic_fraction": 0.75,
            "minimum_validation_groups": expected.minimum_validation_groups,
        },
        "environment_lock_manifest_sha256": run["environment_lock_manifest_sha256"],
    }
    require(crop_marker["identity"] == crop_identity, "native completion identity mismatch")
    metadata_names = {
        "release.json",
        "records.jsonl",
        "train.jsonl",
        "val.jsonl",
        "test.jsonl",
        "exclusions.json",
    }
    shard_declarations = {
        s["path"]: {k: s[k] for k in ("bytes", "sha256")}
        for s in native["shards"]
        if s["split"] in ("train", "val")
    }
    require(
        set(crop_marker["files"]) - metadata_names
        in (set(shard_declarations), set(shard_declarations) | {"progress.json"}),
        "native completion omitted inventory mismatch",
    )
    for name in metadata_names:
        require(
            crop_marker["files"][name] == record(payloads["native-crops/" + name]),
            "native completion metadata mismatch",
        )
    for name, declared in shard_declarations.items():
        safe_name(name)
        checked_sha(declared["sha256"])
        require(
            type(declared["bytes"]) is int and declared["bytes"] > 0, "invalid omitted shard size"
        )
        require(crop_marker["files"][name] == declared, "omitted shard declaration mismatch")
    if "progress.json" in crop_marker["files"]:
        progress = crop_marker["files"]["progress.json"]
        checked_sha(progress["sha256"])
        require(
            type(progress["bytes"]) is int and 0 < progress["bytes"] < 1024**2,
            "invalid omitted progress declaration",
        )
    diagnostics = doc("diagnostics/diagnostics.json")
    require(
        diagnostics["model_file_sha256"] == expected_model_sha256
        and diagnostics["checkpoint_manifest_sha256"] == checkpoint_sha
        and diagnostics["data_summary"] == summary
        and diagnostics["measurement_split"] == "val"
        and diagnostics["training_native_patch_size"]
        == diagnostics["training_source_crop_size"]
        == 128
        and diagnostics["loss_trace"] == state["loss_history"]
        and diagnostics["qualification"] == "engineering_unqualified",
        "diagnostics identity/history mismatch",
    )
    require(
        diagnostics["native_decode_resolution"] == [128, 128],
        "diagnostics native decoder resolution mismatch",
    )
    chosen = [
        data.records[i] for i in data.evaluation_indices("val", min(config.validation_limit, 128))
    ]
    require(
        [(r["id"], r["condition"], r["group_id"]) for r in diagnostics["evaluated_rows"]]
        == [(r["id"], r["condition"], r["group_id"]) for r in chosen]
        and diagnostics["evaluated_samples"] == len(chosen),
        "diagnostic subset changed",
    )
    gradient = diagnostics["fixed_batch_objective_gradient_diagnostic"]
    require(
        gradient["record_id"] == chosen[0]["id"]
        and gradient["group_id"] == chosen[0]["group_id"]
        and gradient["condition"] == chosen[0]["condition"]
        and gradient["prior_seed"] == "42"
        and gradient["posterior"] == "mean (no sampling)",
        "objective gradient diagnostic source mismatch",
    )
    terms = {
        "posterior_l1",
        "neighbor_mse",
        "kl",
        "prior_adversarial",
        "posterior_adversarial",
        "posterior_feature_matching",
    }
    require(
        set(gradient["weighted_objectives"]) == terms,
        "objective gradient diagnostic inventory mismatch",
    )
    for value in gradient["weighted_objectives"].values():
        require(
            set(value) == {"weighted_scalar", "generator_gradient_l2"}
            and all(
                type(x) in (int, float) and float("-inf") < x < float("inf") for x in value.values()
            )
            and value["generator_gradient_l2"] >= 0,
            "invalid objective gradient diagnostic value",
        )
    completion(
        payloads,
        "diagnostics",
        {
            "kind": "tissue-diagnostics",
            "model_sha256": expected_model_sha256,
            "checkpoint_manifest_sha256": checkpoint_sha,
            "run_id": expected_run_id,
        },
    )
    bake = doc("liver-seed42-4096/appearance.bake.json")
    liver = a["condition_regions"].index("liver")
    require(
        bake["model_sha256"] == expected_model_sha256
        and bake["sha256"] == sha(payloads["liver-seed42-4096/appearance.png"])
        and bake["resolution"] == [4096, 4096]
        and bake["condition_index"] == liver
        and bake["seed"] == "42"
        and bake["training_native_patch_size"] == 128
        and bake["native_decode_resolution"] == [128, 128]
        and bake["qualification"] == "engineering_unqualified",
        "4K bake identity mismatch",
    )
    png_size(payloads["liver-seed42-4096/appearance.png"], (4096, 4096))
    bake_sample_check = verify_bake_samples(
        payloads["liver-seed42-4096/appearance.png"], model, liver, 4096
    )
    completion(
        payloads,
        "liver-seed42-4096",
        {
            "kind": "tissue-appearance-bake",
            "model_sha256": expected_model_sha256,
            "condition_index": liver,
            "seed_decimal": "42",
            "resolution": 4096,
        },
    )
    for index in range(len(expected.conditions)):
        png_size(payloads[f"diagnostics/condition-{index}-seed42-256.png"], (256, 256))
    attempts = {n.split("/")[1] for n in payloads if n.startswith("attempts/")}
    require(
        len(attempts) == 1 and re.fullmatch(r"[0-9a-f]{16}", next(iter(attempts))),
        "attempt identity invalid",
    )
    attempt = "attempts/" + next(iter(attempts))
    environment = doc(attempt + "/environment-installation.json")
    require(
        environment["manifest_sha256"] == run["environment_lock_manifest_sha256"],
        "environment lock mismatch",
    )
    preflight = doc(attempt + "/gpu-preflight.json")
    require(
        preflight["schema"] == "viscera.tissue-conv-preflight/v1"
        and preflight["passed"] is True
        and preflight["gpu_executed"] is (expected.device == "cuda")
        and preflight["safe_checkpoint_roundtrip"] is True
        and preflight["portable_export_reference_checked"] is True,
        "preflight failure/identity mismatch",
    )
    require(
        preflight["generator_optimizer_state_entries"] > 0
        and preflight["critic_optimizer_state_entries"] > 0
        and {
            "model",
            "critic",
            "optimizer",
            "critic_optimizer",
            "torch_rng",
            "cuda_rng",
            "sampler_rng",
        }
        <= set(preflight["checkpoint_state_compared_exactly"]),
        "preflight optimizer/checkpoint coverage missing",
    )
    if expected.device == "cuda":
        require(
            "A100" in preflight["hardware"]["gpu_name"]
            and preflight["hardware"]["torch"] == "2.8.0+cu126"
            and preflight["hardware"]["cuda_runtime"] == "12.6",
            "unexpected GPU environment",
        )
    probe_files, probe_report = set(), {"included": False, "required_on_reconnect": False}
    probe_name = attempt + "/probe-300-receipt.json"
    if probe_name in payloads:
        probe = doc(probe_name)
        probe_manifest_name = f"checkpoints/step-{expected.probe_updates:09d}/manifest.json"
        probe_manifest = doc(probe_manifest_name)
        require(
            probe_manifest.get("schema") == "viscera.tissue-checkpoint/v1"
            and probe_manifest.get("request") == request
            and set(probe_manifest.get("files", {})) == {"state.json", "tensors.safetensors"},
            "probe checkpoint request/budget identity mismatch",
        )
        for declared in probe_manifest["files"].values():
            require(
                isinstance(declared, dict)
                and set(declared) == {"bytes", "sha256"}
                and type(declared["bytes"]) is int
                and 0 < declared["bytes"] <= LIMIT,
                "probe checkpoint declaration invalid",
            )
            checked_sha(declared["sha256"])
        require(
            0 < expected.probe_updates < expected.steps
            and probe["status"] == "interrupted"
            and probe["committed_updates"] == expected.probe_updates
            and type(probe["committed_updates"]) is int
            and type(probe["updates_this_attempt"]) is int
            and 0 < probe["updates_this_attempt"] <= expected.probe_updates
            and probe["checkpoint_manifest_sha256"] == sha(payloads[probe_manifest_name])
            and probe["environment"] == request["environment"]
            and probe["batch_size"] == config.batch_size
            and probe["precision"] == config.precision
            and probe["fixture"] is expected.fixture
            and probe["qualification"] == "engineering_unqualified"
            and type(probe["wall_seconds"]) in (float, int)
            and 0 < probe["wall_seconds"] < float("inf"),
            "probe receipt step/checkpoint/environment mismatch",
        )
        probe_files = {probe_name, probe_manifest_name}
        probe_report = {
            "included": True,
            "required_on_reconnect": False,
            "committed_updates": expected.probe_updates,
            "budget_updates": config.steps,
            "checkpoint_manifest_sha256": probe["checkpoint_manifest_sha256"],
            "request_matches_final": True,
            "checkpoint_tensors_reloaded": False,
            "updates_this_attempt": probe["updates_this_attempt"],
            "wall_seconds": probe["wall_seconds"],
        }
    allowed = (
        {
            INVENTORY,
            model_name,
            "request.json",
            "run-identity.json",
            "training-receipt.json",
            "checkpoints/latest.json",
            *[prefix + "/" + n for n in ("manifest.json", "state.json", "tensors.safetensors")],
            *[
                "data-readiness/" + n
                for n in ("records.jsonl", "readiness.json", "completed-result.json")
            ],
            *["native-crops/" + n for n in metadata_names | {"completed-result.json"}],
            *[
                "diagnostics/" + n
                for n in (
                    "diagnostics.json",
                    "appearance-comparison.png",
                    "loss-trace.png",
                    "completed-result.json",
                )
            ],
            *[f"diagnostics/condition-{i}-seed42-256.png" for i in range(len(expected.conditions))],
            *[
                "liver-seed42-4096/" + n
                for n in ("appearance.png", "appearance.bake.json", "completed-result.json")
            ],
            *[
                attempt + "/" + n
                for n in (
                    "gpu-preflight.json",
                    "environment-installation.json",
                    "installed-packages.txt",
                )
            ],
            "training-local/config.json",
        }
        | snapshot_files
        | probe_files
    )
    require(
        set(payloads) in (allowed, allowed | {"training-local/metrics-this-vm-attempt.jsonl"}),
        "missing/unapproved review files or raw payloads",
    )
    return {
        "schema": "viscera.tissue-conv-run-local-verification/v1",
        "passed": True,
        "run_id": expected_run_id,
        "model": model_name,
        "model_sha256": expected_model_sha256,
        "source_bundle_sha256": expected_bundle_sha256,
        "checkpoint_manifest_sha256": checkpoint_sha,
        "native_release_sha256": sha(payloads["native-crops/release.json"]),
        "original_source_release_sha256": expected.source_release_sha256,
        "training_steps": expected.steps,
        "retained_counts": counts,
        "excluded_count": len(exclusions),
        "checkpoint_tensors_reloaded": True,
        "exported_decoder_matches_checkpoint_exactly": True,
        "both_optimizer_states_validated": True,
        "test_metadata_byte_preserved": True,
        "test_payloads_opened_locally": 0,
        "raw_native_payloads_rechecked_locally": False,
        "omitted_native_files": sorted(set(crop_marker["files"]) - metadata_names),
        "png4096_verified": True,
        "native_decode_resolution": [128, 128],
        "bake_selected_pixels_verified": bake_sample_check,
        "frozen_v2_baseline_sha256": expected.baseline_bundle_sha256,
        "prior_snapshots": snapshots,
        "initial_probe": probe_report,
        "photorealism_evaluated": False,
        "qualification": "engineering_unqualified",
    }


def verify(
    archive,
    archive_sha256,
    model_sha256,
    bundle,
    bundle_sha256,
    run_id,
    original_release_dir,
    output,
    *,
    expected=Expectations(),
    baseline_bundle=None,
):
    archive, bundle, output, original_release_dir = [
        Path(p).absolute() for p in (archive, bundle, output, original_release_dir)
    ]
    no_symlinks(output)
    require(
        not output.exists() and output.parent.is_dir(),
        "output must be a new exclusive directory with existing parent",
    )
    payloads = read_archive(archive, archive_sha256)
    baseline_bundle = Path(
        baseline_bundle
        or ROOT
        / "artifacts/tissue-colab-2026-10-19/upload-detail-v2-2/viscera-tissue-detail-colab.zip"
    ).absolute()
    files, modules = source_inventory(
        bundle, bundle_sha256, baseline_bundle, expected.baseline_bundle_sha256
    )
    release, original = original_metadata(original_release_dir, expected)
    stage = Path(tempfile.mkdtemp(prefix=".conv-verify-", dir=output.parent))
    try:
        for name, raw in payloads.items():
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as handle:
                handle.write(raw)
        result = validate_graph(
            payloads,
            stage,
            model_sha256,
            bundle_sha256,
            run_id,
            files,
            modules,
            release,
            original,
            expected,
        )
        result.update(
            archive_sha256=archive_sha256,
            archive_bytes=archive.stat().st_size,
            verifier_sha256=file_sha(Path(__file__)),
            output=str(output),
            inventory_files=len(payloads) - 1,
        )
        output.mkdir(exist_ok=False)
        for child in stage.iterdir():
            child.rename(output / child.name)
        with (output / "local-verification.json").open("x") as handle:
            json.dump(result, handle, indent=2, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        return result
    finally:
        shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    for option in (
        "expected-archive-sha256",
        "expected-model-sha256",
        "expected-bundle-sha256",
        "expected-run-id",
    ):
        parser.add_argument("--" + option, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument(
        "--baseline-bundle",
        type=Path,
        help="Exact frozen v2 ef15 source ZIP; defaults to the verified workspace archive",
    )
    parser.add_argument(
        "--original-release-dir",
        type=Path,
        default=ROOT / "artifacts/tissue-colab-2026-10-19/completed-run-verified/source-release",
    )
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = verify(
            args.archive,
            args.expected_archive_sha256,
            args.expected_model_sha256,
            args.bundle,
            args.expected_bundle_sha256,
            args.expected_run_id,
            args.original_release_dir,
            args.output,
            baseline_bundle=args.baseline_bundle,
        )
    except (ValueError, KeyError, TypeError, OSError, RuntimeError, zipfile.BadZipFile) as error:
        parser.exit(1, f"Verification failed; original archive preserved: {error}\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
