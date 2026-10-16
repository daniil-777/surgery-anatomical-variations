"""Expanded text grammar must apply new diseases and preserve versioned recipes."""

from pathlib import Path

import pytest
from viscera_core.atlas_disease_scene_v2 import DiseaseAtlasSpecV2
from viscera_core.atlas_disease_text_v2 import PROFILES, compile_text

ROOT = Path(__file__).resolve().parents[2] / "datasets/atlas/cohort-v2/templates"


@pytest.mark.parametrize("profile", [key for key, value in PROFILES.items() if value["supported"]])
def test_every_supported_profile_is_explicitly_addressable(profile):
    spec = DiseaseAtlasSpecV2(template_id="hra-liver-female", renderer_version="disease-v2")
    result = compile_text(ROOT, profile + " severity 0.83", spec)
    assert result["status"] == "accepted", result
    assert result["spec"]["renderer_version"] == "disease-v2"
    assert result["spec"]["disease"]["profile_id"] == profile
    assert result["spec"]["disease"]["severity"] == 0.83


def test_shape_edit_preserves_v2_disease_and_baseline_clears_it():
    spec = DiseaseAtlasSpecV2(
        template_id="hra-liver-female",
        renderer_version="disease-v2",
        disease={"profile_id": "liver-capsular-cyst", "severity": 0.8},
    )
    result = compile_text(ROOT, "make the liver slightly wider", spec)
    assert result["status"] == "accepted"
    assert result["spec"]["disease"] == spec.disease.model_dump(mode="json")
    assert result["spec"]["controls"] != spec.controls
    assert compile_text(ROOT, "baseline", spec)["spec"].get("disease") is None
    assert compile_text(ROOT, "liver capsular cyst stage 4", spec)["status"] == "unsupported"
