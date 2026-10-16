"""Image selection, robust observed color, and material-preservation contracts."""

import base64
import io

import numpy as np
import pytest
from PIL import Image, ImageCms, ImageOps
from pydantic import ValidationError
from viscera_core.atlas_materials import (
    MaterialRecipe,
    make_recipe,
    resolve_material,
    sample_material,
)
from viscera_core.reference_analysis import (
    RegionSelection,
    analyze_image,
    decode_base64,
    decode_mask,
    decode_photo,
    extract_observed_color,
    local_segment,
)
from viscera_core.reference_color import (
    ReferenceColor,
    gamut_srgb,
    to_oklab,
    transfer_base_color,
)

from scripts.reports.benchmark_reference_material import (
    synthetic_case,
    synthetic_segmentation_case,
)


def encoded(image: Image.Image, fmt: str = "PNG", **kwargs: object) -> bytes:
    output = io.BytesIO()
    image.save(output, format=fmt, **kwargs)
    return output.getvalue()


def reference(**kwargs: object) -> ReferenceColor:
    return ReferenceColor.model_validate({"organ": "liver", "source_sha256": "a" * 64,
                                          "mask_sha256": "b" * 64,
                                          "observed_srgb": [.64, .37, .32], **kwargs})


def test_decode_orientation_matches_display_and_mask_coordinates() -> None:
    source = Image.new("RGB", (48, 32), (150, 70, 60))
    source.paste((30, 80, 120), (0, 0, 24, 16))
    exif = Image.Exif()
    exif[274] = 6
    raw = encoded(source, exif=exif)
    actual, oriented, notices = decode_photo(raw)
    with Image.open(io.BytesIO(raw)) as original:
        expected = ImageOps.exif_transpose(original).convert("RGB")
    assert oriented == actual.size == (32, 48)
    np.testing.assert_array_equal(actual, expected)
    assert notices
    mask = Image.new("L", actual.size, 255)
    assert decode_mask(encoded(mask), oriented, actual.size).all()
    with pytest.raises(ValueError, match="matching"):
        decode_mask(encoded(Image.new("L", (48, 32), 255)), oriented, actual.size)


def test_srgb_profile_converts_once_and_corrupt_profile_rejects() -> None:
    source = Image.new("RGB", (32, 32), (155, 88, 72))
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    actual, size, notices = decode_photo(encoded(source, icc_profile=profile))
    assert size == (32, 32) and not notices
    np.testing.assert_allclose(actual, source, atol=1)
    with pytest.raises(ValueError, match="profile"):
        decode_photo(encoded(source, icc_profile=b"invalid-profile"))


@pytest.mark.parametrize("raw", [b"not an image", b"", encoded(Image.new("RGB", (8, 32))),
                                    encoded(Image.new("RGB", (32, 32)), "GIF"),
                                    encoded(Image.new("RGBA", (32, 32), (100, 80, 70, 0)))])
def test_invalid_photo_inputs_reject(raw: bytes) -> None:
    with pytest.raises(ValueError):
        decode_photo(raw)


def test_photo_resize_and_animation_rejection() -> None:
    image, original, _ = decode_photo(encoded(Image.new("RGB", (1600, 1200), (140, 80, 70))))
    assert original == (1600, 1200) and image.size == (1024, 768)
    first = Image.new("RGB", (32, 32), (140, 80, 70))
    second = Image.new("RGB", (32, 32), (150, 90, 80))
    with pytest.raises(ValueError, match="animation"):
        decode_photo(encoded(first, save_all=True, append_images=[second], duration=100))


def test_base64_and_decoded_size_limits(monkeypatch: pytest.MonkeyPatch) -> None:
    assert decode_base64(base64.b64encode(b"abc").decode()) == b"abc"
    for invalid in ("", "data:image/png;base64,abcd", "$$$", "YW Jj"):
        with pytest.raises(ValueError):
            decode_base64(invalid)
    monkeypatch.setattr("viscera_core.reference_analysis.MAX_IMAGE_BYTES", 8)
    with pytest.raises(ValueError):
        decode_base64(base64.b64encode(b"x" * 9).decode())
    monkeypatch.setattr("viscera_core.reference_analysis.MAX_PIXELS", 1000)
    with pytest.raises(ValueError, match="megapixels"):
        decode_photo(encoded(Image.new("RGB", (32, 32))))


@pytest.mark.parametrize("mask", [Image.new("L", (32, 32), 127),
                                  Image.new("RGB", (32, 32), (255, 0, 0)),
                                  Image.new("RGBA", (32, 32), (255, 255, 255, 0))])
def test_mask_requires_binary_opaque_luminance(mask: Image.Image) -> None:
    with pytest.raises(ValueError):
        decode_mask(encoded(mask), (32, 32), (32, 32))


def test_mask_downsampling_preserves_binary_membership() -> None:
    array = np.zeros((64, 64), dtype=np.uint8)
    array[16:48, 16:48] = 255
    mask = decode_mask(encoded(Image.fromarray(array)), (64, 64), (32, 32))
    assert mask.dtype == bool and mask.shape == (32, 32) and mask.sum() == 256


@pytest.mark.parametrize("box,fg,bg", [((.5, .1, .4, .9), [], []),
                                       ((0, 0, 1, 1), [(0, .5)], []),
                                       ((0, 0, 1, 1), [(.5, .5)], [(.5, .5)])])
def test_invalid_region_prompts_reject(box: tuple, fg: list, bg: list) -> None:
    with pytest.raises(ValidationError):
        RegionSelection(box=box, foreground_points=fg, background_points=bg)


def test_local_segmentation_recovers_only_known_synthetic_region() -> None:
    image, truth, prompts = synthetic_segmentation_case()
    mask, meta = local_segment(image, prompts)
    assert np.sum(mask & truth) / np.sum(mask | truth) > .90
    assert not meta["learned"] and meta["review_required"]
    assert meta["semantic_identity"] == "user_assigned"


@pytest.mark.parametrize("color", [(120, 120, 120), (150, 80, 70)])
def test_no_spatial_contrast_cannot_support_local_segmentation(color: tuple) -> None:
    prompts = RegionSelection(box=(.1, .1, .9, .9), foreground_points=[(.5, .5)])
    with pytest.raises(ValueError, match="no contrast"):
        local_segment(Image.new("RGB", (64, 64), color), prompts)


@pytest.mark.parametrize("level", [0, 255])
def test_black_and_white_regions_do_not_fabricate_tissue_color(level: int) -> None:
    rgb = np.full((40, 40, 3), level, dtype=np.uint8)
    with pytest.raises(ValueError, match="usable tissue"):
        extract_observed_color(rgb, np.ones((40, 40), dtype=bool))


def test_uniform_pale_tissue_is_retained_without_variance_requirement() -> None:
    rgb = np.full((40, 40, 3), [203, 170, 151], dtype=np.uint8)
    result = extract_observed_color(rgb, np.ones((40, 40), dtype=bool))
    np.testing.assert_allclose(result["observed_color_srgb"], [203/255, 170/255, 151/255], atol=1e-7)
    assert result["quality"]["accepted_fraction"] > .8


def test_contaminant_rejection_improves_known_observed_color_and_counts_pixels() -> None:
    rgb, mask, clean = synthetic_case()
    target = np.median(to_oklab(clean[mask] / 255), axis=0)
    result = extract_observed_color(rgb, mask)
    error = np.linalg.norm(to_oklab(result["observed_color_srgb"])[1:] - target[1:])
    mean_error = np.linalg.norm(to_oklab(np.mean(rgb[mask] / 255, axis=0))[1:] - target[1:])
    assert error < mean_error
    assert result["quality"]["glare_or_clipped_pixels"] > 0
    assert result["quality"]["deep_shadow_pixels"] > 0
    assert result["quality"]["selected_pixels"] == mask.sum()
    assert result["accepted_mask"].sum() == result["quality"]["accepted_pixels"]
    assert not (result["accepted_mask"] & ~mask).any()
    assert result["quality"]["semantic_confidence"] is None
    assert result["quality"]["optical_calibration"] is False


def test_analysis_alignment_overlay_and_provenance() -> None:
    rgb, mask, _ = synthetic_case()
    image = Image.fromarray(rgb)
    result = analyze_image(image, mask, "liver", "a" * 64, {"method": "provided-mask"}, [])
    replay = analyze_image(image, mask, "liver", "a" * 64, {"method": "provided-mask"}, [])
    assert result == replay
    assert result["reference_color"]["organ"] == "liver"
    assert result["reference_color"]["source_sha256"] == "a" * 64
    assert result["reference_color"]["mask_sha256"] == result["mask_sha256"]
    with Image.open(io.BytesIO(base64.b64decode(result["overlay_png_base64"]))) as overlay:
        assert overlay.size == image.size
        np.testing.assert_array_equal(np.asarray(overlay)[~mask], rgb[~mask])
    with pytest.raises(ValueError, match="align"):
        analyze_image(image, mask[:-1], "liver", "a" * 64, {}, [])


def test_transfer_zero_is_exact_and_modes_have_separate_brightness_behavior() -> None:
    original = np.array([.42, .27, .23])
    np.testing.assert_array_equal(transfer_base_color(original, reference(strength=0)), original)
    chroma = transfer_base_color(original, reference(mode="chroma"))
    full = transfer_base_color(original, reference(mode="color"))
    np.testing.assert_allclose(to_oklab(chroma)[0], to_oklab(original)[0], atol=2e-8)
    np.testing.assert_allclose(full, reference().observed_srgb, atol=2e-8)
    assert np.linalg.norm(chroma - original) > .01


def test_gamut_compression_keeps_lightness_and_finite_bounded_rgb() -> None:
    for lab in ([.60, .6, .4], [.75, -.5, -.5], [.3, .3, -.4]):
        rgb = gamut_srgb(lab)
        assert np.isfinite(rgb).all() and np.all((rgb >= 0) & (rgb <= 1))
        np.testing.assert_allclose(to_oklab(rgb)[0], lab[0], atol=1e-7)


@pytest.mark.parametrize("kwargs", [{"observed_srgb": [True, .2, .3]},
                                    {"observed_srgb": [.2, .3, float("nan")]},
                                    {"strength": 1.1}, {"strength": True},
                                    {"source_sha256": "bad"}, {"mode": "albedo"}])
def test_reference_validation_rejects_invalid_metadata_and_channels(kwargs: dict) -> None:
    with pytest.raises(ValidationError):
        reference(**kwargs)


def test_recipe_transfer_preserves_noncolor_material_fields_and_ligament() -> None:
    recipe = make_recipe("liver", "rich", seed=80, wetness=.71, fine_detail=.8)
    changed = MaterialRecipe.model_validate({**recipe.model_dump(), "reference_color": reference(mode="color").model_dump()})
    points = np.random.default_rng(105).uniform(-25, 25, size=(96, 3))
    before_points = points.copy()
    before, after = sample_material(recipe, points), sample_material(changed, points)
    assert np.max(np.abs(before.rgb_srgb - after.rgb_srgb)) > .05
    np.testing.assert_array_equal(points, before_points)
    for field in ("roughness", "height_mm", "height_gradient_drest_mm"):
        np.testing.assert_array_equal(before[field], after[field])
    for key in ("clearcoat", "clearcoat_roughness", "metalness", "geometry_modified"):
        assert before.metadata[key] == after.metadata[key]
    np.testing.assert_array_equal(sample_material(recipe, points, np.ones(len(points))).rgb_srgb,
                                  sample_material(changed, points, np.ones(len(points))).rgb_srgb)
    assert resolve_material(changed)["recipe_sha256"] != resolve_material(recipe)["recipe_sha256"]
    roundtrip = MaterialRecipe.model_validate_json(changed.model_dump_json())
    np.testing.assert_array_equal(sample_material(roundtrip, points).rgb_srgb, after.rgb_srgb)
    np.testing.assert_array_equal(sample_material(recipe, points).rgb_srgb, before.rgb_srgb)


def test_recipe_rejects_reference_assigned_to_another_organ() -> None:
    with pytest.raises(ValidationError):
        MaterialRecipe.model_validate({"organ": "kidney", "reference_color": reference().model_dump()})
