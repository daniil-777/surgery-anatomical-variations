"""Local image-only analysis. Images remain in memory and are never forwarded."""

from __future__ import annotations

import hashlib
import threading
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from viscera_core.atlas_materials import PROFILES
from viscera_core.reference_analysis import (
    MAX_IMAGE_BYTES,
    RegionSelection,
    analyze_image,
    decode_base64,
    decode_mask,
    decode_photo,
    local_segment,
)

router = APIRouter(prefix="/api/atlas/reference-material", tags=["reference material"])
_ANALYSIS_LOCK = threading.Lock()
# These additional canonical tissue names cover the registered whole-scene soft
# structures. A name is an explicit assignment, never an inferred diagnosis.
REFERENCE_ORGANS = frozenset(PROFILES) | {
    "esophagus", "duodenum", "diaphragm", "mesentery", "ureter", "bile-duct",
    "pancreatic-duct", "trachea", "bronchi", "artery", "vein",
}
MAX_REGIONS = 12


@router.get("/status")
def status() -> dict:
    from .reference_segmenter import sam2_status

    sam2 = sam2_status()
    return {"sam2": sam2, "default_segmentation": "sam2" if sam2["configured"] else "local"}


class AnalyzeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    image_base64: str = Field(min_length=4, max_length=MAX_IMAGE_BYTES * 4 // 3 + 4)
    organ: str
    selection: RegionSelection
    mask_base64: str | None = Field(default=None, max_length=MAX_IMAGE_BYTES * 4 // 3 + 4)
    segmentation: Literal["local", "sam2"] = "local"

    @field_validator("organ")
    @classmethod
    def known_organ(cls, value: str) -> str:
        if value not in REFERENCE_ORGANS:
            raise ValueError("Select an organ from the material library")
        return value


class AnalyzeRegion(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    organ: str
    selection: RegionSelection
    mask_base64: str | None = Field(default=None, max_length=MAX_IMAGE_BYTES * 4 // 3 + 4)

    @field_validator("organ")
    @classmethod
    def known_organ(cls, value: str) -> str:
        return AnalyzeRequest.known_organ(value)


class AnalyzeRegionsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    image_base64: str = Field(min_length=4, max_length=MAX_IMAGE_BYTES * 4 // 3 + 4)
    segmentation: Literal["local", "sam2"] = "local"
    regions: list[AnalyzeRegion] = Field(min_length=1, max_length=MAX_REGIONS)

    @model_validator(mode="after")
    def unique_regions(self) -> AnalyzeRegionsRequest:
        if len({region.id for region in self.regions}) != len(self.regions):
            raise ValueError("Each tissue region needs a unique identifier")
        if len(self.image_base64) + sum(len(region.mask_base64 or "") for region in self.regions) > 32 * 1024 * 1024:
            raise ValueError("Combined image and masks exceed the 32 MiB request limit")
        return self


def _analyze_region(image, original_size, source_hash, region, segmentation, notices):
    notices = list(notices)
    if region.mask_base64 is not None:
        mask = decode_mask(decode_base64(region.mask_base64), original_size, image.size)
        meta = {"method": "uploaded-mask", "learned": False,
                "semantic_identity": "user_assigned", "review_required": True}
    elif segmentation == "sam2":
        from .reference_segmenter import segment_sam2

        mask, meta = segment_sam2(image, region.selection.box,
                                  region.selection.foreground_points,
                                  region.selection.background_points)
    else:
        mask, meta = local_segment(image, region.selection)
        notices.append("Local segmentation follows image edges, not organ anatomy. Refine points or upload a mask if it leaks.")
    return analyze_image(image, mask, region.organ, source_hash, meta, notices)


@router.post("/analyze")
def analyze(request: AnalyzeRequest) -> dict:
    if not _ANALYSIS_LOCK.acquire(blocking=False):
        raise HTTPException(429, "Another reference image is being analysed; retry shortly")
    try:
        raw = decode_base64(request.image_base64)
        image, original_size, notices = decode_photo(raw)
        return _analyze_region(image, original_size, hashlib.sha256(raw).hexdigest(),
                               request, request.segmentation, notices)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except (ImportError, RuntimeError) as exc:
        raise HTTPException(503, str(exc)) from exc
    finally:
        _ANALYSIS_LOCK.release()


@router.post("/analyze-regions")
def analyze_regions(request: AnalyzeRegionsRequest) -> dict:
    """Decode one photograph once and report each explicitly assigned region.

    Failed regions stay visible as errors. Nothing here commits materials or
    fills unseen organs. Multiple photographs are queued by the client so the
    normal upload bound and one-analysis-per-process limit still apply.
    """
    if not _ANALYSIS_LOCK.acquire(blocking=False):
        raise HTTPException(429, "Another reference image is being analysed; retry shortly")
    try:
        raw = decode_base64(request.image_base64)
        image, original_size, notices = decode_photo(raw)
        source_hash = hashlib.sha256(raw).hexdigest()
        results = []
        for region in request.regions:
            try:
                analysis = _analyze_region(image, original_size, source_hash, region,
                                           request.segmentation, notices)
                results.append({"id": region.id, "analysis": analysis})
            except (ValueError, ImportError, RuntimeError) as exc:
                results.append({"id": region.id, "error": str(exc)})
        return {"version": "reference-regions-1", "source_sha256": source_hash,
                "results": results}
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    finally:
        _ANALYSIS_LOCK.release()
