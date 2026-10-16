"""Read-only serving audit against an independently hashed downloaded weight ZIP.

Checks every installed template and supported disease with actual HTTP inference.
This tests numerical, provenance and reproducibility contracts, not clinical realism.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

import numpy as np


def request(url: str, endpoint: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = None if body is None else json.dumps(body, allow_nan=False).encode()
    req = urllib.request.Request(
        url.rstrip("/") + endpoint,
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise ValueError(f"{endpoint}: HTTP {error.code}: {error.read().decode()[:500]}") from error


def validate_scene(result: dict[str, Any], template: str) -> dict[str, Any]:
    assert result["spec"]["template_id"] == template, "Template changed"
    assert result["spec"].get("template_sha256"), "Missing source binding"
    assert all(np.isfinite(v) and -1 <= v <= 1 for v in result["spec"]["controls"].values())
    organ = result["scene"]["organs"][0]
    vertices = np.asarray(organ["positions"], dtype=float).reshape(-1, 3)
    triangles = np.asarray(organ["indices"]).reshape(-1, 3)
    assert len(vertices) > 3 and len(triangles) > 0
    assert np.isfinite(vertices).all(), "Nonfinite vertices"
    assert triangles.min() >= 0 and triangles.max() < len(vertices), "Invalid triangle indices"
    assert np.all(np.ptp(vertices, axis=0) > 0), "Collapsed axis"
    return {
        "template": template,
        "geometry_sha256": result["scene"]["metadata"]["geometry_sha256"],
        "vertices": len(vertices),
        "triangles": len(triangles),
        "extent_mm": np.ptp(vertices, axis=0).tolist(),
    }


def run(url: str, weights: Path, output: Path, *, conditioned_only: bool = False) -> dict[str, Any]:
    with weights.open("rb") as stream:
        bundle_sha = hashlib.file_digest(stream, "sha256").hexdigest()
    with zipfile.ZipFile(weights) as archive:
        manifest = json.loads(archive.read("viscera-weights/manifest.json"))
    model_hashes = {
        lane: manifest["artifact_hashes"][name]
        for lane, name in {
            "shape": "shape/model.pt",
            "material": "material/model.npz",
            "disease": "disease/model.npz",
        }.items()
    }
    started = time.monotonic()
    status = request(url, "/api/atlas/models")
    assert status["bundle_sha256"] == bundle_sha, "Live server has different weights"
    catalog = request(url, "/api/atlas/catalog")
    rows: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    seeds = [8123] if conditioned_only else [7101, 7102, 7103]

    def record(lane: str, identity: str, operation: Any) -> None:
        try:
            rows.append({"lane": lane, "identity": identity, **operation()})
            print(f"PASS {lane} {identity}", flush=True)
        except Exception as error:
            errors.append({"lane": lane, "identity": identity, "error": str(error)})
            print(f"FAIL {lane} {identity}: {error}", flush=True)

    for organ in catalog["organs"]:
        for template in organ["templates"]:
            template_id = template["id"]

            def shape_case() -> dict[str, Any]:
                if conditioned_only:
                    base = request(
                        url,
                        "/api/atlas/generate",
                        {"template_id": template_id, "seed": seeds[0], "appearance": "clay"},
                    )
                    target = request(
                        url, "/api/atlas/sample", {"spec": base["spec"], "match_dimensions": True}
                    )
                    before = validate_scene(base, template_id)
                    after = validate_scene(target, template_id)
                    model = target["summary"]["model"]
                    assert model["model_sha256"] == model_hashes["shape"]
                    assert model["refinement_status"] == "matched"
                    error = [
                        abs(x - y) / x
                        for x, y in zip(before["extent_mm"], after["extent_mm"], strict=True)
                    ]
                    assert max(error) <= 0.0011, "Dimension target exceeded tolerance"
                    return {
                        "samples": [before, after],
                        "relative_extent_error": error,
                        "refinement_status": model["refinement_status"],
                    }
                generated = [
                    request(
                        url,
                        "/api/atlas/sample",
                        {
                            "spec": {
                                "template_id": template_id,
                                "seed": seed,
                                "appearance": "clay",
                            },
                            "match_dimensions": False,
                        },
                    )
                    for seed in seeds + [seeds[0]]
                ]
                measures = [validate_scene(item, template_id) for item in generated]
                assert all(
                    item["summary"]["model"]["model_sha256"] == model_hashes["shape"]
                    for item in generated
                )
                assert generated[0]["spec"] == generated[-1]["spec"], "Seed replay differs"
                assert measures[0]["geometry_sha256"] == measures[-1]["geometry_sha256"]
                assert len({item["geometry_sha256"] for item in measures}) > 1, (
                    "Distinct seeds gave no geometry variation"
                )
                return {"samples": measures, "replay_equal": True}

            record("shape", template_id, shape_case)

        if conditioned_only:
            continue
        template_id = organ["templates"][0]["id"]

        def material_case() -> dict[str, Any]:
            generated = [
                request(
                    url,
                    "/api/atlas/sample-material",
                    {
                        "spec": {"template_id": template_id, "seed": 42},
                        "seed": seed,
                    },
                )
                for seed in seeds + [seeds[0]]
            ]
            measures = [validate_scene(item, template_id) for item in generated]
            assert all(
                item["summary"]["material_model"]["model_sha256"] == model_hashes["material"]
                for item in generated
            )
            assert generated[0]["spec"]["material"] == generated[-1]["spec"]["material"], (
                "Surface replay differs"
            )
            assert len({item["geometry_sha256"] for item in measures}) == 1, (
                "Surface changed geometry"
            )
            assert (
                len({json.dumps(item["spec"]["material"], sort_keys=True) for item in generated})
                > 1
            )
            return {"samples": measures, "replay_equal": True, "geometry_preserved": True}

        record("material", organ["id"], material_case)

        for profile in catalog["diseases"]["profiles"]:
            if profile["organ"] != organ["id"] or not profile["supported"]:
                continue

            def disease_case() -> dict[str, Any]:
                generated = [
                    request(
                        url,
                        "/api/atlas/sample-disease",
                        {
                            "spec": {
                                "template_id": template_id,
                                "seed": 42,
                                "disease": {"profile_id": profile["id"]},
                            },
                            "seed": seed,
                        },
                    )
                    for seed in seeds + [seeds[0]]
                ]
                measures = [validate_scene(item, template_id) for item in generated]
                assert all(
                    item["summary"]["disease_model"]["model_sha256"] == model_hashes["disease"]
                    for item in generated
                )
                assert generated[0]["spec"]["disease"] == generated[-1]["spec"]["disease"], (
                    "Disease replay differs"
                )
                assert measures[0]["geometry_sha256"] == measures[-1]["geometry_sha256"]
                assert (
                    len({json.dumps(item["spec"]["disease"], sort_keys=True) for item in generated})
                    > 1
                )
                assert all(
                    item["spec"]["controls"] == generated[0]["spec"]["controls"]
                    for item in generated
                )
                return {"samples": measures, "replay_equal": True, "shape_controls_preserved": True}

            record("disease", profile["id"], disease_case)

    final = request(url, "/api/atlas/models")
    assert final["bundle_sha256"] == bundle_sha, "Active weights changed during audit"
    report = {
        "ok": not errors,
        "bundle_sha256": bundle_sha,
        "model_hashes": model_hashes,
        "seconds": round(time.monotonic() - started, 2),
        "groups_passed": len(rows),
        "groups_failed": len(errors),
        "seeds": seeds,
        "samples_per_group": 2 if conditioned_only else 4,
        "conditioned_only": conditioned_only,
        "scope": "serving/provenance/reproducibility; not clinical realism or calibrated physics",
        "rows": rows,
        "errors": errors,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, allow_nan=False))
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    parser.add_argument("--weights", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument(
        "--conditioned-only",
        action="store_true",
        help="Test Keep overall dimensions on every template",
    )
    args = parser.parse_args()
    report = run(args.url, args.weights, args.out, conditioned_only=args.conditioned_only)
    print(
        json.dumps(
            {key: value for key, value in report.items() if key not in {"rows", "errors"}}, indent=2
        )
    )
    raise SystemExit(0 if report["ok"] else 1)


if __name__ == "__main__":
    main()
