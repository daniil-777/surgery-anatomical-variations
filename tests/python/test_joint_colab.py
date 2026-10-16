"""Independent notebook archive boundaries and actual tiny full-profile export."""
from __future__ import annotations

import ast
import hashlib
import json
import stat
import warnings
import zipfile
from pathlib import Path

import pytest
from viscera_core.atlas_joint_dataset import build_release

from pipelines.train.viscera_train.joint import Config, train
from scripts import build_joint_notebook as notebook
from scripts import joint_notebook_bootstrap as bootstrap
from scripts import joint_train as runner
from scripts.package_joint_colab import write_archive

PROJECT = Path(__file__).resolve().parents[2]
TEMPLATES = PROJECT / "datasets/atlas/cohort-v2/templates"


def test_interpreter_override_preserves_virtualenv_symlink(tmp_path, monkeypatch):
    base = tmp_path / "base-python"
    base.write_text("placeholder")
    interpreter = tmp_path / "venv/bin/python"
    interpreter.parent.mkdir(parents=True)
    interpreter.symlink_to(base)
    monkeypatch.setenv("VISCERA_TRAIN_PYTHON", str(interpreter))
    commands = []
    monkeypatch.setattr(bootstrap.subprocess, "run", lambda command, **kwargs: commands.append(command))
    chosen = bootstrap.install_environment(tmp_path, tmp_path / "unused")
    assert chosen == interpreter
    assert commands and all(command[0] == str(interpreter) for command in commands)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def raw_package(path, entries, *, hashes=None, prefix="baseline", duplicate=None, symlink=None):
    if hashes is None:
        hashes = {name: sha(data) for name, data in entries.items()}
    manifest = {"format": "viscera-joint-package-v1", "prefix": prefix, "artifact_hashes": hashes}
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in entries.items():
            info = zipfile.ZipInfo(prefix + "/" + name)
            info.create_system = 3
            info.external_attr = ((stat.S_IFLNK if name == symlink else stat.S_IFREG) | 0o644) << 16
            archive.writestr(info, data)
        if duplicate:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                archive.writestr(prefix + "/" + duplicate, entries[duplicate])
        archive.writestr(prefix + "/package-manifest.json", json.dumps(manifest))
    return bootstrap.file_digest(path)


@pytest.fixture
def release_index(tmp_path):
    packages = {}
    for lane, prefix in (("baseline", "baseline"), ("disease", "disease"), ("runtime", "viscera")):
        data = tmp_path / (lane + ".json")
        data.write_text(json.dumps({"lane": lane}))
        packages[lane] = write_archive(tmp_path / (lane + ".zip"), prefix, {"data.json": data})
    index = tmp_path / "release-index.json"
    index.write_text(json.dumps({"packages": packages, "drive_folder": "VISCERA Joint VAE Training 2026-10-07"}))
    return index


def test_separate_archives_match_notebook_checksums_and_reject_swapping(release_index, tmp_path):
    packages = json.loads(release_index.read_text())["packages"]
    assert len({entry["sha256"] for entry in packages.values()}) == 3
    for lane, entry in packages.items():
        archive = tmp_path / entry["filename"]
        result = bootstrap.extract_package(archive, entry["sha256"], tmp_path / "unpacked", entry["prefix"])
        assert json.loads((result / "data.json").read_text())["lane"] == lane
        assert bootstrap.extract_package(archive, entry["sha256"], tmp_path / "unpacked", entry["prefix"]) == result
    wrong = packages["baseline"]
    with pytest.raises(ValueError, match="does not match"):
        bootstrap.extract_package(tmp_path / packages["disease"]["filename"], wrong["sha256"], tmp_path / "swapped", wrong["prefix"])


@pytest.mark.parametrize("member", ["../escaped", "nested/../../escaped", "/absolute", "nested//file", "nested/./file", "windows\\file", "C:evil"])
def test_package_rejects_path_aliases_before_extracting(tmp_path, member):
    archive = tmp_path / "unsafe.zip"
    checksum = raw_package(archive, {member: b"bad"})
    with pytest.raises(ValueError, match="Unsafe ZIP"):
        bootstrap.extract_package(archive, checksum, tmp_path / "destination", "baseline")
    assert not (tmp_path / "escaped").exists()
    assert not (tmp_path / "destination/baseline").exists()


def test_package_rejects_duplicates_symlinks_and_unmanifested_files(tmp_path):
    for name, options in (("duplicate", {"duplicate": "data.bin"}), ("symlink", {"symlink": "data.bin"}), ("extra", {"hashes": {"another.bin": sha(b"x")}})):
        archive = tmp_path / (name + ".zip")
        checksum = raw_package(archive, {"data.bin": b"x"}, **options)
        with pytest.raises(ValueError):
            bootstrap.extract_package(archive, checksum, tmp_path / name, "baseline")
        assert not (tmp_path / name / "baseline").exists()


def test_archive_member_and_cached_extraction_tampering_are_rejected(tmp_path):
    archive = tmp_path / "package.zip"
    checksum = raw_package(archive, {"data.bin": b"original"})
    result = bootstrap.extract_package(archive, checksum, tmp_path / "cache", "baseline")
    (result / "data.bin").write_bytes(b"modified")
    with pytest.raises(ValueError, match="checksum"):
        bootstrap.extract_package(archive, checksum, tmp_path / "cache", "baseline")
    damaged = tmp_path / "damaged.zip"
    damaged_sha = raw_package(damaged, {"data.bin": b"modified"}, hashes={"data.bin": sha(b"original")})
    with pytest.raises(ValueError, match="checksum"):
        bootstrap.extract_package(damaged, damaged_sha, tmp_path / "fresh", "baseline")
    assert not list((tmp_path / "fresh").glob(".joint-extract-*"))
    with pytest.raises(ValueError, match="does not match"):
        bootstrap.extract_package(archive, "0" * 64, tmp_path / "wrong-hash", "baseline")


def test_archive_publishing_is_deterministic_and_never_overwrites(tmp_path):
    source = tmp_path / "input.txt"
    source.write_text("unchanged content")
    first = write_archive(tmp_path / "first.zip", "baseline", {"input.txt": source})
    second = write_archive(tmp_path / "second.zip", "baseline", {"input.txt": source})
    assert first["sha256"] == second["sha256"]
    with pytest.raises(ValueError, match="Refusing to replace"):
        write_archive(tmp_path / "first.zip", "baseline", {"input.txt": source})


def test_generated_notebook_runs_plain_python_cells_and_pins_no_edit_defaults(release_index, tmp_path):
    output = notebook.build(release_index, tmp_path / "run-all.ipynb")
    document = json.loads(output.read_text())
    assert document["nbformat"] == 4 and document["metadata"]["accelerator"] == "GPU"
    code = [cell["source"] for cell in document["cells"] if cell["cell_type"] == "code"]
    assert len(code) == 4
    constants = {}
    for index, source in enumerate(code):
        parsed = ast.parse(source)
        compile(parsed, f"cell-{index}", "exec")
        for node in ast.walk(parsed):
            if isinstance(node, ast.Call):
                assert not (isinstance(node.func, ast.Name) and node.func.id == "input")
                assert not (isinstance(node.func, ast.Attribute) and node.func.attr == "upload")
        for node in parsed.body:
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and node.targets[0].id in ("PACKAGES", "DRIVE_FOLDER_NAME"):
                constants[node.targets[0].id] = ast.literal_eval(node.value)
    index = json.loads(release_index.read_text())
    assert constants["PACKAGES"] == index["packages"]
    assert constants["DRIVE_FOLDER_NAME"] == index["drive_folder"]
    assert 'files.download(str(WEIGHTS))' in code[-1]
    assert 'verify_weights(WEIGHTS, COMPLETION)' in code[-1]
    assert '"--device", "auto"' in code[2]
    assert '"/content/drive/MyDrive"' in code[0]
    assert not any(marker in "\n".join(code) for marker in ("YOUR_", "REPLACE_ME", "TODO", "files.upload"))


def make_weights(path, *, relative="model.npz", smoke=False, profile="full", empty=False):
    hashes = {} if empty else {relative: sha(b"fake")}
    manifest = {"format": "viscera-joint-vae-v1", "profile": profile, "smoke_only": smoke, "artifact_hashes": hashes}
    with zipfile.ZipFile(path, "w") as archive:
        for name in hashes:
            archive.writestr("viscera-joint-weights/" + name, b"fake")
        archive.writestr("viscera-joint-weights/manifest.json", json.dumps(manifest))
    return {"status": "complete", "weights_sha256": bootstrap.file_digest(path)}


@pytest.mark.parametrize("options", [{"empty": True}, {"relative": "../escape"}, {"profile": "smoke"}, {"smoke": True}, {}])
def test_final_verifier_rejects_incomplete_unsafe_or_smoke_weights(tmp_path, options):
    path = tmp_path / "weights.zip"
    receipt = make_weights(path, **options)
    with pytest.raises(ValueError):
        bootstrap.verify_weights(path, receipt)


@pytest.fixture(scope="module")
def actual_full_export(tmp_path_factory):
    if not (TEMPLATES / "bp3d-gallbladder-male.npz").exists():
        pytest.skip("Actual attributed templates are not installed")
    parent = tmp_path_factory.mktemp("joint-colab-full-export")
    lanes = []
    for lane in ("baseline", "disease"):
        directory = parent / lane
        build_release(TEMPLATES, directory, lane=lane, count=8, point_count=8, seed=41, workers=1, template_ids=["bp3d-gallbladder-male"])
        lanes.append(directory)
    model = parent / "model"
    train(lanes, model, Config(steps=1000, surrogate_steps=200, hidden=32, latent=6, embedding=4, batch_size=16, threads=1, profile="full", device="cpu"))
    out = parent / "weights"
    out.mkdir()
    receipt = runner.export_weights(model, *lanes, TEMPLATES, out)
    return {"parent": parent, "lanes": lanes, "model": model, "out": out, "receipt": receipt}


def test_real_full_profile_trains_renders_and_exports_studio_bundle(actual_full_export):
    result = actual_full_export
    receipt = result["receipt"]
    weights = result["out"] / "viscera-joint-weights.zip"
    assert bootstrap.verify_weights(weights, receipt) == bootstrap.file_digest(weights)
    audit = json.loads((result["out"] / "exact-renderer-audit.json").read_text())
    assert audit["passed"] and audit["condition_count"] >= 2
    assert audit["rendered_samples"] == audit["condition_count"] * 3
    assert all(row["distinct_rendered_meshes"] for row in audit["conditions"])
    assert receipt["selected_method"] == "joint_conditional_vae"
    with zipfile.ZipFile(weights) as archive:
        meta = json.loads(archive.read("viscera-joint-weights/model.json"))
        assert meta["completed_steps"] == 1000 and meta["training_profile"] == "full"
        assert meta["dataset_hashes"]["baseline/release.json"] == bootstrap.file_digest(result["lanes"][0] / "release.json")
        assert meta["dataset_hashes"]["disease/release.json"] == bootstrap.file_digest(result["lanes"][1] / "release.json")


def test_reexport_does_not_package_stale_unmanifested_files(actual_full_export):
    result = actual_full_export
    stale = result["out"] / "export/obsolete-secret.txt"
    stale.write_text("old diagnostic output that must not be distributed")
    receipt = runner.export_weights(result["model"], *result["lanes"], TEMPLATES, result["out"])
    weights = result["out"] / "viscera-joint-weights.zip"
    with zipfile.ZipFile(weights) as archive:
        assert "viscera-joint-weights/obsolete-secret.txt" not in archive.namelist()
    assert bootstrap.verify_weights(weights, receipt) == bootstrap.file_digest(weights)


def test_cached_package_manifest_cannot_be_changed_after_verification(tmp_path):
    archive = tmp_path / "package.zip"
    checksum = raw_package(archive, {"data.bin": b"original"})
    result = bootstrap.extract_package(archive, checksum, tmp_path / "cache", "baseline")
    (result / "package-manifest.json").write_text('{"forged":true}')
    with pytest.raises(ValueError, match="manifest"):
        bootstrap.extract_package(archive, checksum, tmp_path / "cache", "baseline")


@pytest.mark.parametrize("mode", ["duplicate", "symlink", "failed_audit"])
def test_valid_weight_bundle_cannot_hide_structural_or_audit_failure(actual_full_export, tmp_path, mode):
    result = actual_full_export
    with zipfile.ZipFile(result["out"] / "viscera-joint-weights.zip") as source:
        members = {name: source.read(name) for name in source.namelist()}
    prefix = "viscera-joint-weights/"
    if mode == "failed_audit":
        audit = json.loads(members[prefix + "exact-renderer-audit.json"])
        audit["passed"] = False
        members[prefix + "exact-renderer-audit.json"] = json.dumps(audit).encode()
        manifest = json.loads(members[prefix + "manifest.json"])
        manifest["artifact_hashes"]["exact-renderer-audit.json"] = sha(members[prefix + "exact-renderer-audit.json"])
        members[prefix + "manifest.json"] = json.dumps(manifest).encode()
    target = tmp_path / (mode + ".zip")
    with zipfile.ZipFile(target, "w") as archive:
        for name, data in members.items():
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            kind = stat.S_IFLNK if mode == "symlink" and name == prefix + "model.npz" else stat.S_IFREG
            info.external_attr = (kind | 0o644) << 16
            archive.writestr(info, data)
        if mode == "duplicate":
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                archive.writestr(prefix + "model.npz", members[prefix + "model.npz"])
    receipt = {**result["receipt"], "weights_sha256": bootstrap.file_digest(target), "export_manifest_sha256": sha(members[prefix + "manifest.json"])}
    with pytest.raises(ValueError):
        bootstrap.verify_weights(target, receipt)
