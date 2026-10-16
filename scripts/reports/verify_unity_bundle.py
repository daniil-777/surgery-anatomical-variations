#!/usr/bin/env python3
"""Inspect an actual exported Unity ZIP; write checks and a texture contact sheet."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def inspect_bundle(bundle: Path, output: Path) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(bundle) as archive:
        path = next(name for name in archive.namelist() if name.endswith("/manifest.json"))
        prefix = path.removesuffix("manifest.json")
        manifest = json.loads(archive.read(path))
        for name, info in manifest["files"].items():
            payload = archive.read(prefix + name)
            assert len(payload) == info["bytes"], name
            assert hashlib.sha256(payload).hexdigest() == info["sha256"], name
        mesh = json.loads(archive.read(prefix + "Anatomy.visceraunity"))
        p = np.asarray(mesh["positions"]).reshape(-1, 3)
        n = np.asarray(mesh["normals"]).reshape(-1, 3)
        t = np.asarray(mesh["tangents"]).reshape(-1, 4)
        f = np.asarray(mesh["indices"]).reshape(-1, 3)
        uv = np.asarray(mesh["uv"]).reshape(-1, 2)
        assert all(np.isfinite(a).all() for a in (p, n, t, uv))
        assert f.min() >= 0 and f.max() < len(p)
        assert np.max(np.abs(np.linalg.norm(n, axis=1) - 1)) < 1e-6
        assert np.max(np.abs(np.linalg.norm(t[:, :3], axis=1) - 1)) < 1e-6
        assert np.max(np.abs(np.sum(n * t[:, :3], axis=1))) < 1e-6
        assert set(t[:, 3]) <= {-1, 1}
        atlas_triangle = uv[f]
        assert np.all(np.abs(np.linalg.det(atlas_triangle[:, 1:] - atlas_triangle[:, :1])) > 1e-16)
        sheet = Image.new("RGB", (1440, 570), "#101b20")
        draw = ImageDraw.Draw(sheet)
        draw.text((24, 20), "VISCERA / UNITY 4K MATERIAL EXPORT", fill="#ecf1ed")
        maps = {}
        for i, name in enumerate(("BaseColor", "Normal", "Mask")):
            with Image.open(
                io.BytesIO(archive.read(prefix + f"Textures/Viscera_{name}.png"))
            ) as texture:
                texture.load()
                assert list(texture.size) == manifest["texture_resolution"]
                pixels = np.asarray(texture)
                maps[name] = {
                    "resolution": list(texture.size),
                    "mode": texture.mode,
                    "channel_min": pixels.min(axis=(0, 1)).tolist(),
                    "channel_max": pixels.max(axis=(0, 1)).tolist(),
                }
                if name == "Mask":
                    assert texture.mode == "RGBA"
                    assert np.all(pixels[:, :, 0] == 0) and np.all(pixels[:, :, 1] == 255)
                    assert np.all(pixels[:, :, 2] == 0)
                    preview = Image.fromarray(pixels[:, :, 3]).convert("RGB")
                else:
                    preview = texture.convert("RGB")
                preview.thumbnail((448, 448), Image.Resampling.LANCZOS)
                sheet.paste(preview, (24 + i * 480, 72))
                label = {
                    "BaseColor": "Base color / sRGB",
                    "Normal": "Tangent normals / Unity UV frame",
                    "Mask": "Packed mask / smoothness alpha shown",
                }[name]
                draw.text((24 + i * 480, 536), label, fill="#ecf1ed")
        sheet.save(output / "texture-inspection.png")
        report = {
            "bundle": bundle.name,
            "bytes": bundle.stat().st_size,
            "sha256": hashlib.sha256(bundle.read_bytes()).hexdigest(),
            "status": "PASS",
            "unity_editor_execution": "NOT_RUN",
            "checks": [
                "all manifest file SHA256s",
                "exact texture dimensions",
                "finite mesh arrays",
                "indices in range",
                "unit normals and tangents",
                "orthogonal tangent basis",
                "noncollapsed UV charts",
                "linear metallic/AO/detail defaults",
            ],
            "triangles": len(f),
            "chart_vertices": len(p),
            "extent_m": np.ptp(p, axis=0).tolist(),
            "maps": maps,
            "bake": manifest["bake"],
        }
        (output / "verification.json").write_text(json.dumps(report, indent=2))
        (output / "manifest.json").write_text(json.dumps(manifest, indent=2))
        return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = inspect_bundle(args.bundle, args.output)
    print(json.dumps({k: report[k] for k in ("status", "bytes", "triangles", "maps")}, indent=2))
