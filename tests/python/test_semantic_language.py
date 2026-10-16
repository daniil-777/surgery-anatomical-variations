"""Authored semantic edits preserve identity and apply composed requests atomically."""
from copy import deepcopy
from pathlib import Path

import pytest
from viscera_core.atlas_semantic import (
    apply_plan,
    compile_text,
    context_from_spec,
    make_plan,
    operation,
    parse_semantic,
    plan_fingerprint,
    request_guard,
    validate_plan,
)

ROOT = Path(__file__).resolve().parents[2] / "datasets/atlas/cohort-v2/templates"


def context(active=True, renderer="disease-v2"):
    return {"organ": "liver", "renderer_version": renderer, "disease": {"profile_id": "liver-cirrhosis", "severity": .7, "contrast": .6, "size": .5, "spread": .4, "irregularity": .3, "count": 3} if active else None, "controls": {}, "material": None}


@pytest.mark.parametrize("text,fraction", [("healthier", -.2), ("make the liver look healthier", -.2), ("slightly healthier", -.1), ("25% healthier", -.25), ("sicker", .2), ("less healthy", .2), ("less diseased", -.2)])
def test_comparative_health_authored_policy(text, fraction):
    result = parse_semantic(text, context())
    assert result["status"] == "accepted", result
    assert result["operations"] == [operation("disease_relative", "severity", fraction), operation("disease_relative", "contrast", fraction)]


def test_baseline_comparatives_have_contextual_meaning():
    assert parse_semantic("healthier", context(False))["operations"] == []
    assert parse_semantic("healthier", context(False))["status"] == "accepted"
    assert parse_semantic("sicker", context(False))["status"] == "clarify"
    assert parse_semantic("normalise", context())["operations"] == [operation("disease_clear")]


@pytest.mark.parametrize("text", ["healthier and sicker", "5% wider and 3% narrower", "healthier but preserve the disease", "healthier but keep dimensions unchanged", "wetter and drier", "healthier and resect the lesion", "lesion size 12 mm", "healthier without disease", "healthier and make it fly"])
def test_conflicting_or_unimplemented_edits_never_partially_apply(text):
    original = context()
    before = deepcopy(original)
    result = parse_semantic(text, original)
    assert result["status"] != "accepted", result
    assert result["operations"] == []
    assert original == before


def test_physical_diseased_dimensions_are_explicitly_unavailable():
    assert request_guard("width 200 mm", context())["status"] == "clarify"
    assert request_guard("width 200 mm", context(False)) is None
    assert request_guard("baseline and width 200 mm", context()) is None


@pytest.mark.parametrize("text,field,delta", [("make lesions 20% smaller", "size", -.2), ("reduce disease severity by 15%", "severity", -.15), ("less nodular", "severity", -.2), ("more widespread", "spread", .2), ("less irregular", "irregularity", -.2), ("pigment contrast 0.4", "pigment_contrast", .4)])
def test_grounded_morphology_and_surface_aliases(text, field, delta):
    result = parse_semantic(text, context())
    assert result["status"] == "accepted", result
    assert result["operations"][0]["field"] == field
    assert result["operations"][0]["value"] == delta


def test_legacy_profile_selection_does_not_switch_renderer():
    assert parse_semantic("liver-capsular-cyst", context(renderer="legacy"))["status"] == "clarify"
    assert parse_semantic("liver-hcc", context(renderer="legacy"))["status"] == "accepted"
    assert parse_semantic("liver-capsular-cyst", context())["status"] == "accepted"


def test_plan_schema_refuses_arbitrary_fields_nonfinite_values_and_duplicates():
    bad = [make_plan([operation("disease_relative", "severity", float("nan"))]), make_plan([operation("execute", "code", "boom")]), make_plan([operation("disease_set", "severity", .5), operation("disease_relative", "severity", -.2)])]
    for plan in bad:
        result = validate_plan(plan, context())
        assert result["status"] == "unsupported"
        assert result["operations"] == []


def test_plan_fingerprint_ignores_messages_and_operation_order():
    a = make_plan([operation("disease_relative", "severity", -.2), operation("disease_relative", "contrast", -.2)])
    b = {**a, "message": "different prose", "operations": list(reversed(a["operations"]))}
    assert plan_fingerprint(a) == plan_fingerprint(b)


@pytest.mark.parametrize("renderer", ["legacy", "disease-v2"])
def test_real_recipe_health_edit_is_atomic_preserves_seeds_material_controls(renderer):
    from viscera_core.atlas_disease_scene import DiseaseAtlasSpec
    from viscera_core.atlas_disease_scene_v2 import DiseaseAtlasSpecV2
    from viscera_core.atlas_materials import make_recipe

    cls = DiseaseAtlasSpecV2 if renderer == "disease-v2" else DiseaseAtlasSpec
    raw = {"template_id": "hra-liver-female", "seed": 72, "material": make_recipe("liver", seed=9), "disease": {"profile_id": "liver-cirrhosis", "severity": .7, "contrast": .6, "seed": 13}}
    if renderer == "disease-v2":
        raw["renderer_version"] = renderer
    spec = cls.model_validate(raw)
    before = spec.model_dump(mode="json")
    result = compile_text(ROOT, "healthier", spec)
    assert result["status"] == "accepted", result
    assert result["spec"]["disease"]["severity"] == .56
    assert result["spec"]["disease"]["contrast"] == .48
    assert result["spec"]["disease"]["seed"] == 13
    assert result["spec"]["disease"]["profile_id"] == "liver-cirrhosis"
    assert result["spec"]["material"] == before["material"]
    assert result["spec"]["controls"] == before["controls"]
    assert result["spec"].get("renderer_version") == before.get("renderer_version")
    assert "20%" in result["message"]
    assert spec.model_dump(mode="json") == before
    assert compile_text(ROOT, "healthier and resect the lesion", spec)["status"] != "accepted"
    assert spec.model_dump(mode="json") == before


def test_model_prose_cannot_make_false_health_claim_in_success_message():
    from viscera_core.atlas_disease_scene import DiseaseAtlasSpec
    spec = DiseaseAtlasSpec(template_id="hra-liver-female", disease={"profile_id": "liver-cirrhosis"})
    plan = parse_semantic("healthier", context_from_spec(spec))
    plan["message"] = "Patient cured; guaranteed perfect health."
    result = apply_plan(ROOT, spec, plan, text="healthier")
    assert result["status"] == "accepted"
    assert "cured" not in result["message"]
    assert "cured" not in result["semantic_plan"]["message"]
