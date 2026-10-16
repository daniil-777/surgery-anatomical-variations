"""Real API analysis -> material generation -> textured export contracts."""
import base64
import hashlib
import io
import json
import struct
import zlib
from pathlib import Path

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from viscera_core.atlas_materials import make_recipe
from viscera_core.reference_analysis import decode_mask

from services.api import atlas, reference_material


def encode(array):
    stream = io.BytesIO()
    Image.fromarray(array).save(stream, format="PNG")
    return base64.b64encode(stream.getvalue()).decode()


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(reference_material.router)
    app.include_router(atlas.router)
    return TestClient(app)


@pytest.fixture
def payload():
    photo = np.full((96, 128, 3), [161, 109, 96], dtype=np.uint8)
    photo[25:32, 40:60] = 255
    mask = np.zeros((96, 128), dtype=np.uint8)
    mask[10:86, 12:116] = 255
    return {"image_base64": encode(photo), "organ": "gallbladder",
            "mask_base64": encode(mask), "selection": {"box": [0., 0., 1., 1.]}}


def test_api_replay_source_binding_and_no_semantic_confidence(client, payload):
    first = client.post("/api/atlas/reference-material/analyze", json=payload)
    assert first.status_code == 200, first.text
    result = first.json()
    assert result == client.post("/api/atlas/reference-material/analyze", json=payload).json()
    assert result["source_sha256"] == hashlib.sha256(base64.b64decode(payload["image_base64"])).hexdigest()
    assert result["mask_sha256"] == hashlib.sha256(base64.b64decode(result["mask_png_base64"])).hexdigest()
    assert result["segmentation"]["semantic_identity"] == "user_assigned"
    assert result["quality"]["semantic_confidence"] is None
    assert result["quality"]["glare_or_clipped_pixels"] > 0


@pytest.mark.parametrize("change", [{"image_base64":"bad!"}, {"organ":"mystery"},
                                   {"mask_base64":"abcd"}, {"segmentation":"cloud"},
                                   {"selection":{"box":[.5, .5, .1, .1]}}])
def test_api_rejects_invalid_input_atomically(client, payload, change):
    response = client.post("/api/atlas/reference-material/analyze", json={**payload, **change})
    assert response.status_code == 422


def test_analysis_slot_is_bounded_and_released_after_error(client, payload):
    with reference_material._ANALYSIS_LOCK:
        assert client.post("/api/atlas/reference-material/analyze", json=payload).status_code == 429
    assert client.post("/api/atlas/reference-material/analyze", json={**payload, "image_base64":"bad!"}).status_code == 422
    assert client.post("/api/atlas/reference-material/analyze", json=payload).status_code == 200


def test_transparent_palette_mask_is_not_treated_as_white_foreground():
    mask = Image.new("P", (32, 32), 1)
    mask.putpalette([0, 0, 0, 255, 255, 255] + [0] * 762)
    raw = io.BytesIO()
    mask.save(raw, format="PNG", transparency=1)
    with pytest.raises(ValueError, match="opaque"):
        decode_mask(raw.getvalue(), (32, 32), (32, 32))


@pytest.mark.parametrize("corrupt_profile", [b"", b"profile\0", b"profile\0\x01bad"])
def test_malformed_lazy_png_chunks_are_validation_errors_and_release_slot(client, payload, corrupt_profile):
    def chunk(name, body):
        return struct.pack(">I", len(body)) + name + body + struct.pack(">I", zlib.crc32(name + body))
    raw = b"\x89PNG\r\n\x1a\n"
    raw += chunk(b"IHDR", struct.pack(">IIBBBBB", 32, 32, 8, 2, 0, 0, 0))
    raw += chunk(b"IDAT", zlib.compress((b"\0" + b"\xff" * 96) * 32))
    raw += chunk(b"iCCP", corrupt_profile) + chunk(b"IEND", b"")
    damaged = base64.b64encode(raw).decode()
    assert client.post("/api/atlas/reference-material/analyze", json={**payload,"image_base64":damaged}).status_code == 422
    # Mask size must match in order to reach lazy pixel decode.
    small = encode(np.full((32,32,3), [161,109,96],dtype=np.uint8))
    assert client.post("/api/atlas/reference-material/analyze", json={**payload,"image_base64":small,"mask_base64":damaged}).status_code == 422
    assert client.post("/api/atlas/reference-material/analyze", json=payload).status_code == 200


def test_actual_generation_and_baked_glb_preserve_geometry_and_reference(client, payload, monkeypatch):
    root = Path(__file__).resolve().parents[2]
    templates = root / "datasets/atlas/cohort-v2/templates"
    assert (templates / "bp3d-gallbladder-male.npz").exists()
    monkeypatch.setenv("VISCERA_ATLAS_TEMPLATES", str(templates))
    analysis = client.post("/api/atlas/reference-material/analyze", json=payload).json()
    recipe = make_recipe("gallbladder").model_dump()
    spec = {"template_id":"bp3d-gallbladder-male", "seed":17, "material":recipe}
    before = client.post("/api/atlas/generate", json=spec)
    assert before.status_code == 200, before.text
    changed_recipe = {**recipe, "reference_color":{**analysis["reference_color"], "mode":"color"}}
    changed = client.post("/api/atlas/generate", json={**spec,"material":changed_recipe})
    assert changed.status_code == 200, changed.text
    old, new = before.json(), changed.json()
    assert old["scene"]["metadata"]["geometry_sha256"] == new["scene"]["metadata"]["geometry_sha256"]
    assert old["scene"]["organs"][0]["positions"] == new["scene"]["organs"][0]["positions"]
    assert old["scene"]["organs"][0]["colors"] != new["scene"]["organs"][0]["colors"]
    exported = client.post("/api/atlas/export", json={"spec":new["spec"],"texture_resolution":512})
    assert exported.status_code == 200, exported.text[:100]
    raw = exported.content
    header = json.loads(raw[20:20 + struct.unpack("<I",raw[12:16])[0]])
    assert header["images"] and header["textures"]
    # Inspect the actual baked base-colour pixels, not only the saved recipe.
    texture_id = header["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["index"]
    image_id = header["textures"][texture_id]["source"]
    view = header["bufferViews"][header["images"][image_id]["bufferView"]]
    binary_start = 28 + struct.unpack("<I", raw[12:16])[0]
    image_start = binary_start + view.get("byteOffset", 0)
    with Image.open(io.BytesIO(raw[image_start:image_start + view["byteLength"]])) as baked:
        texels = np.asarray(baked.convert("RGBA"))
        valid = (texels[..., 3] > 0) & (texels[..., :3].max(axis=-1) > 20)
        actual_colour = np.median(texels[..., :3][valid], axis=0) / 255
        np.testing.assert_allclose(actual_colour, analysis["observed_color_srgb"], atol=.04)
    meta = header["scenes"][0]["extras"]
    assert meta["spec"]["material"]["reference_color"] == changed_recipe["reference_color"]
    assert meta["geometry_sha256"] == new["scene"]["metadata"]["geometry_sha256"]
    restored = client.post("/api/atlas/generate", json=spec).json()
    assert restored["scene"]["organs"][0]["colors"] == old["scene"]["organs"][0]["colors"]
