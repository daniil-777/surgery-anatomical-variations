import numpy as np
from test_atlas_disease_v2 import template
from viscera_core.atlas_disease_v2 import (
    DiseaseSpecV2,
    _source_cache,
    disease_field,
    transform_points,
)
from viscera_core.atlas_joint_dataset_v2 import _render, family_splits, sample_controls
from viscera_core.atlas_joint_v2 import decode_controls, spatial_features


def test_stratified_families_and_shared_baseline_material():
    condition = {
        "renderer_version": "disease-v2",
        "template_id": "test",
        "organ": "liver",
        "profile_id": "liver-cirrhosis",
        "material_preset": "balanced",
    }
    a = sample_controls(condition, 24, 89)
    b = sample_controls({**condition, "profile_id": "baseline"}, 24, 89)
    np.testing.assert_array_equal(a[:, :13], b[:, :13])
    assert not b[:, 13:].any()
    roles = family_splits(24, 31)
    for band in range(3):
        assert set(roles[band::3]) == {"train", "val", "audit"}
    for band, (lo, hi) in enumerate(((0.1, 0.35), (0.35, 0.7), (0.7, 1))):
        s = (a[band::3, 13] + 1) / 2
        assert ((s > lo) & (s < hi)).all()


def test_anchor_renderer_exact_replay_and_phase(monkeypatch):
    t = template()
    monkeypatch.setattr("viscera_core.atlas_joint_dataset_v2.get_template", lambda *_: t)
    condition = {
        "renderer_version": "disease-v2",
        "template_id": "test",
        "organ": "liver",
        "profile_id": "liver-cirrhosis",
        "material_preset": "balanced",
    }
    x = sample_controls(condition, 24, 89)[2]
    task = ("", condition, x, 214, [321, 456], 32, "sample", "group", "train", 3, True)
    meta, arr = _render(task)
    assert meta["full_mesh_qa"]["passed"]
    assert meta["lesion_visible_anchor_count"] > 0
    d = decode_controls(condition, arr["controls"], 214, np.array([321, 456], dtype=np.uint32))
    f = disease_field(t, DiseaseSpecV2.model_validate(d["disease"]), d["controls"])
    v, n = transform_points(t, d["controls"], t.vertices_mm, f, normals=_source_cache(t)["normals"])
    ids = arr["anchor_vertex_ids"]
    np.testing.assert_array_equal(arr["observations"][:, :3], (v[ids] / 100).astype(np.float32))
    np.testing.assert_array_equal(arr["normals"], n[ids].astype(np.float32))
    np.testing.assert_array_equal(
        arr["spatial_features"], spatial_features(np.array([321, 456], dtype=np.uint32))
    )
    assert len(np.unique(ids)) == 32
    _, other = _render(
        ("", condition, x, 214, [321, 999], 32, "sample2", "group", "train", 3, False)
    )
    assert not np.array_equal(arr["observations"], other["observations"])


def test_source_safe_family_projection_is_bound_and_replayable(monkeypatch):
    from test_atlas_disease_v2 import sliver_template
    from viscera_core.atlas import CONTROL_NAMES
    from viscera_core.atlas_disease_v2 import mesh_qa
    from viscera_core.atlas_joint_dataset_v2 import safe_shape_controls

    t = sliver_template()
    controls = dict.fromkeys(CONTROL_NAMES, 0.0)
    controls["bend"] = 0.9
    applied, fraction = safe_shape_controls(t, controls)
    assert 0 < fraction < 1
    assert controls["bend"] == 0.9
    assert applied["bend"] == controls["bend"] * fraction
    assert safe_shape_controls(t, controls) == (applied, fraction)
    assert mesh_qa(t, transform_points(t, applied, t.vertices_mm, None), None, applied)["passed"]


def test_uncertifiable_layouts_are_explicitly_rejected_without_fake_targets(monkeypatch):
    t = template()
    monkeypatch.setattr("viscera_core.atlas_joint_dataset_v2.get_template", lambda *_: t)
    attempts = []

    def rejected_field(_template, spec, _controls):
        attempts.append(spec.seed)
        raise ValueError("Requested intermediate strength fails full discrete face QA")

    monkeypatch.setattr("viscera_core.atlas_joint_dataset_v2.disease_field", rejected_field)
    condition = {
        "renderer_version": "disease-v2",
        "template_id": "test",
        "organ": "liver",
        "profile_id": "liver-cirrhosis",
        "material_preset": "balanced",
    }
    x = sample_controls(condition, 24, 89)[2]
    meta, arrays = _render(
        ("", condition, x, 214, [321, 456], 32, "sample", "group", "audit", 3, True)
    )
    assert meta["status"] == "rejected_source_triangle_or_precision_qa"
    assert arrays == {}
    assert len(attempts) == len(set(attempts)) == 16
    assert meta["renderer_seeds"][0] == 321
    assert meta["disease"]["seed"] == attempts[-1]
    assert meta["group_id"] == "group" and meta["split"] == "audit"
