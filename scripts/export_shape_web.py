"""Export the learned shape sampler behind POST /api/atlas/sample for the browser, with fixtures that pin the port.

    PYTHONPATH=py:. .venv/bin/python scripts/export_shape_web.py

The model is the one the API serves: services.api.atlas_model_registry.resolve_model(ROOT, "shape") — the active
imported bundle's shape/model.pt, else VISCERA_ATLAS_MODEL, else artifacts/atlas/run-v2/model.pt. Its selected method
is ridge, so sampling reads no neural weights: the training rows (controls, measured conditions, observation mask),
the per-template condition normalisation and the ridge penalty are the whole model. The sampler also reads the
cohort-v2 templates at request time (control limits, normalisation, the trained artifact hash), so those go along.

Writes apps/studio/public/models/shape-v2/model.json (metadata, templates, array layout, provenance) and weights.bin
(controls and conditions as little-endian float64, the mask as bytes, in the order model.json lists), and
apps/studio/src/__fixtures__/shape-v2.json: complete samples from services.api.atlas_model.sample_model for several
templates × seeds × match_dimensions, with the intermediate values the browser port recomputes (the encoded
conditions, the ridge mean, the draws, the proposal, each attempt's refinement), plus small bounded least-squares
problems solved by scipy's TRF for trustRegionReflective.ts. atlasShapeSampler.test.ts replays all of it.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "py"), str(ROOT)]

import scipy  # noqa: E402
from scipy.optimize import least_squares  # noqa: E402

from pipelines.train.viscera_train import atlas_shape as shape  # noqa: E402
from services.api.atlas import template_root, versioned_template_root  # noqa: E402
from services.api.atlas_model import sample_model  # noqa: E402
from services.api.atlas_model_registry import DEFAULTS, _active, digest, resolve_model  # noqa: E402
from viscera_core import atlas  # noqa: E402
from viscera_core.atlas_dataset import CONDITION_NAMES  # noqa: E402
from viscera_core.atlas_scene import AtlasSpec, get_template  # noqa: E402

OUT = ROOT / "apps/studio/public/models/shape-v2"
FIXTURES = ROOT / "apps/studio/src/__fixtures__/shape-v2.json"
FORMAT = "viscera-atlas-control-model-v1-web"
# services.api.atlas_model.sample_model's refinement settings and attempt schedule
REFINEMENT = {"relative_tolerance": 0.001, "prior_weight": 0.005, "max_nfev": 60, "ftol": 1e-9, "xtol": 1e-9, "gtol": 1e-9}
ATTEMPTS, ATTEMPT_SEED_STRIDE = 4, 104729
DATA_ROOT = Path(__import__("os").environ.get("VISCERA_ATLAS_DATASET", ROOT / "datasets/atlas/cohort-v2"))


def model_source(path: Path) -> str:
    _, directory = _active(ROOT)
    if directory is not None and path.is_relative_to(directory):
        return f"active bundle {directory.name}"
    return str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path)


def template_entries(artifact: dict[str, Any], trained_root: Path, display_root: Path) -> list[dict[str, Any]]:
    p = artifact["preprocessing"]
    entries = []
    for i, template_id in enumerate(p["templates"]):
        trained = get_template(trained_root, template_id)
        entry: dict[str, Any] = {
            "id": template_id,
            "organ_id": int(p["organ_ids"][i]),
            "condition_mean": [float(v) for v in p["condition_mean"][i]],
            "condition_scale": [float(v) for v in p["condition_scale"][i]],
            "condition_available": [bool(v) for v in p["condition_available"][i]],
            "control_limits": [float(v) for v in trained.metadata["control_limits"]],
            "normalization_mm": float(trained.metadata["normalization_mm"]),
            "artifact_sha256": trained.metadata["artifact_sha256"],
            "display_artifact_sha256": trained.metadata["artifact_sha256"],
            "rest_vertex_patches": [],
        }
        if display_root != trained_root:
            # the renderer displays the repaired templates-v3 while the sampler measures cohort-v2: where a vertex
            # differs, the browser substitutes the trained value before measuring, exactly as the API measures
            display = get_template(display_root, template_id)
            entry["display_artifact_sha256"] = display.metadata["artifact_sha256"]
            if display.vertices_mm.shape != trained.vertices_mm.shape:
                raise SystemExit(f"{template_id}: display and trained templates differ in vertex count")
            for index in np.flatnonzero(np.any(display.vertices_mm != trained.vertices_mm, axis=1)):
                entry["rest_vertex_patches"].append({
                    "index": int(index),
                    "display": [float(v) for v in display.vertices_mm[index]],
                    "trained": [float(v) for v in trained.vertices_mm[index]],
                })
        entries.append(entry)
    return entries


def export_model() -> tuple[dict[str, Any], dict[str, Any], Path]:
    model_path = resolve_model(ROOT, "shape")
    artifact = shape.load_model(model_path)
    if artifact["selected_method"] != "ridge":
        raise SystemExit(f"the browser port covers the ridge sampler; the active model selected {artifact['selected_method']}")
    data = shape._train_data(artifact)
    templates = template_entries(artifact, template_root(), versioned_template_root(template_root()))
    lookup = {t["id"]: i for i, t in enumerate(templates)}
    controls = np.ascontiguousarray(data["controls"], dtype="<f8")
    conditions = np.ascontiguousarray(data["conditions"], dtype="<f8")
    mask = np.ascontiguousarray(data["condition_mask"], dtype=np.uint8)
    chunks = [controls.tobytes(), conditions.tobytes(), mask.tobytes()]
    layout, offset = [], 0
    for name, array, dtype in (("controls", controls, "<f8"), ("conditions", conditions, "<f8"), ("condition_mask", mask, "u1")):
        layout.append({"name": name, "dtype": dtype, "shape": list(array.shape), "offset": offset})
        offset += array.nbytes
    meta = {
        "format": FORMAT,
        "method": artifact["selected_method"],
        "model_sha256": digest(model_path),
        "model_source": model_source(model_path),
        "default_model": DEFAULTS["shape"][1],
        "ridge_alpha": float(artifact["config"]["ridge_alpha"]),
        "condition_names": list(artifact["condition_names"]),
        "control_names": list(artifact["control_names"]),
        "templates": templates,
        "training_rows": {"count": int(len(controls)), "template_index": [lookup[str(t)] for t in data["template_ids"]]},
        "arrays": layout,
        "byte_length": offset,
        "dataset": {"root": str(DATA_ROOT.relative_to(ROOT)) if DATA_ROOT.is_relative_to(ROOT) else str(DATA_ROOT), "release_sha256": artifact["dataset_hashes"]["release.json"], "source_sha256": artifact["source_sha256"]},
        "scope": artifact["scope"],
        "sampling_scope": "within_generator_design_distribution",
        "refinement": REFINEMENT,
        "attempts": ATTEMPTS,
        "attempt_seed_stride": ATTEMPT_SEED_STRIDE,
    }
    if meta["condition_names"] != list(CONDITION_NAMES) or meta["control_names"] != list(atlas.CONTROL_NAMES):
        raise SystemExit("the model's measurement or control contract differs from viscera_core")
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "model.json").write_text(json.dumps(meta, separators=(",", ":")) + "\n")
    (OUT / "weights.bin").write_bytes(b"".join(chunks))
    print(f"{meta['model_source']} ({meta['model_sha256'][:12]}…): model.json ({(OUT / 'model.json').stat().st_size} B), weights.bin ({offset} B)")
    return artifact, meta, model_path


# ---------------------------------------------------------------------------------------------- fixtures
def decoder_for(template_id: str) -> Any:
    active = get_template(template_root(), template_id)

    def decoder(requested: str, controls: Any) -> tuple[Any, Any]:
        assert requested == template_id
        v = atlas.deform_vertices(active.vertices_mm, controls, active.metadata["control_limits"], active.metadata["normalization_mm"])
        values = np.full(6, np.nan)
        values[:3] = np.ptp(v, axis=0)
        return values, np.array([True, True, True, False, False, False])

    return decoder


def ridge_internals(artifact: dict[str, Any], template_id: str, targets: dict[str, float]) -> dict[str, Any]:
    """encode_conditions + _ridge for one template, as sample_controls runs them (ridge method, conditions given)."""
    names = artifact["condition_names"]
    data = shape._train_data(artifact)
    ix = data["template_ids"] == template_id
    c = np.asarray([[targets.get(name, np.nan) for name in names]], dtype=np.float64)
    mask = np.asarray([[name in targets for name in names]], dtype=bool)
    _, z, m = shape.encode_conditions(artifact["preprocessing"], np.asarray([template_id]), c, mask)
    _, tz, tm = shape.encode_conditions(artifact["preprocessing"], data["template_ids"][ix], data["conditions"][ix], data["condition_mask"][ix])
    mean, residual = shape._ridge(data["controls"][ix], tz, tm, z[0], m[0], artifact["config"]["ridge_alpha"])
    residual = residual - residual.mean(0)
    return {"z": [float(v) for v in z[0]], "mean": [float(v) for v in mean], "residual": residual, "rows": int(ix.sum())}


def record_attempt(artifact: dict[str, Any], template_id: str, targets: dict[str, float], seed: int, decoder: Any) -> dict[str, Any]:
    """One attempt of sample_model's loop with its intermediate values; asserts they compose to sample_controls' output."""
    proposal = shape.sample_controls(artifact, template_id, targets, count=1, seed=seed)[0]
    record: dict[str, Any] = {"seed": seed, "proposal": [float(v) for v in proposal]}
    rng = np.random.default_rng(seed)
    if targets:
        internals = ridge_internals(artifact, template_id, targets)
        draws = []
        for _ in range(256):
            draws.append(int(rng.integers(internals["rows"])))
            candidate = np.asarray(internals["mean"]) + internals["residual"][draws[-1]]
            if np.isfinite(candidate).all() and np.all(np.abs(candidate) <= 1):
                break
        assert np.array_equal(candidate, proposal), "the recorded draw does not reproduce the proposal"
        record.update({"z": internals["z"], "mean": internals["mean"], "residual_row": [float(v) for v in internals["residual"][draws[-1]]], "draws": draws})
        refinement = shape.refine_controls(artifact, template_id, proposal, targets, decoder, **{k: REFINEMENT[k] for k in ("relative_tolerance", "prior_weight", "max_nfev")})
        record["refinement"] = refinement
    else:
        data = shape._train_data(artifact)
        rows = int((data["template_ids"] == template_id).sum())
        record["draws"] = [int(v) for v in rng.integers(rows, size=1)]
        record["refinement"] = None
    return record


def sample_case(artifact: dict[str, Any], model_path: Path, template_id: str, seed: int, controls: dict[str, float], match: bool) -> dict[str, Any]:
    spec = AtlasSpec(template_id=template_id, seed=seed, controls=controls, appearance="tissue")
    case: dict[str, Any] = {"template_id": template_id, "seed": seed, "match_dimensions": match, "controls": controls}
    try:
        result = sample_model(template_root(), model_path, DATA_ROOT, spec, match)
    except ValueError as error:
        case["error"] = str(error)
        return case
    info = result["summary"]["model"]
    case["result"] = {"controls": [result["spec"]["controls"][k] for k in atlas.CONTROL_NAMES], "template_sha256": result["spec"]["template_sha256"], "model": info}
    decoder = decoder_for(template_id)
    current, _ = decoder(template_id, np.array([controls[k] for k in atlas.CONTROL_NAMES]))
    case["current_extents_mm"] = [float(v) for v in current[:3]]
    targets = {k: float(current[i]) for i, k in enumerate(CONDITION_NAMES[:3])} if match else {}
    attempts = [record_attempt(artifact, template_id, targets, (seed + attempt * ATTEMPT_SEED_STRIDE) % 2**32, decoder) for attempt in range(info["attempt"])]
    final = attempts[-1]
    if match:
        assert final["refinement"]["controls"] == case["result"]["controls"], "the recorded refinement differs from the route's"
        assert final["refinement"]["decoder_calls"] == info["refinement"]["decoder_calls"]
    else:
        assert final["proposal"] == case["result"]["controls"]
    case["attempts"] = attempts
    return case


# small bounded problems for the TRF port alone; the TypeScript test defines the same residuals by name
def rosenbrock(x: np.ndarray) -> np.ndarray:
    return np.array([10 * (x[1] - x[0] ** 2), 1 - x[0]])


def exponential_fit(x: np.ndarray) -> np.ndarray:
    t = np.arange(10, dtype=np.float64)
    y = np.array([2.0, 1.3, 0.95, 0.72, 0.5, 0.41, 0.27, 0.2, 0.13, 0.1])
    return x[0] * np.exp(-x[1] * t) + x[2] - y


def bounded_quadratic(x: np.ndarray) -> np.ndarray:
    a = np.array([[3.0, 1.0, 0.0], [1.0, 2.0, 0.5], [0.0, 0.5, 1.0], [0.3, 0.3, 0.3]])
    b = np.array([4.0, -3.0, 2.0, 1.0])
    return a @ x - b


TRF_PROBLEMS = [
    ("rosenbrock", rosenbrock, [-1.2, 1.0], (-1.5, 1.5)),
    ("rosenbrock", rosenbrock, [0.5, -0.5], (-0.9, 0.9)),
    ("exponential_fit", exponential_fit, [1.0, 0.1, 0.0], (-1.0, 3.0)),
    ("bounded_quadratic", bounded_quadratic, [0.0, 0.0, 0.0], (-1.0, 1.0)),
    ("bounded_quadratic", bounded_quadratic, [0.9, -0.9, 0.9], (-1.0, 1.0)),
]


def export_trf_fixtures() -> list[dict[str, Any]]:
    problems = []
    for name, fun, x0, bounds in TRF_PROBLEMS:
        calls = 0

        def counted(x: np.ndarray) -> np.ndarray:
            nonlocal calls
            calls += 1
            return fun(x)

        result = least_squares(counted, np.asarray(x0, dtype=np.float64), bounds=bounds, max_nfev=REFINEMENT["max_nfev"], ftol=1e-9, xtol=1e-9, gtol=1e-9)
        problems.append({
            "problem": name, "x0": x0, "bounds": list(bounds), "x": result.x.tolist(), "cost": float(result.cost), "fun": result.fun.tolist(),
            "optimality": float(result.optimality), "nfev": int(result.nfev), "njev": int(result.njev), "status": int(result.status),
            "message": result.message, "function_calls": calls, "active_mask": result.active_mask.tolist(),
        })
    return problems


def export_fixtures(artifact: dict[str, Any], meta: dict[str, Any], model_path: Path) -> None:
    zero = {k: 0.0 for k in atlas.CONTROL_NAMES}
    bent = {**zero, "scale_x": 0.3, "bend": -0.4, "twist": 0.2}
    cases = [
        ("hra-liver-female", 42, zero, True), ("hra-liver-female", 42, zero, False),
        ("hra-liver-female", 7, zero, True), ("hra-liver-female", 0, zero, True), ("hra-liver-female", 3, zero, True),
        ("hra-liver-female", 42, bent, True), ("hra-liver-female", 42, bent, False),
        ("hra-liver-female", 5, {**zero, "scale_x": 0.9, "scale_y": 0.9, "scale_z": 0.9}, True),
        ("hra-liver-female", 42, {**zero, "scale_x": 1.0}, True),      # beyond the training support
        ("bp3d-stomach-male", 7, zero, True), ("bp3d-stomach-male", 7, zero, False), ("bp3d-stomach-male", 10007, zero, True),
        ("bp3d-stomach-male", 7, {**zero, "scale_y": -0.5, "taper": 0.6}, True),
        ("bp3d-gallbladder-male", 42, zero, True), ("bp3d-gallbladder-male", 2**32 - 1, zero, False),
        ("hra-urinary-bladder-male", 7, zero, True), ("hra-urinary-bladder-male", 42, zero, False),
        ("hra-spleen-female", 10007, zero, True), ("hra-kidney-male-right", 1729, zero, True),
        ("hra-liver-male", 0, zero, True), ("hra-liver-male", 2**32 - 1, zero, False),
        ("hra-heart-male", 42, zero, True),
    ]
    samples = [sample_case(artifact, model_path, *case) for case in cases]
    rng_cases = []
    for seed in (0, 7, 42, 1729, 2**32 - 1):
        rng_cases.append({"seed": seed, "integers_44": int(np.random.default_rng(seed).integers(44)), "integers_44_size_1": [int(v) for v in np.random.default_rng(seed).integers(44, size=1)],
                          "attempt_seeds": [(seed + attempt * ATTEMPT_SEED_STRIDE) % 2**32 for attempt in range(ATTEMPTS)]})
    fixture = {
        "model_sha256": meta["model_sha256"], "scipy": scipy.__version__, "numpy": np.__version__,
        "rng": rng_cases, "trf": export_trf_fixtures(), "samples": samples,
    }
    FIXTURES.parent.mkdir(parents=True, exist_ok=True)
    FIXTURES.write_text(json.dumps(fixture, indent=0) + "\n")
    errors = sum("error" in s for s in samples)
    print(f"fixtures: {len(rng_cases)} rng seeds, {len(fixture['trf'])} TRF problems, {len(samples)} samples ({errors} refusals) → {FIXTURES.relative_to(ROOT)} ({FIXTURES.stat().st_size} B)")


if __name__ == "__main__":
    export_fixtures(*export_model())
