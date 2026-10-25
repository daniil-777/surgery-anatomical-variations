"""Data-integrity and license boundaries; all HTTP responses are in-memory fixtures."""

from __future__ import annotations

import hashlib
import io
import json
import zipfile
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

import pytest

from scripts.acquire_tissue_datasets import (
    AcquisitionError,
    ApprovedRedirects,
    CurlResponse,
    acquire,
    main,
    select_assets,
    validate_archive,
)


def archive_bytes(content: bytes = b"synthetic test pixels") -> bytes:
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("sample.txt", content)
    return stream.getvalue()


@pytest.fixture
def asset():
    return {"id": "fixture", "dataset_id": "fixture-dataset", "filename": "fixture.zip",
            "url": "https://data.example.org/fixture.zip", "access": "direct", "format": "zip",
            "allowed_hosts": ["data.example.org"], "max_bytes": 4096,
            "allowed_purposes": ["commercial-compatible", "noncommercial-research"],
            "license": "CC-BY-4.0", "license_sources": ["https://data.example.org/license"],
            "citation": "Fixture only, not medical data"}


class Response(io.BytesIO):
    def __init__(self, content, *, status=200, headers=None, url=None):
        super().__init__(content)
        self.status = status
        self.headers = headers or {"Content-Length": str(len(content)), "ETag": '"object-1"'}
        self.url = url or "https://data.example.org/fixture.zip"

    def geturl(self):
        return self.url


def run(asset, tmp_path, content, **options):
    return acquire(asset, tmp_path, max_bytes=4096, reserve_bytes=0,
                   opener=lambda *_args, **_kwargs: Response(content, **options))


def test_acquisition_and_reuse_rehashes_existing_file(asset, tmp_path):
    payload = archive_bytes()
    asset["checksums"] = {"sha256": hashlib.sha256(payload).hexdigest()}
    result = run(asset, tmp_path, payload)
    assert result["publisher_checksums_verified"] == ["sha256"]
    assert result["archive"]["crc_verified"]
    assert Path(result["path"]).read_bytes() == payload
    assert not list(tmp_path.rglob("*.part"))
    assert not list(tmp_path.rglob("*.lock"))
    with patch("urllib.request.build_opener", side_effect=AssertionError("No network for reuse")):
        assert acquire(asset, tmp_path, max_bytes=4096, reserve_bytes=0)["reused"]
    Path(result["path"]).write_bytes(payload[:-1] + b"X")
    with pytest.raises(AcquisitionError):
        acquire(asset, tmp_path, max_bytes=4096, reserve_bytes=0)


def test_local_checksum_not_mislabeled_as_publisher_verified(asset, tmp_path):
    result = run(asset, tmp_path, archive_bytes())
    assert result["integrity_scope"] == "local_hash_only"
    assert result["publisher_checksums_verified"] == []


def test_checksum_failure_never_publishes_archive(asset, tmp_path):
    asset["checksums"] = {"sha256": "0" * 64}
    with pytest.raises(AcquisitionError, match="checksum mismatch"):
        run(asset, tmp_path, archive_bytes())
    assert not (tmp_path / "fixture/fixture.zip").exists()
    assert not list(tmp_path.rglob("*.lock"))


def test_resume_requires_matching_validator_and_range(asset, tmp_path):
    payload = archive_bytes()
    folder = tmp_path / "fixture"
    folder.mkdir()
    (folder / "fixture.zip.part").write_bytes(payload[:10])
    (folder / "fixture.zip.part.json").write_text(json.dumps(
        {"source_url": asset["url"], "validator": '"v1"'}))
    def open_url(request, **_kwargs):
        assert request.get_header("Range") == "bytes=10-"
        assert request.get_header("If-range") == '"v1"'
        return Response(payload[10:], status=206, headers={"ETag": '"v1"',
                        "Content-Range": f"bytes 10-{len(payload)-1}/{len(payload)}",
                        "Content-Length": str(len(payload)-10)})
    result = acquire(asset, tmp_path, max_bytes=4096, reserve_bytes=0, opener=open_url)
    assert Path(result["path"]).read_bytes() == payload


@pytest.mark.parametrize("header,value", [("ETag", '"changed"'),
                                            ("Content-Range", "bytes 9-19/20")])
def test_resume_rejects_mismatched_range_or_validator(asset, tmp_path, header, value):
    folder = tmp_path / "fixture"
    folder.mkdir()
    partial = folder / "fixture.zip.part"
    partial.write_bytes(b"1234567890")
    (folder / "fixture.zip.part.json").write_text(json.dumps(
        {"source_url": asset["url"], "validator": '"v1"'}))
    headers = {"ETag": '"v1"', "Content-Range": "bytes 10-19/20", "Content-Length": "10"}
    headers[header] = value
    with pytest.raises(AcquisitionError):
        run(asset, tmp_path, b"abcdefghij", status=206, headers=headers)
    assert partial.read_bytes() == b"1234567890"


def test_ignored_range_restarts_instead_of_appending(asset, tmp_path):
    folder = tmp_path / "fixture"
    folder.mkdir()
    (folder / "fixture.zip.part").write_bytes(b"old data")
    (folder / "fixture.zip.part.json").write_text(json.dumps(
        {"source_url": asset["url"], "validator": '"old"'}))
    payload = archive_bytes()
    result = run(asset, tmp_path, payload)
    assert Path(result["path"]).read_bytes() == payload


def test_streaming_size_limit_even_without_content_length(asset, tmp_path):
    asset["max_bytes"] = 30
    with pytest.raises(AcquisitionError, match="Streaming response"):
        run(asset, tmp_path, b"X" * 100, headers={"ETag": '"x"'})
    assert not (tmp_path / "fixture/fixture.zip").exists()
    assert (tmp_path / "fixture/fixture.zip.part").stat().st_size <= 30


def test_truncated_transfer_is_retained_but_not_published(asset, tmp_path):
    with pytest.raises(AcquisitionError, match="Truncated"):
        run(asset, tmp_path, b"short", headers={"ETag": '"v1"', "Content-Length": "200"})
    assert (tmp_path / "fixture/fixture.zip.part").read_bytes() == b"short"
    assert not (tmp_path / "fixture/fixture.zip").exists()


@pytest.mark.parametrize("changes", [
    {"access": "gated"}, {"allowed_purposes": ["noncommercial-research"]},
    {"filename": "../../escape.zip"}, {"id": "../escape"},
    {"url": "http://data.example.org/fixture.zip"},
    {"url": "https://other.example.org/fixture.zip"},
])
def test_catalog_policy_rejects_unsafe_or_unlicensed_assets(asset, changes):
    asset.update(changes)
    with pytest.raises(AcquisitionError):
        select_assets({"assets": [asset]}, [asset["id"]], "commercial-compatible")


def test_redirect_policy_checked_before_following():
    with pytest.raises(AcquisitionError, match="Unapproved"):
        ApprovedRedirects(["data.example.org"]).redirect_request(
            None, None, 302, "", {}, "https://other.example.org/secret")


def test_expansion_budget_prevents_unbounded_crc_validation(asset, tmp_path):
    path = tmp_path / "compressed.zip"
    path.write_bytes(archive_bytes(b"X" * 1000))
    asset["max_uncompressed_bytes"] = 100
    with pytest.raises(AcquisitionError, match="expansion"):
        validate_archive(path, asset, 4096)


def test_html_page_and_missing_mount_rejected(asset, tmp_path):
    with pytest.raises(AcquisitionError, match="page instead"):
        run(asset, tmp_path, b"<html>login</html>", headers={"Content-Type": "text/html"})
    with pytest.raises(AcquisitionError, match="already exist"):
        acquire(asset, tmp_path / "missing-mount", max_bytes=4096)


def test_disk_reserve_is_checked_before_download(asset, tmp_path):
    with patch("scripts.acquire_tissue_datasets.shutil.disk_usage") as usage:
        usage.return_value.free = 1
        with pytest.raises(AcquisitionError, match="Insufficient free"):
            run(asset, tmp_path, archive_bytes())


def test_symlinks_and_concurrent_acquisition_rejected(asset, tmp_path):
    folder = tmp_path / "fixture"
    folder.mkdir()
    (folder / "fixture.zip.lock").write_text("123")
    with pytest.raises(AcquisitionError, match="locked"):
        run(asset, tmp_path, archive_bytes())
    (folder / "fixture.zip.lock").unlink()
    outside = tmp_path / "original"
    outside.write_bytes(b"keep")
    (folder / "fixture.zip.part").symlink_to(outside)
    with pytest.raises(AcquisitionError, match="symlink"):
        run(asset, tmp_path, archive_bytes())
    assert outside.read_bytes() == b"keep"


def test_dry_run_makes_no_download_and_requires_explicit_selection(asset, tmp_path):
    catalog = tmp_path / "catalog.json"
    catalog.write_text(json.dumps({"assets": [asset]}))
    with patch("urllib.request.build_opener", side_effect=AssertionError("No network")):
        assert main(["--catalog", str(catalog), "--asset", "fixture"]) == 0
        assert main(["--catalog", str(catalog)]) == 1


def test_catalog_has_sources_and_sane_explicit_asset_policies():
    path = Path(__file__).resolve().parents[2] / "research/tissue-materials/datasets.json"
    data = json.loads(path.read_text())
    assert len(data["datasets"]) >= 15
    assert len({item["id"] for item in data["datasets"]}) == len(data["datasets"])
    datasets = {item["id"] for item in data["datasets"]}
    for asset in data["assets"]:
        assert asset["dataset_id"] in datasets
        assert asset["license_sources"] and asset["citation"]
        select_assets(deepcopy(data), [asset["id"]], asset["allowed_purposes"][0])


class CurlProcess:
    def __init__(self, response, code=0):
        self.stdout = io.BytesIO(response)
        self.stderr = io.BytesIO(b"certificate verification failed" if code else b"")
        self.code = code

    def wait(self, **_kwargs):
        return self.code

    def poll(self):
        return self.code


def test_curl_native_transport_reuses_archive_validation(asset, tmp_path):
    payload = archive_bytes()
    http = b"HTTP/1.1 200 OK\r\nETag: \"one\"\r\nContent-Length: "
    http += str(len(payload)).encode() + b"\r\n\r\n" + payload
    with patch("scripts.acquire_tissue_datasets.subprocess.Popen") as popen:
        popen.return_value = CurlProcess(http)
        result = acquire(asset, tmp_path, max_bytes=4096, reserve_bytes=0, transport="curl")
        command = popen.call_args.args[0]
    assert command[1] == "--disable"
    assert "--location" not in command and "-L" not in command and "--insecure" not in command
    assert command[command.index("--proto") + 1] == "=https"
    assert command[command.index("--max-filesize") + 1] == "4096"
    assert result["transport"] == "curl" and result["archive"]["crc_verified"]


def test_curl_refuses_redirect_without_following(asset, tmp_path):
    with patch("scripts.acquire_tissue_datasets.subprocess.Popen") as popen:
        popen.return_value = CurlProcess(
            b"HTTP/1.1 302 Found\r\nLocation: https://other.example.org/a\r\n\r\n")
        with pytest.raises(AcquisitionError, match="HTTP status 302"):
            acquire(asset, tmp_path, max_bytes=4096, reserve_bytes=0, transport="curl")
        assert popen.call_count == 1


def test_curl_failure_is_reported_and_proxy_status_is_skipped(asset):
    import urllib.request
    request = urllib.request.Request(asset["url"])
    with patch("scripts.acquire_tissue_datasets.subprocess.Popen") as popen:
        popen.return_value = CurlProcess(b"", code=60)
        with pytest.raises(AcquisitionError, match="certificate verification failed"):
            CurlResponse(request, limit=4096, timeout=10)
        popen.return_value = CurlProcess(
            b"HTTP/1.1 200 Connection established\r\n\r\n"
            b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc")
        with CurlResponse(request, limit=4096, timeout=10) as response:
            assert response.read(4) == b"abc"
            assert response.read(4) == b""
