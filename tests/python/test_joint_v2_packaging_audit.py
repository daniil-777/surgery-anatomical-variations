"""Independent v2 delivery preflight, isolated runtime imports and audit recovery."""

from __future__ import annotations

import ast
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from viscera_core.atlas_joint_v2 import RENDERER_PATHS

from scripts import build_joint_v2_notebook as notebook
from scripts import joint_v2_notebook_bootstrap as bootstrap
from scripts import package_joint_v2_colab as packager
from services.api import atlas_joint_model_v2 as importer
from services.api import atlas_joint_registry as history

PROJECT = Path(__file__).resolve().parents[2]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture
def inputs(tmp_path):
    root = tmp_path / "runtime-source"
    core = root / "py/viscera_core"
    core.mkdir(parents=True)
    for source in (PROJECT / "py/viscera_core").glob("*"):
        if source.suffix in {".py", ".json"}:
            shutil.copyfile(source, core / source.name)
    for relative in (
        "pipelines/train/viscera_train/joint_v2.py",
        "scripts/joint_v2_train.py",
        "scripts/qa_joint_model_v2.py",
        "notebooks/requirements-joint-v2-colab.txt",
    ):
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(PROJECT / relative, target)
    templates = tmp_path / "templates"
    templates.mkdir()
    # Packaging checks opaque checksummed members; imports below never read this
    # deliberately tiny fixture as a training mesh or observation array.
    for name in ("fixture.npz", "fixture.json"):
        (templates / name).write_text("fixture")
    lanes = {}
    for lane in ("baseline", "disease"):
        target = tmp_path / lane
        target.mkdir()
        condition = {
            "template_id": "fixture",
            "profile_id": "baseline" if lane == "baseline" else "liver-cirrhosis",
            "organ": "liver",
            "renderer_version": "disease-v2",
            "material_preset": "balanced",
        }
        for name in (
            "train.npz",
            "val.npz",
            "audit.npz",
            "dataset_card.json",
            "reference_catalog.json",
        ):
            (target / name).write_text("fixture")
        (target / "catalog.json").write_text(json.dumps({"conditions": [condition]}))
        release = {
            "format": "viscera-joint-dataset-v2",
            "recipe": {"lane": lane},
            "samples": 24,
            "renderer_hashes": {p: digest(root / p) for p in RENDERER_PATHS},
            "template_hashes": {"fixture": digest(templates / "fixture.npz")},
            "template_metadata_hashes": {"fixture": digest(templates / "fixture.json")},
            "builder_sha256": digest(core / "atlas_joint_dataset_v2.py"),
            "artifact_hashes": {p.name: digest(p) for p in target.iterdir()},
        }
        (target / "release.json").write_text(json.dumps(release))
        lanes[lane] = target
    evidence = tmp_path / "evidence"
    evidence.mkdir()
    return {
        "root": root,
        **lanes,
        "templates": templates,
        "evidence": evidence,
        "out": tmp_path / "release",
    }


@pytest.mark.parametrize("mutation", ["renderer", "mesh", "template_metadata", "lane", "builder"])
def test_packager_rejects_mismatched_inputs_before_creating_archives(inputs, mutation):
    if mutation == "renderer":
        (inputs["root"] / RENDERER_PATHS[0]).write_text("changed")
    elif mutation in {"mesh", "template_metadata"}:
        (
            inputs["templates"] / ("fixture.npz" if mutation == "mesh" else "fixture.json")
        ).write_text("changed")
    elif mutation == "builder":
        (inputs["root"] / "py/viscera_core/atlas_joint_dataset_v2.py").write_text("changed")
    else:
        inputs["baseline"], inputs["disease"] = inputs["disease"], inputs["baseline"]
    with pytest.raises(ValueError):
        packager.package(**inputs)
    assert not list(inputs["out"].glob("*.zip"))


def test_frozen_builder_is_retained_when_current_builder_has_changed(inputs, tmp_path):
    original = inputs["root"] / "py/viscera_core/atlas_joint_dataset_v2.py"
    snapshot = inputs["root"] / "artifacts/joint-v2/dataset-builder-at-release.py"
    snapshot.parent.mkdir(parents=True)
    shutil.copyfile(original, snapshot)
    original.write_text(original.read_text() + "\n# Subsequent maintenance change\n")
    result = packager.package(**inputs)
    entry = result["packages"]["baseline"]
    folder = bootstrap.extract_package(
        inputs["out"] / entry["filename"], entry["sha256"], tmp_path / "extract", entry["prefix"]
    )
    assert digest(folder / "provenance/dataset-builder.py") == digest(snapshot)
    assert digest(original) != digest(snapshot)


def test_notebook_first_cell_extracts_all_pinned_lanes_and_runtime_imports_in_isolation(
    inputs, tmp_path, monkeypatch
):
    result = packager.package(**inputs)
    path = notebook.build(inputs["out"] / "release-index.json", tmp_path / "run-all.ipynb")
    document = json.loads(path.read_text())
    cells = [c["source"] for c in document["cells"] if c["cell_type"] == "code"]
    for cell in cells:
        parsed = ast.parse(cell)
        assert not any(
            isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "input"
            for n in ast.walk(parsed)
        )
    monkeypatch.setenv("VISCERA_JOINT_ARCHIVES", str(inputs["out"]))
    monkeypatch.setenv("VISCERA_JOINT_WORK", str(tmp_path / "work"))
    namespace = {}
    exec(compile(cells[0], "notebook-cell-0", "exec"), namespace)
    assert set(namespace["PATHS"]) == {"baseline", "disease", "runtime"}
    root = namespace["ROOT"]
    environment = {
        **os.environ,
        "PYTHONPATH": str(root / "py") + os.pathsep + str(root),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    command = [os.sys.executable, str(root / "scripts/joint_v2_train.py"), "--help"]
    process = subprocess.run(
        command, cwd=tmp_path, env=environment, capture_output=True, text=True, timeout=45
    )
    assert process.returncode == 0, process.stderr
    assert "--surrogate-steps" in process.stdout
    assert all(result["packages"][lane]["sha256"] in cells[0] for lane in result["packages"])


def valid_audit():
    conditions = [{"template_id": "fixture", "profile_id": "liver-cirrhosis"}]
    flags = (
        "passed",
        "finite",
        "topology_preserved",
        "bounded_colours",
        "renderer_qa_passed",
        "severity_band_passed",
        "seed_replay_passed",
        "bound_recipe_replay_passed",
    )
    bands = [
        {
            "severity": name,
            "passed": True,
            "distinct_rendered_meshes": True,
            "samples": [
                {**dict.fromkeys(flags, True), "seed": seed, "geometry_sha256": str(i + 1) * 64}
                for i, seed in enumerate((71, 1729, 10007))
            ],
        }
        for name in ("mild", "moderate", "severe")
    ]
    return conditions, {
        "format": "viscera-joint-exact-renderer-audit-v2",
        "passed": True,
        "model_sha256": "f" * 64,
        "condition_count": 1,
        "rendered_samples": 9,
        "conditions": [{**conditions[0], "passed": True, "severity_bands": bands}],
    }


@pytest.mark.parametrize(
    "defect",
    [
        "failed_sample",
        "failed_detail",
        "failed_bound_replay",
        "duplicate_seed",
        "duplicate_mesh",
        "count",
        "non_list_samples",
    ],
)
def test_import_audit_rejects_inconsistent_nested_samples(defect):
    conditions, audit = valid_audit()
    importer._validate_audit(audit, conditions, "f" * 64)
    band = audit["conditions"][0]["severity_bands"][0]
    if defect == "failed_sample":
        band["samples"][0]["passed"] = False
    elif defect == "failed_detail":
        band["samples"][0]["renderer_qa_passed"] = False
    elif defect == "failed_bound_replay":
        band["samples"][0]["bound_recipe_replay_passed"] = False
    elif defect == "duplicate_seed":
        band["samples"][0]["seed"] = 1729
    elif defect == "duplicate_mesh":
        band["samples"][0]["geometry_sha256"] = band["samples"][1]["geometry_sha256"]
    elif defect == "non_list_samples":
        band["samples"] = "fake"
    else:
        audit["rendered_samples"] = 3
    with pytest.raises(ValueError):
        importer._validate_audit(audit, conditions, "f" * 64)


def test_corrupted_active_model_does_not_hide_valid_retained_history(tmp_path, monkeypatch):
    monkeypatch.setenv("VISCERA_MODEL_STORE", str(tmp_path / "store"))
    store = tmp_path / "store"
    identifier = "a" * 64
    directory = store / "joint-v2-bundles" / identifier
    directory.mkdir(parents=True)
    (directory / "model.npz").write_text("inert fixture")
    (directory / "model.json").write_text(
        json.dumps({"conditions": [], "selected_method": "conditional_spline_flow"})
    )
    hashes = {p.name: digest(p) for p in directory.iterdir()}
    (directory / "manifest.json").write_text(json.dumps({"artifact_hashes": hashes}))
    (store / "joint-selection.json").write_text(json.dumps({"version": 1, "generation": 2}))
    (store / "active-joint-v2.json").write_text(
        json.dumps({"version": 1, "active_bundle": "b" * 64, "manifest_sha256": "f" * 64})
    )
    result = history.history(tmp_path)
    assert result["selection_error"]
    assert result["active_bundle"] is None
    assert result["selected_generation"] == 2
    assert result["versions"][0]["bundle_sha256"] == identifier
    assert result["versions"][0]["integrity"] == "verified"
    # Byte-integrity listing never activates the intentionally non-model fixture.
    with pytest.raises((ValueError, FileNotFoundError)):
        history.activate_retained(tmp_path, 2, identifier)


def test_observed_roi_lineage_is_actually_applied_to_rendered_profile_targets():
    evidence = PROJECT / "artifacts/joint-v2/evidence/profile_evidence_guidance.json"
    if not evidence.is_file():
        pytest.skip("Local curated evidence is not installed")
    records = {r["roi_id"]: r for r in json.loads(evidence.read_text())["palette_guidance"]}
    profiles = json.loads((PROJECT / "py/viscera_core/disease_profiles_v2.json").read_text())[
        "profiles"
    ]
    applied = 0
    for p in profiles:
        g = p.get("palette_design_guidance")
        if not g:
            continue
        r = records[g["roi_id"]]
        assert g["guidance_sha256"] == digest(evidence)
        assert g["source_sha256"] == r["source_sha256"] and g["used_in_renderer"] is True
        weight = g["observed_rgb_blend_weight"]
        expected = [
            (1 - weight) * original + weight * measured / 255
            for original, measured in zip(
                g["authored_original_target_srgb"], r["observed_srgb_median_8bit"], strict=True
            )
        ]
        assert p["target_srgb"] == pytest.approx(expected, abs=1e-7)
        assert g["calibrated_albedo"] is False
        applied += 1
    assert applied == 11
