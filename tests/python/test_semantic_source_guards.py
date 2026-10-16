"""Independent learned-output boundary regressions; no challenge labels reused.

A model can emit structurally valid JSON with the wrong intent. These tests
check that such output never applies a partial or contradictory edit. The
requests were authored independently of the dataset generator and parser.
"""

from copy import deepcopy

import pytest
from viscera_core.atlas_semantic import make_plan, operation, validate_plan


def _context(*, baseline=False):
    return {
        "organ": "liver",
        "renderer_version": "disease-v2",
        "disease": None if baseline else {
            "profile_id": "liver-cirrhosis", "seed": 17,
            "severity": .6, "size": .5, "spread": .4,
            "irregularity": .3, "contrast": .5, "count": 3,
            "location": [.2, .1, .8],
        },
        "controls": {name: 0.0 for name in (
            "scale_x", "scale_y", "scale_z", "bend", "twist", "taper", "asymmetry",
        )},
        "material": {"organ": "liver", "wetness": .5, "tint": 0.0},
        "appearance": "tissue",
    }


def _health(fraction=-.2):
    return [operation("disease_relative", "severity", fraction),
            operation("disease_relative", "contrast", fraction)]


@pytest.mark.parametrize(("utterance", "operations", "baseline"), [
    ("make this healthier", _health(.2), False),
    ("make this healthier", [operation("disease_set", "profile_id", "liver-hcc")], False),
    ("make this healthier", [operation("disease_relative", "size", -.2)], False),
    ("make this healthier and wetter", [operation("material_relative", "wetness", .15)], False),
    ("make this healthier and wetter", _health(), False),
    ("make this 7% wider", [operation("shape_relative", "width", -.5)], True),
    ("make this 7% wider", [operation("shape_relative", "width", -.07)], True),
    ("make this 7% wider and 3% taller", [operation("shape_relative", "width", .03),
                                         operation("shape_relative", "height", .07)], True),
    ("make this 20% healthier and 10% wider", _health(-.1) + [operation("shape_relative", "width", .2)], False),
    ("set wetness to 0.4 and severity to 0.7", [operation("material_set", "wetness", .7),
                                              operation("disease_set", "severity", .4)], False),
    ("set width to 18 cm and height to 200 mm", [operation("shape_absolute", "width", 200),
                                                operation("shape_absolute", "height", 180)], True),
    ("make it 10% less irregular", [operation("disease_relative", "irregularity", .1)], False),
    ("make lesions 12% smaller", [operation("disease_relative", "contrast", -.12)], False),
    ("set bend to 0.3", [operation("control_set", "twist", .3)], True),
    ("make kidney healthier", _health(), False),
    ("set bend to 0.3 and duplicate the organ", [operation("control_set", "bend", .3)], True),
    ("make this healthier and add a spaceship", _health(), False),
    ("make this healthier with Child-Pugh class A", _health(), False),
    ("make this healthier with stage IV cancer", _health(), False),
    ("set twist to 0.3 without changing height", [operation("control_set", "twist", .3),
                                                operation("preserve", "height")], True),
    ("set bend to 0.3 without changing width", [operation("control_set", "bend", .3),
                                               operation("preserve", "width")], True),
    ("make this healthier and preserve the exact geometry", _health() + [operation("preserve", "shape")], False),
    ("set wetness to 0.3 and restore normal perfusion", [operation("material_set", "wetness", .3)], False),
])
def test_incorrect_model_intent_is_refused_atomically(utterance, operations, baseline):
    context = _context(baseline=baseline)
    before = deepcopy(context)
    result = validate_plan(make_plan(operations), context, text=utterance)
    assert result["status"] in {"unsupported", "clarify"}, (utterance, result)
    assert result["operations"] == [], (utterance, result)
    assert context == before


@pytest.mark.parametrize(("utterance", "operations", "baseline"), [
    ("make this 7% wider", [operation("shape_relative", "width", .07)], True),
    ("make this 7% wider and 3% taller", [operation("shape_relative", "width", .07),
                                         operation("shape_relative", "height", .03)], True),
    ("set wetness to 0.4 and severity to 0.7", [operation("material_set", "wetness", .4),
                                              operation("disease_set", "severity", .7)], False),
    ("ease the pathology visual footprint", _health(), False),
    ("make this healthier and preserve shape controls", _health() + [operation("preserve", "shape_controls")], False),
    ("do not change the disease and set wetness to 0.3", [operation("preserve", "disease"),
                                                       operation("material_set", "wetness", .3)], False),
])
def test_matching_model_intent_remains_usable(utterance, operations, baseline):
    context = _context(baseline=baseline)
    before = deepcopy(context)
    result = validate_plan(make_plan(operations), context, text=utterance)
    assert result["status"] == "accepted", (utterance, result)
    assert result["operations"] == operations
    assert context == before


@pytest.mark.parametrize(("profile", "utterance", "fraction", "accepted"), [
    ("liver-cirrhosis", "make tumor smaller", -.2, False),
    ("liver-steatotic-enlargement", "make the cyst larger", .2, False),
    ("liver-hcc", "make the cyst larger", .2, False),
    ("liver-capsular-cyst", "make tumor smaller", -.2, False),
    ("liver-hcc", "make tumor smaller", -.2, True),
    ("liver-capsular-cyst", "make the cyst larger", .2, True),
])
def test_clinical_noun_matches_selected_surface_profile(profile, utterance, fraction, accepted):
    context = _context()
    context["disease"]["profile_id"] = profile
    before = deepcopy(context)
    result = validate_plan(
        make_plan([operation("disease_relative", "size", fraction)]), context, text=utterance,
    )
    assert (result["status"] == "accepted") is accepted, (profile, utterance, result)
    if not accepted:
        assert result["operations"] == []
    assert context == before
