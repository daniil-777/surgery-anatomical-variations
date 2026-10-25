"""Independent invariants for the isolated tissue-material appearance baseline."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image
from viscera_core.tissue_materials import (
    ORGAN_PROFILES,
    TissueRecipe,
    export_material,
    linear_to_srgb,
    over_linear,
    sample_tissue,
    srgb_to_linear,
)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"seed": -1},
        {"seed": 2**64},
        {"seed": True},
        {"seed": 4.0},
        {"organ": "missing"},
        {"organ": []},
        {"transition_organ": "missing"},
        {"wetness": float("nan")},
        {"wetness": float("inf")},
        {"detail": -1},
        {"vessel_opacity": True},
        {"fascia_opacity": 1.1},
        {"adipose_opacity": -0.1},
        {"tile_size_mm": 0},
        {"transition_width": 0},
    ],
)
def test_recipe_rejects_invalid_controls(kwargs: dict) -> None:
    with pytest.raises(ValueError):
        TissueRecipe(**kwargs)


def test_color_compositing_uses_linear_light_and_straight_coverage() -> None:
    black = np.zeros((1, 3), dtype=np.float32)
    white = np.array([[1.0, 1.0, 1.0, 0.5]], dtype=np.float32)
    composed = over_linear(black, white)
    np.testing.assert_allclose(composed, 0.5)
    np.testing.assert_allclose(linear_to_srgb(composed), 0.73535698, atol=1e-6)
    values = np.array([0, 0.02, 0.04, 0.25, 0.5, 1], dtype=np.float32)
    np.testing.assert_allclose(linear_to_srgb(srgb_to_linear(values)), values, atol=1e-7)
    np.testing.assert_array_equal(over_linear(black, white, 0), black)


def test_periodic_fields_include_transition_and_every_layer() -> None:
    recipe = TissueRecipe(
        organ="heart",
        transition_organ="fascia",
        seed=2**64 - 1,
        fascia_opacity=0.4,
        adipose_opacity=0.3,
    )
    u, v = np.meshgrid(np.linspace(0.001, 0.999, 17), np.linspace(0.007, 0.997, 11))
    a, b = sample_tissue(recipe, u, v), sample_tissue(recipe, u + 1, v - 2)
    for name in ("base_color_linear", "height_mm", "roughness", "thickness_mm", "transition"):
        np.testing.assert_allclose(getattr(a, name), getattr(b, name), atol=2e-5)
    for name in a.layers:
        np.testing.assert_allclose(a.layers[name], b.layers[name], atol=2e-5)
    edge_u = np.array([0.0, 1.0, 0.23, 0.23])
    edge_v = np.array([0.37, 0.37, 0.0, 1.0])
    edge = sample_tissue(recipe, edge_u, edge_v)
    np.testing.assert_allclose(edge.height_mm[[0, 2]], edge.height_mm[[1, 3]], atol=1e-7)
    assert a.transition.min() == 0 and a.transition.max() == 1


def test_seed_uses_high_uint64_bits_and_sampling_is_repeatable() -> None:
    u, v = np.meshgrid(np.linspace(0, 1, 13), np.linspace(0, 1, 11))
    a = sample_tissue(TissueRecipe(seed=11), u, v)
    b = sample_tissue(TissueRecipe(seed=11), u, v)
    high = sample_tissue(TissueRecipe(seed=11 + 2**53), u, v)
    np.testing.assert_array_equal(a.base_color_linear, b.base_color_linear)
    assert not np.array_equal(a.base_color_linear, high.base_color_linear)


@pytest.mark.parametrize("organ", list(ORGAN_PROFILES))
def test_all_surface_families_have_finite_bounded_nonuniform_fields(organ: str) -> None:
    u, v = np.meshgrid(np.linspace(0, 1, 29), np.linspace(0, 1, 23))
    field = sample_tissue(TissueRecipe(organ=organ), u, v)
    for values in (
        field.substrate_linear,
        field.base_color_linear,
        field.height_mm,
        field.roughness,
        field.thickness_mm,
        *field.layers.values(),
    ):
        assert np.isfinite(values).all()
    assert field.base_color_linear.min() >= 0 and field.base_color_linear.max() <= 1
    assert 0.075 <= field.roughness.min() <= field.roughness.max() <= 0.85
    assert field.thickness_mm.min() >= 0.1
    assert np.std(field.height_mm) > 0.001
    assert np.std(field.base_color_linear[..., 0]) > 0.005
    for layer in field.layers.values():
        assert layer.shape == (*u.shape, 4)
        assert layer.min() >= 0 and layer.max() <= 1


def test_global_opacity_does_not_change_exportable_layer_coverage_or_substrate() -> None:
    u, v = np.meshgrid(np.linspace(0, 1, 19), np.linspace(0, 1, 17))
    baseline = sample_tissue(
        TissueRecipe(vessel_opacity=0, fascia_opacity=0, adipose_opacity=0), u, v
    )
    layered = sample_tissue(
        TissueRecipe(vessel_opacity=1, fascia_opacity=1, adipose_opacity=1), u, v
    )
    np.testing.assert_array_equal(baseline.substrate_linear, layered.substrate_linear)
    np.testing.assert_array_equal(baseline.base_color_linear, baseline.substrate_linear)
    for name in baseline.layers:
        np.testing.assert_array_equal(baseline.layers[name], layered.layers[name])
    assert not np.array_equal(layered.base_color_linear, baseline.base_color_linear)


def test_wet_film_changes_roughness_without_baking_highlights_into_color() -> None:
    u, v = np.meshgrid(np.linspace(0, 1, 11), np.linspace(0, 1, 13))
    dry = sample_tissue(TissueRecipe(wetness=0), u, v)
    wet = sample_tissue(TissueRecipe(wetness=1), u, v)
    np.testing.assert_array_equal(dry.base_color_linear, wet.base_color_linear)
    assert np.all(wet.roughness < dry.roughness)


def test_export_decodes_units_hashes_and_normals_from_independent_central_difference(
    tmp_path: Path,
) -> None:
    recipe = TissueRecipe(organ="pancreas", seed=2**64 - 1, adipose_opacity=0.35)
    manifest = export_material(recipe, tmp_path / "material", resolution=64, stripe_rows=9)
    saved = json.loads((tmp_path / "material" / "manifest.json").read_text())
    assert saved == manifest
    assert manifest["provenance"]["seed_decimal"] == str(2**64 - 1)
    assert manifest["provenance"]["clinically_validated"] is False
    for channel in [*manifest["channels"].values(), *manifest["layers"]]:
        path = tmp_path / "material" / channel["file"]
        assert hashlib.sha256(path.read_bytes()).hexdigest() == channel["sha256"]
        with Image.open(path) as image:
            assert image.size == (64, 64)
            if channel["bit_depth"] == 16:
                assert np.asarray(image).dtype == np.uint16
    u, v = np.meshgrid((np.arange(64) + 0.5) / 64, (np.arange(64) + 0.5) / 64)
    expected = sample_tissue(recipe, u, v, footprint_mm=recipe.tile_size_mm / 64)
    height = np.asarray(Image.open(tmp_path / "material" / "height.png")) / 65535 * 4 - 2
    np.testing.assert_allclose(height, expected.height_mm, atol=2 / 65535 + 1e-7)
    # Check the exported normal orientation and physical scale independently.
    spacing = recipe.tile_size_mm / 64
    dx = (np.roll(expected.height_mm, -1, axis=1) - np.roll(expected.height_mm, 1, axis=1)) / (
        2 * spacing
    )
    dy = (np.roll(expected.height_mm, -1, axis=0) - np.roll(expected.height_mm, 1, axis=0)) / (
        2 * spacing
    )
    normal = np.stack((-dx, dy, np.ones(dx.shape)), axis=-1)
    normal /= np.linalg.norm(normal, axis=-1, keepdims=True)
    decoded = np.asarray(Image.open(tmp_path / "material" / "normal.png")) / 255 * 2 - 1
    np.testing.assert_allclose(normal, decoded, atol=1 / 255 + 1e-7)


def test_normal_sign_matches_independent_surface_tangents_for_physical_height_ramp() -> None:
    from viscera_core.tissue_materials.export import _normal_from_height_halo

    # Raster row increases down, whereas surface tangent +Y points up. A ramp
    # h(x,y_up)=.3*x-.4*y_up has exact surface normal (-.3,+.4,1).
    y_down, x = np.mgrid[:9, :11].astype(float)
    height = 0.3 * x + 0.4 * y_down
    actual = _normal_from_height_halo(height, 1)
    expected = np.cross([1, 0, 0.3], [0, 1, -0.4])
    expected /= np.linalg.norm(expected)
    np.testing.assert_allclose(actual, np.broadcast_to(expected, actual.shape), atol=1e-7)


def test_scalar_sampling_matches_vector_sampling() -> None:
    recipe = TissueRecipe(seed=123)
    scalar = sample_tissue(recipe, 0.25, 0.75)
    vector = sample_tissue(recipe, np.array([0.25]), np.array([0.75]))
    np.testing.assert_array_equal(scalar.base_color_linear, vector.base_color_linear[0])


def test_organ_families_do_not_reuse_identical_vascular_layout() -> None:
    u, v = np.meshgrid(np.linspace(0, 1, 64), np.linspace(0, 1, 61))
    liver = sample_tissue(TissueRecipe(organ="liver"), u, v)
    kidney = sample_tissue(TissueRecipe(organ="kidney"), u, v)
    liver_support = liver.layers["vessels"][..., 3] > 0.05
    kidney_support = kidney.layers["vessels"][..., 3] > 0.05
    assert liver_support.any() and kidney_support.any()
    assert not np.array_equal(liver_support, kidney_support)


def test_stripe_partition_does_not_change_any_exported_pixels(tmp_path: Path) -> None:
    recipe = TissueRecipe(organ="heart", transition_organ="peritoneum")
    small = export_material(recipe, tmp_path / "a", resolution=64, stripe_rows=7)
    large = export_material(recipe, tmp_path / "b", resolution=64, stripe_rows=64)
    for channel in [*small["channels"].values(), *small["layers"]]:
        filename = channel["file"]
        a = np.asarray(Image.open(tmp_path / "a" / filename))
        b = np.asarray(Image.open(tmp_path / "b" / filename))
        np.testing.assert_array_equal(a, b)
    assert small["measurement"] == large["measurement"]


def test_export_protects_existing_assets_and_releases_lock(tmp_path: Path) -> None:
    target = tmp_path / "material"
    first = export_material(TissueRecipe(), target, resolution=32)
    with pytest.raises(FileExistsError):
        export_material(TissueRecipe(seed=2), target, resolution=32)
    assert json.loads((target / "manifest.json").read_text()) == first
    assert not (target / ".tissue-export.lock").exists()
    (target / ".tissue-export.lock").write_text("occupied")
    with pytest.raises(RuntimeError):
        export_material(TissueRecipe(), target, resolution=32)


def test_complete_manifest_is_published_after_every_image(tmp_path: Path, monkeypatch) -> None:
    import os

    real_replace = os.replace
    published = []

    def tracked_replace(source, destination):
        published.append(Path(destination).name)
        real_replace(source, destination)

    monkeypatch.setattr(os, "replace", tracked_replace)
    export_material(TissueRecipe(), tmp_path / "complete", resolution=32)
    assert published[-1] == "manifest.json"
    assert len(published) == 15


@pytest.mark.parametrize("resolution", [True, 0, 31, 4097, 64.0])
def test_export_rejects_invalid_resolution(tmp_path: Path, resolution) -> None:
    with pytest.raises(ValueError):
        export_material(TissueRecipe(), tmp_path, resolution=resolution)


def test_chromatic_variation_has_independent_color_axes_without_relief_coupling() -> None:
    u, v = np.meshgrid((np.arange(96) + 0.5) / 96, (np.arange(96) + 0.5) / 96)
    flat = sample_tissue(TissueRecipe(organ="gastric_mucosa", detail=0), u, v)
    relief = sample_tissue(TissueRecipe(organ="gastric_mucosa", detail=2), u, v)
    rgb = linear_to_srgb(flat.substrate_linear).reshape(-1, 3)
    eigenvalues = np.linalg.eigvalsh(np.cov(rgb.T))
    # The previous scalar-noise tint has rank one. Independent warm/pale/cool
    # variation must survive quantization without borrowing geometric shading.
    assert eigenvalues[0] / eigenvalues[-1] > 0.015
    np.testing.assert_array_equal(flat.substrate_linear, relief.substrate_linear)
    assert np.count_nonzero(flat.substrate_height_mm) == 0
    assert np.std(relief.substrate_height_mm) > 0.01


def test_vascular_geometry_has_smooth_connected_tapered_lateral_branches() -> None:
    from viscera_core.tissue_materials.vascular import vessel_graph

    graph = vessel_graph(2**64 - 1)
    assert len(graph) > 100
    for path in graph:
        assert not path.points.flags.writeable and not path.radii.flags.writeable
        assert np.isfinite(path.points).all() and np.isfinite(path.radii).all()
        assert path.radii[-1] == 0
        assert path.radii.max() > 0
        segments = np.diff(path.points, axis=0)
        headings = np.unwrap(np.arctan2(segments[:, 1], segments[:, 0]))
        assert np.max(np.abs(np.diff(headings))) < 0.07
        if path.parent is not None:
            parent = graph[path.parent]
            at = path.attachment
            np.testing.assert_array_equal(path.points[0], parent.points[at])
            parent_tangent = parent.points[at + 1] - parent.points[at]
            actual_tangent = path.points[1] - path.points[0]
            cosine = np.dot(parent_tangent, actual_tangent) / (
                np.linalg.norm(parent_tangent) * np.linalg.norm(actual_tangent)
            )
            assert cosine > 1 - 1e-10
            assert 0 < path.radii[0] < parent.radii[at]
            assert np.all(np.diff(path.radii) <= 0)
        else:
            assert path.radii[0] == 0  # no blunt exposed upstream endpoint
            peak = int(np.argmax(path.radii))
            assert np.all(np.diff(path.radii[peak:]) <= 0)


def test_mucosal_microrelief_has_no_steep_papery_high_frequency_normals() -> None:
    count = 256
    spacing = 80 / count
    u, v = np.meshgrid((np.arange(count) + 0.5) / count, (np.arange(count) + 0.5) / count)
    field = sample_tissue(TissueRecipe(organ="gastric_mucosa"), u, v, footprint_mm=spacing)
    dy, dx = np.gradient(field.substrate_height_mm, spacing)
    slope = np.hypot(dx, dy)
    # An authored slope envelope guards against the former corrugated paper
    # appearance; it is an engineering constraint, not a tissue measurement.
    assert np.quantile(slope, 0.99) < 0.08
    assert np.std(field.substrate_height_mm) > 0.015


def test_layer_heights_are_independent_and_exactly_reconstruct_combined_relief() -> None:
    u, v = np.meshgrid(np.linspace(0, 1, 37), np.linspace(0, 1, 31))
    clean = sample_tissue(
        TissueRecipe(organ="small_bowel", vessel_opacity=0, adipose_opacity=0, fascia_opacity=0),
        u,
        v,
    )
    mixed = sample_tissue(
        TissueRecipe(
            organ="small_bowel", vessel_opacity=0.25, adipose_opacity=0.6, fascia_opacity=0.9
        ),
        u,
        v,
    )
    np.testing.assert_array_equal(clean.height_mm, clean.substrate_height_mm)
    rebuilt = clean.substrate_height_mm.copy()
    for name, opacity in (("vessels", 0.25), ("fascia", 0.9), ("adipose", 0.6)):
        np.testing.assert_array_equal(clean.layer_height_mm[name], mixed.layer_height_mm[name])
        assert np.all(clean.layer_height_mm[name] >= 0)
        rebuilt += clean.layer_height_mm[name] * opacity
    np.testing.assert_array_equal(rebuilt, mixed.height_mm)


def test_exported_editable_relief_is_decodable_and_excludes_global_opacity(tmp_path: Path) -> None:
    recipe = TissueRecipe(organ="mesentery", vessel_opacity=0, adipose_opacity=0, fascia_opacity=0)
    manifest = export_material(recipe, tmp_path, resolution=64)
    channel = manifest["channels"]["layer_relief"]
    assert channel["packing"] == ["vessels", "adipose", "fascia"]
    assert channel["color_space"] == "linear"
    packed = np.asarray(Image.open(tmp_path / channel["file"])) / 255
    u, v = np.meshgrid((np.arange(64) + 0.5) / 64, (np.arange(64) + 0.5) / 64)
    field = sample_tissue(recipe, u, v, footprint_mm=80 / 64)
    for index, (name, scale) in enumerate(zip(channel["packing"], channel["decode_scale_mm"])):
        np.testing.assert_allclose(
            packed[..., index] * scale, field.layer_height_mm[name], atol=scale / 510 + 1e-8
        )
    assert packed.max() > 0
    substrate_normal = np.asarray(Image.open(tmp_path / "substrate_normal.png"))
    combined_normal = np.asarray(Image.open(tmp_path / "normal.png"))
    np.testing.assert_array_equal(substrate_normal, combined_normal)


@pytest.mark.parametrize("wetness,fascia", [(0, 0), (0, 1), (1, 0), (1, 1), (0.35, 0.72)])
def test_dry_roughness_is_independent_and_reconstructs_single_wet_application(
    wetness: float,
    fascia: float,
) -> None:
    u, v = np.meshgrid(np.linspace(0, 1, 31), np.linspace(0, 1, 29))
    dry = sample_tissue(TissueRecipe(wetness=0, fascia_opacity=0), u, v)
    adjusted = sample_tissue(TissueRecipe(wetness=wetness, fascia_opacity=fascia), u, v)
    np.testing.assert_array_equal(dry.substrate_roughness, adjusted.substrate_roughness)
    expected = np.clip(
        (dry.substrate_roughness + 0.10 * dry.layers["fascia"][..., 3] * fascia)
        * (1 - 0.57 * dry.layers["wet_film"][..., 3] * wetness),
        0.075,
        0.85,
    )
    np.testing.assert_allclose(adjusted.roughness, expected, atol=3e-8)


def test_exported_dry_roughness_has_independent_quantized_contract(tmp_path: Path) -> None:
    recipe = TissueRecipe(wetness=1, fascia_opacity=1)
    manifest = export_material(recipe, tmp_path, resolution=64)
    channel = manifest["channels"]["substrate_roughness"]
    assert channel["color_space"] == "linear" and channel["bit_depth"] == 8
    decoded = np.asarray(Image.open(tmp_path / channel["file"])) / 255
    u, v = np.meshgrid((np.arange(64) + 0.5) / 64, (np.arange(64) + 0.5) / 64)
    expected = sample_tissue(recipe, u, v, footprint_mm=80 / 64)
    np.testing.assert_allclose(decoded, expected.substrate_roughness, atol=1 / 510 + 1e-8)
    assert np.all(decoded > expected.roughness)


def _independent_jittered_sites(count: int, seed: int) -> np.ndarray:
    """Construct the declared site process independently of field helpers."""
    x = (
        np.random.default_rng(np.random.SeedSequence([seed, 81]))
        .uniform(-1, 1, (count, count))
        .astype(np.float32)
    )
    y = (
        np.random.default_rng(np.random.SeedSequence([seed, 82]))
        .uniform(-1, 1, (count, count))
        .astype(np.float32)
    )
    iy, ix = np.mgrid[:count, :count]
    return np.stack((ix + 0.5 + 0.38 * x, iy + 0.5 + 0.38 * y), axis=-1)


@pytest.mark.parametrize("seed", [42, 43, 2**64 - 1])
def test_villi_gradient_is_continuous_across_actual_old_voronoi_bisectors(seed: int) -> None:
    from viscera_core.tissue_materials.field import _smooth_tufts

    count, epsilon = 7, 1e-4
    sites = _independent_jittered_sites(count, seed)
    all_sites = sites.reshape(-1, 2)
    verified = 0
    old_jumps, new_jumps = [], []
    for row in range(1, count - 2):
        for column in range(1, count - 2):
            a, b = sites[row, column], sites[row, column + 1]
            midpoint = (a + b) / 2
            distances = np.linalg.norm(all_sites - midpoint, axis=-1)
            nearest = np.argsort(distances)[:2]
            if set(nearest) != {row * count + column, row * count + column + 1}:
                continue
            direction = (b - a) / np.linalg.norm(b - a)
            points = midpoint + np.array([-epsilon, 0, epsilon])[:, None] * direction
            smooth = _smooth_tufts(points[:, 0] / count, points[:, 1] / count, count, seed)
            old_distance_squared = np.square(points[:, None] - all_sites).sum(-1).min(-1)
            old = np.exp(-5 * old_distance_squared)
            old_jumps.append(abs(old[2] - 2 * old[1] + old[0]) / epsilon)
            new_jumps.append(abs(smooth[2] - 2 * smooth[1] + smooth[0]) / epsilon)
            verified += 1
    assert verified >= 5
    assert max(old_jumps) > 0.5  # the regression probe detects the prior crease
    assert max(new_jumps) < 0.004


def test_villi_kernel_has_continuous_slopes_when_floor_stencil_changes() -> None:
    from viscera_core.tissue_materials.field import _smooth_tufts

    count, seed, epsilon = 7, 57, 1e-4
    # Include lattice lines, lattice corners and the periodic seam, in cell units.
    points = np.array([[x, y] for x in (0, 1, 3, 7) for y in (0, 1.3, 4, 7)])
    for direction in (np.array([1, 0]), np.array([0, 1]), np.array([0.6, 0.8])):
        samples = points[:, None, :] + np.array([-epsilon, 0, epsilon])[None, :, None] * direction
        height = _smooth_tufts(samples[..., 0] / count, samples[..., 1] / count, count, seed)
        jump = np.abs(height[:, 2] - 2 * height[:, 1] + height[:, 0]) / epsilon
        assert jump.max() < 0.005


def test_villi_kernel_is_periodic_bounded_and_independent_of_point_batching() -> None:
    from viscera_core.tissue_materials.field import _smooth_tufts

    u = np.linspace(-0.21, 1.15, 47)[None, :]
    v = np.linspace(-0.15, 1.1, 39)[:, None]
    full = _smooth_tufts(u, v, 73, 2**64 - 1)
    shifted = _smooth_tufts(u + 2, v - 3, 73, 2**64 - 1)
    stripes = np.concatenate(
        [_smooth_tufts(u, rows, 73, 2**64 - 1) for rows in np.array_split(v, 7)]
    )
    np.testing.assert_allclose(full, shifted, atol=1e-12)
    np.testing.assert_array_equal(full, stripes)
    assert np.isfinite(full).all() and 0 <= full.min() < full.max() < 1
    scalar = _smooth_tufts(0.31, 0.77, 73, 2**64 - 1)
    np.testing.assert_array_equal(scalar, _smooth_tufts(np.array([0.31]), 0.77, 73, 2**64 - 1)[0])


def test_villi_physical_normals_are_finite_periodic_and_unit_length() -> None:
    count = 256
    u, v = np.meshgrid((np.arange(count) + 0.5) / count, (np.arange(count) + 0.5) / count)
    recipe = TissueRecipe(organ="intestinal_mucosa")
    field = sample_tissue(recipe, u, v, footprint_mm=recipe.tile_size_mm / count)
    height = field.substrate_height_mm
    spacing = recipe.tile_size_mm / count
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) / (2 * spacing)
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) / (2 * spacing)
    normal = np.stack((-dx, dy, np.ones_like(dx)), axis=-1)
    normal /= np.linalg.norm(normal, axis=-1, keepdims=True)
    assert np.isfinite(normal).all() and np.all(normal[..., 2] > 0)
    np.testing.assert_allclose(np.linalg.norm(normal, axis=-1), 1, atol=1e-12)
    assert np.quantile(np.hypot(dx, dy), 0.99) < 0.25
