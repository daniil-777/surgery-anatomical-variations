"""Export the disease recipe model the API serves (the conditional VAE decoder) for the browser sampler, with fixtures
that pin it to this sampler.

    .venv/bin/python scripts/export_disease_web.py

Writes apps/studio/public/models/disease-recipes-v2/model.json (architecture, the profile vocabulary with each profile's
organ, array layout, provenance: the sha256 of model.npz, the active bundle, the recipe release the API binds it to)
and weights.bin (the float32 arrays, little-endian, in the order model.json lists: the profile embedding, the three
decoder layers, and each profile's training support bounds — the min and max over its training recipes, which clip
the proposals, so the 2400 training rows need not travel), and apps/studio/src/__fixtures__/disease-recipes-v2.json: for
every profile at several seeds, numpy's normal draws, the decoder output before and after the count snap and the
support clip, the spatial seed, and the recipe and provenance record the API route returns (services.api
.atlas_disease_model.sample_recipe_model, release verification included) — at fixed seeds and at the seeds a scan
finds where the clip fires or the count lands near a half-way point — and the route's refusal texts;
atlasDiseaseSampler.test.ts replays them. The model is resolve_model(ROOT, "disease")
— the active imported bundle's, else the repository artifact — exactly as the route reads it. Nothing is retrained.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "py"), str(ROOT)]

from pipelines.train.viscera_train import atlas_disease as trainer  # noqa: E402
from services.api.atlas_disease_model import sample_recipe_model  # noqa: E402
from services.api.atlas_model_registry import _active, resolve_model  # noqa: E402
from viscera_core import atlas_disease as renderer  # noqa: E402
from viscera_core import atlas_disease_recipe_dataset as recipes  # noqa: E402

OUT = ROOT / "apps/studio/public/models/disease-recipes-v2"
FIXTURES = ROOT / "apps/studio/src/__fixtures__/disease-recipes-v2.json"
DATA = Path(os.environ.get("VISCERA_DISEASE_DATASET", ROOT / "disease-releases/recipes-v2"))
FORMAT = "viscera-disease-recipe-model-v1-web"
PARAMETERS = ("embedding.weight", "decoder.0.weight", "decoder.0.bias", "decoder.2.weight", "decoder.2.bias", "decoder.4.weight", "decoder.4.bias")
TRACE_SEEDS = (0, 7, 42, 2**32 - 1)
# the branches a browser rounding one ulp apart could take differently are found by scanning this many seeds per
# profile: the first whose proposal the support clips, and the one whose count column lies nearest a half-way point
EDGE_SCAN = 3000
HALF_WAY_WITHIN = 2e-4


def support_bounds(model: dict) -> tuple[np.ndarray, np.ndarray]:
    """Each profile's training support as sample_recipes clips to it: x.min(0) and x.max(0) over its recipes."""
    rows = [trainer._recipe_arrays(model, profile) for profile in model["profiles"]]
    return np.stack([r.min(0) for r in rows]), np.stack([r.max(0) for r in rows])


def export_model() -> tuple[Path, dict, dict]:
    state, _ = _active(ROOT)
    path = resolve_model(ROOT, "disease")
    model = trainer.load_recipe_model(path)
    if model["selected_method"] != "conditional_vae":
        raise SystemExit("the browser port is the VAE decoder; this model selected " + model["selected_method"])
    low, high = support_bounds(model)
    named = [(name, model["arrays"][name]) for name in PARAMETERS] + [("support.min", low), ("support.max", high)]
    layout, chunks, offset = [], [], 0
    for name, array in named:
        a = np.ascontiguousarray(array, dtype=np.float32)
        layout.append({"name": name, "shape": list(a.shape), "offset": offset})
        offset += a.size
        chunks.append(a.ravel())
    weights = np.concatenate(chunks).astype("<f4")
    meta = {
        "format": FORMAT,
        "method": model["selected_method"],
        "model_sha256": model["artifact_sha256"],
        "bundle_sha256": state["active_bundle"],
        "recipe_release_sha256": recipes.digest(DATA / "release.json"),
        "source_sha256": model["source_sha256"],
        "catalog_sha256": model["catalog_sha256"],
        "profile_sha256": recipes.digest(renderer.PROFILE_PATH),
        "dataset_hashes": model["dataset_hashes"],
        "config": {k: model["config"][k] for k in ("latent", "hidden", "embedding")},
        "feature_names": model["feature_names"],
        "profiles": model["profiles"],
        "profile_organs": model["profile_organs"],
        "scope": model["scope"],
        "patient_count": model["patient_count"],
        "training_recipe_count": model["training_recipe_count"],
        "requires_geometry_validation": model["requires_geometry_validation"],
        "environment": model["environment"],
        "arrays": layout,
        "float32_values": int(weights.size),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "model.json").write_text(json.dumps(meta, separators=(",", ":")) + "\n")
    (OUT / "weights.bin").write_bytes(weights.tobytes())
    print(f"model.json ({(OUT / 'model.json').stat().st_size} B), weights.bin ({weights.nbytes} B, {weights.size} float32)")
    return path, model, meta


def route(path: Path, profile_id: str, seed: int) -> dict:
    """The API's own proposal (verification and the legacy DiseaseSpec included), JSON-shaped."""
    answer = sample_recipe_model(path, DATA, profile_id, seed)
    return {**answer, "disease": {**answer["disease"], "location": list(answer["disease"]["location"])}}


def edge_seeds(model: dict, profile_id: str) -> list[tuple[int, str]]:
    """The seeds below EDGE_SCAN that exercise the clip and the count's rounding, tagged."""
    index = model["profiles"].index(profile_id)
    support = trainer._recipe_arrays(model, profile_id)
    z = np.stack([np.random.default_rng(seed).normal(size=(model["config"]["latent"],)) for seed in range(EDGE_SCAN)])
    decoded = trainer.decode_latents(model, np.full(EDGE_SCAN, index, dtype=np.int64), z)
    snapped = trainer._snap_count(decoded)
    clipped = (np.clip(snapped, support.min(0), support.max(0)) != snapped).any(1)
    sevenths = decoded[:, 5] * 7  # what np.rint sees before the snap
    half_way = np.abs(sevenths - np.floor(sevenths) - 0.5)
    found = [(int(np.argmax(clipped)), "clip")] if clipped.any() else []
    nearest = int(np.argmin(half_way))
    return found + ([(nearest, "count_half_way")] if half_way[nearest] < HALF_WAY_WITHIN else [])


def trace(path: Path, model: dict, profile_id: str, seed: int, edge: str | None = None) -> dict:
    """sample_recipes stage by stage — the draws and every float32 array — next to the route's answer."""
    index = model["profiles"].index(profile_id)
    rng = np.random.default_rng(seed)
    z = rng.normal(size=(1, model["config"]["latent"]))
    decoded = trainer.decode_latents(model, np.asarray([index], dtype=np.int64), z)
    snapped = trainer._snap_count(decoded)
    support = trainer._recipe_arrays(model, profile_id)
    clipped = np.clip(snapped, support.min(0), support.max(0))
    values = trainer._snap_count(clipped)
    spatial_seed = int(rng.integers(0, 2**32, size=1, dtype=np.uint64)[0])
    answer = route(path, profile_id, seed)
    expected = recipes.decode_recipe(profile_id, values[0], spatial_seed)
    if answer["disease"] != expected:
        raise SystemExit(f"the trace diverges from the route for {profile_id} seed {seed}")
    return {
        "profile_id": profile_id, "seed": seed, "condition": index, **({"edge": edge} if edge else {}),
        "z": z[0].tolist(), "decoded": decoded[0].tolist(), "values": values[0].tolist(),
        "clipped": (clipped[0] != snapped[0]).tolist(), "spatial_seed": spatial_seed,
        "disease": answer["disease"], "model": answer["model"],
    }


def refusal(call) -> str:
    try:
        call()
    except ValueError as error:
        return str(error)
    raise SystemExit("expected a refusal")


def export_fixtures(path: Path, model: dict, meta: dict) -> None:
    cases = [trace(path, model, profile, seed) for profile in model["profiles"] for seed in TRACE_SEEDS]
    cases += [trace(path, model, profile, seed, edge) for profile in model["profiles"] for seed, edge in edge_seeds(model, profile) if seed not in TRACE_SEEDS]
    refusals = {
        "unsupported_profile": refusal(lambda: trainer.sample_recipes(model, "liver-capsular-cyst", 42)),
        "seed": refusal(lambda: trainer.sample_recipes(model, model["profiles"][0], 2**32)),
    }
    fixture = {"model_sha256": meta["model_sha256"], "numpy_version": np.__version__, "refusals": refusals}
    lines = [f'"{key}":{json.dumps(value, separators=(",", ":"))}' for key, value in fixture.items()]
    lines.append('"cases":[\n' + ",\n".join(json.dumps(c, separators=(",", ":")) for c in cases) + "\n]")
    FIXTURES.parent.mkdir(parents=True, exist_ok=True)
    FIXTURES.write_text("{\n" + ",\n".join(lines) + "\n}\n")
    clipped, half_way = sum(any(c["clipped"]) for c in cases), sum(c.get("edge") == "count_half_way" for c in cases)
    print(f"fixtures: {len(cases)} traced cases over {len(model['profiles'])} profiles ({clipped} clipped to the support, {half_way} counts near a half-way point) → {FIXTURES.relative_to(ROOT)} ({FIXTURES.stat().st_size} B)")


if __name__ == "__main__":
    export_fixtures(*export_model())
