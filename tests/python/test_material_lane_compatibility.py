"""The reviewed reference-colour extension is sound for the material sampler lane.

The material release (datasets/atlas/material-v1) and the material models pin
py/viscera_core/atlas_materials.py at its training bytes; the frozen copy of those bytes is
disease-releases/geometry-v1/decoder/atlas_materials.py. Loaded under another module name, it and
the current module evaluate everything this lane computes -- every recipe of the release (train,
val and audit) at the release's own anchor points, the realized reference surfaces with their
tissue/ligament regions, and the served model's proposals -- and agree byte for byte: recipes,
their JSON, the resolved uniforms and every field array. The serving checks
(services.api.atlas_material_compat, the bundle import's source check) then accept exactly this
extension and refuse any other drift, and POST /api/atlas/sample-material answers with its
provenance, the two repaired references included.
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from viscera_core import atlas_material_dataset as dataset
from viscera_core import atlas_materials as materials
from viscera_core.atlas import list_templates
from viscera_core.atlas_dataset import content_hash, digest
from viscera_core.atlas_scene import get_template
from viscera_core.atlas_surface_scene import material_regions

from pipelines.train.viscera_train import atlas_material as prior
from services.api import atlas_material_compat as compat
from services.api import atlas_model_registry as registry

ROOT = Path(__file__).resolve().parents[2]
FROZEN = ROOT / "disease-releases/geometry-v1/decoder/atlas_materials.py"
RELEASE = ROOT / "datasets/atlas/material-v1"
COHORT = ROOT / "datasets/atlas/cohort-v2/templates"
REPAIRED = ROOT / "datasets/anatomy-templates/templates-v3"
MATERIAL_PATH = "py/viscera_core/atlas_materials.py"
TRAINED_SHA256 = "679aa9214cef534b92e1d64b0043213a88a8c6a0fdd9b25b7ae54e4fa289a0a3"
REFERENCE_EXTENSION_SHA256 = "7bc443111cec91a295297eb1abab9ed3d1acfd6724c49b56c27c4dd0ea650d17"
FIELDS = ("rgb_linear", "rgb_srgb", "roughness", "height_mm", "height_gradient_drest_mm")
SPLITS = ("train", "val", "audit")


@pytest.fixture(scope="module")
def frozen() -> Iterator[Any]:
    if not FROZEN.is_file():
        pytest.skip("the frozen training decoder (disease-releases/geometry-v1/decoder) is absent")
    assert digest(FROZEN) == TRAINED_SHA256
    name = "_material_lane_training_reference"
    spec = importlib.util.spec_from_file_location(name, FROZEN)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
        yield module
    finally:
        sys.modules.pop(name, None)


@pytest.fixture(scope="module")
def release() -> Path:
    if not (RELEASE / "release.json").is_file():
        pytest.skip("the material-v1 release is absent")
    return RELEASE


@pytest.fixture(scope="module")
def served(release: Path) -> tuple[Path, dict[str, Any]]:
    """The model the route serves (the active imported bundle, else the packaged default)."""
    path = registry.resolve_model(ROOT, "material")
    if not path.is_file():
        pytest.skip("no material model is installed")
    model = compat.load_model(path)
    assert model["metadata"]["identity"]["dataset_release_sha256"] == digest(
        release / "release.json"
    )
    return path, model


def same_bytes(actual: Any, expected: Any) -> None:
    a, b = np.asarray(actual), np.asarray(expected)
    assert a.dtype == b.dtype and a.shape == b.shape
    assert a.tobytes() == b.tobytes()


def assert_same_sample(current: Any, training: Any) -> None:
    for field in FIELDS:
        same_bytes(getattr(current, field), getattr(training, field))
    assert current.metadata == training.metadata


def training_twin(frozen: Any, recipe: Any) -> Any:
    """The training decoder's recipe for the same organ, preset, seed and six controls, checked
    equal to the current one in every form the lane serializes or resolves it."""
    controls = {name: getattr(recipe, name) for name in materials.CONTROL_NAMES}
    training = frozen.make_recipe(recipe.organ, recipe.preset, recipe.seed, **controls)
    assert recipe.reference_color is None
    assert recipe.model_dump() == training.model_dump()
    assert recipe.model_dump_json() == training.model_dump_json()
    assert frozen.MaterialRecipe.model_validate(recipe.model_dump()) == training
    assert materials.resolve_material(recipe) == frozen.resolve_material(training)
    return training


def test_every_release_recipe_is_byte_identical_under_the_training_decoder(frozen, release):
    """controls_recipe -> make_recipe -> sample_material at the release's anchor points, as the
    dataset builder, evaluate_controls and the route's measured statistics run them."""
    anchors = prior.load_anchors(release)
    count = 0
    for split in SPLITS:
        rows = compat.read_split(release, split)
        for i, controls in enumerate(rows["controls"]):
            organ, preset = str(rows["organ_names"][i]), str(rows["presets"][i])
            recipe = dataset.controls_recipe(organ, preset, int(rows["seeds"][i]), controls)
            training = training_twin(frozen, recipe)
            points = anchors[str(rows["template_ids"][i])]
            current = materials.sample_material(recipe, points)
            assert_same_sample(current, frozen.sample_material(training, points))
            # ...and the current decoder reproduces the release's own supervision
            fields = dataset.field_arrays(current)
            np.testing.assert_allclose(
                dataset.field_summary(fields), rows["conditions"][i], rtol=1e-12, atol=0
            )
            np.testing.assert_allclose(fields, rows["field_values"][i], rtol=6e-8, atol=1e-30)
            count += 1
    recipe_card = json.loads((release / "release.json").read_text())["recipe"]
    groups = len(materials.PROFILES) * len(materials.PRESETS)
    assert count == recipe_card["per_organ_preset"] * groups == 768


def test_realized_reference_surfaces_are_byte_identical_under_the_training_decoder(
    frozen, release
):
    """realize() colours a reference by sample_material at its rest vertices with its material
    regions: every cohort-v2 reference (the sampler's realization library) and every repaired
    templates-v3 reference (what a disease-v2 request displays), each with a release recipe of its
    organ (the four presets in turn)."""
    rows = compat.read_split(release, "train")
    trained = {m["template_id"]: m["artifact_sha256"] for m in list_templates(COHORT)}
    libraries = [(COHORT, list_templates(COHORT))]
    if (REPAIRED / "catalog.json").is_file():
        repaired = [
            m for m in list_templates(REPAIRED) if m["artifact_sha256"] != trained[m["template_id"]]
        ]
        assert sorted(m["template_id"] for m in repaired) == [
            "hra-heart-male",
            "hra-urinary-bladder-male",
        ]
        libraries.append((REPAIRED, repaired))
    presets = list(materials.PRESETS)
    evaluated = 0
    for library, metas in libraries:
        for index, meta in enumerate(metas):
            template = get_template(library, meta["template_id"])
            regions = material_regions(template)
            same_bytes(
                regions,
                frozen.material_region_ids(template.component_ids, template.metadata["components"]),
            )
            preset = presets[index % len(presets)]
            row = next(
                i
                for i in range(len(rows["controls"]))
                if rows["organ_names"][i] == meta["organ"] and rows["presets"][i] == preset
            )
            recipe = dataset.controls_recipe(
                meta["organ"], preset, int(rows["seeds"][row]), rows["controls"][row]
            )
            training = training_twin(frozen, recipe)
            vertices = template.vertices_mm
            assert_same_sample(
                materials.sample_material(recipe, vertices, region_ids=regions),
                frozen.sample_material(training, vertices, region_ids=regions),
            )
            evaluated += 1
    assert evaluated == sum(len(metas) for _, metas in libraries) >= 24


def test_served_proposals_are_byte_identical_under_the_training_decoder(frozen, release, served):
    """sample_recipe for every organ/preset group of the served model, unconditional and with
    requested field statistics, at three uint32 seeds, measured at the route's anchor template."""
    _, model = served
    anchors = prior.load_anchors(release)
    sources = json.loads((release / "dataset_card.json").read_text())["source_templates"]
    names = dataset.CONDITION_NAMES
    count = 0
    for group in model["group_names"]:
        organ, preset = str(group).split("|")
        ids = np.flatnonzero(model["train_groups"] == group)
        median = dict(zip(names, np.median(model["train_conditions"][ids], axis=0), strict=True))
        requests: list[dict[str, float] | None] = [
            None,
            {"roughness_mean": float(median["roughness_mean"])},
            {"mean_red_linear": float(median["mean_red_linear"]),
             "height_rms_mm": float(median["height_rms_mm"])},
        ]
        points = anchors[sorted(k for k in anchors if sources[k]["organ"] == organ)[0]]
        for seed in (0, 42, 2**32 - 1):
            for conditions in requests:
                proposal = prior.sample_recipe(model, organ, preset, seed, conditions)
                recipe = materials.MaterialRecipe.model_validate(proposal["recipe"])
                training = training_twin(frozen, recipe)
                assert frozen.MaterialRecipe.model_validate(proposal["recipe"]) == training
                assert_same_sample(
                    materials.sample_material(recipe, points),
                    frozen.sample_material(training, points),
                )
                count += 1
    assert count == len(model["group_names"]) * 9 == 432


def test_serving_checks_accept_the_reviewed_extension_and_refuse_other_drift(
    release, served, tmp_path, monkeypatch
):
    model_path, model = served
    release_record = json.loads((release / "release.json").read_text())
    pinned = release_record["recipe"]["code_hashes"]
    identity = model["metadata"]["identity"]
    # The premise: release and model pin the training bytes, the tree holds the extension, and the
    # pinned checks' own sources are the ones the release and the model were built with.
    assert pinned == identity["dataset_code_hashes"]
    assert pinned["atlas_materials.py"] == TRAINED_SHA256
    assert dataset.code_hashes() == {**pinned, "atlas_materials.py": REFERENCE_EXTENSION_SHA256}
    assert digest(Path(prior.__file__)) == identity["source_sha256"]
    with pytest.raises(ValueError, match="Material generator source drift"):
        dataset.verify_material_release(release)
    with pytest.raises(ValueError, match="Material model/decoder source drift"):
        prior.load_model(model_path)
    # The serving checks accept exactly the reviewed pair and run every other check unchanged.
    assert compat.reviewed_code_hashes(pinned) == pinned
    assert compat.verify_material_release(release) == release_record
    assert len(compat.read_split(release, "train")["controls"]) == 480
    assert compat.load_model(model_path)["metadata"]["model_sha256"] == digest(model_path)

    def release_pinning(name: str, sha256: str) -> Path:
        value = json.loads(json.dumps(release_record))
        value["recipe"]["code_hashes"][name] = sha256
        value["release_id"] = content_hash(value["recipe"])[:20]
        value["artifact_hashes"] = {}
        root = tmp_path / f"release-{name}-{sha256[:6]}"
        root.mkdir()
        (root / "release.json").write_text(json.dumps(value))
        return root

    # a release rebuilt on the extension's bytes is exact; any other pin is drift
    compat.verify_material_release(release_pinning("atlas_materials.py", REFERENCE_EXTENSION_SHA256))
    compat.verify_material_release(release_pinning("atlas_materials.py", TRAINED_SHA256))
    for name in ("atlas_materials.py", "atlas_material_dataset.py"):
        with pytest.raises(ValueError, match="Material generator source drift"):
            compat.verify_material_release(release_pinning(name, "a" * 64))

    def model_pinning(label: str, **updates: Any) -> Path:
        directory = tmp_path / f"model-{label}"
        directory.mkdir()
        shutil.copyfile(model_path, directory / "model.npz")
        meta = json.loads(model_path.with_suffix(".json").read_text())
        meta["identity"].update(updates)
        (directory / "model.json").write_text(json.dumps(meta))
        return directory / "model.npz"

    compat.load_model(model_pinning("copy"))
    for label, updates in {
        "material": {"dataset_code_hashes": {**pinned, "atlas_materials.py": "a" * 64}},
        "dataset": {"dataset_code_hashes": {**pinned, "atlas_material_dataset.py": "a" * 64}},
        "extra": {"dataset_code_hashes": {**pinned, "atlas_extra.py": "a" * 64}},
        "trainer": {"source_sha256": "b" * 64},
    }.items():
        with pytest.raises(ValueError, match="Material model/decoder source drift"):
            compat.load_model(model_pinning(label, **updates))

    # an unreviewed edit of either pinned file is refused by every serving check
    current = dataset.code_hashes
    for name in ("atlas_materials.py", "atlas_material_dataset.py"):
        drifted = {**current(), name: "c" * 64}
        monkeypatch.setattr(dataset, "code_hashes", lambda drifted=drifted: drifted)
        with pytest.raises(ValueError, match="Material generator source drift"):
            compat.verify_material_release(release)
        with pytest.raises(ValueError, match="Material generator source drift"):
            compat.read_split(release, "train")
        with pytest.raises(ValueError, match="Material model/decoder source drift"):
            compat.load_model(model_path)


def test_bundle_import_source_check_accepts_only_the_reviewed_pair(tmp_path):
    root = tmp_path / "checkout"
    names = [
        *(f"py/viscera_core/{name}" for name in registry.LEGACY_CORE_SOURCES),
        *(f"pipelines/train/viscera_train/{name}" for name in registry.LEGACY_TRAIN_SOURCES),
    ]
    for name in names:
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, root / name)
    exact = {name: digest(root / name) for name in names}
    assert exact[MATERIAL_PATH] == REFERENCE_EXTENSION_SHA256
    registry._verify_trained_sources(root, exact)
    registry._verify_trained_sources(root, {**exact, MATERIAL_PATH: TRAINED_SHA256})
    for name, sha256 in (
        (MATERIAL_PATH, "a" * 64),
        ("py/viscera_core/atlas_material_bake.py", "a" * 64),
        ("pipelines/train/viscera_train/atlas_material.py", TRAINED_SHA256),
    ):
        with pytest.raises(ValueError, match=f"source mismatch: {Path(name).name}"):
            registry._verify_trained_sources(root, {**exact, name: sha256})
    with pytest.raises(ValueError, match="source mismatch"):
        registry._verify_trained_sources(root, {})
    (root / MATERIAL_PATH).write_bytes((root / MATERIAL_PATH).read_bytes() + b"\n# unreviewed\n")
    with pytest.raises(ValueError, match="source mismatch: atlas_materials.py"):
        registry._verify_trained_sources(root, {**exact, MATERIAL_PATH: TRAINED_SHA256})


def test_material_route_answers_with_provenance_for_lane_templates(release, served):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from services.api import atlas as api

    _, model = served
    app = FastAPI()
    app.include_router(api.router)
    client = TestClient(app)
    cases = [
        ("hra-liver-female", None), ("hra-liver-female", "disease-v2"),
        ("bp3d-stomach-male", None), ("hra-kidney-male-left", "disease-v2"),
        ("hra-heart-male", None), ("hra-heart-male", "disease-v2"),
        ("hra-urinary-bladder-male", None), ("hra-urinary-bladder-male", "disease-v2"),
    ]
    for template_id, renderer in cases:
        spec: dict[str, Any] = {
            "template_id": template_id, "seed": 42, "controls": {}, "appearance": "tissue",
            **({"renderer_version": renderer} if renderer else {}),
        }
        displayed = client.post("/api/atlas/generate", json=spec)
        assert displayed.status_code == 200, displayed.text
        # the studio sends the displayed, bound spec; a disease-v2 one displays templates-v3
        bound = {**spec, "template_sha256": displayed.json()["spec"]["template_sha256"]}
        response = client.post("/api/atlas/sample-material", json={"spec": bound, "seed": 1729})
        assert response.status_code == 200, (template_id, renderer, response.text)
        result = response.json()
        info = result["summary"]["material_model"]
        assert result["scene"]["metadata"]["material_model"] == info
        assert info["model_sha256"] == model["metadata"]["model_sha256"]
        assert info["material_prior"] == "ridge" and info["condition_status"] == "not_requested"
        assert info["measured_anchor_template"] == template_id
        assert result["spec"]["template_sha256"] == bound["template_sha256"]
        assert result["spec"].get("renderer_version") == renderer
        material = result["spec"]["material"]
        assert info["recipe"] == material
        assert (material["seed"], material["preset"]) == (1729, "balanced")
        assert material["organ"] == get_template(COHORT, template_id).metadata["organ"]
    # requested field statistics: a measured proposal, refused outside the training support
    ids = np.flatnonzero(model["train_groups"] == "liver|balanced")
    roughness = float(np.median(model["train_conditions"][ids, 4]))
    spec = {"template_id": "hra-liver-female", "seed": 42, "controls": {}, "appearance": "tissue"}
    response = client.post(
        "/api/atlas/sample-material",
        json={"spec": spec, "seed": 7, "conditions": {"roughness_mean": roughness}},
    )
    assert response.status_code == 200, response.text
    info = response.json()["summary"]["material_model"]
    assert info["condition_status"] == "measured_proposal_not_exact_constraint"
    assert info["requested_conditions"] == {"roughness_mean": roughness}
    assert set(info["condition_errors"]) == {"roughness_mean"}
    response = client.post(
        "/api/atlas/sample-material",
        json={"spec": spec, "seed": 7, "conditions": {"roughness_mean": 5.0}},
    )
    assert response.status_code == 422 and "training support" in response.text
