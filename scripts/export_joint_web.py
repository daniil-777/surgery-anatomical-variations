"""Export the active joint flow (generation 2) for the browser sampler, with fixtures that pin it to this sampler.

    .venv/bin/python scripts/export_joint_web.py

Writes apps/studio/public/models/joint-v2/model.json (the slim metadata: architecture, vocabularies, conditions,
array layout, provenance) and weights.bin (every float32 array, little-endian, in the order model.json lists), and
apps/studio/src/__fixtures__/joint-v2.json: numpy's PCG64 draws for several seeds and complete samples (the uniform
draws, the inverse-flow output, the decoded controls and material recipe) that atlasJointLocal.test.ts replays.
The browser runs the same NumPy arithmetic (viscera_core.atlas_joint_v2) in TypeScript; nothing is retrained.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "py"), str(ROOT)]

from services.api import atlas_joint_model_v2 as route  # noqa: E402
from viscera_core import atlas_joint_v2 as joint  # noqa: E402

OUT = ROOT / "apps/studio/public/models/joint-v2"
FIXTURES = ROOT / "apps/studio/src/__fixtures__/joint-v2.json"


def export_model() -> tuple[dict, dict]:
    state, directory = route._active(ROOT)
    if directory is None:
        raise SystemExit("no active joint v2 bundle")
    model = route._model(directory)
    arrays = model["arrays"]
    names = [name for name in joint.parameter_shapes(model).keys() if name != "masks"]
    layout, offset = [], 0
    chunks = []
    for name in names:
        a = np.ascontiguousarray(arrays[name], dtype=np.float32)
        layout.append({"name": name, "shape": list(a.shape), "offset": offset})
        offset += a.size
        chunks.append(a.ravel())
    weights = np.concatenate(chunks).astype("<f4")
    config = {k: model["config"][k] for k in ("layers", "bins", "blocks", "hidden", "embedding", "context_gain")}
    meta = {
        "format": "viscera-joint-flow-v2-web",
        "method": joint.METHOD,
        "model_sha256": model["artifact_sha256"],
        "bundle_sha256": state["active_bundle"],
        "config": config,
        "templates": model["templates"],
        "profiles": model["profiles"],
        "organs": model["organs"],
        "conditions": [{k: c[k] for k in ("template_id", "profile_id", "organ", "material_preset")} for c in model["conditions"]],
        "masks": arrays["masks"].astype(int).tolist(),
        "training_samples": model["training_samples"],
        "scope": joint.SCOPE,
        "severity_names": list(joint.SEVERITY_NAMES),
        "arrays": layout,
        "float32_values": int(weights.size),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "model.json").write_text(json.dumps(meta, separators=(",", ":")) + "\n")
    (OUT / "weights.bin").write_bytes(weights.tobytes())
    print(f"model.json ({(OUT / 'model.json').stat().st_size} B), weights.bin ({weights.nbytes} B, {weights.size} float32)")
    return model, meta


def export_fixtures(model: dict, meta: dict) -> None:
    rng_cases = []
    for seed in (0, 1, 7, 42, 1729, 10007, 123456789, 2**32 - 1):
        raw = np.random.default_rng(seed).bit_generator.random_raw(3)
        fresh = np.random.default_rng(seed)
        pair = fresh.integers(0, 2**32, 2, dtype=np.uint32)
        sid = int(fresh.integers(1, 4))
        doubles = np.random.default_rng(seed).random(4)
        rng_cases.append({"seed": seed, "raw_uint64": [str(int(v)) for v in raw], "uint32_pair": [int(v) for v in pair],
                          "lemire_1_4_after_pair": sid, "doubles": [float(v) for v in doubles]})
    keys = [joint.condition_key(c) for c in model["conditions"]]
    baseline = [k for k in keys if k[1] == "baseline"]
    samples = []
    cases = [(baseline[i % len(baseline)][0], seed, temperature) for i, (seed, temperature) in enumerate(
        [(42, 1.0), (7, 0.8), (1729, 1.5), (0, 0.1), (10007, 1.0), (3, 1.2), (99, 0.5), (2**32 - 1, 1.0), (5, 1.0), (12345, 0.9)])]
    cases += [("hra-liver-female", s, 1.0) for s in (1, 2, 8)] + [("hra-liver-male", 42, 0.7)]
    for template_id, seed, temperature in cases:
        if (template_id, "baseline") not in keys:
            continue
        index = keys.index((template_id, "baseline"))
        rng = np.random.default_rng(seed)
        seeds = rng.integers(0, 2**32, 2, dtype=np.uint32)
        z = rng.uniform(-1 + 1e-6, 1 - 1e-6, (1, 22)).astype(np.float32)
        warped = np.tanh(np.arctanh(z) * temperature)
        values, _ = joint.flow_transform(model, warped, np.asarray([index]), np.asarray([0]), joint.spatial_features(seeds)[None], inverse=True)
        sampled = joint.sample_joint(model, template_id, None, seed, temperature=temperature)
        samples.append({
            "template_id": template_id, "seed": seed, "temperature": temperature, "condition": index,
            "renderer_seeds": [int(v) for v in seeds],
            "z": [float(v) for v in z[0]], "warped": [float(v) for v in warped[0]],
            "flow_values": [float(v) for v in values[0]],
            "controls": sampled["controls"], "material": sampled["material"], "model": sampled["model"],
        })
    FIXTURES.parent.mkdir(parents=True, exist_ok=True)
    FIXTURES.write_text(json.dumps({"model_sha256": meta["model_sha256"], "rng": rng_cases, "samples": samples}, indent=0) + "\n")
    print(f"fixtures: {len(rng_cases)} rng seeds, {len(samples)} samples → {FIXTURES.relative_to(ROOT)}")


if __name__ == "__main__":
    export_fixtures(*export_model())
