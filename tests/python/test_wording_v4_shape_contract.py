"""Known label repair versus unchanged parser; no neural-quality claim."""

from copy import deepcopy

import pytest
from viscera_core import atlas_semantic as semantic

from scripts.build_wording_v4_shape_draft import qualitative_shape_operation, revise_row


@pytest.fixture(params=[False, True])
def context(request):
    return {
        "organ": "liver",
        "renderer_version": "disease-v2",
        "appearance": "tissue",
        "controls": {},
        "material": None,
        "disease": {"profile_id": "liver-cirrhosis", "severity": 0.6, "contrast": 0.5}
        if request.param
        else None,
    }


@pytest.mark.parametrize(
    "direction,field,sign",
    [
        ("wider", "width", 1),
        ("broader", "width", 1),
        ("narrower", "width", -1),
        ("taller", "height", 1),
        ("shorter", "height", -1),
        ("deeper", "depth", 1),
        ("flatter", "depth", -1),
    ],
)
@pytest.mark.parametrize(
    "qualifier,magnitude", [("", 0.05), ("slightly", 0.03), ("a little", 0.03)]
)
def test_magnitudes_match_frozen_parser(context, direction, field, sign, qualifier, magnitude):
    actual = qualitative_shape_operation(direction, qualifier, context)
    assert actual == {"op": "shape_relative", "field": field, "value": sign * magnitude}
    parsed = semantic.parse_semantic(f"make the liver {qualifier} {direction}", context)
    assert parsed["status"] == "accepted" and parsed["operations"] == [actual]


def row(text, family, operations, context):
    return {
        "id": "parent-id",
        "split": "train",
        "family_id": "v3.train." + family,
        "text": text,
        "context": context,
        "target": semantic.make_plan(operations),
    }


@pytest.mark.parametrize("constraint", ["disease", "material"])
def test_repair_preserves_other_operations_and_input(context, constraint):
    original = row(
        f"make the liver wider but preserve the {constraint}",
        "shape_preserve_" + constraint,
        [
            semantic.operation("shape_relative", "width", 0.1),
            semantic.operation("preserve", constraint),
        ],
        context,
    )
    before = deepcopy(original)
    fixed, correction = revise_row(original)
    assert original == before
    assert fixed["text"] == original["text"] and fixed["context"] == original["context"]
    assert fixed["target"]["operations"] == [
        semantic.operation("shape_relative", "width", 0.05),
        semantic.operation("preserve", constraint),
    ]
    assert correction["before"]["value"] == 0.1 and correction["after"]["value"] == 0.05
    assert fixed["parent_row_id"] == original["id"] and fixed["id"] != original["id"]


def test_explicit_percentage_label_is_unchanged(context):
    original = row(
        "make the liver 10% wider",
        "width_up_percent",
        [semantic.operation("shape_relative", "width", 0.1)],
        context,
    )
    fixed, correction = revise_row(original)
    assert correction is None and fixed["target"] == original["target"]
    assert (
        semantic.parse_semantic(original["text"], context)["operations"]
        == original["target"]["operations"]
    )


def test_unexpected_parent_label_fails_without_broad_relabel(context):
    original = row(
        "make the liver wider",
        "width_up_default",
        [semantic.operation("shape_relative", "width", 0.2)],
        context,
    )
    with pytest.raises(ValueError, match="Unexpected parent label"):
        revise_row(original)


def test_unknown_qualifier_has_no_silent_magnitude(context):
    with pytest.raises(ValueError, match="Unsupported qualitative"):
        qualitative_shape_operation("wider", "dramatically", context)


def test_composition_and_refusal_supplement_has_actual_edit_domains(context):
    from scripts.build_wording_v4_shape_draft import composition_examples

    train = composition_examples(context, "train")
    val = composition_examples(context, "val")
    assert len(train) == len(val) == 8
    assert not {r["text"] for r in train} & {r["text"] for r in val}
    rows = {r["coverage_family"]: r for r in train}
    shape_material = rows["shape_material"]["target"]["operations"]
    assert {r["op"] for r in shape_material} == {"shape_relative", "material_relative"}
    shape_disease = rows["shape_disease"]["target"]["operations"]
    assert "shape_relative" in {r["op"] for r in shape_disease}
    assert ("disease_relative" in {r["op"] for r in shape_disease}) == bool(context["disease"])
    for family in ("conflicting_dimensions", "conflicting_material"):
        assert rows[family]["target"]["status"] == "unsupported"
        assert rows[family]["target"]["operations"] == []
    for family, field, value in (
        ("grain_up", "structure_strength", 0.15),
        ("grain_down", "structure_strength", -0.15),
        ("tint_up", "tint", 0.2),
        ("tint_down", "tint", -0.2),
    ):
        assert rows[family]["target"]["operations"] == [
            semantic.operation("material_relative", field, value)
        ]
