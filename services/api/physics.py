"""Independent liver physics learning and reproducible experiment routes."""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any, Literal

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from viscera_core.atlas_disease_scene_v2 import DiseaseAtlasSpecV2
from viscera_core.atlas_scene import get_template
from viscera_core.physics_learning import (
    PARAMETER_NAMES,
    SCOPE,
    demo_observation,
)
from viscera_core.physics_learning import (
    VERSION as LEGACY_VERSION,
)

from .atlas import ROOT, AtlasSpec, realize, template_root, versioned_template_root

router = APIRouter(prefix="/api/physics", tags=["physics"])
_solve_lock = threading.Lock()


class PhysicsParameters(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, strict=True)
    young_pa: float = Field(default=4800.0, ge=500.0, le=20000.0)
    poisson: float = Field(default=0.45, ge=0.2, le=0.48)
    relaxation_fraction: float = Field(default=0.42, ge=0.05, le=0.75)
    relaxation_time_s: float = Field(default=0.65, ge=0.05, le=2.0)
    density_kg_m3: float = Field(default=1060.0, ge=900.0, le=1200.0)
    contact_stiffness_n_m: float = Field(default=300.0, ge=20.0, le=2000.0)
    indentation_stiffness_n_m: float = Field(default=20000.0, ge=1000.0, le=100000.0)
    fracture_energy_j_m2: float = Field(default=20.0, ge=1.0, le=200.0)


class MaterialRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    spec: AtlasSpec
    parameter_source: Literal["learned", "manual"] = "learned"
    parameters: PhysicsParameters | None = None
    observation: ObservationRequest | None = None

    @model_validator(mode="after")
    def no_ignored_parameters(self) -> "MaterialRequest":
        if self.parameters is not None and self.parameter_source != "manual":
            raise ValueError("Set parameter_source=manual when supplying parameters")
        if self.observation is not None and self.parameter_source != "learned":
            raise ValueError("Set parameter_source=learned to infer from an observation")
        return self


class RunRequest(MaterialRequest):
    protocol: Literal["indent", "grasp", "cut"] = "grasp"
    amplitude_mm: float = Field(default=6.0, ge=1.0, le=12.0, strict=True)


class PlaygroundRequest(MaterialRequest):
    """Prepare geometry and material once; direct interaction runs in the browser."""


class ObservationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, strict=True)
    times_s: list[float] = Field(min_length=16, max_length=257)
    force_n: list[float] = Field(min_length=16, max_length=257)
    displacement_mm: list[float] = Field(min_length=16, max_length=257)
    reference_length_mm: float = Field(gt=0.0, le=1000.0)
    reference_area_mm2: float = Field(gt=0.0, le=1e6)
    provenance: str = Field(min_length=8, max_length=2000)


class AssessmentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    simulation: dict[str, Any]
    reference: dict[str, Any] | None = None


RunRequest.model_rebuild()
PlaygroundRequest.model_rebuild()


def model_root() -> Path:
    return Path(
        os.environ.get("VISCERA_PHYSICS_MODEL", ROOT / "artifacts/physics/liver-network-v2")
    )


def model_backend() -> Any:
    """Route by the on-disk contract, preserving explicit v1 rollback."""
    root = model_root()
    manifest = json.loads((root / "manifest.json").read_text())
    version = manifest.get("version")
    if version is None:
        version = json.loads((root / "model.json").read_text()).get("version")
    if version == "liver-inverse-sls-2.0.0":
        from viscera_core import physics_learning_v2
        return physics_learning_v2
    if version == LEGACY_VERSION:
        from viscera_core import physics_learning
        return physics_learning
    raise ValueError("Unsupported physics model contract")


def application_policy_root() -> Path | None:
    """Optional research policy is disabled unless an explicit directory is configured."""
    configured = os.environ.get("VISCERA_PHYSICS_APPLICATION_POLICY")
    if not configured or configured == "off":
        return None
    return Path(configured)


def validated_application_policy(model_sha256: str) -> dict[str, Any] | None:
    root = application_policy_root()
    if root is None:
        return None
    from viscera_core import physics_learning_robust

    policy, digest = physics_learning_robust.load_policy(root, model_sha256)
    report = json.loads((root / "evaluation.json").read_text())
    gates = report.get("gates")
    if (report.get("stage") != "final" or report.get("all_gates_passed") is not True
        or not isinstance(gates, dict) or not gates or not all(value is True for value in gates.values())
        or report.get("model_sha256") != model_sha256 or report.get("policy_sha256") != digest):
        raise ValueError("Physics application policy evaluation is absent, stale or failed")
    return {"version": policy["version"], "id": digest,
            "scope": "Synthetic calibration precision and noise-stratified response checks; not human-tissue validation.",
            "checks": ["parameter_precision", "structured_residual"], "evaluation_gates": gates}


def infer_material_observation(observation: dict[str, Any]) -> dict[str, Any]:
    backend = model_backend()
    if getattr(backend, "VERSION", LEGACY_VERSION) == "liver-inverse-sls-2.0.0" and application_policy_root() is not None:
        from viscera_core import physics_learning_robust

        _, digest = backend.load_model(model_root())
        policy = validated_application_policy(digest)
        result = physics_learning_robust.infer_observation(model_root(), policy_directory=application_policy_root(), **observation)
        if result["model_id"] != digest or policy is None or result["application_policy_id"] != policy["id"]:
            raise ValueError("Physics model or application policy changed during calibration; retry")
        return result
    return backend.infer_observation(model_root(), **observation)


def learned_parameters(
    supplied: ObservationRequest | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    observation = supplied.model_dump() if supplied is not None else demo_observation()
    fit = infer_material_observation({
            k: observation[k]
            for k in (
                "times_s",
                "force_n",
                "displacement_mm",
                "reference_length_mm",
                "reference_area_mm2",
            )
        } | {"provenance": observation.get("provenance", observation.get("evidence", "unspecified"))})
    if fit.get("accepted_for_application") is False:
        reasons = "; ".join(fit.get("rejection_reasons", [])) or "insufficient calibration evidence"
        suggestions = fit.get("application_diagnostics", {}).get("recommended_next_steps", [])
        advice = " Next steps: " + " ".join(dict.fromkeys(suggestions)) if suggestions else ""
        raise ValueError(f"Physics calibration needs review: {reasons}.{advice}")
    if not fit["within_synthetic_fit_gate"]:
        raise ValueError(
            "Physics model did not reproduce the supplied observation within 5% peak-normalized stress RMSE"
        )
    parameters = PhysicsParameters(
        **{**PhysicsParameters().model_dump(), **fit["parameters"]}
    ).model_dump()
    return parameters, {
        **fit,
        "source": "learned",
        "predicted_parameters": fit["parameters"],
        "observation": observation,
        "observation_origin": "user_supplied_calibration_unverified"
        if supplied is not None
        else "synthetic_demonstration",
        "human_liver_validated": False,
    }


@router.get("/status")
def status() -> dict[str, Any]:
    result: dict[str, Any] = {
        "status": "unavailable",
        "model_id": None,
        "scope": SCOPE,
        "parameters": list(PARAMETER_NAMES),
        "defaults": PhysicsParameters().model_dump(),
        "parameter_bounds": {
            k: {"min": v[0], "max": v[1]}
            for k, v in {
                "young_pa": [500, 20000],
                "poisson": [0.2, 0.48],
                "relaxation_fraction": [0.05, 0.75],
                "relaxation_time_s": [0.05, 2],
                "density_kg_m3": [900, 1200],
                "contact_stiffness_n_m": [20, 2000],
                "indentation_stiffness_n_m": [1000, 100000],
                "fracture_energy_j_m2": [1, 200],
            }.items()
        },
        "protocols": ["indent", "grasp", "cut"],
        "human_liver_validated": False,
    }
    try:
        backend = model_backend()
        _, digest = backend.load_model(model_root())
        report = json.loads((model_root() / "evaluation.json").read_text())
        if report.get("model_sha256") != digest or report.get("synthetic_gate_passed") is not True:
            raise ValueError("Physics model evaluation is absent, stale or failed")
        policy = validated_application_policy(digest) if backend.VERSION == "liver-inverse-sls-2.0.0" else None
        result.update(
            status="ready",
            model_id=digest,
            model_version=backend.VERSION,
            application_policy=policy,
            scope=backend.SCOPE,
            calibration_contract=getattr(backend, "CALIBRATION_CONTRACT", {"protocol": "fixed_2.5_percent_uniaxial_81_samples"}),
            evaluation={
                k: report[k]
                for k in (
                    "split_counts",
                    "parameter_metrics",
                    "held_out_stress_nrmse_median",
                    "held_out_stress_nrmse_p95",
                )
            },
        )
    except (OSError, ValueError, KeyError) as error:
        result["reason"] = str(error)
    return result


@router.get("/demo-observation")
def observation_demo() -> dict[str, Any]:
    return demo_observation()


@router.post("/infer")
def infer(request: ObservationRequest) -> dict[str, Any]:
    if status()["status"] != "ready":
        raise HTTPException(503, "Train and verify the separate physics network first")
    try:
        return infer_material_observation(request.model_dump())
    except OSError as error:
        raise HTTPException(503, "Train the separate physics network first") from error
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


@router.post("/run")
def run(request: RunRequest) -> dict[str, Any]:
    from viscera_core.liver_physics import run_liver_experiment

    if not _solve_lock.acquire(blocking=False):
        raise HTTPException(
            503,
            "A physics experiment is running; retry after it finishes",
            headers={"Retry-After": "5"},
        )
    try:
        parameters, learning, generated = _prepare_material_and_source(request)
        liver = generated["scene"]["organs"][0]
        result = run_liver_experiment(
            np.asarray(liver["positions"]).reshape(-1, 3),
            np.asarray(liver["indices"]).reshape(-1, 3),
            parameters,
            protocol=request.protocol,
            amplitude_mm=request.amplitude_mm,
        )
        result["learning"] = learning
        result["source"] = _source_provenance(generated)
        result["reference_validation"] = {
            "status": "NOT_RUN",
            "reason": "No calibrated liver experiment supplied",
        }
        from viscera_core.physics_assessment import assess_experiment

        result["assessment"] = assess_experiment(result)
        return result
    except (KeyError, ValueError) as error:
        raise HTTPException(422, str(error)) from error
    except FileNotFoundError as error:
        raise HTTPException(503, str(error)) from error
    finally:
        _solve_lock.release()


def _prepare_material_and_source(
    request: MaterialRequest,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    templates = template_root()
    source_root = (
        versioned_template_root(templates)
        if isinstance(request.spec, DiseaseAtlasSpecV2)
        else templates
    )
    template = get_template(source_root, request.spec.template_id)
    if template.metadata["organ"] != "liver":
        raise ValueError("The physics lab currently supports liver meshes only")
    if request.parameter_source == "learned":
        if status()["status"] != "ready":
            raise FileNotFoundError("Train and verify the separate physics network first")
        parameters, learning = learned_parameters(request.observation)
    else:
        parameters = (request.parameters or PhysicsParameters()).model_dump()
        learning = {
            "source": "manual",
            "model_id": None,
            "scope": "User-selected material parameters; not inferred or calibrated",
            "human_liver_validated": False,
        }
    generated = realize(templates, request.spec)
    if request.spec.realized_id and generated["spec"]["realized_id"] != request.spec.realized_id:
        raise ValueError(
            "Displayed mesh identity changed; regenerate the liver before running physics"
        )
    return parameters, learning, generated


def _source_provenance(generated: dict[str, Any]) -> dict[str, Any]:
    return {
        "template_id": generated["spec"]["template_id"],
        "realized_id": generated["spec"]["realized_id"],
        "spec": generated["spec"],
        "geometry_sha256": generated["scene"]["metadata"]["geometry_sha256"],
        "attribution": generated["scene"]["metadata"].get("source", {}),
    }


@router.post("/playground")
def playground(request: PlaygroundRequest) -> dict[str, Any]:
    """Bind the displayed liver and learned material for local interactive dynamics.

    This creates no server-side simulation session. No trajectory is scripted and
    no support nodes are pinned: the browser integrates gravity, material
    constraints and pointer contacts on this same embedded volume.
    """
    from viscera_core.liver_physics import build_liver_cage

    if not _solve_lock.acquire(blocking=False):
        raise HTTPException(
            503,
            "A physics preparation or experiment is running; retry after it finishes",
            headers={"Retry-After": "2"},
        )
    try:
        parameters, learning, generated = _prepare_material_and_source(request)
        liver = generated["scene"]["organs"][0]
        cage = build_liver_cage(liver["positions"], liver["indices"], resolution=4)
        reference, tets = cage["reference"], cage["tets"]
        volumes = (
            np.linalg.det(np.swapaxes(reference[tets[:, 1:]] - reference[tets[:, :1]], 1, 2)) / 6
        )
        volume = float(volumes.sum())
        return {
            "schema_version": "liver-physics-playground-1.0.0",
            "parameters": parameters,
            "learning": learning,
            "source": _source_provenance(generated),
            "units": {"geometry": "mm", "internal": "m-kg-s"},
            "room": {"floor_y_mm": 0.0, "gravity_m_s2": 9.81},
            "mesh": {
                "reference_positions_mm": (reference * 1000).reshape(-1).tolist(),
                "tets": tets.reshape(-1).tolist(),
                "surface_indices": cage["surface_faces"].reshape(-1).tolist(),
                "embedding": {
                    "tet_indices": cage["embedding_tets"].tolist(),
                    "weights": cage["embedding_weights"].reshape(-1).tolist(),
                },
                "source_vertex_count": len(cage["source_vertices"]),
                "source_face_count": len(cage["source_faces"]),
                "reference_geometry_sha256": cage["reference_geometry_sha256"],
                "embedding_max_error_mm": cage["embedding_max_error_mm"],
                "cage_volume_ml": volume * 1e6,
                "mass_kg": volume * parameters["density_kg_m3"],
                "enclosure_over_convex_hull_pct": (volume / cage["source_convex_volume_m3"] - 1)
                * 100,
                "domain": "support_plane_convex_enclosure_of_input_surface",
                "enclosure": cage["enclosure"],
                "pinned_nodes": [],
            },
            "simulation": {
                "execution": "browser_fixed_step_interactive",
                "method": "vertex_block_descent_stable_neo_hookean_green_maxwell",
                "material_model": "continuum",
                "fixed_step_s": 1 / 120,
                "nonlinear_iterations": 4,
                "contact_model": "projected_augmented_lagrangian_sphere_triangle",
                "floor_friction": {"method": "estimated_reaction_split_coulomb", "coefficient": 0.6},
                "contact_accuracy": "finite_budget_needs_force_refinement",
                "human_liver_validated": False,
            },
            "limitations": [
                "The browser uses the recorded finite-strain constitutive law with a fixed-budget vertex block descent solve; its integration is approximate, not a converged offline trajectory.",
                "Learned parameters come from the supplied uniaxial calibration or synthetic demonstration, not from mesh appearance.",
                "The convex volume omits concavities, capsule and internal anatomy; floor friction coefficient and numerical damping are authored assumptions.",
                "Sphere-to-triangle augmented contact reduces overlap; contact force and work remain sensitive to the time step. Bounded tool motion and containment checks are not full continuous collision detection.",
                "Interactive tools deform an intact body; predefined cutting remains in Recorded experiments.",
                "No clinical realism or measured human-liver validation has been established.",
            ],
        }
    except (KeyError, ValueError) as error:
        raise HTTPException(422, str(error)) from error
    except FileNotFoundError as error:
        raise HTTPException(503, str(error)) from error
    finally:
        _solve_lock.release()


@router.post("/assess")
def assess(request: AssessmentRequest) -> dict[str, Any]:
    from viscera_core.physics_assessment import assess_experiment

    try:
        return assess_experiment(request.simulation, request.reference)
    except (ValueError, TypeError, KeyError, IndexError) as error:
        raise HTTPException(422, str(error)) from error
