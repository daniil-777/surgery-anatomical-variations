"""Local Studio weight upload/status API with bounded disk-backed staging."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from . import atlas_model_registry as registry

ROOT = Path(os.environ.get("VISCERA_PROJECT_ROOT", Path(__file__).resolve().parents[2]))
router = APIRouter(prefix="/api/atlas/models", tags=["Atlas models"])


@router.get("")
def models_status() -> dict[str, Any]:
    try:
        return registry.model_status(ROOT)
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise HTTPException(503, str(error)) from error


@router.post("/import")
async def import_models(request: Request) -> dict[str, Any]:
    if request.headers.get("content-type", "").split(";")[0] not in {
        "application/zip",
        "application/octet-stream",
    }:
        raise HTTPException(415, "Upload the weight ZIP as application/zip")
    # Stream to disk, rather than buffering an adapter-sized ZIP in Python memory.
    with tempfile.TemporaryDirectory(prefix="viscera-weight-upload-") as temporary:
        archive = Path(temporary) / "weights.zip"
        total = 0
        with archive.open("wb") as stream:
            async for chunk in request.stream():
                total += len(chunk)
                if total > registry.MAX_UPLOAD_BYTES:
                    raise HTTPException(413, "Weight upload exceeds 128 MiB")
                stream.write(chunk)
        try:
            return await run_in_threadpool(registry.import_weights, ROOT, archive)
        except Exception as error:
            # ZIP, JSON, numpy, torch's weights-only loader and all provenance
            # errors abort staging; the previously active registry is untouched.
            raise HTTPException(422, f"Weights were not activated: {error}") from error


@router.post("/defaults")
def use_defaults(request: Request) -> dict[str, Any]:
    if request.headers.get("content-type", "").split(";")[0] != "application/json":
        raise HTTPException(415, "Use application/json for model changes")
    return registry.restore_defaults(ROOT)


@router.get("/joint/history")
def joint_model_history() -> dict[str, Any]:
    from .atlas_joint_registry import history

    try:
        return history(ROOT)
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise HTTPException(503, str(error)) from error


class JointVersionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    generation: Literal[1, 2]
    bundle_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


@router.post("/joint/activate")
def activate_joint_version(request: JointVersionRequest) -> dict[str, Any]:
    from .atlas_joint_registry import activate_retained

    try:
        return activate_retained(ROOT, request.generation, request.bundle_sha256)
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise HTTPException(422, f"Retained weights were not activated: {error}") from error


class ClinicalSampleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    organ: str = Field(min_length=1, max_length=100)
    disease_code: str = Field(min_length=1, max_length=100)
    seed: int = Field(default=42, ge=0, le=2**32 - 1, strict=True)


class LanguageEnableRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    allow_model_download: bool = Field(default=False, strict=True)


@router.post("/language/enable")
def enable_language(request: LanguageEnableRequest) -> dict[str, Any]:
    if not request.allow_model_download:
        raise HTTPException(
            422, "Explicitly enable the text adapter and its pinned base-model download"
        )
    try:
        from .atlas import template_root
        from .atlas_language_model import enable_adapter

        identifier, directory = registry.resolve_imported_lane(ROOT, "language")
        data = registry.data_paths(ROOT)
        enable_adapter(
            template_root(), directory, data["language"], data["shape"], allow_model_download=True
        )
        return registry.mark_language_enabled(ROOT, identifier)
    except ImportError as error:
        raise HTTPException(
            503,
            "Install the language dependencies (uv sync --extra train --extra disease-data --extra language) before enabling the adapter",
        ) from error
    except (OSError, ValueError, RuntimeError, KeyError, TypeError) as error:
        raise HTTPException(422, f"Text adapter was not enabled: {error}") from error


@router.post("/clinical/sample")
def clinical_sample(request: ClinicalSampleRequest) -> dict[str, Any]:
    from .atlas_disease_model import sample_source_model

    try:
        _, directory = registry.resolve_imported_lane(ROOT, "clinical")
        return sample_source_model(
            directory / "source_model.json",
            registry.data_paths(ROOT)["clinical"],
            request.organ,
            request.disease_code,
            seed=request.seed,
            count=1,
        )
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise HTTPException(422, f"Observed-case retrieval unavailable: {error}") from error
