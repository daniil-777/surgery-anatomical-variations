"""Independent streaming package and isolated-environment setup contracts."""

from __future__ import annotations

import json
import stat
import subprocess
import warnings
import zipfile
from pathlib import Path

import pytest

from scripts import joint_v2_notebook_bootstrap as bootstrap
from scripts import package_joint_v2_colab as packager


def test_archive_streams_zip64_and_reuses_only_verified_identical_release(tmp_path, monkeypatch):
    source = tmp_path / "large.npz"
    source.write_bytes(b"already compressed observations" * 1024)
    metadata = tmp_path / "catalog.json"
    metadata.write_text('{"lane":"baseline"}')
    files = {"train.npz": source, "catalog.json": metadata}
    original = Path.read_bytes

    def prohibit_whole_source_read(path):
        if path == source:
            raise AssertionError("NPZ packaging must stream instead of reading whole split")
        return original(path)

    monkeypatch.setattr(Path, "read_bytes", prohibit_whole_source_read)
    first = packager.write_archive(tmp_path / "release.zip", "baseline", files)
    second = packager.write_archive(tmp_path / "duplicate.zip", "baseline", files)
    assert first["sha256"] == second["sha256"]
    assert packager.write_archive(tmp_path / "release.zip", "baseline", files) == first
    with zipfile.ZipFile(tmp_path / "release.zip") as archive:
        member = archive.getinfo("baseline/train.npz")
        assert member.compress_type == zipfile.ZIP_STORED
        assert member.extract_version >= 45  # force_zip64 permits genuinely large splits
    extracted = bootstrap.extract_package(
        tmp_path / "release.zip", first["sha256"], tmp_path / "extracted", "baseline"
    )
    assert bootstrap.file_digest(extracted / "train.npz") == bootstrap.file_digest(source)
    source.write_bytes(b"changed")
    with pytest.raises(ValueError, match="Refusing to replace"):
        packager.write_archive(tmp_path / "release.zip", "baseline", files)
    assert bootstrap.file_digest(tmp_path / "release.zip") == first["sha256"]


def test_archive_interrupted_write_does_not_publish_or_leave_partial_zip(tmp_path, monkeypatch):
    source = tmp_path / "source.json"
    source.write_text("{}")

    def interrupt(*args, **kwargs):
        raise InterruptedError("simulated packaging interruption")

    monkeypatch.setattr(packager.shutil, "copyfileobj", interrupt)
    output = tmp_path / "release.zip"
    with pytest.raises(InterruptedError):
        packager.write_archive(output, "baseline", {"source.json": source})
    assert not output.exists()
    assert not output.with_suffix(".zip.tmp").exists()


@pytest.mark.parametrize("defect", ["traversal", "duplicate", "symlink", "tamper", "extra"])
def test_v2_extraction_rejects_unsafe_or_inconsistent_members(tmp_path, defect):
    archive_path = tmp_path / "bad.zip"
    body = b"original"
    member = "../escaped" if defect == "traversal" else "data.bin"
    hashes = {member: bootstrap.hashlib.sha256(body).hexdigest()}
    manifest = {
        "format": "viscera-joint-package-v1",
        "prefix": "baseline",
        "artifact_hashes": hashes,
    }
    with zipfile.ZipFile(archive_path, "w") as archive:
        info = zipfile.ZipInfo("baseline/" + member)
        info.external_attr = ((stat.S_IFLNK if defect == "symlink" else stat.S_IFREG) | 0o644) << 16
        archive.writestr(info, b"changed" if defect == "tamper" else body)
        if defect == "duplicate":
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                archive.writestr(info, body)
        if defect == "extra":
            archive.writestr("baseline/undeclared.txt", "extra")
        archive.writestr("baseline/package-manifest.json", json.dumps(manifest))
    with pytest.raises(ValueError):
        bootstrap.extract_package(
            archive_path, bootstrap.file_digest(archive_path), tmp_path / "extract", "baseline"
        )
    assert not (tmp_path / "extract/baseline").exists()
    assert not (tmp_path / "escaped").exists()


@pytest.mark.parametrize("host_version", ["3.12", "3.13"])
@pytest.mark.parametrize("venv_available", [True, False])
def test_environment_uses_venv_python_and_preserves_host_cuda_wheel(
    tmp_path, monkeypatch, host_version, venv_available
):
    monkeypatch.delenv("VISCERA_TRAIN_PYTHON", raising=False)
    monkeypatch.setattr(bootstrap.sys, "executable", "/host/python" + host_version)
    monkeypatch.setattr(bootstrap.sys, "platform", "linux")
    commands = []

    def run(command, **kwargs):
        commands.append(command)
        if command[1:3] == ["-m", "venv"]:
            return subprocess.CompletedProcess(command, 0 if venv_available else 1)
        if command[1] == "-c" and command[0].startswith("/host"):
            return subprocess.CompletedProcess(
                command, 0, json.dumps({"version": "2.11.0", "cuda": "12.6", "available": True})
            )
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(bootstrap.subprocess, "run", run)
    environment = tmp_path / "train-env"
    chosen = bootstrap.install_environment(tmp_path, environment)
    assert chosen == environment / "bin/python"
    torch_install = next(c for c in commands if "torch==2.11.0" in c)
    assert torch_install[0] == str(chosen)
    assert torch_install[-2:] == ["--index-url", "https://download.pytorch.org/whl/cu126"]
    requirements = next(c for c in commands if "-r" in c)
    assert requirements[0] == str(chosen)
    assert ("virtualenv==20.35.3" in str(commands)) is not venv_available


def test_environment_override_preserves_venv_interpreter_without_resolving_symlink(
    tmp_path, monkeypatch
):
    base = tmp_path / "base"
    base.write_text("inert test executable")
    selected = tmp_path / "venv/bin/python"
    selected.parent.mkdir(parents=True)
    selected.symlink_to(base)
    monkeypatch.setenv("VISCERA_TRAIN_PYTHON", str(selected))
    commands = []
    monkeypatch.setattr(
        bootstrap.subprocess, "run", lambda command, **kwargs: commands.append(command)
    )
    assert bootstrap.install_environment(tmp_path, tmp_path / "unused") == selected
    assert len(commands) == 2 and all(c[0] == str(selected) for c in commands)
