"""Atomic material-edit grammar composed with the unchanged atlas shape compiler."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .atlas_materials import MaterialRecipe, make_recipe
from .atlas_scene import get_template
from .atlas_surface_scene import SurfaceAtlasSpec
from .atlas_text import compile_text as compile_geometry

POLICY_VERSION = "atlas-shape-material-text-2.0.0"


def compile_text(root: str | Path, text: str, spec: SurfaceAtlasSpec) -> dict[str, Any]:
    original = spec.model_dump()
    remaining = text.lower().strip().rstrip(".!")
    changes: dict[str, Any] = {}
    preset: str | None = None

    def refused(message: str) -> dict[str, Any]:
        return {"status": "unsupported", "message": message, "policy_version": POLICY_VERSION}

    try:
        # Never consume unsupported negatives or pathology intent before the legacy guard.
        if re.search(
            r"\b(not|no|without|except|avoid|unless|never|tumou?r|disease|resect|remove|cut)\b",
            remaining,
        ):
            return compile_geometry(root, text, spec.geometry_spec())

        def assign(key: str, value: Any) -> None:
            if key in changes:
                raise ValueError(f"Specify {key.replace('_', ' ')} only once per request.")
            changes[key] = value

        def replace_preset(match: re.Match[str]) -> str:
            nonlocal preset
            if preset is not None:
                raise ValueError("Choose one surface preset per request.")
            preset = match.group(1)
            return " "

        remaining = re.sub(
            r"\b(balanced|soft|rich|moist)\s+(?:surface|texture|material)(?:\s+preset)?\b",
            replace_preset,
            remaining,
        )
        labels = {
            "tint": "tint",
            "pigment contrast": "pigment_contrast",
            "mottle scale": "mottle_scale_mm",
            "wetness": "wetness",
            "fine detail": "fine_detail",
            "structure strength": "structure_strength",
            "texture seed": "seed",
            "surface seed": "seed",
        }
        for label, key in labels.items():

            def replace_value(match: re.Match[str], key: str = key) -> str:
                raw = match.group(1)
                if key == "seed" and "." in raw:
                    raise ValueError("Texture seed must be an integer.")
                assign(key, int(raw) if key == "seed" else float(raw))
                return " "

            pattern = r"\b" + label + r"\s*(?:to|=|:)?\s*(-?\d+(?:\.\d+)?)\b"
            if key == "mottle_scale_mm":
                pattern += r"(?:\s*mm\b)?"
            remaining = re.sub(pattern, replace_value, remaining)
        # Qualitative edits are bounded, explicit design requests (not diagnoses).
        relative = {
            "wetter": ("wetness", 0.15),
            "drier": ("wetness", -0.15),
            "more mottled": ("pigment_contrast", 0.15),
            "less mottled": ("pigment_contrast", -0.15),
            "warmer": ("tint", 0.2),
            "cooler": ("tint", -0.2),
            "more fine detail": ("fine_detail", 0.15),
            "less fine detail": ("fine_detail", -0.15),
        }
        relative_edits: dict[str, float] = {}
        for phrase, (key, delta) in relative.items():
            count = len(re.findall(r"\b" + phrase + r"\b", remaining))
            if count:
                if count > 1 or key in relative_edits or key in changes:
                    raise ValueError(f"Conflicting or repeated {key.replace('_', ' ')} edits.")
                relative_edits[key] = delta
                remaining = re.sub(r"\b" + phrase + r"\b", " ", remaining)
        material_edit = bool(preset or changes or relative_edits)
        if not material_edit:
            result = compile_geometry(root, text, spec.geometry_spec())
        else:
            residual = re.sub(
                r"\b(make|the|a|an|please|generate|create|show|use|select|organ|reference|shape|and|with|set|to|be|it)\b|[\s,;]+",
                " ",
                remaining,
            ).strip()
            # Shape-only parser still sees every unconsumed meaningful token.
            if residual:
                result = compile_geometry(root, remaining, spec.geometry_spec())
            else:
                result = {
                    "status": "accepted",
                    "spec": spec.geometry_spec().model_dump(),
                    "message": "Prepared surface-only edit; shape is unchanged.",
                    "policy_version": POLICY_VERSION,
                }
        if result["status"] != "accepted":
            return result
        target = SurfaceAtlasSpec.model_validate(result["spec"])
        organ = get_template(root, target.template_id).metadata["organ"]
        material = spec.material
        if material_edit:
            if material is None or material.organ != organ or preset:
                material = make_recipe(
                    organ, preset=preset or "balanced", seed=material.seed if material else 42
                )
            values = material.model_dump()
            values.update(changes)
            for key, delta in relative_edits.items():
                values[key] += delta
            material = MaterialRecipe.model_validate(values)
            if target.appearance != "tissue" and re.search(r"\b(source|clay)\b", text.lower()):
                return refused("Choose an authored surface or source/clay appearance, not both.")
            target.appearance = "tissue"
        elif target.appearance != "tissue":
            material = None
        elif material is not None and material.organ != organ:
            material = make_recipe(organ, preset=material.preset, seed=material.seed)
        target.material = material
        target.realized_id = None
        target.template_sha256 = None
        result["spec"] = target.model_dump()
        if material_edit or spec.material is not None:
            result["policy_version"] = POLICY_VERSION
            result["material_interpretation"] = (
                "Authored appearance controls; no tissue measurement or disease inference."
            )
            if material_edit:
                result["message"] += " Surface recipe prepared."
        if spec.model_dump() != original:
            raise RuntimeError("Compiler mutated its input")
        return result
    except ValueError as error:
        return refused(str(error))
