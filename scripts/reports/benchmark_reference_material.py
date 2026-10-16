"""Repeatable appearance-transfer audit; synthetic color truth is not tissue optics.

Run from viscera: .venv/bin/python scripts/reports/benchmark_reference_material.py
The DRENDS observation is a workflow smoke, without segmentation/albedo ground truth.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "py"))

from viscera_core.reference_analysis import (  # noqa: E402
    RegionSelection,
    analyze_image,
    decode_photo,
    extract_observed_color,
    local_segment,
)
from viscera_core.reference_color import from_linear, gamut_srgb, to_linear, to_oklab  # noqa: E402

# Frozen before running the audit: colors, perturbations, and aggregate criteria
# are shared across cases. No per-image threshold optimization is performed.
COLORS = {
    "red": (160, 78, 68),
    "pink": (192, 135, 126),
    "pale": (203, 170, 151),
    "olive": (123, 138, 80),
}
CONTAMINATION = (0.0, 0.15, 0.30, 0.45)
SEEDS = (7, 23, 91)


def synthetic_case(
    color: tuple[int, int, int] = COLORS["red"],
    contamination: float = 0.30,
    seed: int = 7,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return contaminated RGB, geometric mask, and clean observed RGB.

    The clean image includes a fixed multiplicative lighting gradient and weak
    sensor-like noise. Its median observed color is the comparison target;
    the target is deliberately not the pre-illumination material albedo.
    """
    h, w = 128, 160
    y, x = np.mgrid[:h, :w]
    mask = ((x - 80) / 53) ** 2 + ((y - 64) / 43) ** 2 <= 1
    shade = 0.70 + 0.40 * x / (w - 1)
    clean = np.broadcast_to(np.array([32, 77, 104], dtype=np.uint8), (h, w, 3)).copy()
    tissue = from_linear(to_linear(np.asarray(color) / 255) * shade[..., None])
    rng = np.random.default_rng(seed)
    tissue += rng.normal(0, 0.003, tissue.shape)
    clean[mask] = np.rint(np.clip(tissue[mask], 0, 1) * 255).astype(np.uint8)
    rgb = clean.copy()
    indices = np.flatnonzero(mask)
    count = int(len(indices) * contamination)
    selected = rng.permutation(indices)[:count]
    flat = rgb.reshape(-1, 3)
    for part, contaminant in zip(
        np.array_split(selected, 3), ((255, 255, 255), (8, 9, 12), (35, 105, 208)), strict=True
    ):
        flat[part] = contaminant
    return rgb, mask, clean


def synthetic_segmentation_case() -> tuple[Image.Image, np.ndarray, RegionSelection]:
    rgb, mask, _ = synthetic_case(contamination=0)
    selection = RegionSelection(box=(0.10, 0.10, 0.90, 0.90), foreground_points=[(0.5, 0.5)])
    return Image.fromarray(rgb), mask, selection


def color_error(rgb: Any, target_oklab: np.ndarray) -> dict[str, float]:
    delta = to_oklab(rgb) - target_oklab
    return {"oklab_distance": float(np.linalg.norm(delta)),
            "oklab_chroma_distance": float(np.linalg.norm(delta[1:])),
            "oklab_lightness_abs": float(abs(delta[0]))}


def synthetic_benchmark(output: Path) -> dict[str, Any]:
    cases = []
    for name, color in COLORS.items():
        for contamination in CONTAMINATION:
            for seed in SEEDS:
                rgb, mask, clean = synthetic_case(color, contamination, seed)
                target = np.median(to_oklab(clean[mask] / 255), axis=0)
                start = time.perf_counter()
                robust = extract_observed_color(rgb, mask)
                elapsed = time.perf_counter() - start
                estimates = {
                    "whole_image_srgb_mean": np.mean(rgb / 255, axis=(0, 1)),
                    "masked_srgb_mean": np.mean(rgb[mask] / 255, axis=0),
                    "masked_oklab_mean": gamut_srgb(np.mean(to_oklab(rgb[mask] / 255), axis=0)),
                    "masked_oklab_median": gamut_srgb(np.median(to_oklab(rgb[mask] / 255), axis=0)),
                    "filtered_oklab_median": robust["observed_color_srgb"],
                }
                cases.append({
                    "color_family": name, "seed": seed, "contamination_fraction": contamination,
                    "target_observed_srgb": gamut_srgb(target).tolist(),
                    "errors": {key: color_error(value, target) for key, value in estimates.items()},
                    "analysis_seconds": elapsed, "quality": robust["quality"],
                })
    contaminated = [case for case in cases if case["contamination_fraction"] > 0]
    clean_cases = [case for case in cases if case["contamination_fraction"] == 0]
    metrics = {
        method: {
            metric: float(np.mean([case["errors"][method][metric] for case in contaminated]))
            for metric in ("oklab_distance", "oklab_chroma_distance", "oklab_lightness_abs")
        }
        for method in cases[0]["errors"]
    }
    gates = {
        "filtered_chroma_better_than_contaminated_masked_mean":
            metrics["filtered_oklab_median"]["oklab_chroma_distance"]
            < metrics["masked_srgb_mean"]["oklab_chroma_distance"],
        "filtered_chroma_better_than_whole_image_mean":
            metrics["filtered_oklab_median"]["oklab_chroma_distance"]
            < metrics["whole_image_srgb_mean"]["oklab_chroma_distance"],
        "clean_observed_color_max_oklab_error_under_001":
            max(case["errors"]["filtered_oklab_median"]["oklab_distance"] for case in clean_cases)
            < .01,
    }
    rgb, mask, _ = synthetic_case()
    preview = analyze_image(Image.fromarray(rgb), mask, "liver", hashlib.sha256(rgb.tobytes()).hexdigest(),
                            {"method": "synthetic-known-geometric-mask", "semantic_identity": "synthetic"}, [])
    Image.fromarray(rgb).save(output / "synthetic-reference.png")
    (output / "synthetic-overlay.png").write_bytes(base64.b64decode(preview["overlay_png_base64"]))
    image, truth, selection = synthetic_segmentation_case()
    start = time.perf_counter()
    segmented, metadata = local_segment(image, selection)
    iou = float(np.sum(segmented & truth) / np.sum(segmented | truth))
    gates["simple_synthetic_region_iou_over_090"] = iou > .90
    return {"status": "PASS" if all(gates.values()) else "FAIL", "gates": gates,
            "case_count": len(cases), "contaminated_aggregate_errors": metrics, "cases": cases,
            "segmentation": {"iou": iou, "seconds": time.perf_counter() - start,
                             "metadata": metadata, "ground_truth": "synthetic ellipse only"},
            "scope": "Known clean observed RGB under synthetic lighting; not calibrated tissue optics.",
            "reinhard_note": "Masked OKLab moments are a location-statistic baseline inspired by statistical transfer; this does not implement or benchmark full Reinhard image transfer."}


def drends_smoke(output: Path) -> dict[str, Any]:
    path = ROOT / "artifacts/ground-truth/drends-pilot/review/frame-00020-left.png"
    attribution = {
        "dataset": "DRENDS", "doi": "https://doi.org/10.5281/zenodo.17598453",
        "authors": "Gerardo Loza, Mattia Magro, Benjamin Calmé, Junlei Hu, Dominic Jones, Elena De Momi, Sharib Ali and Pietro Valdastri",
        "license": "CC BY 4.0", "license_url": "https://creativecommons.org/licenses/by/4.0/",
        "specimen": "porcine ex-vivo colon", "sequence": "Seq01_Colon_Med",
        "changes": "VISCERA frame extraction, resize, manually selected color region, algorithm overlay and swatches",
    }
    if not path.exists():
        return {"status": "NOT_RUN", "reason": "Local DRENDS extracted frame missing", "attribution": attribution}
    raw = path.read_bytes()
    image, original, notices = decode_photo(raw)
    # This local region was selected after viewing the original frame. It is
    # neither a full-organ annotation nor an independently validated tissue mask.
    polygon = [(0.22, .28), (.40, .27), (.47, .37), (.43, .50), (.29, .60), (.20, .45)]
    region = Image.new("L", image.size, 0)
    ImageDraw.Draw(region).polygon([(round(x * image.width), round(y * image.height)) for x, y in polygon], fill=255)
    mask = np.asarray(region) > 0
    start = time.perf_counter()
    result = analyze_image(image, mask, "large-intestine", hashlib.sha256(raw).hexdigest(), {
        "method": "manually-selected-observation-region", "learned": False,
        "semantic_identity": "dataset-specimen-context", "review_required": True,
        "ground_truth": False,
    }, notices)
    (output / "drends-color-overlay.png").write_bytes(base64.b64decode(result.pop("overlay_png_base64")))
    (output / "drends-selection.png").write_bytes(base64.b64decode(result.pop("mask_png_base64")))
    image.save(output / "drends-reference.png")
    local_prompts = RegionSelection(box=(.15, .18, .55, .66), foreground_points=[(.35, .40)],
                                    background_points=[(.18, .21), (.52, .60)])
    local_mask, local_metadata = local_segment(image, local_prompts)
    local_result = analyze_image(image, local_mask, "large-intestine", hashlib.sha256(raw).hexdigest(),
                                 local_metadata, notices)
    (output / "drends-local-overlay.png").write_bytes(base64.b64decode(local_result.pop("overlay_png_base64")))
    (output / "drends-local-selection.png").write_bytes(base64.b64decode(local_result.pop("mask_png_base64")))
    return {"status": "PASS", "analysis_seconds": time.perf_counter() - start,
            "source_path": str(path.relative_to(ROOT)), "original_oriented_size": list(original),
            "normalized_polygon": polygon, "result": result, "attribution": attribution,
            "local_prompted_selection": {"prompts": local_prompts.model_dump(), "result": local_result,
                                         "segmentation_accuracy": "NOT_MEASURED",
                                         "scope": "Appearance-connected proposal bounded by supplied box, not an organ ground-truth annotation."},
            "segmentation_accuracy": "NOT_MEASURED", "albedo_error": "NOT_MEASURED",
            "scope": "Actual-image decode, reviewed-region extraction and overlay smoke only. No anatomical recognition, measured reflectance, human tissue or patient generalization claim."}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "benchmarks/results/reference-material-2026-10-08")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    synthetic = synthetic_benchmark(args.output)
    real = drends_smoke(args.output)
    report = {"version": "reference-material-benchmark-1", "date": "2026-10-08",
              "synthetic": synthetic, "real_image_smoke": real,
              "external_models_run": [], "independent_surgical_validation": "NOT_RUN"}
    destination = args.output / "benchmark.json"
    destination.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"report": str(destination), "synthetic_status": synthetic["status"],
                      "cases": synthetic["case_count"], "real_image_smoke": real["status"]}))
    if synthetic["status"] != "PASS":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
