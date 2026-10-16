import zipfile
from pathlib import Path

from services.api.wording_autoimport import DownloadImporter


def write_archive(path):
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("viscera-wording-weights/manifest.json", "{}")


def test_download_waits_for_stability_then_imports_once_and_preserves_restore(tmp_path, monkeypatch):
    monkeypatch.setenv("VISCERA_MODEL_STORE", str(tmp_path / "store"))
    downloads = tmp_path / "downloads"
    downloads.mkdir()
    (downloads / "unrelated.zip").write_bytes(b"not ours")
    archive = downloads / "viscera-wording-weights (1).zip"
    archive.write_bytes(b"incomplete")
    calls = []
    importer = DownloadImporter(tmp_path, downloads, importer=lambda *args: calls.append(args))
    assert importer.scan(0) == []
    write_archive(archive)
    assert importer.scan(5) == []
    assert importer.scan(9) == []
    assert importer.scan(10)[0]["status"] == "activated"
    assert calls == [(tmp_path, archive)]
    restarted = DownloadImporter(tmp_path, downloads, importer=lambda *args: calls.append(args))
    assert restarted.scan(20) == []
    assert restarted.scan(26) == []
    assert len(calls) == 1


def test_failed_download_is_recorded_without_repeated_import_or_symlink_reads(tmp_path, monkeypatch):
    monkeypatch.setenv("VISCERA_MODEL_STORE", str(tmp_path / "store"))
    downloads = tmp_path / "downloads"
    downloads.mkdir()
    write_archive(downloads / "viscera-wording-weights.zip")
    (downloads / "viscera-wording-weights-link.zip").symlink_to(Path(__file__))
    calls = []

    def reject(*args):
        calls.append(args)
        raise ValueError("Evaluation failed")

    importer = DownloadImporter(tmp_path, downloads, importer=reject)
    assert importer.scan(0) == []
    assert importer.scan(5)[0]["reason"] == "Evaluation failed"
    assert importer.scan(10) == []
    assert len(calls) == 1


def test_joint_download_renamed_as_wording_cannot_switch_joint_model(tmp_path, monkeypatch):
    monkeypatch.setenv("VISCERA_MODEL_STORE", str(tmp_path / "store"))
    with zipfile.ZipFile(tmp_path / "viscera-wording-weights.zip", "w") as archive:
        archive.writestr("viscera-joint-weights/manifest.json", "{}")
    calls = []
    importer = DownloadImporter(tmp_path, tmp_path, importer=lambda *args: calls.append(args))
    assert importer.scan(0) == []
    assert importer.scan(5)[0]["status"] == "rejected"
    assert not calls


def test_once_cli_observes_then_waits_before_importing_a_completed_download(tmp_path, monkeypatch, capsys):
    import time

    from services.api import wording_autoimport

    monkeypatch.setenv("VISCERA_MODEL_STORE", str(tmp_path / "store"))
    downloads = tmp_path / "downloads"
    downloads.mkdir()
    write_archive(downloads / "viscera-wording-weights.zip")
    imports = []
    created = []

    def create(root, directory):
        watcher = DownloadImporter(root, directory, stable_seconds=.02, importer=lambda *args: imports.append(time.monotonic()))
        created.append(time.monotonic())
        return watcher

    monkeypatch.setattr(wording_autoimport, "DownloadImporter", create)
    monkeypatch.setattr(wording_autoimport.signal, "signal", lambda *args: None)
    monkeypatch.setattr("sys.argv", ["wording_autoimport", "--root", str(tmp_path), "--directory", str(downloads), "--once"])
    wording_autoimport.main()
    assert len(imports) == 1
    assert imports[0] - created[0] >= .02
    assert '"status": "activated"' in capsys.readouterr().out


def test_committed_download_receipt_does_not_wait_for_unrelated_model_status(tmp_path, monkeypatch):
    import json

    from services.api import atlas_model_registry as registry
    from services.api import atlas_wording_model as wording

    monkeypatch.setenv("VISCERA_MODEL_STORE", str(tmp_path / "store"))
    archive = tmp_path / "viscera-wording-weights.zip"
    write_archive(archive)
    # Exercise the real extraction/commit path; model validation is a separate
    # tested boundary. A failure in an unrelated lane must not misreport this
    # already-committed download as rejected.
    monkeypatch.setattr(wording, "_validate", lambda *args: {})

    def unrelated_status(root):
        raise AssertionError("The autoimport path must not inventory unrelated model lanes")

    monkeypatch.setattr(registry, "model_status", unrelated_status)
    importer = DownloadImporter(tmp_path, tmp_path)
    assert importer.scan(0) == []
    event = importer.scan(5)[0]
    assert event["status"] == "activated"
    pointer = json.loads((registry.store_root(tmp_path) / "active-wording.json").read_text())
    assert pointer["active_bundle"] == event["sha256"]
