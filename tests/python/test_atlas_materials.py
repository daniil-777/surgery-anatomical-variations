"""Material field contracts: no vertex dependence, exact replay and gradients."""

import json

import numpy as np
import pytest
from pydantic import ValidationError
from viscera_core.atlas_materials import (
    CONTROL_NAMES,
    MATERIAL_GLSL,
    PRESETS,
    PROFILES,
    MaterialRecipe,
    make_recipe,
    material_catalog,
    material_region_ids,
    material_shader_contract,
    resolve_material,
    sample_material,
    srgb_to_linear,
)


def test_recipe_validation_and_preset_defaults() -> None:
    for bad in (
        {"seed": True},
        {"tint": "0.3"},
        {"fine_detail": float("nan")},
        {"wetness": 1.1},
        {"mottle_scale_mm": 0},
        {"version": "unknown"},
        {"tumor": True},
    ):
        with pytest.raises(ValidationError):
            MaterialRecipe(organ="liver", **bad)
    with pytest.raises(ValueError):
        make_recipe("missing")
    with pytest.raises(ValueError):
        make_recipe("liver", "necrotic")
    catalog = material_catalog()
    assert len(catalog["defaults"]) == 12
    for organ in PROFILES:
        for preset in PRESETS:
            stored = catalog["organ_presets"][organ][preset]
            assert stored["recipe"] == make_recipe(organ, preset).model_dump()
            assert all(len(s) == 7 and s.startswith("#") for s in stored["swatches"])
    assert catalog["defaults"]["liver"]["wetness"] != make_recipe("liver", "moist").wetness
    json.dumps(catalog, allow_nan=False)


def test_determinism_chunking_seed_and_no_input_mutation() -> None:
    points = np.random.default_rng(17).normal(size=(127, 3)) * 12
    original = points.copy()
    recipe = make_recipe("liver", "rich", seed=2**32 - 1)
    a = sample_material(recipe, points, chunk_size=127)
    b = sample_material(recipe.model_dump(), points, chunk_size=13)
    np.testing.assert_array_equal(points, original)
    for key in ("rgb_linear", "rgb_srgb", "roughness", "height_mm", "height_gradient_drest_mm"):
        np.testing.assert_array_equal(a[key], b[key])
    different = sample_material(make_recipe("liver", "rich", seed=1), points)
    assert np.max(np.abs(a.rgb_linear - different.rgb_linear)) > 0.005
    assert np.max(np.abs(a.height_mm - different.height_mm)) > 0.001
    assert not a.metadata["geometry_modified"]
    assert a.metadata["evidence"] == "design_heuristic"


@pytest.mark.parametrize("organ", ["liver", "heart", "pancreas"])
def test_analytic_height_gradient_matches_finite_difference(organ: str) -> None:
    points = np.random.default_rng(3).uniform(-40, 40, size=(24, 3))
    regions = np.linspace(0, 1, len(points))
    recipe = make_recipe(organ, "rich", fine_detail=0.9, structure_strength=0.8)
    actual = sample_material(recipe, points, regions, footprint_mm=0.08).height_gradient_drest_mm
    numeric = np.empty_like(points)
    epsilon = 1e-5
    for axis in range(3):
        delta = np.zeros(3)
        delta[axis] = epsilon
        plus = sample_material(recipe, points + delta, regions, footprint_mm=0.08).height_mm
        minus = sample_material(recipe, points - delta, regions, footprint_mm=0.08).height_mm
        numeric[:, axis] = (plus - minus) / (2 * epsilon)
    np.testing.assert_allclose(actual, numeric, atol=2e-8, rtol=1e-5)


def test_continuous_sampling_resolves_detail_inside_a_coarse_triangle() -> None:
    # A single triangle has no interior vertices: its true material field must
    # still vary within it, rather than interpolating three vertex colors.
    triangle = np.array([[0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [0.0, 10.0, 0.0]])
    bary = np.random.default_rng(4).dirichlet([1, 1, 1], size=128)
    recipe = make_recipe("stomach", fine_detail=1.0)
    corners = sample_material(recipe, triangle)
    inside = sample_material(recipe, bary @ triangle)
    assert np.std(inside.height_mm) > 0.001
    assert np.max(np.abs(inside.height_mm - bary @ corners.height_mm)) > 0.003
    assert np.max(np.abs(inside.rgb_linear - bary @ corners.rgb_linear)) > 0.002


def test_all_organ_presets_outputs_bounded_and_filtered() -> None:
    points = np.random.default_rng(2).uniform(-200, 200, size=(256, 3))
    for organ in PROFILES:
        for preset in PRESETS:
            recipe = make_recipe(organ, preset, seed=300)
            s = sample_material(recipe, points)
            assert np.isfinite(s.height_gradient_drest_mm).all()
            assert np.all((s.rgb_linear >= 0.001) & (s.rgb_linear <= 0.98))
            assert np.all((s.roughness >= 0.16) & (s.roughness <= 0.82))
            assert np.max(np.abs(s.height_mm)) <= PROFILES[organ]["height_mm"]
            filtered = sample_material(recipe, points, footprint_mm=100)
            assert not filtered.height_mm.any() and not filtered.height_gradient_drest_mm.any()
            expected = np.tile(
                resolve_material(recipe)["uniforms"]["uAtlasBaseColor"], (len(points), 1)
            )
            np.testing.assert_allclose(filtered.rgb_linear, expected)


def test_wetness_and_fine_detail_have_separate_effects() -> None:
    points = np.array([[1.2, 2.4, 3.1], [-1.4, 8.2, -3.6]])
    dry = sample_material(make_recipe("kidney", wetness=0), points)
    wet = sample_material(make_recipe("kidney", wetness=1), points)
    np.testing.assert_array_equal(dry.rgb_linear, wet.rgb_linear)
    np.testing.assert_array_equal(dry.height_mm, wet.height_mm)
    assert (wet.roughness < dry.roughness).all()
    assert wet.metadata["clearcoat"] > dry.metadata["clearcoat"]
    smooth = sample_material(make_recipe("kidney", fine_detail=0), points)
    assert not smooth.height_mm.any() and not smooth.height_gradient_drest_mm.any()


def test_component_regions_and_linear_color_contract() -> None:
    ids = material_region_ids(
        np.array([0, 1, 1, 2]),
        [{"name": "capsule"}, {"name": "falciform_ligament"}, {"name": "hilum"}],
    )
    np.testing.assert_array_equal(ids, [0, 1, 1, 0])
    r = make_recipe("liver", pigment_contrast=0)
    s = sample_material(r, np.zeros((3, 3)), [0, 0.5, 1])
    np.testing.assert_allclose(s.rgb_linear[1], (s.rgb_linear[0] + s.rgb_linear[2]) * 0.5)
    np.testing.assert_allclose(srgb_to_linear(s.rgb_srgb), s.rgb_linear, atol=1e-12)
    with pytest.raises(ValueError):
        sample_material(r, np.zeros((1, 3)), [2])
    with pytest.raises(ValueError):
        sample_material(r, [[float("nan"), 0, 0]])
    with pytest.raises(ValueError):
        sample_material(r, np.zeros((2, 3)), footprint_mm=[0])
    assert sample_material(r, np.empty((0, 3))).rgb_linear.shape == (0, 3)
    contract = material_shader_contract()
    assert contract["glsl"] == MATERIAL_GLSL
    assert "heightGradientRest" in MATERIAL_GLSL and "uint" in MATERIAL_GLSL
    assert set(CONTROL_NAMES) <= set(r.model_dump())
