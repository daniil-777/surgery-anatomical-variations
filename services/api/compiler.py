"""Deterministic, bounded language compiler for the procedural pilot capabilities.

Unknown operations fail without applying recognized fragments. This compiler is a
baseline for a separately trained language model, not a diagnostic interpreter.
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
from typing import Any

from pydantic import ValidationError
from viscera_core.schema import DEFAULT_PARAMETERS, PARAMETER_BOUNDS, SceneRequest

POLICY_VERSION = "pilot-rules@0.1.1"
FIELDS: dict[str, tuple[str, ...]] = {
    "liver_width_mm": (r"liver\s+width",),
    "liver_height_mm": (r"liver\s+height",),
    "liver_depth_mm": (r"liver\s+depth",),
    "left_lobe_ratio": (r"left[ -]lobe\s+ratio", r"lobe\s+ratio"),
    "inferior_concavity": (r"inferior\s+concavity", r"concavity"),
    "fissure_depth_mm": (r"fissure\s+depth", r"fissure"),
    "gallbladder_length_mm": (r"gallbladder\s+length",),
    "gallbladder_radius_mm": (r"gallbladder\s+radius",),
}
LIMITS = PARAMETER_BOUNDS
DEFAULTS = DEFAULT_PARAMETERS
NUMBER = r"([+-]?(?:\d+(?:\.\d*)?|\.\d+))"
UNIT = r"\s*(mm|cm|millimet(?:er|re)s?|centimet(?:er|re)s?|%)?(?![a-z0-9])"


def content_hash(value: object) -> str:
    """Content identity excludes no semantic fields; nonfinite JSON is rejected."""
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()


def compile_text(
    text: str,
    spec: dict[str, Any] | None = None,
    selected_organ_id: str | None = None,
) -> dict[str, Any]:
    """Compile a supported request atomically; numeric lengths need stated units."""
    source = copy.deepcopy(spec or {})
    source.setdefault("seed", 1234)
    source.setdefault("title", "Original abdominal anatomy")
    source["parameters"] = {**DEFAULTS, **source.get("parameters", {})}
    source.setdefault("include_vessels", True)
    source.setdefault("wall_thickness_mm", 1.5)
    output: dict[str, Any] = {
        "schema_version": "0.1.0",
        "policy_version": POLICY_VERSION,
        "input_spec_hash": content_hash(source),
        "status": "ready",
        "patches": [],
        "changes": [],
        "clarifications": [],
        "unsupported": [],
        "message": "",
        "spec": None,
    }

    def fail(status: str, message: str) -> dict[str, Any]:
        output.update(status=status, message=message, spec=None, patches=[], changes=[])
        output["clarifications" if status == "needs_clarification" else "unsupported"].append(
            message
        )
        return output

    if not text.strip() or len(text) > 4000:
        return fail(
            "needs_clarification",
            "Describe an organ or a supported shape change in 1–4000 characters.",
        )
    normalized = re.sub(r"[–—]", "-", text.lower().strip())
    prohibited = re.search(
        r"\b(tumo[u]?r|cirrhosis|fibrosis|cancer|metastasis|cyst|stone|kidney|spleen|pancreas|uterus|heart|lung|cut|resect|diagnos\w*|child|pediatric|paediatric|pregnan\w*)\b",
        normalized,
    )
    if prohibited:
        return fail(
            "unsupported",
            f"“{prohibited.group()}” is outside the implemented liver/gallbladder pilot. No changes applied.",
        )
    if re.search(r"\b(possible|maybe|suspected|history of|unless|if|either|or)\b", normalized):
        return fail(
            "needs_clarification",
            "Specify one definite geometry request; conditional or uncertain anatomy is not applied automatically.",
        )
    if re.search(
        r"\b(purple|blue|green|redder|color|colour|texture|softer|stiffer|softness|elastic|stiffness)\b",
        normalized,
    ):
        return fail(
            "unsupported",
            "Use the Appearance or Interaction controls for this change; the current text compiler controls anatomy dimensions and proportions.",
        )
    if re.search(r"\b(volume|lit(?:er|re)|ml|mL)\b", normalized):
        return fail(
            "needs_clarification",
            "This pilot exposes measured envelope volume and direct dimension controls. Specify liver width, height and depth in mm, or use the inspector.",
        )
    if re.search(r"\b(bigger|larger|smaller|twice|size)\b", normalized) and not re.search(
        r"left[ -]lobe", normalized
    ):
        return fail(
            "needs_clarification",
            "Specify which dimension to change and by how much; length and volume changes are different.",
        )

    if re.search(
        r"\bgallbladder\s+(?:(?:inferior\s+)?concavity|fissure|(?:left[ -])?lobe\s+ratio)\b",
        normalized,
    ):
        return fail(
            "unsupported",
            "Concavity, fissure depth and lobe ratio are liver controls. No gallbladder equivalent is implemented; the liver was not changed.",
        )

    # Bind generic dimensions before field extraction. A suffix match such as
    # "width" inside "gallbladder width" must never target the liver. Fissure
    # depth is a separate, more-specific control and is not liver depth.
    generic_spans: list[tuple[int, int]] = []
    for dimension in re.finditer(r"\b(width|height|depth)\b", normalized):
        prefix = normalized[: dimension.start()]
        previous = re.search(r"([a-z]+)\s+$", prefix)
        qualifier = previous.group(1) if previous else None
        if qualifier == "liver" or (qualifier == "fissure" and dimension.group() == "depth"):
            continue
        if qualifier == "gallbladder":
            return fail(
                "unsupported",
                "Gallbladder width, height and depth are not implemented controls. Specify gallbladder length or radius; the liver was not changed.",
            )
        if selected_organ_id != "liver":
            return fail(
                "needs_clarification",
                "Name the organ for width, height or depth. Unqualified dimensions apply only when the liver is explicitly selected.",
            )
        generic_spans.append(dimension.span())
    for start, end in reversed(generic_spans):
        normalized = normalized[:start] + "liver " + normalized[start:end] + normalized[end:]

    preserve_pattern = re.compile(
        r"\b(?:keep|preserve|leave)\s+(?:the\s+)?(liver|gallbladder|other organs|everything else|rest)\s+(?:unchanged|fixed|the same)\b"
    )
    preservation_targets = [match.group(1) for match in preserve_pattern.finditer(normalized)]

    candidate = copy.deepcopy(source)
    updates: dict[str, float | bool | int] = {}
    spans: list[tuple[int, int]] = []
    for field, names in FIELDS.items():
        label = "(?:" + "|".join(names) + ")"
        # Relative controls require an explicit direction and unit/percentage.
        relative = re.compile(
            r"\b(increase|decrease|reduce)\s+(?:the\s+)?" + label + r"\s+by\s+" + NUMBER + UNIT
        )
        matches: list[tuple[re.Match[str], float]] = []
        for match in relative.finditer(normalized):
            amount = float(match.group(2))
            unit = match.group(3)
            if amount < 0:
                return fail(
                    "needs_clarification", "Use a positive magnitude after increase/decrease."
                )
            if not field.endswith("_mm") and unit not in (None, "%"):
                return fail(
                    "needs_clarification",
                    f"{field.replace('_', ' ')} is dimensionless; use a fraction or percentage, not length units.",
                )
            direction = 1 if match.group(1) == "increase" else -1
            old = float(source["parameters"][field])
            if unit == "%":
                value = old * (1 + direction * amount / 100)
            elif field.endswith("_mm"):
                if not unit:
                    return fail(
                        "needs_clarification", f"State mm or cm for {field.replace('_', ' ')}."
                    )
                value = old + direction * amount * (10 if unit.startswith("c") else 1)
            else:
                value = old + direction * amount
            matches.append((match, value))
        absolute = re.compile(r"\b" + label + r"\s*(?:=|:|to|of|is)?\s*" + NUMBER + UNIT)
        for match in absolute.finditer(normalized):
            if any(match.start() >= m.start() and match.end() <= m.end() for m, _ in matches):
                continue
            amount = float(match.group(1))
            unit = match.group(2)
            if not field.endswith("_mm") and unit not in (None, "%"):
                return fail(
                    "needs_clarification",
                    f"{field.replace('_', ' ')} is dimensionless; use a fraction or percentage, not length units.",
                )
            if field.endswith("_mm") and not unit:
                return fail("needs_clarification", f"State mm or cm for {field.replace('_', ' ')}.")
            if field.endswith("_mm") and unit == "%":
                return fail(
                    "needs_clarification",
                    "For percentages, say increase/decrease the named dimension by a percentage.",
                )
            value = amount * (10 if unit and unit.startswith("c") else 0.01 if unit == "%" else 1)
            matches.append((match, value))
        if matches:
            values = {round(value, 8) for _, value in matches}
            if len(values) > 1:
                return fail(
                    "needs_clarification", f"Conflicting values for {field.replace('_', ' ')}."
                )
            updates[field] = matches[0][1]
            spans.extend((m.start(), m.end()) for m, _ in matches)

    # Named, visible synthetic presets. Every output explains these resolutions.
    presets: list[tuple[str, str, float]] = [
        (r"(?:broader|larger|prominent|wider)\s+left[ -]lobe", "left_lobe_ratio", 0.68),
        (r"(?:slender|smaller|narrower|tapered)\s+left[ -]lobe", "left_lobe_ratio", 0.38),
        (r"(?:deep|deeper)\s+(?:central\s+)?fissure", "fissure_depth_mm", 10),
        (r"(?:shallow|shallower)\s+(?:central\s+)?fissure", "fissure_depth_mm", 4),
        (r"(?:elongated|long|longer)\s+gallbladder", "gallbladder_length_mm", 100),
        (r"(?:compact|short|shorter)\s+gallbladder", "gallbladder_length_mm", 65),
    ]
    for pattern, field, value in presets:
        for match in re.finditer(pattern, normalized):
            if re.search(
                r"\b(?:no|not|without)\s*$", normalized[max(0, match.start() - 10) : match.start()]
            ):
                return fail(
                    "needs_clarification",
                    "Use an explicit numeric control for a negated qualitative shape description.",
                )
            if field in updates and updates[field] != value:
                return fail(
                    "needs_clarification",
                    f"Conflicting preset and numeric target for {field.replace('_', ' ')}.",
                )
            updates[field] = value
            spans.append((match.start(), match.end()))

    vessel_match = re.search(
        r"\b(no|without|hide|show|include)\s+(?:the\s+)?(?:vessels|vasculature)\b", normalized
    )
    if vessel_match:
        updates["include_vessels"] = vessel_match.group(1) in ("show", "include")
        spans.append((vessel_match.start(), vessel_match.end()))
    seed_match = re.search(r"\bseed\s*(?:=|:)?\s*(\d+)\b", normalized)
    if seed_match:
        seed = int(seed_match.group(1))
        if not 0 <= seed <= 2**32 - 1:
            return fail("unsupported", "Seed must be an unsigned 32-bit integer.")
        updates["seed"] = seed
        spans.append((seed_match.start(), seed_match.end()))

    # Reject unsupported clauses rather than claiming full success on one recognized fragment.
    remainder = list(normalized)
    for start, end in spans:
        remainder[start:end] = [" "] * (end - start)
    rest = "".join(remainder)
    rest = preserve_pattern.sub(" ", rest)
    rest = re.sub(
        r"\b(?:please|generate|create|make|an?|the|adult|healthy|synthetic|anatomy|scene|liver|gallbladder|with|and|then|set|to|of|in|for|model|organ|organs)\b",
        " ",
        rest,
    )
    rest = re.sub(r"[\s,.;:!?-]+", "", rest)
    if rest:
        return fail(
            "unsupported",
            "Part of this request is unsupported. Use named dimensions, left-lobe ratio, concavity, fissure depth, gallbladder length/radius, or a listed example.",
        )
    if not updates and not re.search(r"\b(liver|gallbladder|anatomy)\b", normalized):
        return fail("needs_clarification", "Name a supported organ or shape control.")

    # Preserve clauses are constraints, not stop words. Reject contradictory
    # changes before emitting a partial patch. A seed change may alter every
    # organ's generated appearance, so it cannot satisfy a preservation promise.
    if preservation_targets and updates.get("seed", source["seed"]) != source["seed"]:
        return fail(
            "needs_clarification",
            "Changing the scene seed can change all generated assets. Keep the seed fixed when requesting unchanged organs.",
        )
    for organ_id in preservation_targets:
        if organ_id not in ("liver", "gallbladder"):
            continue
        conflicting = [
            field
            for field, value in updates.items()
            if field in LIMITS
            and (field.startswith("gallbladder") == (organ_id == "gallbladder"))
            and value != source["parameters"][field]
        ]
        if conflicting:
            return fail(
                "needs_clarification",
                f"The request both changes {organ_id} and asks to preserve it unchanged. Resolve that conflict before applying an edit.",
            )

    for field, value in updates.items():
        if field in LIMITS:
            low, high = LIMITS[field]
            if not low <= value <= high:
                return fail(
                    "unsupported",
                    f"{field.replace('_', ' ')} must be within the supported design range {low:g}–{high:g}; no value was clamped.",
                )
            before = candidate["parameters"][field]
            candidate["parameters"][field] = value
            path = f"/parameters/{field}"
        else:
            before = candidate[field]
            candidate[field] = value
            path = f"/{field}"
        if before != value:
            output["changes"].append(
                {"path": path, "before": before, "after": value, "label": field.replace("_", " ")}
            )
            output["patches"].append({"op": "replace", "path": path, "value": value})
    # Individual bounds are not sufficient: the wall/radius relation is also
    # part of the executable scene contract. Never offer an unexecutable patch.
    try:
        candidate = SceneRequest.model_validate(candidate).model_dump()
    except ValidationError as error:
        return fail(
            "unsupported",
            f"Combined controls violate the scene contract: {error.errors(include_url=False)[0]['msg']}. No changes applied.",
        )
    output["spec"] = candidate
    output["message"] = (
        f"Applied {len(output['changes'])} explicit shape control(s). "
        "Qualitative examples use the documented synthetic design presets."
    )
    return output
