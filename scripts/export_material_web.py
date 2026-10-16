"""Export the trained material sampler behind POST /api/atlas/sample-material for the browser, with fixtures that
pin the port.

    PYTHONPATH=py:. .venv/bin/python scripts/export_material_web.py

The model is the one the API serves: services.api.atlas_model_registry.resolve_model(ROOT, "material") -- the
active imported bundle's material/model.npz, else VISCERA_ATLAS_MATERIAL_MODEL, else
artifacts/atlas/material-run-v1/model.npz -- loaded with the serving checks (services.api.atlas_material_compat).
Its selected method is ridge, so sampling reads no neural weights: the organ/preset group vocabulary, the training
rows (group, normalised controls, measured field conditions), the condition normalisation, the ridge coefficients
and the ridge leave-one-out residuals are the whole model. At request time the route also reads the release's fixed
rest-space anchor points (surface_anchors.npz) with the anchor templates' identities (dataset_card.json), and each
template's organ (the cohort-v2 library), so those go along.

Writes apps/studio/public/models/material-v1/model.json (metadata, vocabulary, array layout, provenance of both the
served and the packaged default model) and weights.bin (little-endian float64 arrays, then the uint8 group of each
training row, in the order model.json lists), and apps/studio/src/__fixtures__/material-v1.json: proposals of
pipelines.train.viscera_train.atlas_material.sample_recipe for every organ/preset group x several seeds x without
and with requested field statistics, each with numpy's raw draws, the intermediate values the browser recomputes
(the group's target statistics, the ridge mean, the drawn training rows), the recipe, the field statistics the
route measures at its anchor template, and refusals; plus material fields at sample points (anchors, ligament
vertices, nonzero footprints) with their uniforms. atlasMaterialSampler.test.ts replays all of it.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "py"), str(ROOT)]

from viscera_core import atlas_material_dataset as dataset  # noqa: E402
from viscera_core import atlas_materials as materials  # noqa: E402
from viscera_core.atlas import list_templates  # noqa: E402
from viscera_core.atlas_scene import get_template  # noqa: E402
from viscera_core.atlas_surface_scene import material_regions  # noqa: E402

from pipelines.train.viscera_train import atlas_material as prior  # noqa: E402
from services.api.atlas import template_root  # noqa: E402
from services.api.atlas_material_compat import load_model, verify_material_release  # noqa: E402
from services.api.atlas_model_registry import DEFAULTS, _active, digest, resolve_model  # noqa: E402

OUT = ROOT / "apps/studio/public/models/material-v1"
FIXTURES = ROOT / "apps/studio/src/__fixtures__/material-v1.json"
FORMAT = "viscera-material-prior-v1-web"
DATA = Path(os.environ.get("VISCERA_ATLAS_MATERIAL_DATASET", ROOT / "datasets/atlas/material-v1"))
SEEDS = (0, 42, 2**32 - 1)
# sample_recipe's bounded proposal loop
ATTEMPTS = 10000


def relative(path: Path) -> str:
    return str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path)


def model_source(path: Path) -> tuple[str, str | None]:
    _, directory = _active(ROOT)
    if directory is not None and path.is_relative_to(directory):
        return f"active bundle {directory.name}", directory.name
    return relative(path), None


def anchor_table() -> tuple[list[str], np.ndarray, dict[str, Any]]:
    anchors = prior.load_anchors(DATA)
    sources = json.loads((DATA / "dataset_card.json").read_text())["source_templates"]
    ids = list(anchors)
    points = np.stack([anchors[tid] for tid in ids])
    return ids, points, sources


def export_model() -> tuple[dict[str, Any], dict[str, Any], Path]:
    model_path = resolve_model(ROOT, "material")
    model = load_model(model_path)
    if str(model["selected"]) != "ridge":
        raise SystemExit(f"the browser port covers the ridge sampler; the served model selected {model['selected']}")
    release = verify_material_release(DATA)
    release_sha256 = digest(DATA / "release.json")
    identity = model["metadata"]["identity"]
    if identity["dataset_release_sha256"] != release_sha256:
        raise SystemExit("the served material model was trained on another release than the installed one")
    if list(model["metadata"]["controls"]) != list(dataset.CONTROL_NAMES) or list(model["metadata"]["conditions"]) != list(dataset.CONDITION_NAMES):
        raise SystemExit("the model's control or condition contract differs from viscera_core")
    groups = [str(g) for g in model["group_names"]]
    lookup = {g: i for i, g in enumerate(groups)}
    if len(groups) > 255:
        raise SystemExit("more organ/preset groups than one byte indexes")
    anchor_ids, anchor_points, sources = anchor_table()
    library = template_root()
    templates = [{"id": m["template_id"], "organ": get_template(library, m["template_id"]).metadata["organ"]} for m in list_templates(library)]
    f8 = {
        "condition_mean": model["condition_mean"],
        "condition_scale": model["condition_scale"],
        "ridge_coef": model["ridge_coef"],
        "train_controls": model["train_controls"],
        "train_conditions": model["train_conditions"],
        "ridge_residuals": model["ridge_residuals"],
        "anchor_points": anchor_points,
    }
    chunks, layout, offset = [], [], 0
    for name, array in f8.items():
        data = np.ascontiguousarray(array, dtype="<f8")
        layout.append({"name": name, "dtype": "<f8", "shape": list(data.shape), "offset": offset})
        chunks.append(data.tobytes())
        offset += data.nbytes
    train_group = np.asarray([lookup[str(g)] for g in model["train_groups"]], dtype=np.uint8)
    layout.append({"name": "train_group", "dtype": "u1", "shape": list(train_group.shape), "offset": offset})
    chunks.append(train_group.tobytes())
    offset += train_group.nbytes
    default_path = Path(os.environ.get(DEFAULTS["material"][0], ROOT / DEFAULTS["material"][1]))
    default = None
    if default_path.is_file():
        default_meta = json.loads(default_path.with_suffix(".json").read_text())
        default = {"path": relative(default_path), "sha256": digest(default_path), "selected": default_meta["selected"],
                   "dataset_release_sha256": default_meta["identity"]["dataset_release_sha256"]}
    source, bundle = model_source(model_path)
    meta = {
        "format": FORMAT,
        "method": "ridge",
        "model_sha256": model["metadata"]["model_sha256"],
        "model_source": source,
        "bundle_sha256": bundle,
        "default_model": default,
        "trainer_source_sha256": identity["source_sha256"],
        "dataset_code_hashes": identity["dataset_code_hashes"],
        "dataset": {"root": relative(DATA), "release_sha256": release_sha256, "release_id": release["release_id"]},
        "scope": model["metadata"]["scope"],
        "control_names": list(dataset.CONTROL_NAMES),
        "condition_names": list(dataset.CONDITION_NAMES),
        "groups": groups,
        "templates": templates,
        "anchors": [{"id": tid, "organ": sources[tid]["organ"], "artifact_sha256": sources[tid]["artifact_sha256"]} for tid in anchor_ids],
        "anchor_points": int(anchor_points.shape[1]),
        "training_rows": int(len(train_group)),
        "attempts": ATTEMPTS,
        "arrays": layout,
        "byte_length": offset,
    }
    if digest(model_path) != meta["model_sha256"]:
        raise SystemExit("the served model's archive differs from its metadata")
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "model.json").write_text(json.dumps(meta, separators=(",", ":")) + "\n")
    (OUT / "weights.bin").write_bytes(b"".join(chunks))
    print(f"{source} ({meta['model_sha256'][:12]}…; packaged default {default['sha256'][:12] + '…' if default else 'absent'}): "
          f"model.json ({(OUT / 'model.json').stat().st_size} B), weights.bin ({offset} B)")
    return model, meta, model_path


# ---------------------------------------------------------------------------------------------- fixtures
def replay(model: dict[str, Any], organ: str, preset: str, seed: int, conditions: dict[str, float] | None) -> dict[str, Any]:
    """sample_recipe's draws, recorded: numpy's generator, the group rows each draw picks, and for requested
    statistics the target and the ridge mean -- composed here exactly as sample_recipe composes them."""
    group = f"{organ}|{preset}"
    ids = np.flatnonzero(model["train_groups"] == group)
    rng = np.random.default_rng(seed)
    record: dict[str, Any] = {}
    if conditions:
        target = model["train_conditions"][ids].mean(axis=0)
        for name, value in conditions.items():
            target[dataset.CONDITION_NAMES.index(name)] = value
        data = {"organ_names": np.asarray([organ]), "presets": np.asarray([preset]), "conditions": target[None, :]}
        mean = prior.predict(model, data)[0]
        draws = []
        for _ in range(ATTEMPTS):
            draws.append(int(rng.integers(0, len(ids))))   # Generator.choice(ids) is ids[integers(0, len(ids))]
            controls = mean + model["ridge_residuals"][ids[draws[-1]]]
            if (np.abs(controls) <= 1).all():
                break
        record.update(target=target.tolist(), mean=mean.tolist())
    else:
        draws = [int(rng.integers(0, len(ids)))]
        controls = model["train_controls"][ids[draws[0]]].copy()
    record.update(draws=draws, rows=[int(ids[d]) for d in draws], controls=controls.tolist())
    return record


def sample_case(model: dict[str, Any], anchors: dict[str, np.ndarray], sources: dict[str, Any], organ: str, preset: str, seed: int, conditions: dict[str, float] | None) -> dict[str, Any]:
    case: dict[str, Any] = {"organ": organ, "preset": preset, "seed": seed, "conditions": conditions}
    try:
        proposal = prior.sample_recipe(model, organ, preset, seed, conditions)
    except ValueError as error:
        case["error"] = str(error)
        return case
    record = replay(model, organ, preset, seed, conditions)
    assert record["controls"] == proposal["normalized_controls"], "the recorded draws do not reproduce the proposal"
    recipe = materials.MaterialRecipe.model_validate(proposal["recipe"])
    keys = [key for key in anchors if sources.get(key, {}).get("organ") == organ]
    key = sorted(keys)[0]
    measured_controls = dataset.recipe_controls(recipe)
    measured, _ = dataset.evaluate_controls(organ, recipe.preset, recipe.seed, measured_controls, anchors[key])
    case.update({k: v for k, v in record.items() if k != "controls"})
    # stored once for the file: the request's own statistics and the model's release
    assert proposal.pop("requested_conditions") == (conditions or {})
    assert proposal.pop("dataset_release_sha256") == model["metadata"]["identity"]["dataset_release_sha256"]
    case.update(proposal=proposal, anchor_template=key, measured_controls=measured_controls.tolist(), measured=measured.tolist())
    return case


def field_case(recipe: Any, points: np.ndarray, regions: np.ndarray, footprint: np.ndarray) -> dict[str, Any]:
    sample = materials.sample_material(recipe, points, region_ids=regions, footprint_mm=footprint)
    return {
        "recipe": recipe.model_dump(), "points": points.reshape(-1).tolist(), "regions": regions.tolist(), "footprint": footprint.tolist(),
        "rgb_linear": sample.rgb_linear.reshape(-1).tolist(), "rgb_srgb": sample.rgb_srgb.reshape(-1).tolist(), "roughness": sample.roughness.tolist(),
        "height_mm": sample.height_mm.tolist(), "gradient": sample.height_gradient_drest_mm.reshape(-1).tolist(), "uniforms": sample.metadata["uniforms"],
    }


def export_fixtures(model: dict[str, Any], meta: dict[str, Any]) -> None:
    anchors = prior.load_anchors(DATA)
    sources = json.loads((DATA / "dataset_card.json").read_text())["source_templates"]
    cases, fields = [], []
    for group in meta["groups"]:
        organ, preset = group.split("|")
        ids = np.flatnonzero(model["train_groups"] == group)
        median = dict(zip(dataset.CONDITION_NAMES, np.median(model["train_conditions"][ids], axis=0).tolist(), strict=True))
        requests: list[dict[str, float] | None] = [
            None,
            {"roughness_mean": median["roughness_mean"]},
            {"mean_red_linear": median["mean_red_linear"], "height_rms_mm": median["height_rms_mm"], "gradient_rms": median["gradient_rms"]},
        ]
        for seed in SEEDS:
            for conditions in requests:
                cases.append(sample_case(model, anchors, sources, organ, preset, seed, conditions))
    # refusals: beyond the observed support, an unknown statistic, a seed beyond uint32, an unknown group (a
    # non-finite statistic cannot travel in JSON; the browser test refuses it on its own)
    lo = float(model["train_conditions"][np.flatnonzero(model["train_groups"] == "liver|balanced"), 4].min())
    for organ, preset, seed, conditions in (
        ("liver", "balanced", 42, {"roughness_mean": lo - 1e-6}),
        ("liver", "balanced", 42, {"roughness_mean": 5.0}),
        ("kidney", "rich", 7, {"mean_red_linear": 0.2, "colour": 0.1}),
        ("liver", "balanced", 2**32, None),
        ("liver", "invented", 1, None),
    ):
        cases.append(sample_case(model, anchors, sources, organ, preset, seed, conditions))
    # material fields at sample points: one sampled recipe per organ, anchor points, ligament vertices, footprints
    library = template_root()
    presets = list(materials.PRESETS)
    for index, organ in enumerate(sorted(materials.PROFILES)):
        preset = presets[index % len(presets)]
        case = next(c for c in cases if "error" not in c and (c["organ"], c["preset"], c["seed"], c["conditions"]) == (organ, preset, 42, None))
        recipe = materials.MaterialRecipe.model_validate(case["proposal"]["recipe"])
        points = anchors[case["anchor_template"]][:20]
        regions = np.zeros(len(points))
        for meta_t in list_templates(library):
            if meta_t["organ"] != organ:
                continue
            template = get_template(library, meta_t["template_id"])
            ligament = np.flatnonzero(material_regions(template) == 1)
            if len(ligament):
                points = np.concatenate([points, template.vertices_mm[ligament[:: max(1, len(ligament) // 6)][:6]]])
                regions = np.concatenate([regions, np.ones(len(points) - len(regions))])
                break
        footprint = np.resize([0.0, 0.05, 0.3, 0.9, 2.5, 12.0], len(points)) if index % 2 else np.zeros(len(points))
        fields.append(field_case(recipe, points, regions, footprint))
    fixture = {
        "model_sha256": meta["model_sha256"], "numpy": np.__version__, "python": sys.version.split()[0],
        "condition_names": list(dataset.CONDITION_NAMES), "dataset_release_sha256": meta["dataset"]["release_sha256"],
        "note": "each proposal's requested_conditions are the case's conditions (or {}) and its dataset_release_sha256 the file's",
        "cases": cases, "fields": fields,
    }
    FIXTURES.parent.mkdir(parents=True, exist_ok=True)
    FIXTURES.write_text(json.dumps(fixture, separators=(",", ":"), allow_nan=False) + "\n")
    errors = sum("error" in c for c in cases)
    print(f"fixtures: {len(cases)} proposals ({errors} refusals), {len(fields)} field cases → {relative(FIXTURES)} ({FIXTURES.stat().st_size} B)")


if __name__ == "__main__":
    model, meta, _ = export_model()
    export_fixtures(model, meta)
