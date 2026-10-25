import base64
import io
import json
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest
from PIL import Image
from viscera_core.visual_policy.contract import (
    INSTRUCTIONS,
    SCHEMA,
    decode_action,
    parse_request,
    promotion_ready,
)

from scripts.visual_policy_server import allowed_origin, make_handler


def request():
    image = io.BytesIO()
    Image.new("RGB", (256, 256)).save(image, format="JPEG")
    return {
        "schema": SCHEMA,
        "requestId": "test-1",
        "instruction": INSTRUCTIONS[0],
        "state": [0.0] * 16,
        "image": "data:image/jpeg;base64," + base64.b64encode(image.getvalue()).decode(),
    }


def test_contract_decodes_real_image_and_rejects_invalid_inputs():
    value = request()
    parsed = parse_request(value)
    assert parsed["image"].size == (256, 256)
    for patch in (
        {"state": [0.0]},
        {"state": [float("nan")] * 16},
        {"state": [False] * 16},
        {"instruction": "cut the liver"},
        {"requestId": "a\nb"},
        {"image": "data:image/jpeg;base64,???"},
    ):
        with pytest.raises(ValueError):
            parse_request({**value, **patch})


def test_actions_abstain_instead_of_claiming_probabilities():
    assert decode_action([1.0, 0.0, 0.0, 0.0, 0.0])["accepted"]
    assert not decode_action([0.5, 0.4, 0.0, 0.0, 0.0])["accepted"]
    assert not decode_action([4.0, 0.0, 0.0, 0.0, 0.0])["accepted"]
    with pytest.raises(ValueError):
        decode_action([float("nan")] * 5)


def test_readiness_requires_evidence_not_only_a_boolean():
    assert not promotion_ready({"ready": True})
    manifest = {
        "ready": True,
        "training": {"episodes": {"train": 12, "validation": 3, "test": 5}},
        "test": {"accuracy": 1.0, "coverage": 1.0, "wrongAccepted": 0},
        "latency": {"p95Ms": 400},
    }
    assert promotion_ready(manifest)
    assert not promotion_ready({**manifest, "test": {**manifest["test"], "wrongAccepted": 1}})
    assert not promotion_ready({**manifest, "latency": {"p95Ms": float("nan")}})


@pytest.mark.parametrize(
    "origin",
    [
        "https://attacker.example",
        "http://localhost.attacker.example:8877",
        "http://user@localhost:8877",
        "https://daniil-777.github.io.attacker.example",
        "http://127.0.0.1:8877/path",
    ],
)
def test_origin_boundary(origin):
    assert not allowed_origin(origin)


def test_service_rejects_cross_origin_and_has_no_inference_queue():
    from http.server import ThreadingHTTPServer

    class Service:
        ready = True
        lock = threading.Lock()

        def health(self):
            return {"schema": SCHEMA, "ready": True, "modelId": "test"}

        def predict(self, value):
            return {"requestId": value["requestId"], **decode_action([1.0, 0.0, 0.0, 0.0, 0.0])}

    service = Service()
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(service))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def call(path, origin="https://daniil-777.github.io", body=None):
        return urlopen(
            Request(
                f"http://127.0.0.1:{server.server_port}{path}",
                data=None if body is None else json.dumps(body).encode(),
                headers={
                    "Host": "127.0.0.1:8877",
                    "Origin": origin,
                    "Content-Type": "application/json",
                },
            ),
            timeout=3,
        )

    try:
        with call("/health") as result:
            assert json.load(result)["ready"]
        with pytest.raises(HTTPError) as error:
            call("/health", origin="https://attacker.example")
        assert error.value.code == 403
        with call("/predict", body=request()) as result:
            assert json.load(result)["skill"] == "look"
        service.lock.acquire()
        with pytest.raises(HTTPError) as error:
            call("/predict", body=request())
        assert error.value.code == 429
        service.lock.release()
        service.ready = False
        with pytest.raises(HTTPError) as error:
            call("/predict", body=request())
        assert error.value.code == 503
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
