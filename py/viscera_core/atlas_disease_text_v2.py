"""Explicit disease design grammar composed atomically with shape/material edits."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .atlas_disease_scene_v2 import DiseaseAtlasSpecV2 as DiseaseAtlasSpec
from .atlas_disease_text import ALIASES as LEGACY_ALIASES
from .atlas_disease_v2 import PROFILES, DiseaseSpec
from .atlas_material_text import compile_text as compile_surface
from .atlas_materials import make_recipe
from .atlas_scene import catalog, get_template

POLICY_VERSION = "atlas-disease-text-2.0.0"

ALIASES = {
    key: sorted(
        set(LEGACY_ALIASES.get(key, []) + [key, key.replace("-", " "), profile["label"].lower()]),
        key=len,
        reverse=True,
    )
    for key, profile in PROFILES.items()
}
ALIASES["liver-steatotic-enlargement"].extend(["fatty liver", "steatotic liver"])


def compile_text(root: str | Path, text: str, spec: DiseaseAtlasSpec) -> dict[str, Any]:
    def refused(message: str) -> dict[str, Any]:
        return {"status": "unsupported", "message": message, "policy_version": POLICY_VERSION}

    remaining = text.lower().strip().rstrip(".!")
    selected = []
    for key, aliases in ALIASES.items():
        pattern = (
            r"\b(?:"
            + "|".join(re.escape(x) for x in sorted(aliases + [key], key=len, reverse=True))
            + r")\b"
        )
        if re.search(pattern, remaining):
            selected.append(key)
            remaining = re.sub(pattern, " ", remaining)
    healthy = bool(re.search(r"\b(?:healthy|baseline|clear disease)\b", remaining))
    changes = {}
    for name in ("severity", "size", "spread", "irregularity", "contrast", "count", "disease seed"):
        pattern = r"\b" + name + r"\s*(?:to|=|:)?\s*(-?\d+(?:\.\d+)?)\b"
        matches = re.findall(pattern, remaining)
        if len(matches) > 1:
            return refused(f"Specify {name} once.")
        if matches:
            raw = matches[0]
            if name in ("count", "disease seed") and "." in raw:
                return refused(f"{name} must be an integer.")
            changes["seed" if name == "disease seed" else name] = (
                int(raw) if name in ("count", "disease seed") else float(raw)
            )
            remaining = re.sub(pattern, " ", remaining)
    disease_intent = bool(selected or healthy or changes)
    if not disease_intent:
        result = compile_surface(root, text, spec.surface_spec())
        if result["status"] == "accepted":
            target = DiseaseAtlasSpec.model_validate(
                {**result["spec"], "renderer_version": "disease-v2"}
            )
            if spec.disease is not None:
                if (
                    get_template(root, target.template_id).metadata["organ"]
                    != PROFILES[spec.disease.profile_id]["organ"]
                ):
                    return refused(
                        "Clear the disease or choose a compatible disease when changing organs."
                    )
                target.disease = spec.disease
            result["spec"] = target.model_dump(mode="json")
        return result
    if len(selected) > 1 or healthy and selected:
        return refused("Choose one disease profile or baseline per request.")
    if re.search(
        r"\b(not|no|without|except|avoid|unless|never|remove|resect|cut|stage|grade|stiffness|kpa|mm|cm)\b",
        remaining,
    ):
        return refused(
            "This grammar supports explicit morphology controls, not negation, clinical stages, dimensions or tissue mechanics."
        )
    if selected and not PROFILES[selected[0]]["supported"]:
        return refused(PROFILES[selected[0]]["unavailable_reason"])
    target = spec.model_copy(deep=True)
    try:
        if selected:
            profile = PROFILES[selected[0]]
            current_organ = get_template(root, target.template_id).metadata["organ"]
            if current_organ != profile["organ"]:
                organ = next(
                    (o for o in catalog(root)["organs"] if o["id"] == profile["organ"]), None
                )
                if organ is None:
                    return refused("This anatomy library has no matching organ reference.")
                target.template_id = organ["templates"][0]["id"]
                target.controls = {key: 0.0 for key in target.controls}
                if target.material is not None:
                    target.material = make_recipe(profile["organ"], seed=target.material.seed)
            existing = (
                spec.disease
                if spec.disease and spec.disease.profile_id == selected[0]
                else DiseaseSpec(profile_id=selected[0], seed=spec.seed)
            )
            target.disease = DiseaseSpec.model_validate({**existing.model_dump(), **changes})
        elif healthy:
            if changes:
                return refused("Baseline has no active disease controls.")
            target.disease = None
            remaining = re.sub(r"\b(?:healthy|baseline|clear disease)\b", " ", remaining)
        elif spec.disease is not None:
            target.disease = DiseaseSpec.model_validate({**spec.disease.model_dump(), **changes})
        else:
            return refused("Choose a disease profile before setting disease controls.")
        # Unconsumed meaningful tokens still pass through the existing strict compiler.
        residual = re.sub(
            r"\b(make|the|a|an|please|generate|create|show|use|select|organ|reference|shape|and|with|set|to|be|it|disease)\b|[\s,;]+",
            " ",
            remaining,
        ).strip()
        if residual:
            result = compile_surface(root, remaining, target.surface_spec())
            if result["status"] != "accepted":
                return result
            revised = DiseaseAtlasSpec.model_validate(
                {**result["spec"], "renderer_version": "disease-v2"}
            )
            if (
                target.disease
                and get_template(root, revised.template_id).metadata["organ"]
                != PROFILES[target.disease.profile_id]["organ"]
            ):
                return refused("Disease and requested organ conflict.")
            revised.disease = target.disease
            target = revised
        target.template_sha256 = None
        target.realized_id = None
        return {
            "status": "accepted",
            "spec": target.model_dump(mode="json"),
            "message": "Prepared disease morphology design. Strength is an engineering control, not a clinical stage.",
            "policy_version": POLICY_VERSION,
        }
    except ValueError as e:
        return refused(str(e))
