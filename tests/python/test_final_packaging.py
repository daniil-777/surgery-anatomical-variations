"""Archive boundary tests: reject traversal, aliases, symlinks and tampering."""

from __future__ import annotations

import hashlib
import json
import re
import zipfile
from pathlib import Path

import pytest

from scripts.package_final_colab import (
    DATASET_PATHS,
    FORMAT,
    member_name,
    source_files,
    verify_archive,
)


def test_workspace_script_entrypoints_are_included_in_source_bundle():
    root = Path(__file__).resolve().parents[2]
    package = json.loads((root / "package.json").read_text())
    included = {path.relative_to(root).as_posix() for path in source_files(root)}
    references = set()
    for command in package["scripts"].values():
        references.update(re.findall(r"(?:node|python)\s+(scripts/[\w./-]+)", command))
    assert references, "Expected at least the Studio dev bootstrap"
    assert references <= included
    assert "pipelines/train/viscera_train/language.py" not in included


@pytest.mark.parametrize(
    "name",
    [
        "../x",
        "/viscera/x",
        "viscera/../x",
        "viscera//x",
        "viscera/./x",
        "viscera\\x",
        "viscera/C:x",
        "other/x",
    ],
)
def test_unsafe_paths_rejected(name):
    with pytest.raises(ValueError, match="Unsafe archive path"):
        member_name(name)


def make_archive(path, *, altered=False, symlink=False, extra=False):
    payload = b"checked source\n"
    manifest = {
        "format": FORMAT,
        "dataset_paths": DATASET_PATHS,
        "artifact_hashes": {"py/example.py": hashlib.sha256(payload).hexdigest()},
    }
    with zipfile.ZipFile(path, "w") as archive:
        entries = {
            "viscera/py/example.py": b"tampered\n" if altered else payload,
            "viscera/final-bundle-manifest.json": json.dumps(manifest).encode(),
        }
        if extra:
            entries["viscera/hidden.py"] = b"unlisted"
        for name, content in entries.items():
            entry = zipfile.ZipInfo(name)
            entry.external_attr = (0o120777 if symlink else 0o100644) << 16
            archive.writestr(entry, content)


def test_verified_extract_is_exact_and_refuses_nonempty_destination(tmp_path):
    archive = tmp_path / "bundle.zip"
    make_archive(archive)
    destination = tmp_path / "unpacked"
    verify_archive(archive, destination)
    assert (destination / "viscera/py/example.py").read_bytes() == b"checked source\n"
    with pytest.raises(ValueError, match="must be empty"):
        verify_archive(archive, destination)


@pytest.mark.parametrize(
    "option,match",
    [("altered", "SHA256"), ("symlink", "regular files"), ("extra", "exact manifest")],
)
def test_archive_contract_rejects_tampering(tmp_path, option, match):
    archive = tmp_path / "bad.zip"
    make_archive(archive, **{option: True})
    with pytest.raises(ValueError, match=match):
        verify_archive(archive)
