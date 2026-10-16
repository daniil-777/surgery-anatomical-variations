"""The reviewed optional reference-colour extension preserves joint rendering."""

from __future__ import annotations

import hashlib
import importlib.util
import sys
from pathlib import Path

import numpy as np
import pytest
from viscera_core import atlas_joint, atlas_joint_v2, atlas_materials

from services.api import atlas_joint_model, atlas_joint_model_v2
from services.api.atlas_renderer_compat import matches_renderer_source

ROOT = Path(__file__).resolve().parents[2]
MATERIAL_PATH = "py/viscera_core/atlas_materials.py"
TRAINED_SHA256 = "679aa9214cef534b92e1d64b0043213a88a8c6a0fdd9b25b7ae54e4fa289a0a3"
REFERENCE_EXTENSION_SHA256 = "7bc443111cec91a295297eb1abab9ed3d1acfd6724c49b56c27c4dd0ea650d17"


@pytest.fixture(scope="module")
def frozen_materials():
    source = ROOT / "disease-releases/geometry-v1/decoder/atlas_materials.py"
    assert hashlib.sha256(source.read_bytes()).hexdigest() == TRAINED_SHA256
    name = "_joint_material_training_reference"
    spec = importlib.util.spec_from_file_location(name, source)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
        yield module
    finally:
        sys.modules.pop(name, None)


@pytest.mark.parametrize("organ", atlas_materials.PROFILES)
def test_optional_reference_extension_has_exact_training_material_parity(frozen_materials, organ):
    """Cover all organs/presets, uint32 seed bounds and control support bounds."""
    points = np.random.default_rng(42).uniform(-100, 100, (96, 3))
    regions = np.resize([0.0, 0.5, 1.0], len(points))
    footprints = np.resize([0.0, 0.1, 1.0, 3.0], len(points))
    control_cases = [
        {},
        {name: low for name, _, low, _, _ in atlas_materials.CONTROL_DEFINITIONS},
        {name: high for name, _, _, high, _ in atlas_materials.CONTROL_DEFINITIONS},
    ]
    for preset in atlas_materials.PRESETS:
        for seed in (0, 42, 2**32 - 1):
            for controls in control_cases:
                current = atlas_materials.make_recipe(organ, preset, seed, **controls)
                frozen = frozen_materials.make_recipe(organ, preset, seed, **controls)
                assert current.reference_color is None
                assert current.model_dump() == frozen.model_dump()
                assert current.model_dump_json() == frozen.model_dump_json()
                assert atlas_materials.resolve_material(current) == frozen_materials.resolve_material(
                    frozen
                )
                actual = atlas_materials.sample_material(current, points, regions, footprints)
                expected = frozen_materials.sample_material(frozen, points, regions, footprints)
                for field in (
                    "rgb_linear", "rgb_srgb", "roughness", "height_mm",
                    "height_gradient_drest_mm",
                ):
                    np.testing.assert_array_equal(getattr(actual, field), getattr(expected, field))
                assert actual.metadata == expected.metadata


def test_material_compatibility_is_limited_to_the_reviewed_file_and_hash_pair():
    assert matches_renderer_source(MATERIAL_PATH, TRAINED_SHA256, REFERENCE_EXTENSION_SHA256)
    assert matches_renderer_source("py/viscera_core/atlas.py", "a" * 64, "a" * 64)
    for name, expected, actual in (
        (MATERIAL_PATH, "a" * 64, REFERENCE_EXTENSION_SHA256),
        (MATERIAL_PATH, TRAINED_SHA256, "a" * 64),
        (MATERIAL_PATH, REFERENCE_EXTENSION_SHA256, TRAINED_SHA256),
        ("py/viscera_core/atlas.py", TRAINED_SHA256, REFERENCE_EXTENSION_SHA256),
    ):
        assert not matches_renderer_source(name, expected, actual)
    assert hashlib.sha256((ROOT / MATERIAL_PATH).read_bytes()).hexdigest() == (
        REFERENCE_EXTENSION_SHA256
    )


@pytest.mark.parametrize("service,decoder", [
    (atlas_joint_model, atlas_joint), (atlas_joint_model_v2, atlas_joint_v2),
])
def test_both_joint_verifiers_accept_reviewed_extension_and_reject_further_drift(
    tmp_path, service, decoder,
):
    hashes = {}
    for name in decoder.RENDERER_PATHS:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        content = (ROOT / MATERIAL_PATH).read_bytes() if name == MATERIAL_PATH else b"frozen"
        path.write_bytes(content)
        hashes[name] = TRAINED_SHA256 if name == MATERIAL_PATH else hashlib.sha256(content).hexdigest()
    decoder_name = Path(decoder.__file__).name
    decoder_path = tmp_path / "py/viscera_core" / decoder_name
    decoder_path.write_bytes(b"decoder")
    metadata = {
        "renderer_hashes": hashes,
        "model_decoder_sha256": hashlib.sha256(b"decoder").hexdigest(),
    }
    service._verify_renderer(tmp_path, metadata)
    material_path = tmp_path / MATERIAL_PATH
    material_path.write_bytes(material_path.read_bytes() + b"\n# unreviewed drift\n")
    with pytest.raises(ValueError, match="renderer source differs.*atlas_materials"):
        service._verify_renderer(tmp_path, metadata)


@pytest.mark.parametrize("decoder", [atlas_joint, atlas_joint_v2])
@pytest.mark.parametrize("profile", ["baseline", "liver-cirrhosis"])
def test_joint_decoders_do_not_enable_the_reference_colour_extension(decoder, profile):
    condition = {
        "template_id": "test-liver",
        "organ": "liver",
        "profile_id": profile,
        "material_preset": "balanced",
        "renderer_seed": 523,
        "renderer_version": "disease-v2",
    }
    for seed in (0, 42, 2**32 - 1):
        for values in (np.full(22, -1.0), np.zeros(22), np.ones(22)):
            sampled = decoder.decode_controls(condition, values, seed)
            assert "reference_color" not in sampled["material"]
            assert atlas_materials.MaterialRecipe.model_validate(sampled["material"]).reference_color is None
