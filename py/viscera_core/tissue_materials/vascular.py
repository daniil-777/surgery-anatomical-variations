"""Deterministic smooth, tapered vessel priors, independent of material shading.

These are appearance graphs on a periodic patch, not anatomical vascular trees.
Depth is an authored optical-softening parameter, not measured tissue depth.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import gaussian_filter

RASTER_SIZE = 2048


@dataclass(frozen=True)
class VesselPath:
    points: np.ndarray
    radii: np.ndarray
    kind: int
    depth: float
    parent: int | None
    attachment: int | None


def vessel_graph(seed: int) -> tuple[VesselPath, ...]:
    """Continuous parent trunks with tangent-matched lateral branches and tapered tips."""
    rng = np.random.default_rng(np.random.SeedSequence([seed, 902]))
    paths: list[VesselPath] = []

    def branch(
        origin: np.ndarray,
        heading: float,
        length: float,
        radius: float,
        levels: int,
        kind: int,
        depth: float,
        bend: float,
        parent: int | None = None,
        attachment: int | None = None,
    ) -> None:
        steps = 96
        t = np.linspace(0, 1, steps, dtype=np.float64)
        # Smooth angle changes, with a zero derivative at the attachment. The
        # first segment is exactly aligned to the parent's local tangent.
        turn = t if parent is None else np.minimum(t / 0.42, 1)
        ease = turn * turn * (3 - 2 * turn)
        angles = heading + bend * ease + rng.uniform(-0.24, 0.24) * np.sin(np.pi * t) ** 2
        increments = np.stack((np.cos(angles), np.sin(angles)), -1) * length / steps
        points = np.concatenate((origin[None], origin[None] + np.cumsum(increments, axis=0)))
        s = np.linspace(0, 1, steps + 1)
        # A narrow distal continuation avoids a blunt painted endpoint.
        radii = radius * (1 - s) ** 0.80
        if parent is None:
            # The unobserved upstream trunk recedes into tissue instead of
            # leaving a blunt cut vessel end in the middle of a material tile.
            emergence = np.minimum(s / 0.14, 1)
            radii *= emergence * emergence * (3 - 2 * emergence)
        points.setflags(write=False)
        radii.setflags(write=False)
        index = len(paths)
        paths.append(VesselPath(points, radii, kind, depth, parent, attachment))
        if levels:
            for i, fraction in enumerate((0.28, 0.48, 0.68)):
                at = round((fraction + rng.uniform(-0.045, 0.045)) * steps)
                tangent = points[at + 1] - points[at]
                sign = -1 if (index + i) % 2 else 1
                branch(
                    points[at],
                    float(np.arctan2(tangent[1], tangent[0])),
                    length * rng.uniform(0.29, 0.43),
                    float(radii[at]) * rng.uniform(0.48, 0.64),
                    levels - 1,
                    kind,
                    min(0.9, depth + rng.uniform(0.08, 0.18)),
                    sign * rng.uniform(0.70, 1.25),
                    index,
                    at,
                )

    for i in range(4):
        branch(
            rng.uniform(0, 1, 2),
            float(rng.uniform(0, 2 * np.pi)),
            float(rng.uniform(0.62, 0.85)),
            float(rng.uniform(0.0028, 0.0044)),
            3,
            i % 2,
            float(rng.uniform(0.12, 0.48)),
            float(rng.uniform(-1.6, 1.6)),
        )
    return tuple(paths)


def _ribbon(drawer: ImageDraw.ImageDraw, path: VesselPath, size: int, alpha: int) -> None:
    tangent = np.gradient(path.points, axis=0)
    tangent /= np.linalg.norm(tangent, axis=-1, keepdims=True)
    normals = np.stack((-tangent[:, 1], tangent[:, 0]), -1)
    left = path.points + normals * path.radii[:, None]
    right = path.points - normals * path.radii[:, None]
    polygon = np.concatenate((left, right[::-1])) * size
    for oy in (-size, 0, size):
        for ox in (-size, 0, size):
            shifted = polygon + [ox, oy]
            if np.any(shifted.max(axis=0) < 0) or np.any(shifted.min(axis=0) >= size):
                continue
            drawer.polygon([tuple(p) for p in shifted], fill=alpha)


@lru_cache(maxsize=3)
def vessel_tiles(seed: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return periodic artery/vein absorption coverage and shallow-vessel relief.

    Depth bins produce increasingly diffuse, weaker color; raised relief uses
    only the shallower network. Channels are immutable bounded 2048² arrays.
    """
    paths = vessel_graph(seed)
    result = [np.zeros((RASTER_SIZE, RASTER_SIZE), dtype=np.float32) for _ in range(3)]
    for depth_bin in range(3):
        images = [Image.new("L", (RASTER_SIZE, RASTER_SIZE)) for _ in range(2)]
        drawers = [ImageDraw.Draw(image) for image in images]
        for path in paths:
            if min(2, int(path.depth * 3)) == depth_bin:
                _ribbon(drawers[path.kind], path, RASTER_SIZE, round(255 * (1 - 0.52 * path.depth)))
        for kind, image in enumerate(images):
            coverage = np.asarray(image, dtype=np.float32) / 255
            softened = gaussian_filter(coverage, sigma=1.3 + depth_bin * 1.7, mode="wrap")
            result[kind] = 1 - (1 - result[kind]) * (1 - softened)
            if depth_bin < 2:
                relief = gaussian_filter(coverage, sigma=2.8 + depth_bin * 2, mode="wrap")
                result[2] = np.maximum(result[2], relief * (0.7 if depth_bin == 0 else 0.25))
    for tile in result:
        tile.setflags(write=False)
    return tuple(result)
