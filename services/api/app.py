"""Local-only VISCERA generation, language, snapshot and export service."""

from __future__ import annotations

import copy
import hashlib
import math
import os
import time
from pathlib import Path
from typing import Any, Literal

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field
from starlette.types import ASGIApp, Message, Receive, Scope, Send
from viscera_core.geometry import (
    DEFAULT_SAMPLER_PROFILE,
    SAMPLER_PROFILES,
    generate_scene,
    sample_parameters,
    scene_clearance,
)
from viscera_core.schema import DEFAULT_PARAMETERS, PARAMETER_BOUNDS, SceneRequest

from .compiler import POLICY_VERSION, compile_text, content_hash
from .exports import checked_mesh, export_scene
from .repository import SnapshotStore, StaleRevision

ROOT = Path(os.environ.get("VISCERA_PROJECT_ROOT", Path(__file__).resolve().parents[2]))


class BoundedRequestMiddleware:
    """Bound buffering while receiving, including requests without Content-Length."""

    def __init__(self, app: ASGIApp, max_bytes: int = 32 * 1024 * 1024):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_checked(message: Message) -> None:
            if message["type"] == "http.response.start":
                message["headers"] = [
                    *message.get("headers", []),
                    (b"x-content-type-options", b"nosniff"),
                ]
            await send(message)

        if scope["method"] != "POST":
            await self.app(scope, receive, send_checked)
            return
        if scope.get("path") == "/api/atlas/models/import":
            # This route has its own bounded streaming-to-disk reader. Avoid the
            # generic 32 MiB JSON buffer for a potentially larger weights ZIP.
            await self.app(scope, receive, send_checked)
            return
        too_large = JSONResponse({"detail": "Request exceeds the 32 MiB local limit"}, 413)
        for name, value in scope.get("headers", []):
            if name.lower() == b"content-length":
                try:
                    length = int(value)
                except ValueError:
                    await JSONResponse({"detail": "Invalid Content-Length"}, 400)(
                        scope, receive, send_checked
                    )
                    return
                if length < 0:
                    await JSONResponse({"detail": "Invalid Content-Length"}, 400)(
                        scope, receive, send_checked
                    )
                    return
                if length > self.max_bytes:
                    await too_large(scope, receive, send_checked)
                    return
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            if len(body) + len(chunk) > self.max_bytes:
                await too_large(scope, receive, send_checked)
                return
            body.extend(chunk)
            if not message.get("more_body", False):
                break

        delivered = False

        async def replay() -> Message:
            nonlocal delivered
            if delivered:
                return await receive()
            delivered = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}

        await self.app(scope, replay, send_checked)


class GenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    spec: SceneRequest = Field(default_factory=lambda: SceneRequest.model_validate({}))
    resolution: Literal["low", "medium", "high"] = "medium"


class CompileRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=4000)
    spec: SceneRequest = Field(default_factory=lambda: SceneRequest.model_validate({}))
    selectedOrganId: str | None = None


class EditRequest(GenerateRequest):
    base_snapshot_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    expected_content_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    locked_organ_ids: list[Literal["liver", "gallbladder"]] = Field(default_factory=list)


class ExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    snapshot_id: str | None = None
    scene: dict[str, Any] | None = None
    format: Literal["glb", "obj", "viscera"] = "glb"


class CommitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: str = Field(min_length=1, max_length=80, pattern=r"^[a-zA-Z0-9_-]+$")
    title: str = Field(min_length=1, max_length=120)
    snapshot_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    expected_revision: int | None = Field(None, ge=0)


class SnapshotRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scene: dict[str, Any]


class LearnedRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    seed: int = Field(default=1234, ge=0, le=2**32 - 1, strict=True)
    conditions: dict[str, float] = Field(default_factory=dict, max_length=5)
    method: Literal["flow", "pca", "nearest"] = "flow"
    resolution: Literal["low", "medium", "high"] = "medium"


def measure_realized(scene: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Measure the actual retained arrays; construction controls are not measurements."""
    measurements: dict[str, Any] = {}
    checks: list[dict[str, Any]] = []
    for item in scene["organs"]:
        metrics = checked_mesh(item).metadata["measurement"]
        checks.append(
            {"id": f"surface-validity:{item['id']}", "result": "PASS", "metrics": metrics}
        )
        if item["id"] == "liver":
            measurements.update(
                liver_volume_ml=metrics["volume_ml"],
                liver_width_mm=metrics["width_mm"],
                liver_height_mm=metrics["height_mm"],
                liver_depth_mm=metrics["depth_mm"],
            )
        else:
            measurements["gallbladder_enclosed_ml"] = metrics["volume_ml"]
    return measurements, checks


def create_app(database: Path | None = None) -> FastAPI:
    app = FastAPI(
        title="VISCERA local studio",
        version="0.1.0",
        description="Original procedural anatomy pilot. Documentation describes actual capabilities.",
    )
    from .atlas import router as atlas_router
    from .atlas_models import router as models_router
    from .physics import router as physics_router
    from .reference_material import router as reference_material_router
    app.include_router(atlas_router)
    app.include_router(models_router)
    app.include_router(physics_router)
    app.include_router(reference_material_router)
    store = SnapshotStore(
        database or Path(os.environ.get("VISCERA_DB", ROOT / "data" / "studio.sqlite"))
    )
    app.state.store = store
    # the development server's origin, plus any origins the operator names (VISCERA_CORS_ORIGINS, comma-separated:
    # the public static copy on GitHub Pages calls a hosted API cross-origin; no credentials are ever involved)
    configured = [
        origin.strip().rstrip("/")
        for origin in os.environ.get("VISCERA_CORS_ORIGINS", "").split(",")
        if origin.strip().startswith(("http://", "https://"))
    ]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5174", "http://127.0.0.1:5174", *configured],
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
        allow_credentials=False,
        max_age=600,
    )

    app.add_middleware(BoundedRequestMiddleware)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, error: RequestValidationError) -> JSONResponse:
        # The JSON parser accepts NaN/Infinity, but strict JSON responses do not.
        # Echoing those rejected input values through FastAPI's default handler
        # turns a normal validation error into a 500 during serialization.
        details = jsonable_encoder(
            error.errors(),
            custom_encoder={float: lambda value: value if math.isfinite(value) else str(value)},
        )
        return JSONResponse({"detail": details}, status_code=422)

    def load_snapshot(identifier: str) -> dict[str, Any]:
        try:
            return store.load(identifier)
        except KeyError as error:
            raise HTTPException(404, str(error)) from error

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "version": "0.1.0",
            "mode": "local",
            "generator": "procedural",
            "evidence_profile": "development_preview",
        }

    @app.get("/api/capabilities")
    def capabilities() -> dict[str, Any]:
        return {
            "schema_version": "0.1.0",
            "families": ["liver", "gallbladder"],
            "parameters": {
                key: {"min": bounds[0], "max": bounds[1], "default": DEFAULT_PARAMETERS[key]}
                for key, bounds in PARAMETER_BOUNDS.items()
            },
            "text_policy": POLICY_VERSION,
            "resolutions": ["low", "medium", "high"],
            "export_formats": ["glb", "obj", "viscera"],
            "physics": "tetrahedral_xpbd_preview",
            "anatomical_review": "unreviewed",
            "trained_generation": "experimental_parameter_flow",
            "learned_sampler_methods": ["flow", "pca", "nearest"],
            "model_available": Path(
                os.environ.get(
                    "VISCERA_SHAPE_MODEL", ROOT / "artifacts/models/shape-pilot-v1/model.pt"
                )
            ).is_file(),
            "default_sampler_profile": DEFAULT_SAMPLER_PROFILE,
            "sampler_profiles": SAMPLER_PROFILES,
            "unsupported": [
                "clinical_pathology",
                "patient_import",
                "validated_organ_mechanics",
                "surgical_cutting",
            ],
        }

    @app.get("/api/schema")
    def schema() -> dict[str, Any]:
        return dict(SceneRequest.model_json_schema())

    @app.post("/api/generate")
    def generate(payload: GenerateRequest) -> dict[str, Any]:
        started = time.perf_counter()
        scene = generate_scene(payload.spec, payload.resolution)
        if not scene["gate"]["passed"]:
            raise HTTPException(422, {"code": "GEOMETRY_GATE_FAILED", "gate": scene["gate"]})
        snapshot = store.save(scene)
        return {**scene, "snapshot": snapshot, "timing_ms": (time.perf_counter() - started) * 1000}

    @app.post("/api/compile")
    def compile_request(payload: CompileRequest) -> dict[str, Any]:
        return compile_text(payload.text, payload.spec.model_dump(), payload.selectedOrganId)

    @app.post("/api/sample-learned")
    def sample_learned(payload: LearnedRequest) -> dict[str, Any]:
        """Optional experimental learned parameter distribution, with rejection."""
        model = Path(
            os.environ.get("VISCERA_SHAPE_MODEL", ROOT / "artifacts/models/shape-pilot-v1/model.pt")
        )
        if not model.is_file():
            raise HTTPException(
                503,
                {
                    "code": "MODEL_UNAVAILABLE",
                    "message": "Train the local shape pilot or set VISCERA_SHAPE_MODEL to its checksummed artifact.",
                },
            )
        try:
            import numpy as np
            import viscera_core.geometry as decoder
            from pipelines.train.viscera_train.shape import safe_load
            from pipelines.train.viscera_train.shape import sample_parameters as learned_sample

            artifact = safe_load(model)
            decoder_path = Path(decoder.__file__)
            if (
                hashlib.sha256(decoder_path.read_bytes()).hexdigest()
                != artifact["code_identity"]["geometry_sha256"]
            ):
                raise ValueError(
                    "The trained model decoder hash differs from the installed geometry; use matching sources or retrain"
                )
            allowed = artifact["condition_names"]
            if set(payload.conditions) - set(allowed) or any(
                v <= 0 for v in payload.conditions.values()
            ):
                raise ValueError(
                    f"Positive measured conditions required; supported fields: {allowed}"
                )
            conditions = np.asarray([[payload.conditions.get(name, np.nan) for name in allowed]])
            values = learned_sample(artifact, conditions, method=payload.method, seed=payload.seed)[
                0
            ]
            params = dict(zip(artifact["parameter_names"], map(float, values), strict=True))
            spec = SceneRequest.model_validate({"seed": payload.seed, "parameters": params})
            scene = generate_scene(spec, payload.resolution)
            if not scene["gate"]["passed"]:
                raise ValueError("Sample failed the geometry gate")
            scene["metadata"]["generation_source"] = (
                f"experimental_conditional_parameter_{payload.method}"
            )
            scene["metadata"]["sampling_method"] = payload.method
            scene["metadata"]["model_sha256"] = hashlib.sha256(model.read_bytes()).hexdigest()
            scene["metadata"]["requested_conditions"] = payload.conditions
            scene["metadata"]["condition_errors"] = {
                name: scene["measurements"][name] - value
                for name, value in payload.conditions.items()
            }
            scene["metadata"]["model_limitations"] = (
                "Trained on a single synthetic procedural lineage; approximate conditioning; no measured human anatomy distribution."
            )
            scene.pop("content_hash", None)
            scene["content_hash"] = content_hash(scene)
            return {**scene, "snapshot": store.save(scene)}
        except ImportError as error:
            raise HTTPException(503, "Install the train extra to use a local model") from error
        except (ValueError, KeyError, RuntimeError) as error:
            raise HTTPException(
                422,
                {
                    "code": "LEARNED_SAMPLE_REJECTED",
                    "message": str(error),
                    "seed": payload.seed,
                    "projected": False,
                },
            ) from error

    @app.get("/api/variation/{seed}")
    def variation(seed: int) -> dict[str, Any]:
        if not 0 <= seed <= 2**32 - 1:
            raise HTTPException(422, "Seed is outside uint32")
        return dict(
            SceneRequest.model_validate(
                {"seed": seed, "parameters": sample_parameters(seed)}
            ).model_dump()
        )

    @app.post("/api/edit")
    def edit(payload: EditRequest) -> dict[str, Any]:
        base = load_snapshot(payload.base_snapshot_id)
        if content_hash(base) != payload.expected_content_hash:
            raise HTTPException(
                409, {"code": "STALE_SNAPSHOT", "message": "Base content hash does not match"}
            )
        old_params = base["spec"]["parameters"]
        new_params = payload.spec.parameters.model_dump()
        for organ_id in payload.locked_organ_ids:
            relevant = [
                key
                for key in new_params
                if (
                    key.startswith("gallbladder")
                    if organ_id == "gallbladder"
                    else not key.startswith("gallbladder")
                )
            ]
            if any(old_params[key] != new_params[key] for key in relevant):
                raise HTTPException(
                    422,
                    {
                        "code": "LOCK_CONFLICT",
                        "message": f"The request changes locked {organ_id} controls",
                    },
                )
            if (
                organ_id == "gallbladder"
                and base["spec"].get("wall_thickness_mm") != payload.spec.wall_thickness_mm
            ):
                raise HTTPException(
                    422,
                    {
                        "code": "LOCK_CONFLICT",
                        "message": "The request changes the locked gallbladder wall",
                    },
                )
        same_construction = (
            old_params == new_params
            and base["spec"]["seed"] == payload.spec.seed
            and base["spec"].get("wall_thickness_mm") == payload.spec.wall_thickness_mm
        )
        resolution = (
            base.get("metadata", {}).get("resolution", payload.resolution)
            if same_construction
            else payload.resolution
        )
        candidate = generate_scene(payload.spec, resolution)
        if not candidate["gate"]["passed"]:
            raise HTTPException(422, {"code": "GEOMETRY_GATE_FAILED", "gate": candidate["gate"]})
        preservation = []
        dependency_matches = True
        preserved_ids = set(payload.locked_organ_ids)
        for original in base["organs"]:
            organ_id = original["id"]
            relevant = [
                key
                for key in new_params
                if (
                    key.startswith("gallbladder")
                    if organ_id == "gallbladder"
                    else not key.startswith("gallbladder")
                )
            ]
            unchanged = all(old_params[key] == new_params[key] for key in relevant)
            if organ_id == "gallbladder":
                unchanged = (
                    unchanged
                    and base["spec"].get("wall_thickness_mm") == payload.spec.wall_thickness_mm
                )
            if unchanged and base["spec"]["seed"] == payload.spec.seed:
                preserved_ids.add(organ_id)
            elif original.get("metadata", {}).get("editor_modified"):
                raise HTTPException(
                    422,
                    {
                        "code": "LOCAL_EDIT_CONFLICT",
                        "message": f"Changing {organ_id} generation controls would replace its local sculpt. Undo the sculpt or explicitly regenerate first.",
                    },
                )
        for organ_id in sorted(preserved_ids):
            original = next(item for item in base["organs"] if item["id"] == organ_id)
            index = next(i for i, item in enumerate(candidate["organs"]) if item["id"] == organ_id)
            dependency_matches = dependency_matches and all(
                original[key] == candidate["organs"][index][key] for key in ("positions", "indices")
            )
            candidate["organs"][index] = copy.deepcopy(original)
            preservation.append(
                {
                    "organ_id": organ_id,
                    "scope": "surface_geometry_and_appearance",
                    "exact_hash_match": content_hash(original)
                    == content_hash(candidate["organs"][index]),
                }
            )
        # A mixed locked assembly needs new scene relations; fail rather than attach a stale gate.
        if preserved_ids:
            clearance = scene_clearance(candidate)
            if not clearance["passed"]:
                raise HTTPException(
                    422,
                    {
                        "code": "INFEASIBLE_LOCKS",
                        "message": "Locked surfaces conflict with the generated assembly",
                    },
                )
            measurements, checks = measure_realized(candidate)
            candidate["gate"] = {
                "profile": "development_preview",
                "passed": True,
                "checks": checks,
                "edit_clearance": clearance,
                "anatomical_validity": "not_evaluated",
                "simulation_verified": False,
                "self_intersection": "NOT_RUN",
            }
            candidate["measurements"] = {
                **measurements,
                "organ_clearance_mm": clearance["minimum_vertical_clearance_mm"],
            }
            if not dependency_matches:
                if payload.spec.include_vessels and not base["spec"].get("include_vessels", True):
                    raise HTTPException(
                        422,
                        {
                            "code": "DEPENDENCY_CONFLICT",
                            "message": "Showing vessels requires regenerated attachment geometry; the edited surfaces cannot supply verified attachment coordinates.",
                        },
                    )
                candidate["vessels"] = []
                candidate["anatomical_graph"] = None
                candidate.pop("simulation", None)
            candidate["metadata"]["edit_note"] = (
                "Unchanged and locked surfaces preserved exactly; dependent assets retained only when source arrays match."
            )
        candidate.pop("content_hash", None)
        candidate["content_hash"] = content_hash(candidate)
        snapshot = store.save(candidate)
        return {
            "status": "ready",
            "scene": candidate,
            "snapshot": snapshot,
            "preservation_checks": preservation,
            "base_snapshot_id": payload.base_snapshot_id,
        }

    @app.post("/api/snapshots")
    def store_realized(payload: SnapshotRequest) -> dict[str, Any]:
        """Store inspected realized surfaces; do not trust uploaded readiness badges."""
        scene = copy.deepcopy(payload.scene)
        try:
            scene["spec"] = SceneRequest.model_validate(scene["spec"]).model_dump()
            organs = scene["organs"]
            if (
                not isinstance(organs, list)
                or len(organs) != 2
                or any(not isinstance(item, dict) for item in organs)
                or {item.get("id") for item in organs} != {"gallbladder", "liver"}
            ):
                raise ValueError("The local pilot requires one liver and one gallbladder")
            metadata = scene.get("metadata", {})
            if not isinstance(metadata, dict):
                raise ValueError("Scene metadata must be an object")
            if metadata.get("resolution", "medium") not in ("low", "medium", "high"):
                raise ValueError("Unsupported source resolution")
            if (
                metadata.get("units", "mm") != "mm"
                or metadata.get("coordinate_frame", "RAS+") != "RAS+"
            ):
                raise ValueError("Uploaded surfaces must use RAS+ millimetres")

            # An upload's modification flag and derived geometry are not evidence
            # that its arrays still match the authored recipe. Only an exact
            # server-held snapshot or exact recipe reconstruction establishes it.
            reference_organs: dict[str, Any] = {}
            supplied_snapshot = scene.get("snapshot")
            if isinstance(supplied_snapshot, dict):
                identifier = supplied_snapshot.get("id")
                if isinstance(identifier, str):
                    try:
                        reference = store.load(identifier)
                    except KeyError:
                        reference = None
                    if reference is not None and all(
                        reference["spec"][key] == scene["spec"][key]
                        for key in ("seed", "parameters", "wall_thickness_mm")
                    ):
                        reference_organs = {item["id"]: item for item in reference["organs"]}
            if not reference_organs:
                # Bundled scenes and portable project imports need not have a
                # database ID on this machine. Reconstruct their bounded recipe
                # and compare actual arrays; metadata alone never proves a match.
                authored = generate_scene(
                    scene["spec"], metadata.get("resolution", "medium"), include_simulation=False
                )
                reference_organs = {item["id"]: item for item in authored["organs"]}
            for item in organs:
                mesh = checked_mesh(item)
                item_metadata = item.get("metadata", {})
                if not isinstance(item_metadata, dict):
                    raise ValueError("Organ metadata must be an object")
                if item_metadata.get("units", "mm") != "mm":
                    raise ValueError("Uploaded surfaces must use millimetres")
                item["metadata"] = item_metadata
                item_metadata["metrics"] = mesh.metadata["measurement"]
                item_metadata["anatomical_review"] = "unreviewed"
                item_metadata["units"] = "mm"
                for key, components in (("uv", 2), ("colors", 3)):
                    if key in item:
                        values = np.asarray(item[key], dtype=np.float64)
                        if (
                            values.ndim != 1
                            or values.size != len(mesh.vertices) * components
                            or not np.isfinite(values).all()
                            or (key == "colors" and (np.any(values < 0) or np.any(values > 1)))
                        ):
                            raise ValueError(f"Invalid per-vertex {key} array")
                item["normals"] = np.asarray(mesh.vertex_normals).reshape(-1).tolist()
                original = reference_organs.get(item["id"])
                matches_reference = original is not None and all(
                    item[key] == original[key] for key in ("positions", "indices")
                )
                if matches_reference and original is not None:
                    for key in ("landmarks", "lumen", "semantic_regions"):
                        item.pop(key, None)
                        if key in original:
                            item[key] = copy.deepcopy(original[key])
                    item_metadata["editor_modified"] = bool(
                        original.get("metadata", {}).get("editor_modified")
                    )
                else:
                    item_metadata["editor_modified"] = True
                    for key in ("landmarks", "lumen", "semantic_regions"):
                        item.pop(key, None)
                    item_metadata["representation"] = "closed_outer_surface"
                    item_metadata["derived_geometry_status"] = (
                        "Reference landmarks, lumen and region labels invalidated; no matching trusted source surface"
                    )
            measurements, checks = measure_realized(scene)
            clearance = scene_clearance(scene)
            if not clearance["passed"]:
                raise ValueError("Realized organs fail the assembly clearance check")
            for key in ("snapshot", "content_hash", "timing_ms", "simulation", "anatomical_graph"):
                scene.pop(key, None)
            scene["vessels"] = []
            scene["parameters"] = copy.deepcopy(scene["spec"]["parameters"])
            scene["qa"] = {"passed": True, "profile": "development_preview"}
            scene["gate"] = {
                "profile": "development_preview",
                "passed": True,
                "anatomical_validity": "not_evaluated",
                "simulation_verified": False,
                "edit_clearance": clearance,
                "self_intersection": "NOT_RUN",
                "checks": checks,
            }
            scene["measurements"] = {
                **measurements,
                "organ_clearance_mm": clearance["minimum_vertical_clearance_mm"],
            }
            scene["metadata"] = {
                **metadata,
                "review_status": "unreviewed",
                "source": "realized_surface_upload",
                "units": "mm",
                "coordinate_frame": "RAS+",
                "snapshot_source": "validated_realized_surface_upload",
            }
            scene["content_hash"] = content_hash(scene)
            return store.save(scene)
        except (ValueError, KeyError, TypeError, IndexError) as error:
            raise HTTPException(
                422, {"code": "SNAPSHOT_REJECTED", "message": str(error)}
            ) from error

    @app.get("/api/snapshots/{identifier}")
    def snapshot(identifier: str) -> dict[str, Any]:
        return load_snapshot(identifier)

    @app.get("/api/projects")
    def projects() -> list[dict[str, Any]]:
        return store.projects()

    @app.post("/api/projects/commit")
    def commit(payload: CommitRequest) -> dict[str, Any]:
        try:
            return store.commit(
                payload.project_id, payload.title, payload.snapshot_id, payload.expected_revision
            )
        except StaleRevision as error:
            raise HTTPException(409, {"code": "STALE_REVISION", "message": str(error)}) from error
        except KeyError as error:
            raise HTTPException(404, str(error)) from error

    @app.post("/api/export")
    def export(payload: ExportRequest) -> Response:
        if bool(payload.snapshot_id) == bool(payload.scene):
            raise HTTPException(422, "Supply exactly one snapshot_id or scene")
        scene = load_snapshot(payload.snapshot_id) if payload.snapshot_id else payload.scene
        assert scene is not None
        try:
            data, mime, name = export_scene(scene, payload.format)
        except (ValueError, KeyError, TypeError) as error:
            raise HTTPException(422, {"code": "EXPORT_REJECTED", "message": str(error)}) from error
        return Response(
            data, media_type=mime, headers={"Content-Disposition": f'attachment; filename="{name}"'}
        )

    return app


app = create_app()
