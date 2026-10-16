"""Disease designs must change the surface, preserve bindings and match exported color."""

from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import pytest
import trimesh
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from viscera_core.atlas_disease import (
    DiseaseSpec,
    apply_disease_color,
    disease_catalog,
    sample_disease,
)
from viscera_core.atlas_disease_scene import DiseaseAtlasSpec, export_glb, realize
from viscera_core.atlas_disease_text import compile_text
from viscera_core.atlas_materials import make_recipe
from viscera_core.atlas_surface_scene import realize as surface_realize

pytest_plugins = ["test_atlas_integration"]


def test_all_organs_supported_with_explicit_unavailable_conditions():
    c = disease_catalog()
    assert len(c["profiles"]) == 36
    assert len({p["organ"] for p in c["profiles"] if p["supported"]}) == 12
    for p in c["profiles"]:
        if p["supported"]:
            for seed in (1, 42):
                d = sample_disease(p["id"], seed)
                assert d == sample_disease(p["id"], seed)
                assert d != sample_disease(p["id"], seed + 1)
        else:
            with pytest.raises(ValidationError):
                DiseaseSpec(profile_id=p["id"])


@pytest.mark.parametrize(
    "changes",
    [
        {"severity": True},
        {"severity": float("nan")},
        {"size": 1.01},
        {"count": 1.2},
        {"seed": True},
        {"location": [0, 0, float("inf")]},
        {"location": [0, 0]},
        {"extra": 1},
    ],
)
def test_disease_contract_fails_closed(changes):
    with pytest.raises(ValidationError):
        DiseaseSpec.model_validate({"profile_id": "liver-hcc", **changes})


def test_baseline_replay_and_material_independence(library: Path):
    spec = DiseaseAtlasSpec(template_id="fixture-liver", material=make_recipe("liver"))
    baseline = realize(library, spec)
    assert baseline == surface_realize(library, spec.surface_spec())
    zero = realize(
        library,
        DiseaseAtlasSpec(
            **spec.model_dump(), disease=DiseaseSpec(profile_id="liver-hcc", severity=0)
        ),
    )
    assert zero["scene"]["organs"][0]["positions"] == baseline["scene"]["organs"][0]["positions"]
    changed = realize(
        library, DiseaseAtlasSpec(**spec.model_dump(), disease=DiseaseSpec(profile_id="liver-hcc"))
    )
    assert (
        changed["scene"]["metadata"]["geometry_sha256"]
        != baseline["scene"]["metadata"]["geometry_sha256"]
    )
    assert changed["scene"]["organs"][0]["indices"] == baseline["scene"]["organs"][0]["indices"]
    assert changed["summary"]["disease"]["max_displacement_mm"] > 0
    second = realize(
        library,
        DiseaseAtlasSpec.model_validate(
            {**changed["spec"], "material": make_recipe("liver", "rich", 913).model_dump()}
        ),
    )
    assert (
        second["scene"]["metadata"]["geometry_sha256"]
        == changed["scene"]["metadata"]["geometry_sha256"]
    )
    assert second["spec"]["realized_id"] != changed["spec"]["realized_id"]
    with pytest.raises(ValueError, match="match"):
        realize(
            library,
            DiseaseAtlasSpec(
                template_id="fixture-liver", disease=DiseaseSpec(profile_id="lung-cancer")
            ),
        )


def test_export_preserves_actual_geometry_and_rejects_stale_recipe(library: Path):
    r = realize(
        library,
        DiseaseAtlasSpec(
            template_id="fixture-liver", disease=DiseaseSpec(profile_id="liver-cirrhosis")
        ),
    )
    spec = DiseaseAtlasSpec.model_validate(r["spec"])
    binary = export_glb(library, spec)
    m = trimesh.load(io.BytesIO(binary), file_type="glb", force="mesh", process=False)
    source = r["scene"]["organs"][0]
    p = np.asarray(source["positions"]).reshape(-1, 3) / 1000
    f = np.asarray(source["indices"]).reshape(-1, 3)
    np.testing.assert_allclose(m.vertices[m.faces], p[f], atol=1e-8)
    modified = spec.model_copy(
        update={"disease": spec.disease.model_copy(update={"severity": 0.9})}
    )
    with pytest.raises(ValueError, match="match"):
        export_glb(library, modified)


def test_shader_color_formula_and_bake_share_linear_blend():
    from viscera_core.atlas_material_bake import _bake_maps
    from viscera_core.atlas_materials import sample_material

    p = np.array([[0.0, 0, 0], [12, 0, 0], [12, 12, 0], [0, 12, 0]])
    f = np.array([[0, 1, 2], [0, 2, 3]])
    n = np.tile([0.0, 0, 1], (4, 1))
    recipe = make_recipe("liver")
    field = {
        "fields": [{"center_mm": [6, 6, 0], "radius_mm": 20}],
        "target_srgb": [0.7, 0.2, 0.1],
        "color_strength": 0.8,
    }
    baked = _bake_maps(p, p, n, f, np.zeros(4), recipe, 128, disease_field=field)
    for tri in baked["faces"]:
        uv = baked["uv"][tri]
        pixel = np.floor(uv.mean(axis=0) * 128).astype(int)
        inv = np.linalg.inv(uv[1:] - uv[:1])
        ab = ((pixel + 0.5) / 128 - uv[0]) @ inv
        bary = np.r_[1 - ab.sum(), ab]
        rest = p[baked["mapping"][tri]]
        dr = inv @ (rest[1:] - rest[:1])
        footprint = np.max(np.linalg.norm(dr, axis=1)) / 128
        point = (bary @ rest)[None]
        rgb = sample_material(recipe, point, footprint_mm=footprint).rgb_srgb
        expected = apply_disease_color(rgb, point, field)
        np.testing.assert_allclose(
            baked["base_color"][pixel[1], pixel[0]] / 255, expected[0], atol=0.5 / 255 + 1e-8
        )


def test_disease_text_is_atomic_and_preserves_edits(library: Path):
    spec = DiseaseAtlasSpec(template_id="fixture-liver", material=make_recipe("liver"))
    before = spec.model_dump()
    accepted = compile_text(library, "liver with cirrhosis severity 0.8 and wetter", spec)
    assert accepted["status"] == "accepted"
    assert accepted["spec"]["disease"]["severity"] == 0.8
    assert accepted["spec"]["material"]["wetness"] == 0.65
    active = DiseaseAtlasSpec.model_validate(accepted["spec"])
    assert compile_text(library, "healthy liver", active)["spec"].get("disease") is None
    for text in [
        "no cirrhosis",
        "cirrhosis severity 1.2",
        "cirrhosis and glitter",
        "cirrhosis and liver metastases",
        "aortic stenosis",
        "cirrhosis stage 4",
        "cirrhosis count 1.5",
    ]:
        assert compile_text(library, text, spec)["status"] == "unsupported", text
    assert spec.model_dump() == before


def test_api_generation_and_model_failure_are_explicit(library: Path, tmp_path: Path, monkeypatch):
    from services.api.atlas import router

    monkeypatch.setenv("VISCERA_ATLAS_TEMPLATES", str(library))
    monkeypatch.setenv("VISCERA_DISEASE_MODEL", str(tmp_path / "missing.npz"))
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    assert len(client.get("/api/atlas/catalog").json()["diseases"]["defaults"]) == 12
    spec = DiseaseAtlasSpec(
        template_id="fixture-liver", disease=DiseaseSpec(profile_id="liver-hcc")
    )
    response = client.post("/api/atlas/generate", json=spec.model_dump())
    assert response.status_code == 200
    assert response.json()["summary"]["disease"]["max_displacement_mm"] > 0
    assert (
        client.post(
            "/api/atlas/sample-disease", json={"spec": response.json()["spec"], "seed": 7}
        ).status_code
        == 503
    )
    assert (
        client.post(
            "/api/atlas/generate",
            json={**spec.model_dump(), "disease": {"profile_id": "heart-aortic-stenosis"}},
        ).status_code
        == 422
    )
