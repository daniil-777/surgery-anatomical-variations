#!/usr/bin/env python3
"""Independently audit published tissue PNGs; diagnostics are not realism scores."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import struct
import time
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

import numpy as np
from PIL import Image

CHANNELS = {
    "substrate": (3, 8, "srgb"),
    "base_color": (3, 8, "srgb"),
    "normal": (3, 8, "linear"),
    "substrate_normal": (3, 8, "linear"),
    "layer_relief": (3, 8, "linear"),
    "roughness": (1, 8, "linear"),
    "substrate_roughness": (1, 8, "linear"),
    "height": (1, 16, "linear"),
    "thickness": (1, 16, "linear"),
    "transition": (1, 8, "linear"),
}
LAYERS = {"vessels", "adipose", "fascia", "wet_film"}


def safe_path(root: Path, relative: object) -> Path:
    """Reject absolute paths, traversal, Windows paths and symlink escapes."""
    if not isinstance(relative, str) or not relative or "\\" in relative or ":" in relative:
        raise ValueError("asset path must be a nonempty POSIX relative path")
    path = PurePosixPath(relative)
    if path.is_absolute() or any(part in ("", ".", "..") for part in relative.split("/")):
        raise ValueError(f"unsafe asset path: {relative}")
    resolved = root.joinpath(*path.parts).resolve()
    if not resolved.is_relative_to(root.resolve()):
        raise ValueError(f"asset symlink escapes library: {relative}")
    return resolved


def _sha256(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def _finite_positive(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and value > 0
    )


def validate_manifest(manifest: dict, resolution: int) -> list[str]:
    errors = []
    if manifest.get("schema") != "viscera.tissue-materials/v1":
        errors.append("unexpected manifest schema")
    if manifest.get("resolution") != [resolution, resolution]:
        errors.append("manifest resolution does not match requested native/preview size")
    recipe, provenance = manifest.get("recipe", {}), manifest.get("provenance", {})
    seed = recipe.get("seed")
    if type(seed) is not int or not 0 <= seed < 2**64:
        errors.append("recipe seed is not a full-fidelity uint64 JSON integer")
    elif provenance.get("seed_decimal") != str(seed):
        errors.append("decimal seed provenance does not exactly match uint64 recipe seed")
    tile = recipe.get("tile_size_mm")
    if not _finite_positive(tile):
        errors.append("physical tile size is not finite and positive")
    elif manifest.get("physical_size_mm") != [tile, tile] or not math.isclose(
        manifest.get("pixel_size_mm", -1), tile / resolution, rel_tol=1e-12
    ):
        errors.append("physical size / pixel spacing does not agree with recipe and resolution")
    if (
        provenance.get("clinically_validated") is not False
        or provenance.get("patient_specific") is not False
    ):
        errors.append("procedural baseline qualification flags are missing or inconsistent")
    if not isinstance(provenance.get("training_datasets"), list):
        errors.append("training dataset provenance must be explicit")
    sources = provenance.get("source_sha256", {})
    if (
        not sources
        or not isinstance(sources, dict)
        or any(
            not isinstance(x, str) or not re.fullmatch(r"[0-9a-f]{64}", x) for x in sources.values()
        )
    ):
        errors.append("generator source hashes are missing or malformed")
    channels = manifest.get("channels", {})
    if not isinstance(channels, dict) or set(channels) != set(CHANNELS):
        errors.append("required PBR channel set is incomplete or unexpected")
    layers = manifest.get("layers", [])
    if (
        not isinstance(layers, list)
        or len(layers) != 4
        or {layer.get("id") for layer in layers if isinstance(layer, dict)} != LAYERS
    ):
        errors.append("four independent layer declarations are required")
    for name, (_, bits, space) in CHANNELS.items():
        channel = channels.get(name, {})
        if channel.get("bit_depth") != bits or channel.get("color_space") != space:
            errors.append(f"{name}: channel encoding declaration is inconsistent")
    for name in ("height", "thickness"):
        channel = channels.get(name, {})
        decode = channel.get("decode_range", [])
        if (
            channel.get("unit") != "mm"
            or not isinstance(decode, list)
            or len(decode) != 2
            or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in decode)
            or decode[0] >= decode[1]
        ):
            errors.append(f"{name}: invalid millimeter decode range")
    for name in ("normal", "substrate_normal"):
        if channels.get(name, {}).get("convention") != "OpenGL +Y":
            errors.append(f"{name}: normal convention must be explicit OpenGL +Y")
    relief = channels.get("layer_relief", {})
    if relief.get("unit") != "mm" or relief.get("packing") != ["vessels", "adipose", "fascia"]:
        errors.append("layer_relief: explicit RGB vessel/adipose/fascia millimeter packing required")
    for field, expected in (("decode_scale_mm", [0.035, 0.45, 0.035]), ("decode_offset_mm", [0, 0, 0])):
        values = relief.get(field)
        if values != expected or not isinstance(values, list) or any(type(value) not in (int, float) for value in values):
            errors.append(f"layer_relief: invalid {field}")
    for layer in layers:
        if not isinstance(layer, dict):
            continue
        if (
            layer.get("bit_depth") != 8
            or layer.get("color_space") != "srgb"
            or layer.get("alpha") != "straight, linear coverage"
        ):
            errors.append(f"{layer.get('id')}: invalid RGBA color/coverage convention")
        opacity = layer.get("opacity")
        if (
            not isinstance(opacity, (int, float))
            or isinstance(opacity, bool)
            or not math.isfinite(opacity)
            or not 0 <= opacity <= 1
        ):
            errors.append(f"{layer.get('id')}: invalid opacity")
    return errors


def image_diagnostics(image: Image.Image, bits: int, normal: bool) -> dict:
    """Whole-image statistics in bounded float stripes, using decoded pixels."""
    width, height = image.size
    count = len(image.getbands())
    total = np.zeros(count, dtype=np.float64)
    squared = total.copy()
    minimum, maximum = np.full(count, np.inf), np.full(count, -np.inf)
    edge_sum, neighbor_sum = total.copy(), total.copy()
    max_normal_error, normal_length_sum, min_normal_z = 0.0, 0.0, 1.0
    finite_count = 0
    denominator = float(2**bits - 1)

    def pixels(box):
        values = np.asarray(image.crop(box), dtype=np.float64) / denominator
        return values[..., None] if values.ndim == 2 else values

    for row in range(0, height, 64):
        data = pixels((0, row, width, min(row + 64, height)))
        total += data.sum(axis=(0, 1))
        squared += np.square(data).sum(axis=(0, 1))
        minimum = np.minimum(minimum, data.min(axis=(0, 1)))
        maximum = np.maximum(maximum, data.max(axis=(0, 1)))
        edge_sum += np.abs(data[:, 0] - data[:, -1]).sum(axis=0)
        neighbor_sum += (np.abs(data[:, 1] - data[:, 0]) + np.abs(data[:, -1] - data[:, -2])).sum(
            axis=0
        ) / 2
        if normal:
            vector = data * 2 - 1
            length = np.linalg.norm(vector, axis=-1)
            finite_count += int(np.count_nonzero(~np.isfinite(vector)))
            max_normal_error = max(max_normal_error, float(np.abs(length - 1).max()))
            normal_length_sum += float(length.sum())
            min_normal_z = min(min_normal_z, float(vector[..., 2].min()))
    top, next_top = pixels((0, 0, width, 1)), pixels((0, 1, width, 2))
    bottom, next_bottom = (
        pixels((0, height - 1, width, height)),
        pixels((0, height - 2, width, height - 1)),
    )
    y_edge = np.abs(top - bottom).mean(axis=(0, 1))
    y_neighbor = (np.abs(top - next_top) + np.abs(bottom - next_bottom)).mean(axis=(0, 1)) / 2
    x_edge, x_neighbor = edge_sum / height, neighbor_sum / height

    def ratio(seam, adjacent):
        return [float(a / b) if b > 0 else None for a, b in zip(seam, adjacent)]

    mean = total / (width * height)
    result = {
        "pixel_count": width * height,
        "channels": count,
        "normalized_sample_mean": mean.tolist(),
        "normalized_sample_std": np.sqrt(
            np.maximum(0, squared / (width * height) - mean**2)
        ).tolist(),
        "normalized_sample_min": minimum.tolist(),
        "normalized_sample_max": maximum.tolist(),
        "seam_diagnostics": {
            "u_jump_mean": x_edge.tolist(),
            "v_jump_mean": y_edge.tolist(),
            "u_adjacent_edge_neighbor_mean": x_neighbor.tolist(),
            "v_adjacent_edge_neighbor_mean": y_neighbor.tolist(),
            "u_ratio": ratio(x_edge, x_neighbor),
            "v_ratio": ratio(y_edge, y_neighbor),
        },
    }
    if normal:
        result["normal"] = {
            "nonfinite_components": finite_count,
            "max_length_error": max_normal_error,
            "mean_length": normal_length_sum / (width * height),
            "min_tangent_z": min_normal_z,
            "quantization_tolerance": math.sqrt(3) / 255 + 1e-6,
        }
    return result


def audit_asset(
    path: Path, declaration: dict, expected_channels: int, resolution: int, normal: bool = False
) -> dict:
    errors = []
    result = {"file": declaration.get("file"), "errors": errors}
    if not path.is_file():
        errors.append("published manifest references a missing image")
        return result
    digest = _sha256(path)
    result.update({"sha256": digest, "bytes": path.stat().st_size})
    if digest != declaration.get("sha256"):
        errors.append("SHA256 mismatch")
    if result["bytes"] != declaration.get("bytes"):
        errors.append("file length mismatch")
    with path.open("rb") as handle:
        header = handle.read(33)
    if len(header) != 33 or header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
        errors.append("invalid PNG signature/header")
        return result
    width, height, bits, color_type, compression, filter_method, interlace = struct.unpack(
        ">IIBBBBB", header[16:29]
    )
    components = {0: 1, 2: 3, 6: 4}.get(color_type)
    result["png_header"] = {
        "width": width,
        "height": height,
        "bit_depth": bits,
        "channels": components,
        "color_type": color_type,
    }
    if (
        (width, height) != (resolution, resolution)
        or components != expected_channels
        or bits != declaration.get("bit_depth")
    ):
        errors.append(
            "PNG header resolution/channel count/bit depth does not match manifest contract"
        )
        return result
    if compression != 0 or filter_method != 0 or interlace not in (0, 1):
        errors.append("unsupported PNG header encoding")
        return result
    try:
        with Image.open(path) as check:
            check.verify()
        with Image.open(path) as image:
            image.load()
            if image.size != (width, height) or len(image.getbands()) != expected_channels:
                errors.append("decoded pixel shape differs from PNG declaration")
            result["diagnostics"] = image_diagnostics(image, bits, normal)
        if normal:
            n = result["diagnostics"]["normal"]
            if (
                n["nonfinite_components"]
                or n["max_length_error"] > n["quantization_tolerance"]
                or n["min_tangent_z"] < -1 / 255
            ):
                errors.append(
                    "decoded normals are nonfinite, nonunit, or face below tangent surface"
                )
    except (OSError, SyntaxError, ValueError) as exc:
        errors.append(f"PNG decode/integrity failure: {exc}")
    return result


def qualify_report(report: dict) -> dict:
    """Keep technical integrity separate from unperformed scientific validation."""
    report["source_digest_scope"] = (
        "Generator hashes describe source files read at manifest creation; matching the current checkout does not independently prove which Python bytecode was loaded if a source file changed while an export process was running."
    )
    report["gates"] = {
        "engineering_integrity": "passed"
        if report["all_complete_and_passed"]
        else (
            "incomplete"
            if report["counts"]["incomplete"]
            and not report["counts"]["failed"]
            and not report["errors"]
            else "failed"
        ),
        "photorealism": "not_assessed",
        "clinical_training_validity": "not_assessed",
        "patient_specific_fidelity": "not_assessed",
    }
    report["source_digest_differences"] = [
        {"material": material["id"], "file": filename, **values}
        for material in report["materials"]
        for filename, values in material.get("generator_source_digests", {}).items()
        if not values["matches"]
    ]
    return report


def audit_library(
    root: Path, *, resolution: int = 4096, expected_count: int | None = None, preview: bool = False
) -> dict:
    start = time.perf_counter()
    root = root.resolve()
    report = {
        "schema": "viscera.tissue-artifact-audit/v1",
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "library": str(root),
        "resolution": [resolution, resolution],
        "mode": "preview" if preview else "native",
        "qualification": "Engineering integrity diagnostics only; no realism score, clinical validation, patient-fidelity evidence or fair comparison against lit photographs.",
        "seam_definition": "Absolute opposite-edge pixel difference divided by mean adjacent pixel differences near those same edges; null for zero denominator. Pixel centers differ across a repeat seam, so equal edge pixels are not required. No seam ratio is treated as a realism or automatic pass threshold.",
        "errors": [],
        "materials": [],
    }
    try:
        catalog_path = root / "catalog.json"
        catalog = json.loads(catalog_path.read_text())
        report["catalog_sha256"] = _sha256(catalog_path)
        if catalog.get("schema") != "viscera.tissue-catalog/v1" or not isinstance(
            catalog.get("materials"), list
        ):
            raise ValueError("invalid catalog schema/materials")
        seen_ids, seen_paths = set(), set()
        for entry in catalog["materials"]:
            material = {"id": entry.get("id"), "status": "passed", "errors": [], "assets": []}
            report["materials"].append(material)
            try:
                identifier = entry.get("id")
                if (
                    not isinstance(identifier, str)
                    or not re.fullmatch(r"[a-z][a-z0-9_]*", identifier)
                    or identifier in seen_ids
                ):
                    raise ValueError("invalid or duplicated catalog material ID")
                seen_ids.add(identifier)
                path = safe_path(root, entry.get("preview" if preview else "manifest"))
                if path in seen_paths:
                    raise ValueError("catalog entries share a manifest path")
                seen_paths.add(path)
                if not path.is_file():
                    material["status"] = "incomplete"
                    material["errors"].append(
                        "manifest not published; generation is incomplete or absent"
                    )
                    continue
                before = path.read_bytes()
                manifest = json.loads(before)
                material["manifest_sha256"] = hashlib.sha256(before).hexdigest()
                material["errors"] += validate_manifest(manifest, resolution)
                if material["errors"]:
                    material["status"] = "failed"
                    continue
                material["recipe"] = manifest["recipe"]
                material["seed_decimal"] = manifest["provenance"]["seed_decimal"]
                declared_paths = set()
                for name, declaration in [
                    *manifest["channels"].items(),
                    *((layer["id"], layer) for layer in manifest["layers"]),
                ]:
                    asset_path = safe_path(path.parent, declaration.get("file"))
                    if asset_path in declared_paths:
                        raise ValueError("multiple channel/layer declarations share an image path")
                    declared_paths.add(asset_path)
                    channels = CHANNELS[name][0] if name in CHANNELS else 4
                    asset = audit_asset(
                        asset_path, declaration, channels, resolution, normal=name in ("normal", "substrate_normal")
                    )
                    asset["id"] = name
                    material["assets"].append(asset)
                    material["errors"] += [f"{name}: {error}" for error in asset["errors"]]
                if not path.is_file() or path.read_bytes() != before:
                    material["errors"].append(
                        "manifest changed during audit; repeat after writer finishes"
                    )
                source_root = (
                    Path(__file__).resolve().parents[1] / "py/viscera_core/tissue_materials"
                )
                current_matches = {}
                source_digests = {}
                for filename, digest in manifest["provenance"]["source_sha256"].items():
                    source = safe_path(source_root, filename)
                    current_digest = _sha256(source) if source.is_file() else None
                    current_matches[filename] = current_digest == digest
                    source_digests[filename] = {
                        "declared_sha256": digest,
                        "current_sha256": current_digest,
                        "matches": current_digest == digest,
                    }
                material["generator_sources_match_current_checkout"] = current_matches
                material["generator_source_digests"] = source_digests
                # Source drift is provenance, not proof of bad historical pixels.
                if material["errors"]:
                    material["status"] = "failed"
            except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
                material["status"] = "failed"
                material["errors"].append(str(exc))
        if not catalog["materials"]:
            report["errors"].append("catalog contains no materials")
        if expected_count is not None and len(catalog["materials"]) != expected_count:
            report["errors"].append(
                f"expected {expected_count} materials, catalog declares {len(catalog['materials'])}"
            )
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        report["errors"].append(str(exc))
    counts = {
        state: sum(x["status"] == state for x in report["materials"])
        for state in ("passed", "failed", "incomplete")
    }
    report["counts"] = counts
    report["all_complete_and_passed"] = (
        bool(counts["passed"])
        and not report["errors"]
        and not counts["failed"]
        and not counts["incomplete"]
    )
    report["elapsed_seconds"] = time.perf_counter() - start
    return qualify_report(report)


def main() -> None:
    viscera = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--library", type=Path, default=viscera / "apps/studio/public/tissue-materials"
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=viscera / "artifacts/tissue-materials-2026-10-19/native-audit.json",
    )
    parser.add_argument("--expected-count", type=int, default=21)
    parser.add_argument("--preview", action="store_true")
    args = parser.parse_args()
    report = audit_library(
        args.library,
        resolution=512 if args.preview else 4096,
        expected_count=args.expected_count,
        preview=args.preview,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(
        json.dumps(
            {
                "receipt": str(args.output),
                "counts": report["counts"],
                "all_complete_and_passed": report["all_complete_and_passed"],
                "seconds": report["elapsed_seconds"],
            }
        ),
        flush=True,
    )
    raise SystemExit(0 if report["all_complete_and_passed"] else 1)


if __name__ == "__main__":
    main()
