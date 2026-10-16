import numpy as np
import pytest
import trimesh
from viscera_core.atlas import CONTROL_NAMES, AtlasTemplate
from viscera_core.atlas_disease_scene_v2 import DiseaseAtlasSpecV2
from viscera_core.atlas_disease_v2 import (
    PROFILES,
    DiseaseSpecV2,
    deform_disease,
    disease_field,
    mesh_qa,
    transform_points,
)


def template():
    mesh = trimesh.creation.icosphere(subdivisions=3, radius=50)
    return AtlasTemplate(
        vertices_mm=np.asarray(mesh.vertices),
        faces=np.asarray(mesh.faces),
        colors=np.full((len(mesh.vertices), 3), 0.4),
        component_ids=np.zeros(len(mesh.vertices), dtype=np.int32),
        metadata={
            "organ": "liver",
            "components": [{"name": "liver capsule"}],
            "normalization_mm": 100.0,
            "control_limits": [0.25, 0.25, 0.25, 0.15, 0.15, 0.12, 0.15],
        },
    )


def test_explicit_version_and_profile_validation():
    with pytest.raises(ValueError):
        DiseaseAtlasSpecV2(template_id="x")
    with pytest.raises(ValueError):
        DiseaseSpecV2(profile_id="kidney-polycystic", severity=True)
    with pytest.raises(ValueError):
        disease_field(template(), DiseaseSpecV2(profile_id="kidney-polycystic"))
    counts = {}
    for p in PROFILES.values():
        if p["supported"]:
            counts[p["organ"]] = counts.get(p["organ"], 0) + 1
    assert len(counts) == 12 and set(counts.values()) == {5}


def test_compact_map_jacobian_and_normal_transport():
    t = template()
    s = DiseaseSpecV2(profile_id="liver-hcc", severity=1, size=0.8, count=2)
    f = disease_field(t, s)
    p = t.vertices_mm.copy()
    transformed, jac = deform_disease(p, f, jacobian=True)
    eps = 1e-4
    numerical = np.stack(
        [
            (deform_disease(p + np.eye(3)[a] * eps, f) - deform_disease(p - np.eye(3)[a] * eps, f))
            / (2 * eps)
            for a in range(3)
        ],
        axis=-1,
    )
    np.testing.assert_allclose(jac, numerical, atol=1e-8, rtol=1e-7)
    assert np.linalg.det(jac).min() >= f["continuous_jacobian_lower_bound"] - 1e-9
    controls = dict(zip(CONTROL_NAMES, [0.2, -0.3, 0.4, 0.7, -0.6, 0.5, 0.6]))
    n = p / np.linalg.norm(p, axis=1)[:, None]
    v, outn = transform_points(t, controls, p, f, normals=n)
    total = np.stack(
        [
            (
                transform_points(t, controls, p + np.eye(3)[a] * eps, f)
                - transform_points(t, controls, p - np.eye(3)[a] * eps, f)
            )
            / (2 * eps)
            for a in range(3)
        ],
        axis=-1,
    )
    expected = np.linalg.solve(total.transpose(0, 2, 1), n[..., None])[..., 0]
    expected /= np.linalg.norm(expected, axis=1)[:, None]
    np.testing.assert_allclose(outn, expected, atol=1e-8)
    assert mesh_qa(t, v, f, controls)["passed"]


def test_identity_and_full_query_replay_and_distinct_profiles():
    t = template()
    controls = dict.fromkeys(CONTROL_NAMES, 0.0)
    for profile in [
        "liver-cirrhosis",
        "liver-hcc",
        "liver-metastases",
        "liver-steatotic-enlargement",
        "liver-capsular-cyst",
    ]:
        f = disease_field(t, DiseaseSpecV2(profile_id=profile, severity=0))
        np.testing.assert_array_equal(deform_disease(t.vertices_mm, f), t.vertices_mm)
    outputs = []
    for p in PROFILES.values():
        if p["supported"] and p["organ"] == "liver":
            f = disease_field(t, DiseaseSpecV2(profile_id=p["id"], severity=1, count=8))
            a = transform_points(t, controls, t.vertices_mm, f)
            b = transform_points(t, controls, t.vertices_mm[::7], f)
            np.testing.assert_array_equal(a[::7], b)
            outputs.append(a)
    assert all(np.linalg.norm(a - b) > 1 for i, a in enumerate(outputs) for b in outputs[i + 1 :])


def sliver_template():
    """A source triangle whose straight chords can invert under a valid shear."""
    t = template()
    offset = len(t.vertices_mm)
    # The continuous x bend is a bijection. Its displaced straight edge chord
    # can nevertheless cross this triangle's third vertex.
    return AtlasTemplate(
        vertices_mm=np.vstack((t.vertices_mm, [[0, 0, -10], [0, 0, 10], [0.005, 0, 0]])),
        faces=np.vstack((t.faces, [offset, offset + 1, offset + 2])),
        colors=np.vstack((t.colors, np.full((3, 3), 0.4))),
        component_ids=np.r_[t.component_ids, np.zeros(3, dtype=np.int32)],
        metadata=t.metadata.copy(),
    )


def test_discrete_guard_detects_chord_inversion_despite_positive_continuous_jacobian():
    t = sliver_template()
    controls = dict.fromkeys(CONTROL_NAMES, 0.0)
    controls["bend"] = 0.9
    v = transform_points(t, controls, t.vertices_mm, None)
    qa = mesh_qa(t, v, None, controls)
    assert qa["continuous_jacobian_lower_bound"] > 0
    assert not qa["passed"]
    assert qa["opposed_transported_face_normals"] == 1
    # No local field is needed for this failure; global/base-map faces count.
    with pytest.raises(ValueError, match="full-source|intermediate"):
        disease_field(t, DiseaseSpecV2(profile_id="liver-capsular-cyst", seed=7), controls)


def test_requested_strength_scales_relative_to_source_capacity():
    t = template()
    controls = dict.fromkeys(CONTROL_NAMES, 0.0)
    fields = [
        disease_field(t, DiseaseSpecV2(profile_id="liver-cirrhosis", severity=s, seed=47), controls)
        for s in (0.1, 0.3, 0.6, 0.9, 1.0)
    ]
    capacities = [f["discrete_guard"]["strength_capacity"] for f in fields]
    assert max(capacities) == min(capacities)
    gains = [f["effective_morphology_strength"] for f in fields]
    assert gains == sorted(gains)
    np.testing.assert_allclose(gains, np.array([0.1, 0.3, 0.6, 0.9, 1.0]) * capacities[0])
    assert all(f["full_mesh_qa"]["passed"] for f in fields)


def test_actual_strength_backoff_is_shared_and_explicit(monkeypatch):
    import viscera_core.atlas_disease_v2 as renderer

    t = template()
    original = renderer.mesh_qa
    calls = []

    def intermediate_fails(*args):
        qa = original(*args)
        calls.append(qa)
        # Unit-capacity succeeds; quantization invalidates requested .8 only.
        if len(calls) == 2:
            return {**qa, "passed": False}
        return qa

    monkeypatch.setattr(renderer, "mesh_qa", intermediate_fails)
    f = disease_field(t, DiseaseSpecV2(profile_id="liver-hcc", severity=0.8))
    assert f["full_mesh_qa"]["passed"]
    assert f["effective_morphology_strength"] == 0.4
    assert f["applied_displacement_fraction"] == 0.5
    assert f["discrete_guard"]["actual_strength_backoffs"] == 1
    assert f["discrete_guard"]["intermediate_rejected_strengths"] == [0.8]
