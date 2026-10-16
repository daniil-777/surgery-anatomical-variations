"""Independent contract review of disease wrappers on the available atlas references.

The large real-source sweep is opt-in; its outputs are geometry engineering checks,
not an anatomical or biomechanical certification.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
import pytest
from viscera_core.atlas_disease import PROFILES, DiseaseSpec, deform_disease, evaluate_mask
from viscera_core.atlas_disease_scene import DiseaseAtlasSpec, realize
from viscera_core.atlas_disease_text import compile_text
from viscera_core.atlas_scene import catalog, get_template

ROOT = Path(os.environ.get("VISCERA_REVIEW_TEMPLATES", "datasets/atlas/cohort-v2/templates"))
SUPPORTED = [key for key, profile in PROFILES.items() if profile["supported"]]


def field_fixture():
    return {
        "fields": [
            {"center_mm": [0, 0, 0], "radius_mm": 5, "amplitude_mm": 1, "direction": [0, 0, 1]},
            {"center_mm": [11, 0, 0], "radius_mm": 5, "amplitude_mm": 0.5, "direction": [0, 1, 0]},
        ],
        "steps": 3,
    }


def test_compact_field_is_identity_outside_support_and_lipschitz_bound_is_conservative():
    field = field_fixture()
    far = np.array([[50.0, 10.0, -20.0], [-20.0, 20.0, 0.0]])
    np.testing.assert_array_equal(deform_disease(far, field), far)
    np.testing.assert_array_equal(evaluate_mask(far, field), 0)
    # Exact analytic derivative sampled throughout a support ball is positive.
    rng = np.random.default_rng(251)
    samples = rng.uniform(-5, 5, (2000, 3))
    r2 = np.sum(samples * samples, axis=1) / 25
    grad = -6 * np.maximum(1 - r2, 0)[:, None] ** 2 * samples / 25
    jac = np.eye(3)[None] + np.einsum("i,nj->nij", [0.0, 0.0, 1.0], grad)
    assert np.linalg.det(jac).min() >= 1 - 0.344
    assert np.linalg.svd(jac, compute_uv=False).min() >= 1 - 0.344


def source_spec(organ="liver"):
    if not (ROOT / "catalog.json").is_file():
        pytest.skip("Atlas source templates unavailable")
    entry = next(row for row in catalog(ROOT)["organs"] if row["id"] == organ)
    return DiseaseAtlasSpec(template_id=entry["templates"][0]["id"])


@pytest.mark.parametrize(
    "text",
    [
        "cirrhosis and aortic stenosis",
        "cirrhosis and stiffness 5 kPa",
        "without cirrhosis",
        "cirrhosis severity 2",
        "cirrhosis count 1.5",
        "cirrhosis size 0.5 and impossiblephysics",
        "healthy cirrhosis",
        "aortic stenosis",
        "gastric ulcer and darker tissue",
    ],
)
def test_unsupported_disease_text_is_atomic(text):
    spec = source_spec()
    before = spec.model_dump(mode="json")
    result = compile_text(ROOT, text, spec)
    assert result["status"] == "unsupported"
    assert "spec" not in result
    assert spec.model_dump(mode="json") == before


@pytest.mark.skipif(
    os.environ.get("VISCERA_DISEASE_FULL_SWEEP") != "1", reason="opt-in real-source geometry sweep"
)
@pytest.mark.parametrize("profile_id", SUPPORTED)
def test_real_source_severity_seed_sweep(profile_id):
    base_spec = source_spec(PROFILES[profile_id]["organ"])
    baseline = realize(ROOT, base_spec)
    source = get_template(ROOT, base_spec.template_id)
    original = np.asarray(baseline["scene"]["organs"][0]["positions"]).reshape(-1, 3)
    source_indices = np.asarray(baseline["scene"]["organs"][0]["indices"])
    positive = []
    rows = []
    for severity in (0.0, 1.0):
        for seed in (42, 314159):
            spec = DiseaseAtlasSpec(
                **{
                    **base_spec.model_dump(),
                    "disease": DiseaseSpec(profile_id=profile_id, severity=severity, seed=seed),
                }
            )
            result = realize(ROOT, spec)
            item = result["scene"]["organs"][0]
            vertices = np.asarray(item["positions"]).reshape(-1, 3)
            displacement = float(np.linalg.norm(vertices - original, axis=1).max())
            np.testing.assert_array_equal(item["indices"], source_indices)
            assert vertices.shape == source.vertices_mm.shape
            assert np.isfinite(vertices).all()
            assert result["scene"]["metadata"]["qa"]["passed"]
            assert result["summary"]["min_jacobian"] > 0
            sites = item["metadata"]["disease_field"]["fields"]
            for i, a in enumerate(sites):
                for b in sites[i + 1 :]:
                    assert (
                        np.linalg.norm(np.asarray(a["center_mm"]) - b["center_mm"])
                        > a["radius_mm"] + b["radius_mm"]
                    )
            if severity == 0:
                np.testing.assert_array_equal(vertices, original)
                assert displacement == 0
            else:
                assert displacement > 1e-8
                positive.append(vertices)
            rows.append(
                {
                    "profile": profile_id,
                    "template": base_spec.template_id,
                    "severity": severity,
                    "seed": seed,
                    "max_displacement_mm": displacement,
                    "fraction": result["summary"]["disease"]["applied_displacement_fraction"],
                    "sites": len(sites),
                    "passed": True,
                }
            )
    assert np.max(np.abs(positive[0] - positive[1])) > 1e-8
    output = Path(
        os.environ.get("VISCERA_DISEASE_REVIEW_OUTPUT", "/tmp/viscera-disease-review-sweep.jsonl")
    )
    with output.open("a") as stream:
        for row in rows:
            stream.write(json.dumps(row) + "\n")


def test_direct_disease_field_does_not_poison_fresh_atlas_cache():
    from viscera_core.atlas import generate, load_template
    from viscera_core.atlas_disease import disease_field

    spec = source_spec()
    template = load_template(ROOT, spec.template_id)
    disease_field(template, DiseaseSpec(profile_id="liver-hcc"))
    generated = generate(template, [0.0] * 7)
    assert generated.qa["passed"]


def test_plain_disease_glb_keeps_nonmetallic_double_sided_material_and_clearcoat():
    import struct

    from viscera_core.atlas_disease_scene import export_glb

    base = source_spec()
    result = realize(
        ROOT, DiseaseAtlasSpec(**{**base.model_dump(), "disease": {"profile_id": "liver-hcc"}})
    )
    binary = export_glb(ROOT, DiseaseAtlasSpec.model_validate(result["spec"]))
    length = struct.unpack_from("<I", binary, 12)[0]
    tree = json.loads(binary[20 : 20 + length])
    appearance = result["scene"]["organs"][0]["metadata"]["appearance"]
    material = tree["materials"][tree["meshes"][0]["primitives"][0]["material"]]
    assert material["pbrMetallicRoughness"]["metallicFactor"] == 0
    assert material["pbrMetallicRoughness"]["roughnessFactor"] == appearance["roughness"]
    assert material["doubleSided"] is True
    assert (
        material["extensions"]["KHR_materials_clearcoat"]["clearcoatFactor"]
        == appearance["clearcoat"]
    )
