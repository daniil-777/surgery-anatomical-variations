"""Exercise every API feature the studio uses against one server and print one line per feature.

    python scripts/probe_web_app.py http://127.0.0.1:8011        # a staged server (scripts/verify_stage.sh)
    python scripts/probe_web_app.py https://<space>.hf.space      # the published app

Exit status 1 when a feature that the public app promises fails. Routes that the web boundary blocks must answer 403.
"""
from __future__ import annotations

import base64
import json
import struct
import sys
import time
import urllib.error
import urllib.request
import zlib
from typing import Any, Callable

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://127.0.0.1:8011"
TOLERATED: set[str] = set()   # nothing: the material sampler answers since its reviewed-extension fix
results: dict[str, int] = {}


def call(method: str, path: str, body: Any = None, raw: bool = False, timeout: float = 900) -> tuple[int, Any]:
    data = None if body is None else json.dumps(body).encode()
    headers = {"Content-Type": "application/json"} if body is not None else {}
    request = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read()
            return response.status, (payload if raw else json.loads(payload))
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read()).get("detail")
        except Exception:  # noqa: BLE001 - any body is only diagnostic here
            detail = "?"
        return error.code, detail


def check(name: str, method: str, path: str, body: Any = None, raw: bool = False,
          summarize: Callable[[Any], str] = lambda r: "") -> Any:
    started = time.time()
    status, result = call(method, path, body, raw)
    ok = 200 <= status < 300
    try:
        note = summarize(result) if ok else str(result)[:220]
    except Exception as error:  # noqa: BLE001 - a summary must never hide the status
        note = f"(summary failed: {error}) keys={list(result)[:8] if isinstance(result, dict) else type(result).__name__}"
    results[name] = status
    print(f"{'ok  ' if ok else 'FAIL'} {status} {time.time() - started:5.1f}s {name}: {note}")
    return result if ok else None


def expect_403(name: str, method: str, path: str, body: Any = None) -> None:
    status, result = call(method, path, body)
    results[name] = 200 if status == 403 else status
    print(f"{'ok  ' if status == 403 else 'FAIL'} {status} {name}: {str(result)[:80]}")


def synthetic_photo(width: int, height: int) -> bytes:
    """A PNG with contrast: a reddish organ blob on a darker background."""
    rows = []
    for y in range(height):
        row = b"\x00"
        for x in range(width):
            inside = (x - width / 2) ** 2 / (0.32 * width) ** 2 + (y - height / 2) ** 2 / (0.28 * height) ** 2 < 1
            row += bytes((150 + (x * 7) % 30, 60 + (y * 5) % 20, 50)) if inside else bytes((40 + (x * 3) % 12, 30, 30))
        rows.append(row)
    raw = b"".join(rows)

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def main() -> int:
    check("health", "GET", "/api/health", summarize=lambda r: r["status"])
    check("frontend html", "GET", "/", raw=True, summarize=lambda r: f"{len(r)} bytes, has /assets/: {b'/assets/' in r}")
    check("texture lab html", "GET", "/textures.html", raw=True, summarize=lambda r: f"{len(r)} bytes, mode meta: {b'viscera-mode' in r}")
    catalog = check("catalog", "GET", "/api/atlas/catalog", summarize=lambda r: f"{r['renderer_version']}, {len(r['organs'])} organs")
    organ = catalog["organs"][0]
    template_id = organ["templates"][0]["id"]
    spec = {
        "renderer_version": catalog["renderer_version"], "template_id": template_id, "seed": 42,
        "controls": {c["key"]: c["default"] for c in catalog["controls"]}, "appearance": "tissue",
        "material": dict(catalog["materials"]["defaults"][organ["id"]]),
    }
    first = catalog["controls"][0]
    generated = check("generate", "POST", "/api/atlas/generate", spec, summarize=lambda r: f"{r['summary'].get('triangles', '?')} triangles")
    check("generate (slider at max)", "POST", "/api/atlas/generate", {**spec, "controls": {**spec["controls"], first["key"]: first["max"]}}, summarize=lambda r: "ok")
    check("generate (seed)", "POST", "/api/atlas/generate", {**spec, "seed": 7}, summarize=lambda r: "ok")
    check("shape sample (learned)", "POST", "/api/atlas/sample", {"spec": spec}, summarize=lambda r: str(r.get("summary", {}).get("model", {}).get("method", "?")))
    check("joint VAE sample", "POST", "/api/atlas/sample-joint", {"spec": spec, "seed": 7, "temperature": 0.8}, summarize=lambda r: str(r["summary"].get("joint_model", r["summary"].get("model", {})).get("method", "?")))
    check("material sample (ridge)", "POST", "/api/atlas/sample-material", {"spec": spec, "seed": 3}, summarize=lambda r: str(r.get("summary", {}).get("material_model", {}))[:120])
    disease = catalog["diseases"]["defaults"].get(organ["id"]) or {"profile_id": catalog["diseases"]["profiles"][0]["id"], "severity": 0.5}
    disease_spec = {**spec, "disease": disease}
    check("generate (disease)", "POST", "/api/atlas/generate", disease_spec, summarize=lambda r: str(r["summary"]["disease"].get("recipe", {}).get("profile_id", "?")))
    check("joint VAE sample (disease, severe)", "POST", "/api/atlas/sample-joint", {"spec": disease_spec, "seed": 8, "temperature": 1.0, "severity": "severe"}, summarize=lambda r: f"severity {r['summary']['disease']['recipe']['severity']:.2f}")
    check("disease sample", "POST", "/api/atlas/sample-disease", {"spec": disease_spec, "seed": 3}, summarize=lambda r: str(r["summary"]["disease_model"].get("method", "?")))
    check("text command", "POST", "/api/atlas/compile", {"text": "make it wider", "spec": spec}, summarize=lambda r: str(r.get("status")))
    check("text command (trained adapter)", "POST", "/api/atlas/compile", {"text": "make it wider", "spec": spec, "use_trained_language": True},
          summarize=lambda r: str({k: r[k] for k in r if k == "status" or "adapter" in k or "language" in k or "model" in k})[:240])
    check("models (read)", "GET", "/api/atlas/models", summarize=lambda r: f"source {r.get('source')}, joint generation {r.get('joint_generation')}, language_enabled {r.get('language_enabled')}")
    check("joint history", "GET", "/api/atlas/models/joint/history", summarize=lambda r: f"{len(r.get('versions', []))} versions")
    check("clinical sample", "POST", "/api/atlas/models/clinical/sample", {"organ": "pancreas", "disease_code": "pancreatic_ductal_adenocarcinoma", "seed": 1}, summarize=lambda r: f"{len(r.get('cases', []))} cases")
    check("physics status", "GET", "/api/physics/status", summarize=lambda r: str(r.get("status")))
    check("physics demo observation", "GET", "/api/physics/demo-observation", summarize=lambda r: f"{len(r.get('times_s', []))} samples")
    check("physics playground (learned)", "POST", "/api/physics/playground", {"spec": spec, "parameter_source": "learned"}, summarize=lambda r: f"cage {r['mesh'].get('cage_volume_ml', 0):.0f} ml")
    check("physics playground (manual)", "POST", "/api/physics/playground", {"spec": spec, "parameter_source": "manual", "parameters": {"young_pa": 6000.0}}, summarize=lambda r: "ok")
    check("physics run (grasp, learned)", "POST", "/api/physics/run", {"spec": spec, "parameter_source": "learned", "protocol": "grasp", "amplitude_mm": 6.0}, summarize=lambda r: str(r.get("protocol")))
    check("physics run (cut, manual)", "POST", "/api/physics/run", {"spec": spec, "parameter_source": "manual", "parameters": {}, "protocol": "cut", "amplitude_mm": 4.0}, summarize=lambda r: "ok")
    check("reference-material status", "GET", "/api/atlas/reference-material/status", summarize=lambda r: f"default segmentation {r.get('default_segmentation')}")
    image = base64.b64encode(synthetic_photo(96, 96)).decode()
    check("reference analyze (local segmentation)", "POST", "/api/atlas/reference-material/analyze", {"image_base64": image, "organ": organ["id"], "selection": {"box": [0.1, 0.1, 0.9, 0.9]}}, summarize=lambda r: str(list(r)[:6]))
    check("export GLB (textured)", "POST", "/api/atlas/export", {"spec": generated["spec"], "format": "glb", "texture_resolution": 512}, raw=True, summarize=lambda r: f"{len(r) // 1024} KB, magic {r[:4]!r}")
    check("export Unity", "POST", "/api/atlas/export", {"spec": generated["spec"], "format": "unity", "texture_resolution": 512}, raw=True, summarize=lambda r: f"{len(r) // 1024} KB, magic {r[:2]!r}")
    legacy = check("legacy generate", "POST", "/api/generate", {"spec": {}, "resolution": "low"}, summarize=lambda r: f"{len(r.get('organs', []))} organs")
    check("legacy compile", "POST", "/api/compile", {"text": "a liver with a gallbladder", "spec": {}}, summarize=lambda r: str(r.get("status")))
    check("legacy learned sample", "POST", "/api/sample-learned", {"seed": 5, "resolution": "low"}, summarize=lambda r: f"{len(r.get('organs', []))} organs")
    check("legacy snapshot", "POST", "/api/snapshots", {"scene": legacy}, summarize=lambda r: str(r.get("id", "?"))[:16])
    expect_403("admin import blocked", "POST", "/api/atlas/models/import", {})
    expect_403("admin activate blocked", "POST", "/api/atlas/models/joint/activate", {"generation": 2, "bundle_sha256": "0" * 64})
    expect_403("language enable blocked", "POST", "/api/atlas/models/language/enable", {"allow_model_download": True})
    expect_403("projects listing blocked", "GET", "/api/projects")
    failing = [name for name, status in results.items() if not 200 <= status < 300]
    blocking = [name for name in failing if name.split(" (")[0] not in TOLERATED]
    print(f"== {len(results) - len(failing)}/{len(results)} features ok on {BASE}; failing: {failing}; tolerated: {sorted(set(failing) - set(blocking))}")
    return 1 if blocking else 0


if __name__ == "__main__":
    sys.exit(main())
