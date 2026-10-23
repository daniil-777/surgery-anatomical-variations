"""Read native derived patches without resizing or opening test payloads implicitly."""

from __future__ import annotations

import io

import numpy as np
from PIL import Image

from viscera_core.tissue_learning.data import InsufficientCoverageError, TissueDataset, read_blob


class NativePatchDataset(TissueDataset):
    def load(self, index, patch_size, *, crop_seed=None, minimum_valid_fraction=.5):
        if patch_size != 128:
            raise ValueError("native patch loader requires 128px; no silent resizing")
        row = self.records[index]
        if not row.get("mask_path"):
            raise ValueError("detail training requires an explicit valid-tissue mask")
        with Image.open(io.BytesIO(read_blob(self.root, row, "image"))) as image:
            if image.mode != "RGB" or image.size != (128, 128):
                raise ValueError("expected a native 128x128 RGB patch")
            rgb = np.asarray(image, dtype=np.float32) / 255
        with Image.open(io.BytesIO(read_blob(self.root, row, "mask"))) as image:
            if image.mode not in ("L", "1") or image.size != (128, 128):
                raise ValueError("expected a matching native 128x128 mask")
            valid = np.asarray(image.convert("L")) >= 128
        # The prepared mask already records its source glare/dark exclusions.
        # Preserve those exact bits; a second heuristic could invalidate a crop
        # after release qualification and conceal a change in the data contract.
        coverage = float(valid.mean())
        if coverage < minimum_valid_fraction:
            raise InsufficientCoverageError(row["id"], coverage)
        if crop_seed is not None:
            # Dihedral augmentation preserves every pixel and mask bit. The
            # sampler owns this seed; no global Torch/NumPy RNG is consumed.
            rng = np.random.default_rng(crop_seed)
            turns, flip = int(rng.integers(4)), bool(rng.integers(2))
            rgb, valid = np.rot90(rgb, turns), np.rot90(valid, turns)
            if flip:
                rgb, valid = rgb[:, ::-1], valid[:, ::-1]
        return (rgb.transpose(2, 0, 1).copy(), valid[None].astype(np.float32),
                self.conditions.index(row["condition"]))
