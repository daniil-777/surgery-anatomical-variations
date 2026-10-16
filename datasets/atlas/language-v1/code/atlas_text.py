"""Conservative, atomic text-to-atlas recipe compiler with measured dimension solving."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import numpy as np
from scipy.optimize import least_squares

from .atlas import CONTROL_NAMES, deform_vertices, list_templates
from .atlas_scene import AtlasSpec, get_template

POLICY_VERSION = "atlas-text-1.0.0"
ALIASES = {
    "liver": "liver",
    "gallbladder": "gallbladder",
    "stomach": "stomach",
    "pancreas": "pancreas",
    "spleen": "spleen",
    "kidney": "kidney",
    "kidneys": "kidney",
    "small intestine": "small-intestine",
    "large intestine": "large-intestine",
    "colon": "large-intestine",
    "heart": "heart",
    "lung": "lung",
    "lungs": "lung",
    "brain": "brain",
    "urinary bladder": "urinary-bladder",
    "bladder": "urinary-bladder",
}
DIRECTIONS = {
    "wider": (0, 1),
    "narrower": (0, -1),
    "taller": (1, 1),
    "shorter": (1, -1),
    "deeper": (2, 1),
    "flatter": (2, -1),
}
AXES = {"width": 0, "height": 1, "depth": 2, "wide": 0, "tall": 1, "deep": 2}


def compile_text(root: str | Path, text: str, spec: AtlasSpec) -> dict[str, Any]:
    """Only fully understood requests succeed; the input recipe is never mutated."""

    def unsupported(message: str) -> dict[str, Any]:
        return {"status": "unsupported", "message": message, "policy_version": POLICY_VERSION}

    if not text.strip() or len(text) > 4000:
        return unsupported("Enter an organ and a supported shape or dimension edit.")
    remaining = text.lower().strip().rstrip(".!")
    if re.search(
        r"\b(not|no|without|except|avoid|unless|never|tumor|tumour|disease|resect|remove|cut)\b",
        remaining,
    ):
        return unsupported(
            "This compiler supports reference selection and bounded shape edits; this request contains an unsupported constraint."
        )
    library = list_templates(root)
    current = next((t for t in library if t["template_id"] == spec.template_id), None)
    if current is None:
        return unsupported("The current reference is unavailable.")
    mentions = []
    for alias, organ in sorted(ALIASES.items(), key=lambda p: -len(p[0])):
        if re.search(r"\b" + re.escape(alias) + r"\b", remaining):
            mentions.append(organ)
            remaining = re.sub(r"\b" + re.escape(alias) + r"\b", " ", remaining)
    if len(set(mentions)) > 1:
        return unsupported("Select one organ at a time; multi-organ assembly is not implemented.")
    organ = mentions[0] if mentions else current["organ"]
    selectors = {}
    for word, key in [
        ("female", "sex_label"),
        ("male", "sex_label"),
        ("left", "laterality"),
        ("right", "laterality"),
    ]:
        if re.search(r"\b" + word + r"\b", remaining):
            if key in selectors:
                return unsupported("Choose one sex label and one side.")
            selectors[key] = word
            remaining = re.sub(r"\b" + word + r"\b", " ", remaining)
    candidates = [
        t
        for t in library
        if t["organ"] == organ and all(t.get(k) == v for k, v in selectors.items())
    ]
    if not candidates:
        return unsupported("That organ/reference combination is not in the licensed library.")
    chosen = next(
        (t for t in candidates if t["template_id"] == spec.template_id),
        sorted(candidates, key=lambda t: t["template_id"])[0],
    )
    switched = chosen["template_id"] != spec.template_id
    controls = {k: 0.0 for k in CONTROL_NAMES} if switched else dict(spec.controls)
    appearance = spec.appearance
    reset = bool(re.search(r"\b(reset|original|reference shape|undeformed)\b", remaining))
    if reset:
        controls = {k: 0.0 for k in CONTROL_NAMES}
        remaining = re.sub(r"\b(reset|original|reference shape|undeformed)\b", " ", remaining)
    template = get_template(root, chosen["template_id"])

    def extents(c: dict[str, float]) -> np.ndarray:
        v = deform_vertices(
            template.vertices_mm,
            c,
            template.metadata["control_limits"],
            template.metadata["normalization_mm"],
        )
        return np.asarray(np.ptp(v, axis=0), dtype=np.float64)

    original = extents(controls)
    targets = {}
    changes = []
    direct_controls: set[str] = set()
    appearance_requests: set[str] = set()

    def absolute(match: re.Match[str]) -> str:
        axis = AXES[match.group("axis")]
        value = float(match.group("number")) * (10 if match.group("unit") == "cm" else 1)
        if axis in targets:
            raise ValueError("Each dimension may be requested only once.")
        if not np.isfinite(value) or value <= 0:
            raise ValueError("Dimensions must be positive.")
        targets[axis] = value
        changes.append(f"{list(AXES)[axis]} {value:g} mm")
        return " "

    try:
        remaining = re.sub(
            r"\b(?P<axis>width|height|depth)\s*(?:of|to|=|:)?\s*(?P<number>\d+(?:\.\d+)?)\s*(?P<unit>mm|cm)\b",
            absolute,
            remaining,
        )
        remaining = re.sub(
            r"\b(?P<number>\d+(?:\.\d+)?)\s*(?P<unit>mm|cm)\s*(?P<axis>wide|tall|deep)\b",
            absolute,
            remaining,
        )

        def relative(m: re.Match[str]) -> str:
            axis, sign = DIRECTIONS[m.group("direction")]
            if axis in targets:
                raise ValueError("Each dimension may be requested only once.")
            fraction = (
                float(m.group("percent")) / 100
                if m.group("percent")
                else (0.03 if m.group("qualifier") in ("slightly", "a little") else 0.05)
            )
            if fraction <= 0 or fraction >= 1:
                raise ValueError(
                    "Relative dimensions must change by more than zero and less than 100%."
                )
            targets[axis] = original[axis] * (1 + sign * fraction)
            changes.append(f"{fraction * 100:g}% {m.group('direction')}")
            return " "

        remaining = re.sub(
            r"\b(?:(?P<percent>\d+(?:\.\d+)?)\s*%\s*|(?P<qualifier>slightly|a little)\s+)?(?P<direction>wider|narrower|taller|shorter|deeper|flatter)\b",
            relative,
            remaining,
        )
        for word, key in [
            ("bent", "bend"),
            ("twisted", "twist"),
            ("tapered", "taper"),
            ("asymmetric", "asymmetry"),
        ]:
            pattern = r"\b(more|less)\s+" + word + r"\b"
            m = re.search(pattern, remaining)
            if m:
                old = controls[key]
                controls[key] = (
                    np.sign(old) * max(0, abs(old) - 0.2)
                    if m.group(1) == "less"
                    else (float(np.sign(old)) if old else 1.0) * (abs(old) + 0.2)
                )
                changes.append(m.group(0))
                remaining = re.sub(pattern, " ", remaining, count=1)
        for key in CONTROL_NAMES:
            m = re.search(r"\b" + key + r"\s*(?:to|=|:)?\s*(-?\d+(?:\.\d+)?)\b", remaining)
            if m:
                direct_controls.add(key)
                controls[key] = float(m.group(1))
                changes.append(f"{key} {controls[key]:g}")
                remaining = remaining[: m.start()] + " " + remaining[m.end() :]
        for mode in ("tissue", "source", "clay"):
            if re.search(r"\b" + mode + r"(?:\s+appearance)?\b", remaining):
                appearance_requests.add(mode)
                appearance = mode
                changes.append(mode + " appearance")
                remaining = re.sub(r"\b" + mode + r"(?:\s+appearance)?\b", " ", remaining)
        remaining = re.sub(
            r"\b(make|the|a|an|please|generate|create|show|use|select|organ|reference|shape|and|with|set|to|be|it)\b",
            " ",
            remaining,
        )
        remaining = re.sub(r"[\s,;]+", " ", remaining).strip()
        if remaining:
            return unsupported(
                "Unsupported wording: "
                + remaining
                + ". Use e.g. “liver 5% wider”, “width 200 mm” or “twist 0.2”."
            )
        if not (mentions or selectors or reset or changes):
            return unsupported("No supported organ or shape edit was found.")
        if any(not -1 <= v <= 1 for v in controls.values()):
            raise ValueError("The request exceeds the bounded shape-control range.")
        if len(appearance_requests) > 1:
            return unsupported("Choose one appearance mode per request.")
        if any(CONTROL_NAMES[axis] in direct_controls for axis in targets):
            return unsupported("Specify a dimension target or its scale control, not both.")
        if targets:
            axes = sorted(targets)
            keys = [CONTROL_NAMES[i] for i in axes]
            wanted = np.array([targets[i] for i in axes])

            def residual(values: np.ndarray) -> np.ndarray:
                c = dict(controls)
                c.update(zip(keys, values, strict=True))
                return np.asarray((extents(c)[axes] - wanted) / wanted, dtype=np.float64)

            result = least_squares(
                residual,
                np.array([controls[k] for k in keys]),
                bounds=(-1, 1),
                xtol=1e-11,
                ftol=1e-11,
                gtol=1e-11,
                max_nfev=80,
            )
            if not result.success or float(np.max(np.abs(residual(result.x)))) > 1e-4:
                return unsupported(
                    "Requested dimensions cannot be reached within this reference’s conservative control bounds. No edit was applied."
                )
            controls.update(zip(keys, result.x.tolist(), strict=True))
        output = AtlasSpec(
            template_id=chosen["template_id"],
            seed=spec.seed,
            controls=controls,
            appearance=appearance,
        )
        actual = extents(output.controls)
        return {
            "status": "accepted",
            "message": "Prepared "
            + chosen["template_id"]
            + (" · " + ", ".join(changes) if changes else "")
            + ". Numeric dimensions are checked against the actual deformed mesh.",
            "spec": output.model_dump(),
            "policy_version": POLICY_VERSION,
            "interpretation": "Bounded design edits; qualitative “slightly” means 3%, unqualified relative edits 5%.",
            "measured_extent_mm": actual.tolist(),
            "requested_extent_mm": {str(k): v for k, v in targets.items()},
            "max_dimension_relative_error": max(
                (abs(actual[k] - v) / v for k, v in targets.items()), default=0.0
            ),
        }
    except ValueError as error:
        return unsupported(str(error))
