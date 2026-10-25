"""Fit a nonparametric appearance model to verified generated research tiles.

PCA decorrelation and empirical Gaussianization allow histogram-preserving
periodic blending in the browser. This does not recover intrinsic tissue optics.
"""

import argparse, base64, hashlib, json
from pathlib import Path
import numpy as np
from PIL import Image
from scipy.special import ndtri

FAMILIES = ["liver", "spleen", "stomach", "small_bowel", "large_bowel", "pancreas"]


def periodicize(a, width=24):
    a = a.copy()
    for axis in (0, 1):
        a = np.swapaxes(a, 0, axis)
        for d in range(width):
            w = 0.5 * (1 + np.cos(np.pi * d / width))
            middle = (a[d] + a[-1 - d]) * 0.5
            a[d] = a[d] * (1 - w) + middle * w
            a[-1 - d] = a[-1 - d] * (1 - w) + middle * w
        a = np.swapaxes(a, 0, axis)
    return a


def fit(root, output):
    output.mkdir(parents=True, exist_ok=True)
    models = []
    report = {}
    for family in FAMILIES:
        sources = []
        images = []
        for seed in range(1, 5):
            directory = root / f"learned-clean-{family}-s{seed}" / "preview"
            m = json.loads((directory / "manifest.json").read_text())
            path = directory / m["channels"]["substrate"]["file"]
            raw = path.read_bytes()
            digest = hashlib.sha256(raw).hexdigest()
            assert digest == m["channels"]["substrate"]["sha256"]
            rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.float64) / 255
            assert rgb.shape == (512, 512, 3)
            images.append(
                periodicize(np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4))
            )
            sources.append(
                {
                    "path": str(path.relative_to(root)),
                    "sha256": digest,
                    "provenance": m.get("provenance", {}),
                    "license": m.get("license"),
                }
            )
        stack = np.stack(images)
        samples = stack.reshape(-1, 3)
        mean = samples.mean(0)
        _, axes = np.linalg.eigh(np.cov(samples.T))
        basis = axes[:, ::-1].T
        projected = (samples - mean) @ basis.T
        probabilities = np.linspace(0, 1, 1025)
        quantiles = np.quantile(projected, probabilities, axis=0).T
        gaussian = np.empty_like(projected)
        for c in range(3):
            gaussian[:, c] = ndtri(
                np.clip(np.interp(projected[:, c], quantiles[c], probabilities), 0.000233, 0.999767)
            )
        packed = np.rint((np.clip(gaussian, -3.5, 3.5) + 3.5) / 7 * 255).astype(np.uint8).tobytes()
        srgb = np.where(stack <= 0.0031308, stack * 12.92, 1.055 * stack ** (1 / 2.4) - 0.055)
        artifact = {
            "schema": "viscera.tissue-exemplar/v1",
            "model_type": "pca-histogram-preserving-exemplar",
            "architecture": {
                "latent_dim": 16,
                "condition_labels": [f"human:laparoscopic_exterior:{family}"],
                "condition_regions": [family],
                "condition_species": ["human"],
                "native_resolution": [512, 512],
                "exemplar_count": 4,
                "gaussian_range": 3.5,
            },
            "statistics": {
                "mean": mean.tolist(),
                "basis": basis.tolist(),
                "quantiles": quantiles.tolist(),
            },
            "weights": {
                "encoding": "base64-u8",
                "sha256": hashlib.sha256(packed).hexdigest(),
                "byte_length": len(packed),
                "data_base64": base64.b64encode(packed).decode(),
            },
            "output": {
                "kind": "observed_rgb_appearance",
                "color_space": "srgb",
                "channels": ["r", "g", "b"],
                "binding": "fixed-rest-uv",
                "pbr_ground_truth": False,
                "clinically_validated": False,
            },
            "provenance": {
                "training_status": "exemplar_fitted",
                "qualification": "engineering_unqualified",
                "training_native_patch_size": 512,
                "source_type": "generated-research-tile-exemplars",
                "method": "PCA decorrelation, empirical Gaussianization, variance-preserving periodic blending",
                "training_profile": "noncommercial-research",
                "sources": sources,
                "source_gradient_mean_srgb": float(np.mean(np.abs(np.diff(srgb, axis=2)))) * 255,
                "source_red_range_srgb": float(np.ptp(srgb[..., 0])) * 255,
            },
            "seed_algorithm": "sha256-box-muller-f32-v1",
        }
        name = f"exemplar-{family}.tissue-model.json"
        data = json.dumps(artifact, separators=(",", ":"), allow_nan=False).encode()
        (output / name).write_bytes(data)
        models.append(
            {
                "id": f"exemplar-{family}",
                "label": "Generative Model 13",
                "path": f"tissue-models/{name}",
                "schema": artifact["schema"],
                "model_type": artifact["model_type"],
                "training_status": "exemplar_fitted",
                "training_steps": 0,
                "patch_size": 512,
                "regions": [family],
                "conditions": artifact["architecture"]["condition_labels"],
                "rank": 0,
                "recommended": True,
                "sha256": hashlib.sha256(data).hexdigest(),
                "bytes": len(data),
            }
        )
        report[family] = {
            "source_count": 4,
            "source_resolution": [512, 512],
            "bytes": len(data),
            "mean_linear_rgb": mean.tolist(),
            "source_hashes": [s["sha256"] for s in sources],
        }
    path = output / "catalog.json"
    catalog = json.loads(path.read_text())
    old = [m for m in catalog["appearance_models"] if not m["id"].startswith("exemplar-")]
    for m in old:
        m["recommended"] = False
        m["rank"] = max(10, m["rank"])
    catalog["appearance_models"] = models + old
    catalog["best_appearance_model_id"] = "exemplar-liver"
    catalog["pbr_bundles"] = [
        b for b in catalog["pbr_bundles"] if (root.parent / b["path"]).is_file()
    ]
    path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n")
    return report


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--library", type=Path, default=Path("apps/studio/public/tissue-materials"))
    p.add_argument("--output", type=Path, default=Path("apps/studio/public/tissue-models"))
    p.add_argument("--report", type=Path, required=True)
    a = p.parse_args()
    a.report.write_text(json.dumps(fit(a.library, a.output), indent=2) + "\n")
