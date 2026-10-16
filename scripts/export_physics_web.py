"""Export the physics calibration (POST /api/physics/infer, and /playground with a learned observation) for the browser.

    PYTHONPATH=py:. .venv/bin/python scripts/export_physics_web.py

The model is the one the API serves: services.api.physics.model_root() (VISCERA_PHYSICS_MODEL, else
artifacts/physics/liver-network-v2), routed by its manifest to viscera_core.physics_learning_v2. The optional research
application policy (VISCERA_PHYSICS_APPLICATION_POLICY) is off unless configured, and the shipped candidate
(artifacts/physics/liver-application-policy-v1) failed its final evaluation, so the API cannot serve it; the export
refuses to run while one is configured. What the API runs for an observation is therefore v2.infer_observation:
the calibrated strain/stress, 81-point resampled features, a three-member MLP ensemble (165-160-96-3, ReLU, sigmoid)
whose mean proposal warm-starts scipy's bounded soft-L1 least squares in the encoded [0, 1]^3 box, a central-difference
sensitivity matrix, conformal intervals and the excitation/fit diagnostics that decide accepted_for_application.

Writes apps/studio/public/models/physics-v2/model.json (layout, encoding, calibration, the API's result text and
defaults, provenance) and weights.bin (every weight and bias as little-endian float32: the stored float64 values are
all float32-exact, so the browser's float64 promotion reproduces numpy's float64 arrays bit for bit), and
apps/studio/src/__fixtures__/physics-v2.json: the HTTP responses of the API's own routes (FastAPI TestClient on
services.api.app) to the demonstration observation and to constructed ones — soft and stiff synthetic tissue,
16 to 257 samples, non-uniform grids, unloading and cyclic histories, sensor noise, outliers and drift, curves the
application gate rejects and inputs that must fail validation — with the intermediate values the browser recomputes,
plus small bounded robust-loss problems solved by scipy's TRF for trustRegionReflective.ts and numpy's np.sum across
its pairwise-summation blocks. Constructed observations are recorded as a browser sends them (JSON.stringify writes
-0 as 0). For every calibration the fixture also records how far the API's own answer moves under last-bit changes
of its arithmetic (its convolution summed in three other orders, or with 8 % of its exp/expm1 values one ulp off), and
for every TRF problem whether scipy's own decisions survive one-ulp residual noise and the other LAPACK SVD driver:
the browser cannot repeat Accelerate's BLAS order or libm bit for bit, and these spreads are the yardstick its
agreement is held to where they exceed 1e-10. atlasPhysicsCalibration.test.ts replays all of it and compares with the
running API.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import platform
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "py"), str(ROOT)]
_TMP = tempfile.TemporaryDirectory(prefix="viscera-physics-export-")
os.environ["VISCERA_DB"] = str(Path(_TMP.name) / "module.sqlite")   # services.api.app builds a module-level app

import scipy  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from scipy.optimize import least_squares  # noqa: E402
from viscera_core import physics_learning_v2 as v2  # noqa: E402
from viscera_core.physics_learning import BOUNDS, PARAMETER_NAMES, demo_observation  # noqa: E402

from services.api import physics as api  # noqa: E402
from services.api.app import create_app  # noqa: E402

OUT = ROOT / "apps/studio/public/models/physics-v2"
FIXTURES = ROOT / "apps/studio/src/__fixtures__/physics-v2.json"
FORMAT = "viscera-physics-inverse-v2-web"
PLAYGROUND_TEMPLATE = "hra-liver-female"
# the files whose logic the browser port repeats; the test refuses a model exported from other sources
PORT_SOURCES = ("py/viscera_core/physics_learning.py", "py/viscera_core/physics_learning_v2.py", "services/api/physics.py")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def relative(path: Path) -> str:
    path = Path(path).resolve()
    return str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path)


# ---------------------------------------------------------------------------------------------- the model
def served_model() -> tuple[dict[str, Any], str, Path]:
    if api.application_policy_root() is not None:
        raise SystemExit("VISCERA_PHYSICS_APPLICATION_POLICY is configured: the browser port covers the v2 path without the optional research policy")
    if api.model_backend() is not v2:
        raise SystemExit("the served physics model is not the v2 contract (liver-inverse-sls-2.0.0); the browser port covers v2 only")
    root = api.model_root()
    model, digest = v2.load_model(root)
    status = api.status()
    if status["status"] != "ready" or status["model_id"] != digest or status.get("application_policy") is not None:
        raise SystemExit(f"the physics API is not ready with this model: {status.get('reason', status['status'])}")
    return model, digest, Path(root)


def parameter_fields() -> dict[str, dict[str, float]]:
    """PhysicsParameters' ge/le bounds, as the route validates the merged learned parameters."""
    fields = {}
    for name, info in api.PhysicsParameters.model_fields.items():
        bounds = {}
        for item in info.metadata:
            for key in ("ge", "le", "gt", "lt"):
                if getattr(item, key, None) is not None:
                    bounds[key] = float(getattr(item, key))
        fields[name] = bounds
    return fields


def result_text(model: dict[str, Any]) -> dict[str, Any]:
    """The constant text of a v2 result, taken from the API's own function rather than copied by hand."""
    demo = demo_observation()
    result = v2.predict_history(model, np.asarray(demo["times_s"]), np.asarray(demo["strain"]), np.asarray(demo["stress_pa"]))
    return {key: result[key] for key in ("version", "scope", "estimator", "uncertainty_scope", "stress_nrmse_definition", "fixed_or_unidentified")} | {
        "ood_scope": result["diagnostics"]["ood_scope"]}


def export_model() -> tuple[dict[str, Any], dict[str, Any]]:
    model, digest, root = served_model()
    width = v2.FEATURE_POINTS * 2 + 3
    members, chunks, offset = [], [], 0
    for member in model["members"]:
        layers, previous = [], width
        for layer in member:
            entry = {}
            for key in ("weight", "bias"):
                values = np.asarray(layer[key], dtype=np.float64)
                single = values.astype("<f4")
                if not np.array_equal(single.astype(np.float64), values):
                    raise SystemExit("a physics weight is not float32-exact; export float64 instead")
                entry[key] = {"shape": list(values.shape), "offset": offset}
                chunks.append(single.tobytes())
                offset += single.nbytes
            if entry["weight"]["shape"][1] != previous:
                raise SystemExit("unexpected physics network layout")
            previous = entry["weight"]["shape"][0]
            layers.append(entry)
        members.append(layers)
    weights = b"".join(chunks)
    log_bounds = BOUNDS.copy()
    log_bounds[[0, 2]] = np.log(log_bounds[[0, 2]])
    span = np.diff(log_bounds, axis=1).ravel()
    status = api.status()
    meta = {
        "format": FORMAT,
        "version": v2.VERSION,
        "preprocessing_version": v2.PREPROCESSING_VERSION,
        "model_sha256": digest,
        "model_source": relative(root),
        "parameter_names": list(PARAMETER_NAMES),
        "bounds": BOUNDS.tolist(),
        # encode/decode_parameters' constants as numpy computes them (log of E and tau bounds, np.diff spans)
        "encoding": {"low": log_bounds[:, 0].tolist(), "high": log_bounds[:, 1].tolist(), "span": span.tolist(), "log_scaled": [True, False, True]},
        "feature_points": v2.FEATURE_POINTS,
        "calibration": model["calibration"],
        "members": members,
        "dtype": "<f4",
        "byte_length": offset,
        "weights_sha256": sha256(weights),
        "calibration_contract": v2.CALIBRATION_CONTRACT,
        "scope": v2.SCOPE,
        "result_text": result_text(model),
        "defaults": api.PhysicsParameters().model_dump(),
        "parameter_fields": parameter_fields(),
        "application_policy": None,
        "evaluation": status["evaluation"],
        "port_sources": {path: sha256((ROOT / path).read_bytes()) for path in PORT_SOURCES},
        "exported_with": {"numpy": np.__version__, "scipy": scipy.__version__, "system": platform.system(), "machine": platform.machine()},
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "model.json").write_text(json.dumps(meta, separators=(",", ":")) + "\n")
    (OUT / "weights.bin").write_bytes(weights)
    print(f"{meta['model_source']} ({digest[:12]}…): model.json ({(OUT / 'model.json').stat().st_size} B), weights.bin ({offset} B)")
    return model, meta


# ---------------------------------------------------------------------------------------------- observations
def rhr(times: np.ndarray, amplitude: float, ramp: float, hold: float, release: float | None = None) -> np.ndarray:
    """Ramp, hold, release, rest (v1's standard_strain shape with free timings)."""
    release = ramp if release is None else release
    return amplitude * np.minimum(np.clip(times / ramp, 0, 1), np.clip((ramp + hold + release - times) / release, 0, 1))


def triangle(times: np.ndarray, amplitude: float, period: float) -> np.ndarray:
    phase = (times % period) / period
    return amplitude * (1 - np.abs(2 * phase - 1))


def cyclic(times: np.ndarray, amplitude: float, frequency: float) -> np.ndarray:
    return amplitude * 0.5 * (1 - np.cos(2 * np.pi * frequency * times))


def staircase(times: np.ndarray, levels: list[float], step: float, ramp: float) -> np.ndarray:
    strain = np.zeros_like(times)
    previous = 0.0
    for k, level in enumerate(levels):
        start = k * step
        strain = strain + (level - previous) * np.clip((times - start) / ramp, 0, 1)
        previous = level
    return strain


def synthetic(name: str, kind: str, times: np.ndarray, strain: np.ndarray, parameters: list[float], *, length: float = 20.0,
              area: float = 100.0, noise: float = 0.0, seed: int = 0, drift: float = 0.0, spikes: tuple[tuple[int, float], ...] = (),
              quantum: float = 0.0, response: Callable[[np.ndarray, np.ndarray, np.ndarray], np.ndarray] | None = None,
              note: str = "") -> dict[str, Any]:
    stress = (response or v2.stress_response)(times, strain, np.asarray(parameters, dtype=float))
    peak = float(np.max(np.abs(stress)))
    rng = np.random.default_rng(seed)
    if noise:
        stress = stress + rng.normal(size=stress.shape) * noise * peak
    if drift:
        stress = stress + drift * peak * times / times[-1]
    for index, factor in spikes:
        stress[index] += factor * peak
    stress[0] = 0.0   # tared
    force = stress * (area * 1e-6)
    if quantum:
        force = np.round(force / quantum) * quantum
    observation = {"times_s": times.tolist(), "force_n": force.tolist(), "displacement_mm": (strain * length).tolist(),
                   "reference_length_mm": length, "reference_area_mm2": area,
                   "provenance": f"Synthetic fixture {name}: SLS E={parameters[0]:g} Pa, g={parameters[1]:g}, tau={parameters[2]:g} s{note}"}
    return {"name": name, "class": kind, "observation": observation}


def demo_request() -> dict[str, Any]:
    demo = demo_observation()
    return {k: demo[k] for k in ("times_s", "force_n", "displacement_mm", "reference_length_mm", "reference_area_mm2")} | {
        "provenance": "VISCERA synthetic demonstration; not a tissue measurement."}


def mutated(name: str, kind: str, change: Callable[[dict[str, Any]], None], base: dict[str, Any] | None = None) -> dict[str, Any]:
    observation = copy.deepcopy(base or demo_request())
    change(observation)
    return {"name": name, "class": kind, "observation": observation}


def two_modes(times: np.ndarray, strain: np.ndarray, p: np.ndarray) -> np.ndarray:
    return 0.5 * v2.stress_response(times, strain, np.array([p[0], p[1], 0.1])) + 0.5 * v2.stress_response(times, strain, np.array([p[0], p[1], 3.0]))


def stiffening(times: np.ndarray, strain: np.ndarray, p: np.ndarray) -> np.ndarray:
    return v2.stress_response(times, strain, p) * (1 + 40 * strain)


def as_sent_by_browser(value: Any) -> Any:
    """The request a browser sends: JSON.stringify writes -0 as 0 (every other float survives the round trip)."""
    if isinstance(value, float) and value == 0.0:
        return 0.0
    if isinstance(value, list):
        return [as_sent_by_browser(item) for item in value]
    if isinstance(value, dict):
        return {key: as_sent_by_browser(item) for key, item in value.items()}
    return value


def cases() -> list[dict[str, Any]]:
    lin = np.linspace
    t81, t64, t257 = lin(0, 6, 81), lin(0, 5, 64), lin(0, 10, 257)
    nonuniform = 8 * (np.arange(65) / 64) ** 1.1
    out = [{"name": "demonstration", "class": "demonstration", "observation": demo_request()}]
    # clean synthetic tissue
    out += [
        synthetic("soft_rhr_81", "synthetic_soft", t81, rhr(t81, .025, .6, 3.0), [700., .30, .40]),
        synthetic("very_soft_rhr_64", "synthetic_soft", t64, rhr(t64, .04, .5, 2.0), [540., .20, .30]),
        synthetic("soft_triangle_33", "synthetic_soft", lin(0, 4, 33), triangle(lin(0, 4, 33), .03, 2.0), [1200., .55, .35]),
        synthetic("mid_nonuniform_65", "synthetic_mid", nonuniform, .035 * np.minimum(np.clip(nonuniform / .8, 0, 1), np.clip((5.6 - nonuniform) / 1.1, 0, 1)), [7400., .38, .80]),
        synthetic("mid_cyclic_200", "synthetic_mid", lin(0, 8, 200), cyclic(lin(0, 8, 200), .02, .5), [4500., .45, .90]),
        synthetic("mid_staircase_121", "synthetic_mid", lin(0, 9, 121), staircase(lin(0, 9, 121), [.01, .02, .03, .015, 0.0], 1.8, .3), [3300., .50, .60]),
        synthetic("stiff_rhr_257", "synthetic_stiff", t257, rhr(t257, .02, .8, 4.0), [15000., .50, 1.20]),
        synthetic("very_stiff_rhr_16", "synthetic_stiff", lin(0, 3, 16), rhr(lin(0, 3, 16), .01, .6, 1.2), [19000., .35, .50]),
        synthetic("stiff_triangle_129", "synthetic_stiff", lin(0, 6, 129), triangle(lin(0, 6, 129), .03, 2.0), [11000., .60, .25]),
        synthetic("short_1s_17", "synthetic_mid", lin(0, 1, 17), rhr(lin(0, 1, 17), .01, .15, .5), [4000., .40, .10]),
        synthetic("long_12s_257", "synthetic_mid", lin(0, 12, 257), rhr(lin(0, 12, 257), .05, 1.5, 6.0), [2500., .70, 1.90]),
        synthetic("low_relaxation_81", "synthetic_mid", t81, rhr(t81, .025, .6, 3.0), [6000., .07, .50]),
        synthetic("fast_relaxation_161", "synthetic_mid", lin(0, 4, 161), rhr(lin(0, 4, 161), .02, .2, 1.5), [5000., .50, .06]),
        synthetic("partial_unload_negative_97", "synthetic_mid", lin(0, 6, 97), rhr(lin(0, 6, 97), .03, .6, 2.0) - .0008 * np.clip((lin(0, 6, 97) - 3.2) / .4, 0, 1), [4200., .40, .55]),
        synthetic("geometry_large_area_81", "synthetic_mid", t81, rhr(t81, .025, .6, 3.0), [4800., .42, .65], length=55.0, area=2500.0),
        synthetic("geometry_small_area_81", "synthetic_mid", t81, rhr(t81, .025, .6, 3.0), [4800., .42, .65], length=3.5, area=0.8),
    ]
    integers = synthetic("integer_samples_41", "synthetic_mid", np.arange(41) * 0.2, rhr(np.arange(41) * 0.2, .025, .6, 3.0), [5200., .40, .70])
    integers["observation"].update(reference_length_mm=20, reference_area_mm2=100)
    integers["observation"]["times_s"] = [int(v) if float(v).is_integer() else v for v in integers["observation"]["times_s"]]
    out.append(integers)
    # sensor noise, outliers, drift, quantisation
    out += [
        synthetic("noise_0p5pct_81", "noisy", t81, rhr(t81, .025, .6, 3.0), [4800., .42, .65], noise=.005, seed=11),
        synthetic("noise_1pct_cyclic_129", "noisy", lin(0, 8, 129), cyclic(lin(0, 8, 129), .025, .4), [3000., .40, .70], noise=.01, seed=12),
        synthetic("noise_2pct_stiff_257", "noisy", t257, rhr(t257, .02, .8, 4.0), [15000., .50, 1.20], noise=.02, seed=13),
        synthetic("noise_3pct_soft_64", "noisy", t64, rhr(t64, .04, .5, 2.0), [900., .30, .40], noise=.03, seed=14),
        synthetic("noise_5pct_81", "noisy", t81, rhr(t81, .025, .6, 3.0), [4800., .42, .65], noise=.05, seed=15),
        synthetic("outliers_spikes_101", "noisy", lin(0, 6, 101), rhr(lin(0, 6, 101), .025, .6, 3.0), [5600., .45, .70], noise=.004, seed=16, spikes=((20, .35), (47, -.30), (80, .25))),
        synthetic("drift_3pct_81", "noisy", t81, rhr(t81, .025, .6, 3.0), [4800., .42, .65], noise=.003, seed=17, drift=.03),
        synthetic("quantized_force_81", "noisy", t81, rhr(t81, .02, .6, 3.0), [1500., .40, .60], area=25.0, quantum=2e-5),
    ]
    # curves the application gate refuses, and responses outside the SLS model (the gate decides)
    out += [
        synthetic("monotonic_ramp_81", "rejected", t81, .025 * t81 / 6, [5000., .40, .70]),
        synthetic("fast_ramp_rate_121", "rejected", lin(0, 4, 121), rhr(lin(0, 4, 121), .05, .1, 2.0), [5000., .40, .70]),
        synthetic("stiffer_than_training_81", "rejected", t81, rhr(t81, .025, .6, 3.0), [60000., .40, .70]),
        synthetic("softer_than_training_81", "rejected", t81, rhr(t81, .025, .6, 3.0), [150., .40, .70]),
        synthetic("purely_elastic_81", "rejected", t81, rhr(t81, .025, .6, 3.0), [4800., 0.0, .65]),
        synthetic("two_relaxation_times_129", "model_mismatch", lin(0, 8, 129), rhr(lin(0, 8, 129), .03, .5, 4.0), [5000., .60, 1.0], response=two_modes, note=" (two relaxation times)"),
        synthetic("strain_stiffening_81", "model_mismatch", t81, rhr(t81, .05, .6, 3.0), [3000., .40, .60], response=stiffening, note=" (strain stiffening)"),
        synthetic("slow_relaxation_short_hold_41", "rejected", lin(0, 2, 41), rhr(lin(0, 2, 41), .02, .3, .4), [5000., .50, 30.0]),
        synthetic("heavy_noise_12pct_81", "rejected", t81, rhr(t81, .025, .6, 3.0), [4800., .42, .65], noise=.12, seed=18),
    ]
    # validation: the pydantic request model, then v2's own checks (each message at least once)
    out += [
        mutated("too_few_samples_15", "invalid", lambda o: o.update({k: o[k][:15] for k in ("times_s", "force_n", "displacement_mm")})),
        mutated("too_many_samples_258", "invalid", lambda o: o.update(times_s=list(np.linspace(0, 6, 258)), force_n=[0.0] * 258, displacement_mm=[0.0] * 258)),
        mutated("mismatched_lengths", "invalid", lambda o: o.update(force_n=o["force_n"][:80])),
        mutated("zero_reference_length", "invalid", lambda o: o.update(reference_length_mm=0.0)),
        mutated("reference_length_above_1000", "invalid", lambda o: o.update(reference_length_mm=1000.5)),
        mutated("reference_area_above_1e6", "invalid", lambda o: o.update(reference_area_mm2=1e6 + 1)),
        mutated("negative_reference_area", "invalid", lambda o: o.update(reference_area_mm2=-5.0)),
        mutated("provenance_too_short", "invalid", lambda o: o.update(provenance="lab")),
        mutated("provenance_whitespace", "invalid", lambda o: o.update(provenance="   \t   \n  ")),
        mutated("provenance_padded_short", "invalid", lambda o: o.update(provenance="  bench   ")),
        mutated("provenance_four_astral", "invalid", lambda o: o.update(provenance="\U0001F52C\U0001F9EA\U0001F4CF\U0001F9EB")),
        mutated("provenance_too_long", "invalid", lambda o: o.update(provenance="x" * 2001)),
        mutated("provenance_2000_astral", "accepted_text", lambda o: o.update(provenance="\U0001F52C" * 2000)),
        mutated("extra_field", "invalid", lambda o: o.update(evidence="synthetic_demonstration_not_measurement")),
        mutated("missing_provenance", "invalid", lambda o: o.pop("provenance")),
        mutated("several_request_errors", "invalid", lambda o: o.update({**{k: o[k][:15] for k in ("times_s", "force_n")}, "reference_length_mm": 0.0, "provenance": "x", "unit": "N"})),
        mutated("wrong_types", "invalid", lambda o: o.update(times_s=[str(v) for v in o["times_s"][:3]] + o["times_s"][3:], reference_area_mm2="100", provenance=12345678)),
        mutated("null_samples", "invalid", lambda o: o["force_n"].__setitem__(5, None)),
        mutated("time_offset", "invalid", lambda o: o.update(times_s=[v + 0.01 for v in o["times_s"]])),
        mutated("non_increasing_times", "invalid", lambda o: o["times_s"].__setitem__(10, o["times_s"][9])),
        mutated("overflowing_force", "invalid", lambda o: o["force_n"].__setitem__(30, 1.7e308)),
        mutated("duration_below_1s", "invalid", lambda o: o.update(times_s=[v * .15 for v in o["times_s"]])),
        mutated("duration_above_12s", "invalid", lambda o: o.update(times_s=[v * 2.1 for v in o["times_s"]])),
        mutated("peak_strain_below_half_percent", "invalid", lambda o: o.update(displacement_mm=[v * .15 for v in o["displacement_mm"]])),
        mutated("peak_strain_above_5pct", "invalid", lambda o: o.update(displacement_mm=[v * 2.5 for v in o["displacement_mm"]])),
        mutated("initial_strain", "invalid", lambda o: o["displacement_mm"].__setitem__(0, 20 * 3e-5)),
        mutated("negative_strain", "invalid", lambda o: o["displacement_mm"].__setitem__(-1, -20 * .002)),
        mutated("nonpositive_force", "invalid", lambda o: o.update(force_n=[-abs(v) for v in o["force_n"]])),
        mutated("untared_force", "invalid", lambda o: o["force_n"].__setitem__(0, .2 * max(o["force_n"]))),
        mutated("time_gap", "invalid", lambda o: o.update(times_s=o["times_s"][:20] + o["times_s"][45:], force_n=o["force_n"][:20] + o["force_n"][45:], displacement_mm=o["displacement_mm"][:20] + o["displacement_mm"][45:])),
        mutated("reference_length_1000", "invalid", lambda o: o.update(reference_length_mm=1000.0)),
    ]
    names = [c["name"] for c in out]
    assert len(names) == len(set(names)), "fixture names must be unique"
    return [{**c, "observation": as_sent_by_browser(c["observation"])} for c in out]


# ---------------------------------------------------------------------------------------------- fixtures
class Recorder:
    """Wraps v2.least_squares to keep scipy's OptimizeResult of each refinement."""

    def __init__(self) -> None:
        self.results: list[Any] = []
        self.calls = 0
        self.original = v2.least_squares

    def __enter__(self) -> "Recorder":
        def wrapped(fun: Any, *args: Any, **kwargs: Any) -> Any:
            def counted(x: np.ndarray) -> np.ndarray:
                self.calls += 1
                return fun(x)
            result = self.original(counted, *args, **kwargs)
            self.results.append(result)
            return result
        v2.least_squares = wrapped
        return self

    def __exit__(self, *exc: Any) -> None:
        v2.least_squares = self.original


def internals(model: dict[str, Any], observation: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
    """predict_history step by step, asserted to compose to the route's response."""
    times = np.asarray(observation["times_s"], float)
    strain = np.asarray(observation["displacement_mm"], float) / observation["reference_length_mm"]
    stress = np.asarray(observation["force_n"], float) / (observation["reference_area_mm2"] * 1e-6)
    features = v2.observation_features(times, strain, stress)
    outputs = []
    for member in model["members"]:
        h = np.asarray(features, float)
        for index, layer in enumerate(member):
            h = h @ np.asarray(layer["weight"]).T + np.asarray(layer["bias"])
            h = np.maximum(h, 0) if index < len(member) - 1 else 1 / (1 + np.exp(-np.clip(h, -60, 60)))
        outputs.append(h.tolist())
    proposals = v2.neural_proposals(model, features)
    mean = proposals.mean(axis=0)
    with Recorder() as recorder:
        fit = v2.refine_parameters(times, strain, stress, mean)
    (result,) = recorder.results
    if fit["parameters_array"].tolist() != list(body["parameters"].values()) or fit["refinement_evaluations"] != body["refinement_evaluations"]:
        raise SystemExit("the step-by-step refinement differs from the route's")
    scale = max(float(np.max(abs(stress))), 1e-6)
    return {
        "features": features.tolist(), "member_outputs": outputs, "proposals": proposals.tolist(),
        "initial": np.clip(v2.encode_parameters(mean), 1e-6, 1 - 1e-6).tolist(), "scale": scale,
        "least_squares": {"x": result.x.tolist(), "cost": float(result.cost), "optimality": float(result.optimality), "nfev": int(result.nfev),
                          "njev": int(result.njev), "status": int(result.status), "message": result.message, "active_mask": result.active_mask.tolist(),
                          "function_calls": recorder.calls},
        "sigma_encoded": fit["sigma_encoded"].tolist(),
    }


# ---------------------------------------------------------------------------------------------- the API's own spread
def _variant(kind: str) -> Callable[[np.ndarray, np.ndarray, np.ndarray], np.ndarray]:
    """v2.stress_response with only its last bits changed: the convolution's sums in another order (correctly
    rounded, sequential, pairwise; Accelerate's BLAS order otherwise), or the BLAS order with a seeded 8 % of the exp
    and expm1 values one ulp up (libm and V8 differ in the last bit for about that share)."""
    def response(times: np.ndarray, strain: np.ndarray, parameters: np.ndarray) -> np.ndarray:
        t, e, p = np.asarray(times, float), np.asarray(strain, float), np.asarray(parameters, float)
        young, g, tau = p
        dt = np.diff(t)
        lag = t[:, None] - t[None, 1:]
        kernel = np.exp(-np.maximum(lag, 0) / tau) * (lag >= -1e-12)
        decay = -np.expm1(-dt / tau)
        if kind == "ulp":
            rng = np.random.default_rng(len(t))
            mask = rng.random(kernel.shape) < .08
            kernel[mask] = np.nextafter(kernel[mask], np.inf) * (lag[mask] >= -1e-12)
            mask = rng.random(decay.shape) < .08
            decay[mask] = np.nextafter(decay[mask], np.inf)
        rate = tau * decay * np.diff(e) / dt
        if kind == "fsum":
            h = np.array([math.fsum(row * rate) for row in kernel])
        elif kind == "sequential":
            h = np.array([np.cumsum(row * rate)[-1] for row in kernel])
        elif kind == "pairwise":
            h = np.sum(kernel * rate, axis=1)
        else:
            h = kernel @ rate
        return young * ((1 - g) * e + g * h)
    return response


def rounding_spread(model: dict[str, Any], observation: dict[str, Any], body: dict[str, Any], lsq_x: list[float], sigma: list[float]) -> dict[str, Any]:
    """How far the API's own answer moves under last-bit changes of its arithmetic (the browser cannot repeat
    Accelerate's dot-product order or libm's exp bit for bit): per field, the largest deviation over four variants,
    relative (absolute for x in [0, 1] and the peak-normalised RMSE; fitted stress relative to the peak stress)."""
    times = np.asarray(observation["times_s"], float)
    strain = np.asarray(observation["displacement_mm"], float) / observation["reference_length_mm"]
    stress = np.asarray(observation["force_n"], float) / (observation["reference_area_mm2"] * 1e-6)
    peak = float(np.max(np.abs(stress)))
    names = list(PARAMETER_NAMES)

    def rel(a: Any, b: Any) -> float:
        a, b = np.asarray(a, float), np.asarray(b, float)
        return float(np.max(np.abs(a - b) / np.maximum(np.abs(b), 1e-300)))

    spread = {key: 0.0 for key in ("x", "parameters", "intervals", "fitted", "stress_nrmse", "condition_number", "minimum_sensitivity", "noise_fraction_estimate", "sigma_encoded")}
    decisions = []
    original = v2.stress_response
    try:
        for kind in ("fsum", "sequential", "pairwise", "ulp"):
            v2.stress_response = _variant(kind)
            with Recorder() as recorder:
                fit = v2.refine_parameters(times, strain, stress, v2.neural_proposals(model, v2.observation_features(times, strain, stress)).mean(axis=0))
            (result,) = recorder.results
            diag = v2.diagnostics(times, strain, stress, fit)
            q = np.asarray(model["calibration"]["quantiles_90"])
            lower = v2.decode_parameters(np.clip(fit["encoded"] - q * fit["sigma_encoded"], 0, 1))
            upper = v2.decode_parameters(np.clip(fit["encoded"] + q * fit["sigma_encoded"], 0, 1))
            theirs = body["parameter_intervals_90"]
            decisions.append({"variant": kind, "nfev": int(result.nfev), "njev": int(result.njev), "status": int(result.status), "reasons": diag["reasons"]})
            for key, value in {
                "x": float(np.max(np.abs(result.x - np.asarray(lsq_x)))),
                "parameters": rel(fit["parameters_array"], [body["parameters"][n] for n in names]),
                "intervals": max(rel(lower, [theirs[n]["lower"] for n in names]), rel(upper, [theirs[n]["upper"] for n in names])),
                "fitted": float(np.max(np.abs(fit["fitted_stress_pa"] - np.asarray(body["fitted_stress_pa"])))) / peak,
                "stress_nrmse": abs(fit["stress_nrmse"] - body["stress_nrmse"]),
                "condition_number": rel(fit["condition_number"], body["diagnostics"]["condition_number"]),
                "minimum_sensitivity": rel(fit["minimum_sensitivity"], body["diagnostics"]["minimum_sensitivity"]),
                "noise_fraction_estimate": rel(fit["noise_fraction_estimate"], body["diagnostics"]["noise_fraction_estimate"]),
                "sigma_encoded": rel(fit["sigma_encoded"], sigma),
            }.items():
                spread[key] = max(spread[key], value)
    finally:
        v2.stress_response = original
    return {"fields": spread, "decisions": decisions}


def response(client: TestClient, route: str, body: dict[str, Any]) -> tuple[int, Any]:
    reply = client.post(route, json=body)
    return reply.status_code, reply.json()


def export_fixtures(model: dict[str, Any], meta: dict[str, Any]) -> None:
    client = TestClient(create_app(Path(_TMP.name) / "fixtures.sqlite"))
    generated = client.post("/api/atlas/generate", json={"template_id": PLAYGROUND_TEMPLATE})
    if generated.status_code != 200:
        raise SystemExit(f"/api/atlas/generate {PLAYGROUND_TEMPLATE}: {generated.status_code}")
    spec = generated.json()["spec"]
    status, snapshot = response(client, "/api/physics/playground", {"spec": spec, "parameter_source": "learned"})
    if status != 200:
        raise SystemExit(f"/api/physics/playground (learned, no observation): {status} {snapshot}")
    fixture_cases = []
    for case in cases():
        observation = case["observation"]
        status, body = response(client, "/api/physics/infer", observation)
        record: dict[str, Any] = {**case, "infer": {"status": status, "body": body} if status == 200 else {"status": status, "detail": body["detail"]}}
        pg_status, playground = response(client, "/api/physics/playground", {"spec": spec, "parameter_source": "learned", "observation": observation})
        if pg_status == 200:
            if status != 200:
                raise SystemExit(f"{case['name']}: the playground accepted what /infer refused")
            dumped = json.loads(json.dumps(api.ObservationRequest(**observation).model_dump()))
            expected = {**body, "source": "learned", "predicted_parameters": body["parameters"], "observation": dumped,
                        "observation_origin": "user_supplied_calibration_unverified", "human_liver_validated": False}
            if playground["learning"] != expected or list(playground["learning"]) != list(expected):
                raise SystemExit(f"{case['name']}: the playground's learning is not the inference plus provenance")
            for key in playground:
                if key not in ("parameters", "learning") and playground[key] != snapshot[key]:
                    raise SystemExit(f"{case['name']}: the playground's {key} depends on the observation")
            record["playground"] = {"status": 200, "parameters": playground["parameters"], "learning_keys": list(playground["learning"])}
        else:
            record["playground"] = {"status": pg_status, "detail": playground["detail"]}
        if status == 200:
            record["internals"] = internals(model, observation, body)
            record["api_rounding_spread"] = rounding_spread(model, observation, body, record["internals"]["least_squares"]["x"], record["internals"]["sigma_encoded"])
        fixture_cases.append(record)
        outcome = (f"accepted, {body['refinement_evaluations']} evaluations" if body["accepted_for_application"] else f"review: {', '.join(body['rejection_reasons'])}") if status == 200 else f"{status}: {body['detail'] if isinstance(body['detail'], str) else '; '.join(e['msg'] for e in body['detail'])}"
        print(f"  {case['name']:34s} {outcome[:150]}")
    reduced = copy.deepcopy(snapshot)
    for key in ("reference_positions_mm", "tets", "surface_indices"):
        reduced["mesh"][key] = reduced["mesh"][key][:24]
    reduced["mesh"]["embedding"] = {k: v[:8] for k, v in reduced["mesh"]["embedding"].items()}
    fixture = {
        "model_sha256": meta["model_sha256"], "numpy": np.__version__, "scipy": scipy.__version__,
        "system": platform.system(), "machine": platform.machine(),
        "playground_template": PLAYGROUND_TEMPLATE, "playground_snapshot": reduced,
        "trf": export_trf_fixtures(), "numpy_sums": export_sum_fixtures(), "cases": fixture_cases,
    }
    FIXTURES.parent.mkdir(parents=True, exist_ok=True)
    FIXTURES.write_text(json.dumps(fixture, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    counts = {}
    for c in fixture_cases:
        key = "invalid" if c["infer"]["status"] != 200 else ("accepted" if c["infer"]["body"]["accepted_for_application"] else "review")
        counts[key] = counts.get(key, 0) + 1
    print(f"fixtures: {len(fixture_cases)} observations {counts}, {len(fixture['trf'])} TRF problems → {relative(FIXTURES)} ({FIXTURES.stat().st_size} B)")


# small bounded robust-loss problems for the TRF extension; the TypeScript test defines the same residuals by name
FIT_T = np.arange(10, dtype=np.float64)
FIT_Y_OUTLIERS = np.array([2.0, 1.3, 0.95, 1.52, 0.5, 0.41, 0.27, -0.3, 0.13, 0.1])
QUADRATIC_A = np.array([[3.0, 1.0, 0.0], [1.0, 2.0, 0.5], [0.0, 0.5, 1.0], [0.3, 0.3, 0.3]])
QUADRATIC_B = np.array([4.0, -3.0, 2.0, 1.0])


def rosenbrock(x: np.ndarray) -> np.ndarray:
    return np.array([10 * (x[1] - x[0] ** 2), 1 - x[0]])


def exponential_fit_outliers(x: np.ndarray) -> np.ndarray:
    return x[0] * np.exp(-x[1] * FIT_T) + x[2] - FIT_Y_OUTLIERS


def bounded_quadratic(x: np.ndarray) -> np.ndarray:
    return QUADRATIC_A @ x - QUADRATIC_B


TRF_PROBLEMS = [
    ("rosenbrock", rosenbrock, [-1.2, 1.0], (-1.5, 1.5)),
    ("exponential_fit_outliers", exponential_fit_outliers, [1.0, 0.1, 0.0], (-1.0, 3.0)),
    ("bounded_quadratic", bounded_quadratic, [0.9, -0.9, 0.9], (-1.0, 1.0)),
]


def trf_spread(fun: Callable[[np.ndarray], np.ndarray], x0: list[float], options: dict[str, Any], reference: Any) -> dict[str, Any]:
    """scipy's own reproducibility on a problem, under the two kinds of last-bit difference a browser has: eight runs
    whose residuals carry seeded one-ulp noise (libm and BLAS order), and one whose trust-region SVD is LAPACK's
    gesvd instead of gesdd (an equally accurate SVD rounded differently). decisions_stable says whether every run
    takes the reference's status, nfev and njev; x is the largest deviation, relative to max(1, |x|)."""
    from scipy.linalg import svd
    from scipy.optimize._lsq import trf as trf_module

    stable, spread = True, 0.0

    def compare(result: Any) -> None:
        nonlocal stable, spread
        stable &= (int(result.status), int(result.nfev), int(result.njev)) == (int(reference.status), int(reference.nfev), int(reference.njev))
        spread = max(spread, float(np.max(np.abs(result.x - reference.x) / np.maximum(1, np.abs(reference.x)))))

    for seed in range(8):
        rng = np.random.default_rng(seed)

        def noisy(x: np.ndarray) -> np.ndarray:
            f = np.asarray(fun(x), dtype=np.float64)
            direction = np.where(rng.random(f.shape) < 0.5, -np.inf, np.inf)
            return np.where(rng.random(f.shape) < 0.5, np.nextafter(f, direction), f)

        compare(least_squares(noisy, np.asarray(x0, dtype=np.float64), **options))
    original = trf_module.svd
    trf_module.svd = lambda a, full_matrices=True: svd(a, full_matrices=full_matrices, lapack_driver="gesvd")
    try:
        compare(least_squares(fun, np.asarray(x0, dtype=np.float64), **options))
    finally:
        trf_module.svd = original
    return {"decisions_stable": bool(stable), "x": spread}


def export_trf_fixtures() -> list[dict[str, Any]]:
    problems = []
    for name, fun, x0, bounds in TRF_PROBLEMS:
        for loss in ("linear", "soft_l1", "huber", "cauchy", "arctan"):
            for f_scale in ((1.0,) if loss == "linear" else (0.1, 1.0)):
                calls = 0

                def counted(x: np.ndarray) -> np.ndarray:
                    nonlocal calls
                    calls += 1
                    return fun(x)

                options = dict(bounds=bounds, loss=loss, f_scale=f_scale, max_nfev=60, ftol=1e-9, xtol=1e-9, gtol=1e-9)
                result = least_squares(counted, np.asarray(x0, dtype=np.float64), **options)
                problems.append({
                    "problem": name, "loss": loss, "f_scale": f_scale, "x0": x0, "bounds": list(bounds), "x": result.x.tolist(),
                    "cost": float(result.cost), "fun": result.fun.tolist(), "optimality": float(result.optimality), "nfev": int(result.nfev),
                    "njev": int(result.njev), "status": int(result.status), "message": result.message, "function_calls": calls,
                    "active_mask": result.active_mask.tolist(), "scipy_rounding_spread": trf_spread(fun, x0, options, result),
                })
    return problems


def export_sum_fixtures() -> list[dict[str, Any]]:
    """np.sum of float64 vectors across numpy's pairwise-summation block boundaries (8, 128), wide dynamic range."""
    rng = np.random.default_rng(2718)
    sums = []
    for n in (1, 7, 8, 9, 15, 16, 17, 64, 127, 128, 129, 130, 136, 255, 256, 257, 300):
        values = rng.normal(size=n) * 10.0 ** rng.uniform(-6, 6, n)
        sums.append({"values": values.tolist(), "sum": float(np.sum(values))})
    return sums


if __name__ == "__main__":
    export_fixtures(*export_model())
