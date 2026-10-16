"""Pinned, no-edit notebook bootstrap must fail closed before importing code."""

from __future__ import annotations

import hashlib
import json
import stat
import warnings
import zipfile
from pathlib import Path

import pytest

from scripts import build_final_notebook as builder
from scripts import final_notebook_bootstrap as bootstrap
from scripts.final_train import DEFAULT_PATHS


def _digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _dataset_zip(
    path: Path,
    *,
    extra: dict[str, bytes] | None = None,
    duplicate: bool = False,
    symlink: bool = False,
    corrupt_member: bool = False,
) -> tuple[str, dict]:
    payload = b"print('verified code only')\n"
    manifest = {
        "format": "viscera-final-colab-bundle-v1",
        "dataset_paths": DEFAULT_PATHS,
        "artifact_hashes": {"scripts/train.py": _digest(payload)},
    }
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("viscera/final-bundle-manifest.json", json.dumps(manifest))
        entry = zipfile.ZipInfo("viscera/scripts/train.py")
        entry.external_attr = ((stat.S_IFLNK if symlink else stat.S_IFREG) | 0o644) << 16
        archive.writestr(entry, b"unlisted replacement" if corrupt_member else payload)
        if duplicate:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                archive.writestr("viscera/scripts/train.py", payload)
        for name, contents in (extra or {}).items():
            archive.writestr(name, contents)
    return bootstrap.file_digest(path), manifest


def _weights_zip(path: Path, *, bad_member: bool = False, extra: bool = False) -> dict:
    expected_payload = b"safe trained coefficients"
    manifest = {
        "format": "viscera-final-training-v1",
        "artifact_hashes": {"shape/model.pt": _digest(expected_payload)},
        "smoke_only": False,
    }
    encoded = json.dumps(manifest).encode()
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("viscera-weights/manifest.json", encoded)
        archive.writestr(
            "viscera-weights/shape/model.pt",
            b"corrupt learned coefficients" if bad_member else expected_payload,
        )
        if extra:
            archive.writestr("viscera-weights/unlisted.py", b"not allowed")
    return {
        "status": "complete",
        "weights_sha256": bootstrap.file_digest(path),
        "export_manifest_sha256": _digest(encoded),
    }


def test_dataset_extract_and_exact_rerun(tmp_path):
    archive = tmp_path / "dataset.zip"
    digest, manifest = _dataset_zip(archive)
    root, read_manifest = bootstrap.extract_verified(archive, digest, tmp_path / "work")
    assert read_manifest == manifest
    assert (root / "scripts/train.py").read_bytes() == b"print('verified code only')\n"
    before = (root / "scripts/train.py").stat().st_mtime_ns
    same_root, _ = bootstrap.extract_verified(archive, digest, tmp_path / "work")
    assert same_root == root
    assert (root / "scripts/train.py").stat().st_mtime_ns == before


def test_pinned_zip_rejects_wrong_hash_before_extraction(tmp_path):
    archive = tmp_path / "dataset.zip"
    _dataset_zip(archive)
    with pytest.raises(ValueError, match="does not match"):
        bootstrap.extract_verified(archive, "0" * 64, tmp_path / "work")
    assert not (tmp_path / "work").exists()


@pytest.mark.parametrize(
    "member",
    [
        "../escape.py",
        "viscera/../../escape.py",
        "/viscera/absolute.py",
        "viscera/scripts//alias.py",
        "viscera/scripts/./alias.py",
        "viscera/scripts\\escape.py",
        "viscera/C:escape.py",
    ],
)
def test_unsafe_archive_paths_are_rejected_before_any_write(tmp_path, member):
    archive = tmp_path / "dataset.zip"
    digest, _ = _dataset_zip(archive, extra={member: b"not code"})
    with pytest.raises(ValueError, match="Unsafe archive member"):
        bootstrap.extract_verified(archive, digest, tmp_path / "work")
    assert not (tmp_path / "work/viscera").exists()
    assert not (tmp_path / "escape.py").exists()


@pytest.mark.parametrize("kwargs", [{"duplicate": True}, {"symlink": True}])
def test_duplicate_and_nonregular_members_are_rejected(tmp_path, kwargs):
    archive = tmp_path / "dataset.zip"
    digest, _ = _dataset_zip(archive, **kwargs)
    with pytest.raises(ValueError, match="Duplicate|regular-file"):
        bootstrap.extract_verified(archive, digest, tmp_path / "work")
    assert not (tmp_path / "work/viscera").exists()


def test_archive_unlisted_member_is_rejected(tmp_path):
    archive = tmp_path / "dataset.zip"
    digest, _ = _dataset_zip(archive, extra={"viscera/scripts/extra.py": b"extra"})
    with pytest.raises(ValueError, match="manifest members differ"):
        bootstrap.extract_verified(archive, digest, tmp_path / "work")


def test_bad_internal_hash_cleans_temporary_extraction(tmp_path):
    archive = tmp_path / "dataset.zip"
    digest, _ = _dataset_zip(archive, corrupt_member=True)
    with pytest.raises(ValueError, match="Corrupt"):
        bootstrap.extract_verified(archive, digest, tmp_path / "work")
    assert not (tmp_path / "work/viscera").exists()
    assert not list((tmp_path / "work").glob(".extract-*"))


@pytest.mark.parametrize("change", ["extra", "corrupt", "symlink"])
def test_reuse_rejects_modified_extraction(tmp_path, change):
    archive = tmp_path / "dataset.zip"
    digest, _ = _dataset_zip(archive)
    root, _ = bootstrap.extract_verified(archive, digest, tmp_path / "work")
    if change == "extra":
        (root / "unlisted.py").write_text("unlisted code")
    elif change == "corrupt":
        (root / "scripts/train.py").write_text("different code")
    else:
        (root / "shortcut").symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(ValueError, match="unlisted|Corrupt|Symlink"):
        bootstrap.extract_verified(archive, digest, tmp_path / "work")


def test_reuse_rejects_symlink_extraction_root(tmp_path):
    archive = tmp_path / "dataset.zip"
    digest, _ = _dataset_zip(archive)
    original, _ = bootstrap.extract_verified(archive, digest, tmp_path / "original")
    work = tmp_path / "work"
    work.mkdir()
    (work / "viscera").symlink_to(original, target_is_directory=True)
    with pytest.raises(ValueError, match="symlink|Symlink"):
        bootstrap.extract_verified(archive, digest, work)


def test_weights_verify_all_members_and_completion_manifest(tmp_path):
    archive = tmp_path / "weights.zip"
    completion = _weights_zip(archive)
    assert bootstrap.verify_weights(archive, completion) == completion["weights_sha256"]
    completion["export_manifest_sha256"] = "0" * 64
    with pytest.raises(ValueError, match="manifest changed"):
        bootstrap.verify_weights(archive, completion)


@pytest.mark.parametrize("kwargs", [{"bad_member": True}, {"extra": True}])
def test_weights_bad_payload_or_unlisted_member_rejected(tmp_path, kwargs):
    archive = tmp_path / "weights.zip"
    completion = _weights_zip(archive, **kwargs)
    with pytest.raises(ValueError, match="checksum failed|members differ"):
        bootstrap.verify_weights(archive, completion)


def test_weights_changed_zip_or_failed_training_rejected(tmp_path):
    archive = tmp_path / "weights.zip"
    completion = _weights_zip(archive)
    bad_status = dict(completion, status="failed")
    with pytest.raises(ValueError, match="did not complete"):
        bootstrap.verify_weights(archive, bad_status)
    with archive.open("ab") as stream:
        stream.write(b"changed after completion")
    with pytest.raises(ValueError, match="changed"):
        bootstrap.verify_weights(archive, completion)


def test_generated_notebook_compiles_and_pins_exact_archive(tmp_path):
    archive = tmp_path / "viscera-final-colab.zip"
    digest, _ = _dataset_zip(archive)
    notebook = json.loads(builder.build(archive, tmp_path / "final.ipynb").read_text())
    assert notebook["metadata"]["accelerator"] == "GPU"
    code = [cell["source"] for cell in notebook["cells"] if cell["cell_type"] == "code"]
    assert len(code) == 4
    for index, cell in enumerate(code):
        compile(cell, f"notebook-cell-{index}", "exec")
    assert f"EXPECTED_SHA256 = {digest!r}" in code[0]
    assert 'drive.mount("/content/drive")' in code[0]
    assert 'VISCERA_RUN_PROFILE", "full"' in code[1]
    assert 'PYTHONDONTWRITEBYTECODE="1"' in code[2]
    assert "verify_weights(WEIGHTS, COMPLETION)" in code[3]
    assert "files.download(str(WEIGHTS))" in code[3]
    assert "files.upload" not in "\n".join(code)
