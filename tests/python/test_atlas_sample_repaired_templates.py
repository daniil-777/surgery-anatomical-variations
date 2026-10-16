"""The learned shape sampler (/api/atlas/sample) for the two repaired references, hra-heart-male and
hra-urinary-bladder-male: a disease-v2 specimen is displayed from templates-v3, whose artifact hash differs from
the frozen cohort-v2 one the trained sampler binds, so the route must bind the displayed hash itself. Runs against
the real libraries and the shape model the API serves; skipped where either is absent."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services.api import atlas
from services.api.atlas_model_registry import resolve_model

ROOT = Path(__file__).resolve().parents[2]
TRAINED_LIBRARY = ROOT / "datasets/atlas/cohort-v2/templates"
REPAIRED_LIBRARY = ROOT / atlas.V2_TEMPLATES_DEFAULT
REPAIRED = ("hra-urinary-bladder-male", "hra-heart-male")
UNCHANGED = "hra-liver-female"


def artifact_hash(library: Path, template_id: str) -> str:
    return json.loads((library / f"{template_id}.json").read_text())["artifact_sha256"]


def v2_spec(template_id: str, **extra: Any) -> dict[str, Any]:
    return {
        "template_id": template_id,
        "renderer_version": "disease-v2",
        "seed": 42,
        "appearance": "tissue",
        **extra,
    }


@pytest.fixture
def libraries(monkeypatch: pytest.MonkeyPatch) -> None:
    for library in (TRAINED_LIBRARY, REPAIRED_LIBRARY):
        if not (library / "catalog.json").is_file():
            pytest.skip(f"template library absent: {library.relative_to(ROOT)}")
    # the routes must resolve the libraries as the served API does: cohort-v2 for the samplers, templates-v3 for
    # the v2 renderer; a shell that points them elsewhere would test another checkout
    for name in ("VISCERA_ATLAS_TEMPLATES", "VISCERA_ATLAS_TEMPLATES_V2", "VISCERA_ATLAS_DATASET"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def client(libraries: None) -> Any:
    try:
        model = resolve_model(ROOT, "shape")
    except (OSError, ValueError, KeyError) as error:
        pytest.skip(f"no served shape model: {error}")
    if not model.is_file() or not (ROOT / "datasets/atlas/cohort-v2/release.json").is_file():
        pytest.skip("the served shape model or its cohort-v2 release is absent")
    app = FastAPI()
    app.include_router(atlas.router)
    with TestClient(app) as test_client:
        yield test_client


def test_the_repaired_references_carry_their_own_hash(libraries: None) -> None:
    for template_id in REPAIRED:
        assert artifact_hash(REPAIRED_LIBRARY, template_id) != artifact_hash(
            TRAINED_LIBRARY, template_id
        )
    assert artifact_hash(REPAIRED_LIBRARY, UNCHANGED) == artifact_hash(TRAINED_LIBRARY, UNCHANGED)


def test_unbind_for_sampler_rebinds_only_disease_v2_specs(libraries: None) -> None:
    template_id = REPAIRED[1]
    displayed = artifact_hash(REPAIRED_LIBRARY, template_id)
    trained = artifact_hash(TRAINED_LIBRARY, template_id)
    spec = atlas.parse_spec(v2_spec(template_id, template_sha256=displayed))
    geometry, binding = atlas.unbind_for_sampler(spec, spec.geometry_spec())
    assert geometry.template_sha256 is None
    assert binding == {"template_sha256": displayed}
    surface, binding = atlas.unbind_for_sampler(spec, spec.surface_spec())  # the material sampler's
    assert surface.template_sha256 is None
    assert binding == {"template_sha256": displayed}
    unbound = atlas.parse_spec(v2_spec(template_id))
    assert atlas.unbind_for_sampler(unbound, unbound.geometry_spec())[1] == binding
    stale = atlas.parse_spec(v2_spec(template_id, template_sha256=trained))
    with pytest.raises(ValueError, match="Displayed reference changed"):
        atlas.unbind_for_sampler(stale, stale.geometry_spec())
    legacy = atlas.parse_spec({"template_id": template_id, "template_sha256": trained})
    geometry, binding = atlas.unbind_for_sampler(legacy, legacy.geometry_spec())
    assert geometry.template_sha256 == trained
    assert binding == {}


@pytest.mark.parametrize("template_id", [*REPAIRED, UNCHANGED])
def test_v2_sample_binds_the_displayed_reference(client: TestClient, template_id: str) -> None:
    displayed = artifact_hash(REPAIRED_LIBRARY, template_id)
    generated = client.post("/api/atlas/generate", json=v2_spec(template_id))
    assert generated.status_code == 200, generated.text
    bound = generated.json()["spec"]
    assert bound["template_sha256"] == displayed
    # as the studio sends it (the displayed, bound spec) and unbound
    for spec in (bound, v2_spec(template_id)):
        sampled = client.post("/api/atlas/sample", json={"spec": spec, "match_dimensions": True})
        assert sampled.status_code == 200, sampled.text
        result = sampled.json()
        assert result["spec"]["renderer_version"] == "disease-v2"
        assert result["spec"]["template_sha256"] == displayed
        assert result["summary"]["model"]["refinement_status"] == "matched"
        assert result["scene"]["metadata"]["model"] == result["summary"]["model"]
        # the bound sample is a displayable, exportable v2 specimen: it replays to the same realized_id
        replay = client.post("/api/atlas/generate", json=result["spec"])
        assert replay.status_code == 200, replay.text
        assert replay.json()["spec"]["realized_id"] == result["spec"]["realized_id"]


def test_v2_sample_refuses_a_stale_displayed_hash(client: TestClient) -> None:
    # for a repaired reference the trained hash is the stale one on the v2 display: the check moved, not dropped
    template_id = REPAIRED[0]
    stale = v2_spec(template_id, template_sha256=artifact_hash(TRAINED_LIBRARY, template_id))
    response = client.post("/api/atlas/sample", json={"spec": stale, "match_dimensions": False})
    assert response.status_code == 422
    assert response.json()["detail"] == "Displayed reference changed; reload before sampling"


def test_legacy_sample_still_binds_the_trained_reference(client: TestClient) -> None:
    spec = {"template_id": UNCHANGED, "seed": 42, "appearance": "tissue"}
    sampled = client.post("/api/atlas/sample", json={"spec": spec, "match_dimensions": True})
    assert sampled.status_code == 200, sampled.text
    result = sampled.json()
    assert "renderer_version" not in result["spec"]
    assert result["spec"]["template_sha256"] == artifact_hash(TRAINED_LIBRARY, UNCHANGED)
    assert result["summary"]["model"]["refinement_status"] == "matched"
