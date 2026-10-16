"""Local atlas library and source-bound generation routes."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator
from viscera_core.atlas_disease_scene import DiseaseAtlasSpec as LegacyAtlasSpec
from viscera_core.atlas_disease_scene import catalog as legacy_catalog
from viscera_core.atlas_disease_scene import export_glb as legacy_export
from viscera_core.atlas_disease_scene import realize as legacy_realize
from viscera_core.atlas_disease_scene_v2 import DiseaseAtlasSpecV2
from viscera_core.atlas_disease_text import compile_text
from viscera_core.atlas_material_bake import MaterialBakeBusyError

from .atlas_model_registry import resolve_model

router = APIRouter(prefix="/api/atlas", tags=["atlas"])
ROOT = Path(os.environ.get("VISCERA_PROJECT_ROOT", Path(__file__).resolve().parents[2]))
AtlasSpec = DiseaseAtlasSpecV2 | LegacyAtlasSpec
SPEC_ADAPTER = TypeAdapter(AtlasSpec)


def parse_spec(value: Any) -> AtlasSpec:
    return SPEC_ADAPTER.validate_python(value)


V2_TEMPLATES_DEFAULT = "datasets/anatomy-templates/templates-v3"


def versioned_template_root(templates: Path) -> Path:
    """V2 precision repairs must never replace the frozen V1 references. The generation-2 joint bundle binds the
    repaired templates-v3 (two of its 24 references differ from cohort-v2); a checkout that carries that folder
    uses it unless VISCERA_ATLAS_TEMPLATES_V2 says otherwise."""
    configured = os.environ.get("VISCERA_ATLAS_TEMPLATES_V2")
    if configured:
        return Path(configured)
    if os.environ.get("VISCERA_ATLAS_TEMPLATES"):   # an explicit library (tests, other checkouts) is used as given
        return Path(templates)
    repaired = ROOT / V2_TEMPLATES_DEFAULT
    return repaired if repaired.is_dir() else Path(templates)


def realize(templates: Path, spec: AtlasSpec) -> dict[str, Any]:
    if isinstance(spec, DiseaseAtlasSpecV2):
        from viscera_core.atlas_disease_scene_v2 import realize as realize_v2

        return realize_v2(versioned_template_root(templates), spec)
    return legacy_realize(templates, spec)


def export_glb(templates: Path, spec: AtlasSpec, resolution: int) -> bytes:
    if isinstance(spec, DiseaseAtlasSpecV2):
        from viscera_core.atlas_disease_scene_v2 import export_glb as export_v2

        return export_v2(versioned_template_root(templates), spec, resolution)
    return legacy_export(templates, spec, resolution)


def catalog(templates: Path) -> dict[str, Any]:
    from .atlas_joint_registry import selected_generation

    if selected_generation(ROOT) == 2:
        from viscera_core.atlas_disease_scene_v2 import catalog as catalog_v2

        result = catalog_v2(versioned_template_root(templates))
        result["renderer_version"] = "disease-v2"
        return result
    return legacy_catalog(templates)


def template_root() -> Path:
    return Path(
        os.environ.get("VISCERA_ATLAS_TEMPLATES", ROOT / "datasets/atlas/cohort-v2/templates")
    )


class CompileRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=4000)
    spec: AtlasSpec
    use_trained_language: bool = Field(default=False, strict=True)


class SurfaceEdit(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    organ_id: str = Field(min_length=1, max_length=200)
    positions: list[float] = Field(min_length=9, max_length=1_800_000)


class SurfaceVesselsBinding(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    organ_id: str = Field(min_length=1, max_length=200)
    network: dict[str, Any]


class ExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    spec: AtlasSpec
    format: Literal["glb", "unity"] = "glb"
    texture_resolution: Literal[512, 1024, 2048, 4096] = 2048
    surface_edits: list[SurfaceEdit] = Field(default_factory=list, max_length=24)
    surface_vessels: list[SurfaceVesselsBinding] = Field(default_factory=list, max_length=24)


@router.get("/catalog")
def get_catalog() -> dict[str, Any]:
    try:
        return catalog(template_root())
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(503, "Atlas templates unavailable: " + str(e)) from e


@router.post("/generate")
def generate(request: AtlasSpec) -> dict[str, Any]:
    try:
        return realize(template_root(), request)
    except (KeyError, FileNotFoundError) as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@router.post("/compile")
def compile(request: CompileRequest) -> dict[str, Any]:
    try:
        is_v2 = isinstance(request.spec, DiseaseAtlasSpecV2)
        from viscera_core import atlas_semantic as semantic

        from .atlas_wording_model import active as active_wording

        context = semantic.context_from_spec(request.spec)
        guarded = semantic.request_guard(request.text, context)
        if guarded is not None:
            return {**guarded, "policy_version": semantic.POLICY_VERSION}
        templates = template_root()
        if is_v2:
            templates = versioned_template_root(templates)
        # A newly imported wording model supersedes the older shape-only
        # adapter, including browsers that still have its old opt-in selected.
        use_wording = not request.use_trained_language or active_wording(ROOT)[1] is not None
        if use_wording:
            from .atlas_wording_model import compile_request

            if is_v2:
                from viscera_core.atlas_disease_text_v2 import compile_text as compile_v2

                original = compile_v2(templates, request.text, request.spec)
            else:
                original = compile_text(templates, request.text, request.spec)
            return compile_request(ROOT, templates, request.text, request.spec, original)
        # The optional legacy adapter only proposes shape controls. Its opt-in
        # must not disable contextual disease/material edits or baseline no-ops.
        # Parse the complete request before selecting this route: mixed edits
        # remain atomic, and ordinary shape requests still use the opted-in model.
        plan = semantic.parse_semantic(request.text, context)
        shape_operations = {"shape_relative", "shape_absolute", "control_set", "preserve"}
        if plan["status"] == "accepted" and (
            not plan["operations"]
            or any(item["op"] not in shape_operations for item in plan["operations"])
        ):
            return semantic.apply_plan(templates, request.spec, plan, text=request.text)
        if plan["status"] != "accepted":
            from viscera_core.atlas_text import compile_text as compile_shape

            # Preserve legacy-only shape syntax, but do not send a rejected
            # contextual/compound request to a model that cannot interpret it.
            legacy_shape = compile_shape(
                template_root(), request.text, request.spec.geometry_spec()
            )
            if legacy_shape["status"] != "accepted":
                return {**plan, "policy_version": semantic.POLICY_VERSION}
        # The frozen learned language adapter supports shape edits. Keep the
        # versioned disease recipe around that specifically guarded operation.
        text_spec = (
            LegacyAtlasSpec.model_validate(
                {
                    key: value
                    for key, value in request.spec.model_dump(mode="json").items()
                    if key not in ("renderer_version", "disease")
                }
            )
            if is_v2
            else request.spec
        )
        if request.use_trained_language:
            from .atlas_model_registry import data_paths, language_enabled, resolve_imported_lane

            if not language_enabled(ROOT):
                raise ValueError(
                    "Enable the imported text adapter in Trained models before using it"
                )
            from .atlas_language_model import compile_with_adapter

            _, directory = resolve_imported_lane(ROOT, "language")
            data = data_paths(ROOT)
            result = compile_with_adapter(
                template_root(),
                directory,
                data["language"],
                data["shape"],
                request.text,
                text_spec.model_dump(mode="json"),
                allow_model_download=False,
            )
        else:
            result = compile_text(template_root(), request.text, text_spec)
        if is_v2 and result.get("status") == "accepted" and result.get("spec"):
            result["spec"] = parse_spec(
                {
                    **result["spec"],
                    "renderer_version": "disease-v2",
                    "disease": request.spec.disease.model_dump() if request.spec.disease else None,
                }
            ).model_dump(mode="json")
        return result
    except (KeyError, FileNotFoundError) as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    except (ImportError, RuntimeError) as e:
        raise HTTPException(
            503, "Text adapter unavailable; enable it in Trained models: " + str(e)
        ) from e


@router.post("/export")
def export(request: ExportRequest) -> Response:
    try:
        if request.format == "unity" or request.surface_edits or request.surface_vessels:
            from viscera_core.atlas_material_bake import export_material_glb
            from viscera_core.atlas_unity_export import (
                apply_surface_edits,
                bind_surface_vessels,
                export_edited_vertex_glb,
                export_unity,
            )

            if not request.spec.realized_id or not request.spec.template_sha256:
                raise ValueError("Export requires the bound spec of the displayed specimen")
            result = realize(template_root(), request.spec)
            if result["spec"]["realized_id"] != request.spec.realized_id:
                raise ValueError("Export recipe does not match the displayed specimen")
            apply_surface_edits(result, [item.model_dump() for item in request.surface_edits])
            if request.surface_vessels:
                if request.spec.material is None:
                    raise ValueError("Surface vessel export requires a tissue material")
                bind_surface_vessels(
                    result, [item.model_dump() for item in request.surface_vessels]
                )
            if request.format == "unity":
                if request.spec.material is None:
                    raise ValueError(
                        "Unity texture export requires Tissue appearance with a material"
                    )
                binary = export_unity(result, request.spec.material, request.texture_resolution)
            elif request.spec.material is not None:
                binary = export_material_glb(
                    result, request.spec.material, request.texture_resolution
                )
            else:
                binary = export_edited_vertex_glb(result)
        else:
            binary = export_glb(template_root(), request.spec, request.texture_resolution)
        suffix = "unity.zip" if request.format == "unity" else "glb"
        return Response(
            binary,
            media_type="application/zip" if request.format == "unity" else "model/gltf-binary",
            headers={
                "Content-Disposition": f'attachment; filename="{request.spec.template_id}-{request.spec.seed}.{suffix}"'
            },
        )
    except (KeyError, FileNotFoundError) as e:
        raise HTTPException(404, str(e)) from e
    except MaterialBakeBusyError as e:
        raise HTTPException(503, str(e), headers={"Retry-After": "2"}) from e
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


class SampleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    spec: AtlasSpec
    match_dimensions: bool = Field(default=True, strict=True)


@router.post("/sample")
def sample(request: SampleRequest) -> dict[str, Any]:
    from .atlas_model import sample_model

    dataset = Path(os.environ.get("VISCERA_ATLAS_DATASET", ROOT / "datasets/atlas/cohort-v2"))
    try:
        model = resolve_model(ROOT, "shape")
        result = sample_model(
            template_root(), model, dataset, request.spec.geometry_spec(), request.match_dimensions
        )
        if (
            request.spec.material is not None
            or request.spec.disease is not None
            or isinstance(request.spec, DiseaseAtlasSpecV2)
        ):
            target = parse_spec(
                {
                    **result["spec"],
                    **(
                        {"renderer_version": "disease-v2"}
                        if isinstance(request.spec, DiseaseAtlasSpecV2)
                        else {}
                    ),
                    "material": request.spec.material.model_dump()
                    if request.spec.material
                    else None,
                    "disease": request.spec.disease.model_dump() if request.spec.disease else None,
                }
            )
            decorated = realize(template_root(), target)
            decorated["summary"]["model"] = result["summary"]["model"]
            decorated["scene"]["metadata"]["model"] = result["scene"]["metadata"]["model"]
            return decorated
        return result
    except (FileNotFoundError, ImportError) as e:
        raise HTTPException(
            503,
            "Atlas model unavailable. Install the training extra and prepare the checksummed model/dataset: "
            + str(e),
        ) from e
    except KeyError as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


class JointSampleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    spec: AtlasSpec
    seed: int = Field(default=42, ge=0, le=2**32 - 1, strict=True)
    temperature: float = Field(default=1.0, ge=0.2, le=1.5, strict=True)
    severity: Literal["auto", "mild", "moderate", "severe"] = "auto"


@router.post("/sample-joint")
def sample_joint(request: JointSampleRequest) -> dict[str, Any]:
    from .atlas_joint_registry import selected_generation

    try:
        if selected_generation(ROOT) == 2:
            from .atlas_joint_model_v2 import sample_model

            return sample_model(
                ROOT, request.spec, request.seed, request.temperature, request.severity
            )
        if request.severity != "auto":
            raise ValueError("Severity-stratified sampling requires the expanded v2 model")
        from .atlas_joint_model import sample_model

        return sample_model(ROOT, request.spec, request.seed, request.temperature)
    except (FileNotFoundError, ImportError) as error:
        raise HTTPException(503, f"Joint VAE unavailable: {error}") from error
    except (ValueError, KeyError, TypeError) as error:
        raise HTTPException(422, str(error)) from error


class MaterialSampleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    spec: AtlasSpec
    seed: int = Field(default=42, ge=0, le=2**32 - 1, strict=True)
    conditions: dict[str, float] | None = None

    @field_validator("conditions", mode="before")
    @classmethod
    def numeric_conditions(cls, value: Any) -> Any:
        if value is not None and (
            not isinstance(value, dict)
            or any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in value.values())
        ):
            raise ValueError("Material conditions must be numeric")
        return value


@router.post("/sample-material")
def sample_material(request: MaterialSampleRequest) -> dict[str, Any]:
    from .atlas_material_model import sample_material_model

    dataset = Path(
        os.environ.get("VISCERA_ATLAS_MATERIAL_DATASET", ROOT / "datasets/atlas/material-v1")
    )
    try:
        model = resolve_model(ROOT, "material")
        result = sample_material_model(
            template_root(),
            model,
            dataset,
            request.spec.surface_spec(),
            request.seed,
            request.conditions,
        )
        if request.spec.disease is not None or isinstance(request.spec, DiseaseAtlasSpecV2):
            target = parse_spec(
                {
                    **result["spec"],
                    **(
                        {"renderer_version": "disease-v2"}
                        if isinstance(request.spec, DiseaseAtlasSpecV2)
                        else {}
                    ),
                    "disease": request.spec.disease.model_dump() if request.spec.disease else None,
                }
            )
            decorated = realize(template_root(), target)
            decorated["summary"]["material_model"] = result["summary"]["material_model"]
            decorated["scene"]["metadata"]["material_model"] = result["scene"]["metadata"][
                "material_model"
            ]
            return decorated
        return result
    except (FileNotFoundError, ImportError) as e:
        raise HTTPException(
            503,
            "Material model unavailable; install training dependencies and the material release: "
            + str(e),
        ) from e
    except KeyError as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


class DiseaseSampleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    spec: AtlasSpec
    seed: int = Field(default=42, ge=0, le=2**32 - 1, strict=True)


@router.post("/sample-disease")
def sample_disease(request: DiseaseSampleRequest) -> dict[str, Any]:
    from .atlas_disease_model import sample_recipe_model

    if request.spec.disease is None:
        raise HTTPException(422, "Choose a disease profile before sampling")
    data = Path(os.environ.get("VISCERA_DISEASE_DATASET", ROOT / "disease-releases/recipes-v2"))
    try:
        model = resolve_model(ROOT, "disease")
        proposal = sample_recipe_model(model, data, request.spec.disease.profile_id, request.seed)
        target = parse_spec(
            {**request.spec.model_dump(), "disease": proposal["disease"], "realized_id": None}
        )
        result = realize(template_root(), target)
        result["summary"]["disease_model"] = proposal["model"]
        result["scene"]["metadata"]["disease_model"] = proposal["model"]
        return result
    except (FileNotFoundError, ImportError) as e:
        raise HTTPException(
            503,
            "Disease model unavailable; install the paired disease model and recipe release: "
            + str(e),
        ) from e
    except (ValueError, KeyError) as e:
        raise HTTPException(422, str(e)) from e
