"""Snapshot integrity and isolation tests, with no generator or image dependencies."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

from scripts import stage_tissue_library as staging


@pytest.fixture
def library(tmp_path: Path) -> Path:
    source = tmp_path / "source"
    for variant in ("native", "preview"):
        folder = source / "liver" / variant
        (folder / "overlays").mkdir(parents=True)
        declarations = []
        for name in ("base_color.png", "overlays/wet_film.png"):
            payload = f"fixture:{variant}:{name}".encode()
            (folder / name).write_bytes(payload)
            declarations.append({"file": name, "sha256": hashlib.sha256(payload).hexdigest(),
                                 "bytes": len(payload)})
        manifest = {
            "schema": "viscera.tissue-materials/v1", "recipe": {"seed": 2**64 - 1},
            "channels": {"base_color": declarations[0]},
            "layers": [{"id": "wet_film", **declarations[1]}],
        }
        (folder / "manifest.json").write_text(json.dumps(manifest, indent=3) + "\n")
    (source / "catalog.json").write_text(json.dumps({
        "schema": "viscera.tissue-catalog/v1", "materials": [{
            "id": "liver", "manifest": "liver/native/manifest.json",
            "preview": "liver/preview/manifest.json",
        }],
    }))
    (source / "liver/native/base_color 2.png").write_bytes(b"corrupt sync duplicate")
    (source / ".old-stage/empty").mkdir(parents=True)
    (source / ".old-stage/stale.json").write_text("preserve failed source")
    return source


def source_bytes(source: Path) -> dict[str, bytes]:
    return {path.relative_to(source).as_posix(): path.read_bytes()
            for path in source.rglob("*") if path.is_file()}


def edit_manifest(source: Path, change) -> None:
    path = source / "liver/native/manifest.json"
    manifest = json.loads(path.read_text())
    change(manifest)
    path.write_text(json.dumps(manifest))


def test_snapshot_copies_only_declared_files_and_preserves_source(library: Path) -> None:
    before = source_bytes(library)
    target = library.parent / "snapshot"
    receipt = staging.stage_library(library, target)
    expected = set(before) - {"liver/native/base_color 2.png", ".old-stage/stale.json"}
    assert set(source_bytes(target)) == expected
    assert source_bytes(library) == before
    assert all((target / name).read_bytes() == before[name] for name in expected)
    assert json.loads((target / "liver/native/manifest.json").read_text())["recipe"]["seed"] == 2**64 - 1
    assert receipt["asset_count"] == 4
    assert receipt["manifest_count"] == 2
    assert receipt["copied_file_count"] == 7
    assert receipt["scan"]["ignored_unreferenced_file_count"] == 2
    assert receipt["scan"]["ignored_unreferenced_directories"] == [".old-stage", ".old-stage/empty"]
    assert receipt["copied_bytes"] == sum(len(before[name]) for name in expected)
    assert not list(target.parent.glob(".snapshot.stage-*"))


@pytest.mark.parametrize("failure", ["hash", "size", "missing_asset", "missing_preview", "missing_hash"])
def test_invalid_library_never_publishes_and_cleans_stage(library: Path, failure: str) -> None:
    if failure == "hash":
        path = library / "liver/native/base_color.png"
        path.write_bytes(b"X" * path.stat().st_size)
    elif failure == "size":
        edit_manifest(library, lambda m: m["channels"]["base_color"].update(bytes=1))
    elif failure == "missing_asset":
        (library / "liver/native/base_color.png").unlink()
    elif failure == "missing_preview":
        (library / "liver/preview/manifest.json").unlink()
    else:
        edit_manifest(library, lambda m: m["channels"]["base_color"].pop("sha256"))
    before = source_bytes(library)
    with pytest.raises((ValueError, OSError)):
        staging.stage_library(library, library.parent / "snapshot")
    assert source_bytes(library) == before
    assert not (library.parent / "snapshot").exists()
    assert not list(library.parent.glob(".snapshot.stage-*"))


def test_absent_optional_byte_count_still_verifies_digest(library: Path) -> None:
    edit_manifest(library, lambda m: m["channels"]["base_color"].pop("bytes"))
    assert staging.stage_library(library, library.parent / "snapshot")["asset_count"] == 4


@pytest.mark.parametrize("relative", ["../outside.png", "/absolute.png", "a/../../b.png",
                                     "a\\b.png", "a//b.png", "./a.png", "C:foo", "a\x00b"])
@pytest.mark.parametrize("location", ["catalog", "asset"])
def test_unsafe_paths_rejected(library: Path, relative: str, location: str) -> None:
    if location == "asset":
        edit_manifest(library, lambda m: m["channels"]["base_color"].update(file=relative))
    else:
        path = library / "catalog.json"
        catalog = json.loads(path.read_text())
        catalog["materials"][0]["manifest"] = relative
        path.write_text(json.dumps(catalog))
    with pytest.raises(ValueError, match="unsafe relative path"):
        staging.stage_library(library, library.parent / "snapshot")
    assert not (library.parent / "snapshot").exists()


@pytest.mark.parametrize("kind", ["file", "directory", "ignored", "root"])
def test_symlinks_are_rejected_even_when_they_stay_inside_source(library: Path, kind: str) -> None:
    source = library
    if kind == "root":
        source = library.parent / "source-link"
        source.symlink_to(library, target_is_directory=True)
    elif kind == "directory":
        folder = library / "liver/native/overlays"
        folder.rename(folder.with_name("actual-overlays"))
        folder.symlink_to("actual-overlays", target_is_directory=True)
    elif kind == "ignored":
        (library / "ignored-link").symlink_to("catalog.json")
    else:
        path = library / "liver/native/base_color.png"
        path.rename(path.with_name("actual.png"))
        path.symlink_to("actual.png")
    with pytest.raises(ValueError, match="symlink"):
        staging.stage_library(source, library.parent / "snapshot")


def test_existing_target_and_target_inside_source_are_untouched(library: Path) -> None:
    target = library.parent / "snapshot"
    target.mkdir()
    with pytest.raises(FileExistsError):
        staging.stage_library(library, target)
    assert target.is_dir() and not list(target.iterdir())
    with pytest.raises(ValueError, match="outside source"):
        staging.stage_library(library, library / "snapshot")
    assert not (library / "snapshot").exists()


def test_target_created_during_copy_cannot_be_replaced(library: Path, monkeypatch) -> None:
    publish = staging._publish
    target = library.parent / "snapshot"

    def race(stage: Path, destination: Path) -> None:
        assert stage.is_dir() and not destination.exists()
        destination.mkdir()  # Plain os.rename would replace this empty directory.
        publish(stage, destination)

    monkeypatch.setattr(staging, "_publish", race)
    with pytest.raises(FileExistsError):
        staging.stage_library(library, target)
    assert target.is_dir() and not list(target.iterdir())
    assert not list(library.parent.glob(".snapshot.stage-*"))


def test_catalog_change_during_copy_rejected(library: Path, monkeypatch) -> None:
    original = staging._open_file
    changed = False

    def changing(root_fd: int, relative: str):
        nonlocal changed
        if relative.endswith("wet_film.png") and not changed:
            changed = True
            with (library / "catalog.json").open("a") as handle:
                handle.write("\n")
        return original(root_fd, relative)

    monkeypatch.setattr(staging, "_open_file", changing)
    with pytest.raises(ValueError, match="metadata changed"):
        staging.stage_library(library, library.parent / "snapshot")
    assert not (library.parent / "snapshot").exists()


def test_conflicting_declarations_and_duplicate_json_keys_rejected(library: Path) -> None:
    edit_manifest(library, lambda m: m["channels"].update(
        alias={**m["channels"]["base_color"], "sha256": "0" * 64}))
    with pytest.raises(ValueError, match="conflicting"):
        staging.stage_library(library, library.parent / "snapshot")
    (library / "catalog.json").write_text('{"schema":"a","schema":"b"}')
    with pytest.raises(ValueError, match="duplicate JSON key"):
        staging.stage_library(library, library.parent / "snapshot")


def test_cli_emits_machine_readable_receipt_and_nonzero_on_existing_target(library: Path) -> None:
    script = Path(staging.__file__)
    command = [sys.executable, str(script), str(library), str(library.parent / "snapshot")]
    result = subprocess.run(command, capture_output=True, text=True, check=True)
    assert json.loads(result.stdout)["publication"] == "exclusive atomic directory rename"
    repeated = subprocess.run(command, capture_output=True, text=True)
    assert repeated.returncode == 1
    assert not repeated.stdout
    assert "target already exists" in repeated.stderr
