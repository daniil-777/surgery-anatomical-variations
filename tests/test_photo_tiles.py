"""The photo-derived detail tiles: seamless, hole-free, mean-preserving, with a faithful inverse lookup."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from pipelines.textures.photo_tiles import gaussianize, seamless

ROOT = Path(__file__).resolve().parents[1]
TEXTURES = ROOT / "apps/studio/public/textures"


def test_seamless_edges_match_like_neighbours() -> None:
    rng = np.random.default_rng(3)
    base = rng.random((96, 96, 3))
    from scipy import ndimage
    smooth = ndimage.uniform_filter(base, size=(7, 7, 1))
    smooth[:, :20] += 0.3   # a hard vertical step away from the centre: the original edges are anything but seamless
    tile = seamless(smooth)
    inner_x = np.mean(np.abs(np.diff(tile, axis=1)))
    wrap_x = np.mean(np.abs(tile[:, 0] - tile[:, -1]))
    inner_y = np.mean(np.abs(np.diff(tile, axis=0)))
    wrap_y = np.mean(np.abs(tile[0, :] - tile[-1, :]))
    assert wrap_x < 2.0 * inner_x and wrap_y < 2.0 * inner_y
    assert abs(tile.mean() - smooth.mean()) < 0.02


def test_gaussianize_roundtrip() -> None:
    rng = np.random.default_rng(7)
    tile8 = (rng.beta(2, 5, (64, 64, 3)) * 255).astype(np.uint8)
    gauss, lut = gaussianize(tile8)
    for c in range(3):
        back = lut[gauss[..., c], c].astype(float)
        assert np.mean(np.abs(back - tile8[..., c])) < 2.0   # within two 8-bit steps on average
        assert abs(gauss[..., c].astype(float).mean() - 127.5) < 3   # Gaussianised around the middle


@pytest.mark.skipif(not (TEXTURES / "manifest.json").exists(), reason="tiles not built")
def test_built_tiles_are_consistent() -> None:
    manifest = json.loads((TEXTURES / "manifest.json").read_text())
    assert manifest["organs"], "no organ tiles"
    for organ, info in manifest["organs"].items():
        albedo = np.asarray(Image.open(TEXTURES / info["files"]["albedo"]).convert("RGB"))
        gauss = np.asarray(Image.open(TEXTURES / info["files"]["gauss"]).convert("RGB"))
        lut = np.asarray(Image.open(TEXTURES / info["files"]["lut"]).convert("RGB"))[0]
        assert albedo.shape == gauss.shape and albedo.shape[0] == albedo.shape[1] == info["side_px"], organ
        assert lut.shape == (256, 3)
        for c in range(3):
            assert np.mean(np.abs(lut[gauss[..., c], c].astype(float) - albedo[..., c])) < 2.5, f"{organ}: lookup drifts"
        assert info["seam_ratio_x"] < 1.6 and info["seam_ratio_y"] < 1.6, f"{organ}: seams"
        assert info["source"]["license"] and info["source"]["photo_sha256"], f"{organ}: provenance"
        assert all(0 < v < 1 for v in info["mean_linear"]), organ
