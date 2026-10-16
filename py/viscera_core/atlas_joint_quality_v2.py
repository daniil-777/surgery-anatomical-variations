"""Promotion gate shared by Colab export and local Studio activation."""

from __future__ import annotations

import math
from typing import Any


def verify_density_acceptance(meta: dict[str, Any]) -> None:
    acceptance = meta.get("validation_acceptance")
    if not isinstance(acceptance, dict) or any(
        acceptance.get(key) is not True
        for key in (
            "density_improved_over_identity",
            "audit_improved_over_identity",
            "export_eligible",
        )
    ):
        raise ValueError("V2 model has not passed held-out density promotion gates")
    for key in (
        "uniform_nll",
        "selected_nll",
        "audit_uniform_nll",
        "audit_selected_nll",
        "minimum_improvement",
    ):
        value = acceptance.get(key)
        if type(value) not in (int, float) or not math.isfinite(value):
            raise ValueError("V2 density acceptance contains invalid metrics")
    # These are duplicated summary fields, not independent measurements. Bind
    # them to the actual held-out reports so a stale or edited summary cannot
    # promote a model whose reported validation/audit result disagrees.
    for split, prefix in (("validation", ""), ("audit", "audit_")):
        report = meta.get(split)
        density = report.get("density") if isinstance(report, dict) else None
        macro = density.get("macro") if isinstance(density, dict) else None
        if not isinstance(macro, dict):
            raise ValueError("V2 promotion requires held-out density macro reports")
        for summary, metric in (
            ("uniform_nll", "uniform_nll_per_active_dimension"),
            ("selected_nll", "flow_nll_per_active_dimension"),
        ):
            measured = macro.get(metric)
            if (
                type(measured) not in (int, float)
                or not math.isfinite(measured)
                or measured != acceptance[prefix + summary]
            ):
                raise ValueError("V2 density acceptance differs from its held-out macro report")
    threshold = acceptance["minimum_improvement"]
    if threshold < 0.002 or any(
        acceptance[base] - acceptance[selected] <= threshold
        for base, selected in (
            ("uniform_nll", "selected_nll"),
            ("audit_uniform_nll", "audit_selected_nll"),
        )
    ):
        raise ValueError("V2 density improvement is below the required validation/audit threshold")
    if type(meta.get("selected_step")) is not int or not 0 < meta["selected_step"] <= meta.get(
        "completed_steps", 0
    ):
        raise ValueError("V2 promotion requires a trained, held-out-selected checkpoint")
