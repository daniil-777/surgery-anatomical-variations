"""Parallel range correctness and failure atomicity without external networking."""

from __future__ import annotations

import hashlib
import io
import json
import threading
import urllib.request
import zipfile
from unittest.mock import patch

import pytest

from scripts.acquire_tissue_datasets import AcquisitionError
from scripts.acquire_tissue_parallel import check_range, parallel_acquire


@pytest.fixture
def payload():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("tissue-fixture.txt", b"fixture pixels" * 100)
    return buffer.getvalue()


@pytest.fixture
def asset():
    return {"id": "sample", "dataset_id": "sample", "filename": "sample.zip", "format": "zip",
            "url": "https://data.example.org/sample.zip", "allowed_hosts": ["data.example.org"],
            "access": "direct", "allowed_purposes": ["commercial-compatible"],
            "license": "CC-BY-4.0", "license_sources": ["https://data.example.org/license"],
            "citation": "Synthetic fixture", "max_bytes": 10000}


class Response(io.BytesIO):
    def __init__(self, body, start, end, total, *, etag='"v1"', status=206):
        super().__init__(body)
        self.status = status
        self.headers = {"Content-Range": f"bytes {start}-{end}/{total}",
                        "Content-Length": str(end - start + 1), "ETag": etag}

    def geturl(self):
        return "https://data.example.org/sample.zip"


class Server:
    def __init__(self, payload):
        self.payload = payload
        self.requests = []
        self.lock = threading.Lock()
        self.mutate = None

    def __call__(self, request: urllib.request.Request, *, limit, timeout):
        start, end = map(int, request.get_header("Range").removeprefix("bytes=").split("-"))
        assert limit == end - start + 1
        with self.lock:
            self.requests.append((start, end, request.get_header("If-match")))
        response = Response(self.payload[start:end + 1], start, end, len(self.payload))
        if self.mutate:
            self.mutate(response, start, end, request)
        return response


def run(asset, tmp_path, server, **kwargs):
    return parallel_acquire(asset, tmp_path, max_bytes=10000, reserve_bytes=0,
                            chunk_bytes=100, workers=4, opener=server, **kwargs)


def test_assembles_exact_object_pins_all_ranges_preserves_fallback(asset, payload, tmp_path):
    folder = tmp_path / "sample"
    folder.mkdir()
    fallback = folder / "sample.zip.part"
    fallback.write_bytes(b"untrusted fallback prefix")
    asset["checksums"] = {"sha256": hashlib.sha256(payload).hexdigest()}
    server = Server(payload)
    receipt = run(asset, tmp_path, server)
    assert (folder / "sample.zip").read_bytes() == payload
    assert fallback.read_bytes() == b"untrusted fallback prefix"
    assert receipt["publisher_checksums_verified"] == ["sha256"]
    assert receipt["archive"]["crc_verified"]
    assert receipt["transport"] == "curl-parallel-ranges"
    assert all(etag == '"v1"' for _, _, etag in server.requests[1:])
    assert len(list(folder.rglob("*.bin"))) == 0
    assert not (folder / "sample.zip.lock").exists()
    stored = json.loads((folder / "sample.zip.provenance.json").read_text())
    assert stored["http_etag"] == '"v1"'


@pytest.mark.parametrize("mutation", ["etag", "range", "length", "status", "overrun", "truncated"])
def test_bad_ranges_never_publish_archive(asset, payload, tmp_path, mutation):
    server = Server(payload)
    def mutate(response, start, end, _request):
        if end == 0:
            return
        if mutation == "etag":
            response.headers["ETag"] = '"changed"'
        elif mutation == "range":
            response.headers["Content-Range"] = f"bytes {start+1}-{end}/{len(payload)}"
        elif mutation == "length":
            response.headers["Content-Length"] = "999"
        elif mutation == "status":
            response.status = 200
        elif mutation == "overrun":
            response.seek(0, 2)
            response.write(b"X")
            response.seek(0)
        elif mutation == "truncated":
            response.truncate(end - start)
    server.mutate = mutate
    with pytest.raises(AcquisitionError):
        run(asset, tmp_path, server)
    assert not (tmp_path / "sample/sample.zip").exists()
    assert not (tmp_path / "sample/sample.zip.provenance.json").exists()
    assert not (tmp_path / "sample/sample.zip.lock").exists()


def test_final_probe_catches_changed_origin(asset, payload, tmp_path):
    server = Server(payload)
    def mutate(response, start, end, request):
        if end == 0 and request.get_header("If-match"):
            response.headers["ETag"] = '"changed"'
    server.mutate = mutate
    with pytest.raises(AcquisitionError, match="ETag"):
        run(asset, tmp_path, server)
    assert not (tmp_path / "sample/sample.zip").exists()


def test_verified_chunks_resume_after_failed_final_probe(asset, payload, tmp_path):
    server = Server(payload)
    def mutate(response, start, end, request):
        if end == 0 and request.get_header("If-match"):
            response.status = 412
    server.mutate = mutate
    with pytest.raises(AcquisitionError):
        run(asset, tmp_path, server)
    chunks = sorted((tmp_path / "sample").rglob("*.bin"))
    assert chunks
    corrupt = chunks[0]
    corrupt.write_bytes(b"X" * corrupt.stat().st_size)
    server = Server(payload)
    result = run(asset, tmp_path, server)
    data_requests = [(a, b) for a, b, _ in server.requests if b > 0]
    assert data_requests == [(0, 99)]  # Only the corrupted chunk is fetched again.
    assert result["sha256"] == hashlib.sha256(payload).hexdigest()


def test_byte_budget_and_assembly_disk_budget_checked_before_chunks(asset, payload, tmp_path):
    server = Server(payload)
    asset["max_bytes"] = 100
    with pytest.raises(AcquisitionError, match="budget"):
        run(asset, tmp_path, server)
    assert len(server.requests) == 1
    asset["max_bytes"] = 10000
    with patch("scripts.acquire_tissue_parallel.shutil.disk_usage") as usage:
        usage.return_value.free = len(payload)
        with pytest.raises(AcquisitionError, match="assembly"):
            run(asset, tmp_path, Server(payload))


def test_existing_single_stream_lock_prevents_parallel_start(asset, payload, tmp_path):
    folder = tmp_path / "sample"
    folder.mkdir()
    lock = folder / "sample.zip.lock"
    lock.write_text("running process")
    server = Server(payload)
    with pytest.raises(AcquisitionError, match="locked"):
        run(asset, tmp_path, server)
    assert server.requests == []
    assert lock.read_text() == "running process"


def test_writer_metadata_is_persisted_before_any_network(asset, payload, tmp_path):
    server = Server(payload)
    lock = tmp_path / "sample/sample.zip.lock"

    def inspect(request, **kwargs):
        metadata = json.loads(lock.read_text())
        assert metadata["schema"] == "viscera.dataset-acquisition-writer/v1"
        assert metadata["pid"] > 0 and metadata["hostname"] and metadata["created_utc"]
        assert metadata["asset_id"] == asset["id"] and metadata["source_url"] == asset["url"]
        assert metadata["destination"] == str(tmp_path / "sample/sample.zip")
        return server(request, **kwargs)

    run(asset, tmp_path, inspect)
    assert not lock.exists()


@pytest.mark.parametrize("published", [False, True])
@pytest.mark.parametrize("lock_text", ["12345", '{"pid":12345,"hostname":"previous-colab-vm"}'])
def test_interrupted_lock_gives_actionable_error_and_preserves_evidence(asset, payload, tmp_path, published, lock_text):
    folder = tmp_path / "sample"
    if published:
        run(asset, tmp_path, Server(payload))
    else:
        folder.mkdir()
    lock = folder / "sample.zip.lock"
    lock.write_text(lock_text)
    partial = folder / "sample.zip.parallel.part"
    partial.write_bytes(b"interrupted assembly evidence")
    server = Server(payload)
    with pytest.raises(AcquisitionError, match="ALL kernels/processes") as failure:
        run(asset, tmp_path, server)
    assert "previous VM is not proof" in str(failure.value)
    assert "manually remove this specific stale .lock" in str(failure.value)
    assert "training checkpoint resume" in str(failure.value)
    assert lock.read_text() == lock_text
    assert partial.read_bytes() == b"interrupted assembly evidence"
    assert not server.requests


def test_rejects_weak_etag_and_unsafe_final_url(asset):
    response = Response(b"x", 0, 0, 100, etag='W/"weak"')
    with pytest.raises(AcquisitionError, match="strong ETag"):
        check_range(response, asset, 0, 0)
    response = Response(b"x", 0, 0, 100)
    response.geturl = lambda: "https://unknown.example.org/download"
    with pytest.raises(AcquisitionError, match="Unapproved"):
        check_range(response, asset, 0, 0)


def test_full_archive_checksum_failure_never_publishes(asset, payload, tmp_path):
    asset["checksums"] = {"sha256": "0" * 64}
    with pytest.raises(AcquisitionError, match="checksum mismatch"):
        run(asset, tmp_path, Server(payload))
    assert not (tmp_path / "sample/sample.zip").exists()


def test_existing_published_archive_is_rehashed_without_network(asset, payload, tmp_path):
    first = run(asset, tmp_path, Server(payload))
    def no_network(*_args, **_kwargs):
        raise AssertionError("Existing verified artifact must not be fetched")
    second = run(asset, tmp_path, no_network)
    assert second["reused"] and second["sha256"] == first["sha256"]
