#!/usr/bin/env python3
"""Loopback-only, single-flight local inference for the deployed visual skill UI."""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py"))
from viscera_core.visual_policy.contract import (
    SCHEMA,
    decode_action,
    parse_request,
    promotion_ready,
)


def allowed_origin(origin: str | None):
    from urllib.parse import urlsplit

    if origin is None or origin == "https://daniil-777.github.io":
        return True
    parsed = urlsplit(origin)
    return (
        parsed.scheme == "http"
        and parsed.hostname in ("127.0.0.1", "localhost")
        and not parsed.username
        and not parsed.password
        and parsed.path == ""
        and parsed.query == ""
        and parsed.fragment == ""
    )


def make_handler(service):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def permitted(self):
            return self.headers.get("Host") in (
                "127.0.0.1:8877",
                "localhost:8877",
            ) and allowed_origin(self.headers.get("Origin"))

        def send(self, status, value):
            body = json.dumps(value, allow_nan=False).encode()
            self.send_response(status)
            origin = self.headers.get("Origin")
            if origin and allowed_origin(origin):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_OPTIONS(self):
            self.send(200 if self.permitted() else 403, {})

        def do_GET(self):
            if not self.permitted():
                return self.send(403, {"error": "Origin or host rejected"})
            if self.path != "/health":
                return self.send(404, {"error": "Unknown route"})
            self.send(200, service.health())

        def do_POST(self):
            if not self.permitted():
                return self.send(403, {"error": "Origin or host rejected"})
            if self.path != "/predict":
                return self.send(404, {"error": "Unknown route"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if (
                    not 0 < length <= 200000
                    or self.headers.get("Content-Type") != "application/json"
                ):
                    return self.send(413, {"error": "Invalid request body"})
                self.connection.settimeout(5)
                request = parse_request(json.loads(self.rfile.read(length)))
            except (ValueError, OSError, TimeoutError):
                return self.send(400, {"error": "Invalid visual observation"})
            if not service.ready:
                return self.send(503, {"error": "Policy has not passed evaluation"})
            if not service.lock.acquire(blocking=False):
                return self.send(429, {"error": "Inference busy; no request was queued"})
            try:
                result = service.predict(request)
                self.send(200, result)
            except Exception as error:
                print("Inference failed:", type(error).__name__, file=sys.stderr, flush=True)
                self.send(503, {"error": "Inference failed"})
            finally:
                service.lock.release()

        def log_message(self, format, *args):
            print(format % args, file=sys.stderr, flush=True)

    return Handler


class PolicyService:
    def __init__(self, models: Path, run: Path):
        import torch
        from PIL import Image
        from viscera_core.visual_policy.contract import INSTRUCTIONS
        from viscera_core.visual_policy.model import build_policy, make_batch, predict, sha256

        self.manifest = json.loads((run / "manifest.json").read_text())
        if (
            self.manifest.get("schema") != SCHEMA
            or self.manifest["adapterSha256"] != sha256(run / "adapter.safetensors")
            or self.manifest["baseSha256"] != sha256(models / "base/model.safetensors")
        ):
            raise ValueError("Model manifest or checkpoint hash mismatch")
        self.ready = promotion_ready(self.manifest)
        self.lock = threading.Lock()
        torch.set_num_threads(4)
        self.device = (
            "mps"
            if torch.backends.mps.is_available()
            else "cuda"
            if torch.cuda.is_available()
            else "cpu"
        )
        self.policy = build_policy(models, self.device, run / "adapter.safetensors")
        self._batch, self._predict = make_batch, predict
        # Warm both the image encoder and all flow-sampling steps before readiness.
        sample = {
            "image": Image.new("RGB", (256, 256)),
            "state": [0.0] * 16,
            "instruction": INSTRUCTIONS[0],
        }
        for _ in range(2):
            began = time.perf_counter()
            predict(self.policy, make_batch(self.policy, [sample], self.device))
            self.warm_ms = (time.perf_counter() - began) * 1000
        self.ready = self.ready and self.warm_ms <= 1500

    def health(self):
        return {
            "schema": SCHEMA,
            "ready": self.ready,
            "modelId": self.manifest["modelId"],
            "device": self.device,
            "scope": "guarded simulation skills",
            "latency": self.manifest["latency"],
            "warmMs": self.warm_ms,
        }

    def predict(self, request):
        began = time.perf_counter()
        scores = self._predict(self.policy, self._batch(self.policy, [request], self.device))[0]
        return {
            "requestId": request["requestId"],
            **decode_action(scores),
            "modelId": self.manifest["modelId"],
            "inferenceMs": (time.perf_counter() - began) * 1000,
        }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--run", type=Path, required=True)
    args = parser.parse_args()
    service = PolicyService(args.models, args.run)
    server = ThreadingHTTPServer(("127.0.0.1", 8877), make_handler(service))
    server.daemon_threads = True
    print(json.dumps(service.health()), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
