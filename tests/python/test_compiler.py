import pytest

from services.api.compiler import DEFAULTS, compile_text


def test_units_and_multiple_controls():
    result = compile_text("liver width 26 cm and gallbladder length 95 mm")
    assert result["status"] == "ready"
    assert result["spec"]["parameters"]["liver_width_mm"] == 260
    assert result["spec"]["parameters"]["gallbladder_length_mm"] == 95


def test_relative_edit_preserves_unrelated_controls():
    result = compile_text("increase liver width by 10% and keep gallbladder unchanged")
    assert result["status"] == "ready"
    assert result["spec"]["parameters"]["liver_width_mm"] == pytest.approx(
        DEFAULTS["liver_width_mm"] * 1.1
    )
    assert result["spec"]["parameters"]["gallbladder_length_mm"] == 80


def test_unknown_clause_is_atomic_failure():
    result = compile_text("liver width 260 mm and rotate the heart")
    assert result["status"] == "unsupported"
    assert result["patches"] == [] and result["spec"] is None


def test_ambiguous_and_conflicting():
    assert compile_text("make liver bigger")["status"] == "needs_clarification"
    assert compile_text("liver width 270")["status"] == "needs_clarification"
    assert (
        compile_text("liver width 260 mm and liver width 280 mm")["status"] == "needs_clarification"
    )


def test_bounds_are_rejected_not_clamped():
    assert compile_text("liver width 900 mm")["status"] == "unsupported"
    assert compile_text("reduce liver width by 95%")["status"] == "unsupported"


def test_qualitative_presets_and_negation():
    r = compile_text("a broader left lobe, deep fissure and elongated gallbladder")
    assert r["status"] == "ready"
    assert r["spec"]["parameters"]["left_lobe_ratio"] == 0.68
    assert r["spec"]["parameters"]["fissure_depth_mm"] == 10
    assert compile_text("not a deep fissure")["status"] != "ready"


def test_vessels_and_seed():
    r = compile_text("create anatomy without vessels, seed 27")
    assert r["status"] == "ready" and r["spec"]["include_vessels"] is False
    assert r["spec"]["seed"] == 27


def test_no_implicit_diagnosis_or_body_attributes():
    for text in ["rock hard liver", "cirrhotic liver", "make a female liver", "blue liver"]:
        assert compile_text(text)["status"] != "ready"


def test_qualified_fields_do_not_match_another_organs_suffix():
    wrong = compile_text("gallbladder width 250 mm", selected_organ_id="liver")
    assert wrong["status"] == "unsupported"
    assert wrong["spec"] is None and wrong["patches"] == []
    fissure = compile_text("fissure depth 8 mm")
    assert fissure["status"] == "ready"
    assert fissure["spec"]["parameters"]["fissure_depth_mm"] == 8
    assert fissure["spec"]["parameters"]["liver_depth_mm"] == DEFAULTS["liver_depth_mm"]


def test_unqualified_dimensions_bind_only_to_an_explicit_liver_selection():
    for selected in (None, "gallbladder", "unknown"):
        result = compile_text("increase width by 10%", selected_organ_id=selected)
        assert result["status"] == "needs_clarification"
        assert result["spec"] is None
    result = compile_text("increase width by 10%", selected_organ_id="liver")
    assert result["status"] == "ready"
    assert result["spec"]["parameters"]["liver_width_mm"] == pytest.approx(258.5)
    explicit = compile_text("liver width 250 mm", selected_organ_id="gallbladder")
    assert explicit["status"] == "ready"
    assert explicit["spec"]["parameters"]["liver_width_mm"] == 250


@pytest.mark.parametrize(
    "text",
    [
        "left lobe ratio 0.5 mm",
        "left lobe ratio 0.05 cm",
        "increase concavity by 0.1 cm",
        "decrease left lobe ratio by 0.1 millimetres",
    ],
)
def test_dimensionless_controls_reject_length_units_atomically(text):
    result = compile_text(f"liver width 250 mm and {text}")
    assert result["status"] == "needs_clarification"
    assert result["spec"] is None and result["changes"] == [] and result["patches"] == []


def test_dimensionless_fractions_and_percentages_remain_supported():
    assert compile_text("left lobe ratio 50%")["spec"]["parameters"]["left_lobe_ratio"] == 0.5
    assert compile_text("increase concavity by 10%")["spec"]["parameters"][
        "inferior_concavity"
    ] == pytest.approx(0.33)
    assert compile_text("increase concavity by 0.1")["spec"]["parameters"][
        "inferior_concavity"
    ] == pytest.approx(0.4)


@pytest.mark.parametrize(
    "text",
    [
        "keep liver unchanged and liver width 260 mm",
        "gallbladder length 90 mm and preserve the gallbladder fixed",
        "seed 99 and leave the liver the same",
    ],
)
def test_preservation_constraints_cannot_be_discarded(text):
    result = compile_text(text)
    assert result["status"] == "needs_clarification"
    assert result["spec"] is None and result["patches"] == []


def test_preservation_without_a_conflict_keeps_unrelated_values():
    original = {"parameters": {**DEFAULTS, "gallbladder_length_mm": 86}}
    result = compile_text("liver width 245 mm and keep gallbladder unchanged", original)
    assert result["status"] == "ready"
    assert result["spec"]["parameters"]["gallbladder_length_mm"] == 86
    assert original["parameters"]["liver_width_mm"] == DEFAULTS["liver_width_mm"]


def test_compiler_validates_combined_wall_radius_constraint_atomically():
    source = {"wall_thickness_mm": 3.0}
    result = compile_text("liver width 245 mm and gallbladder radius 10 mm", source)
    assert result["status"] == "unsupported"
    assert "wall thickness" in result["message"]
    assert result["spec"] is None and result["patches"] == [] and result["changes"] == []
    assert compile_text("gallbladder radius 11 mm", source)["status"] == "ready"


@pytest.mark.parametrize("control", ["concavity 0.4", "fissure depth 8 mm", "lobe ratio 0.5"])
def test_gallbladder_cannot_silently_target_liver_specific_controls(control):
    result = compile_text(f"gallbladder {control}")
    assert result["status"] == "unsupported"
    assert result["spec"] is None and result["patches"] == []
