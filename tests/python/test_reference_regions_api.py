"""Multi-region image analysis: independent anatomy, bounded work and failures."""
import base64
import hashlib
import io

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from services.api import reference_material


def encoded(array):
    output = io.BytesIO()
    Image.fromarray(array).save(output, format="PNG")
    return base64.b64encode(output.getvalue()).decode()


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(reference_material.router)
    return TestClient(app)


@pytest.fixture
def payload():
    image = np.empty((100, 160, 3), dtype=np.uint8)
    image[:, :80] = [155, 72, 62]
    image[:, 80:] = [182, 142, 114]
    left = np.zeros((100, 160), dtype=np.uint8)
    left[10:90, 10:70] = 255
    right = np.zeros_like(left)
    right[10:90, 90:150] = 255
    return {"image_base64": encoded(image), "segmentation": "local", "regions": [
        {"id": "liver-region", "organ": "liver", "selection": {"box": [0., 0., .5, 1.]}, "mask_base64": encoded(left)},
        {"id": "mesentery-region", "organ": "mesentery", "selection": {"box": [.5, 0., 1., 1.]}, "mask_base64": encoded(right)},
    ]}


def test_distinct_regions_share_original_photo_but_keep_masks_and_colours_separate(client, payload, monkeypatch):
    decoded = []
    original = reference_material.decode_photo

    def counted(raw):
        decoded.append(len(raw))
        return original(raw)

    monkeypatch.setattr(reference_material, "decode_photo", counted)
    response = client.post("/api/atlas/reference-material/analyze-regions", json=payload)
    assert response.status_code == 200, response.text
    result = response.json()
    assert len(decoded) == 1
    assert result["version"] == "reference-regions-1"
    source_hash = hashlib.sha256(base64.b64decode(payload["image_base64"])).hexdigest()
    assert result["source_sha256"] == source_hash
    first, second = [entry["analysis"] for entry in result["results"]]
    assert [entry["id"] for entry in result["results"]] == ["liver-region", "mesentery-region"]
    assert first["source_sha256"] == second["source_sha256"] == source_hash
    assert first["mask_sha256"] != second["mask_sha256"]
    assert first["organ"] == "liver" and second["organ"] == "mesentery"
    np.testing.assert_allclose(first["observed_color_srgb"], np.array([155, 72, 62]) / 255, atol=1e-6)
    np.testing.assert_allclose(second["observed_color_srgb"], np.array([182, 142, 114]) / 255, atol=1e-6)
    assert first["quality"]["semantic_confidence"] is None
    assert result == client.post("/api/atlas/reference-material/analyze-regions", json=payload).json()


def test_failed_region_is_explicit_without_erasing_good_analysis_or_retaining_lock(client, payload):
    payload["regions"][1]["mask_base64"] = encoded(np.zeros((100, 160), dtype=np.uint8))
    result = client.post("/api/atlas/reference-material/analyze-regions", json=payload).json()
    assert "analysis" in result["results"][0]
    assert "Too little selected tissue" in result["results"][1]["error"]
    assert "analysis" not in result["results"][1]
    assert not reference_material._ANALYSIS_LOCK.locked()


@pytest.mark.parametrize("invalid", ["duplicate", "unknown", "empty", "too-many", "bad-box"])
def test_invalid_batch_shape_is_rejected_before_processing(client, payload, invalid, monkeypatch):
    if invalid == "duplicate":
        payload["regions"][1]["id"] = payload["regions"][0]["id"]
    elif invalid == "unknown":
        payload["regions"][1]["organ"] = "unidentified-red-tissue"
    elif invalid == "empty":
        payload["regions"] = []
    elif invalid == "too-many":
        payload["regions"] = [{**payload["regions"][0], "id": f"region-{i}"} for i in range(13)]
    else:
        payload["regions"][0]["selection"]["box"] = [.6, .6, .4, .4]
    monkeypatch.setattr(reference_material, "decode_photo", lambda _: pytest.fail("Invalid request must not decode a photo"))
    assert client.post("/api/atlas/reference-material/analyze-regions", json=payload).status_code == 422


def test_batch_uses_shared_analysis_limit_and_releases_it_after_bad_photo(client, payload):
    with reference_material._ANALYSIS_LOCK:
        assert client.post("/api/atlas/reference-material/analyze-regions", json=payload).status_code == 429
    assert client.post("/api/atlas/reference-material/analyze-regions", json={**payload, "image_base64": "bad!"}).status_code == 422
    assert not reference_material._ANALYSIS_LOCK.locked()
    assert client.post("/api/atlas/reference-material/analyze-regions", json=payload).status_code == 200


def test_unavailable_segmenter_is_reported_per_region_and_reviewed_masks_still_work(client, payload, monkeypatch):
    from services.api import reference_segmenter

    def unavailable(*_):
        raise RuntimeError("SAM 2 checkpoint is not configured.")

    monkeypatch.setattr(reference_segmenter, "segment_sam2", unavailable)
    payload["segmentation"] = "sam2"
    del payload["regions"][1]["mask_base64"]
    response = client.post("/api/atlas/reference-material/analyze-regions", json=payload)
    assert response.status_code == 200
    results = response.json()["results"]
    assert results[0]["analysis"]["segmentation"]["method"] == "uploaded-mask"
    assert "checkpoint" in results[1]["error"]
    assert not reference_material._ANALYSIS_LOCK.locked()
