"""Export and activation must fail closed on a failed or fabricated quality flag."""

import copy
import math

import pytest
from viscera_core.atlas_joint_quality_v2 import verify_density_acceptance


def model():
    return {
        "selected_step": 100,
        "completed_steps": 4000,
        "validation": {
            "density": {
                "macro": {
                    "uniform_nll_per_active_dimension": 0.7,
                    "flow_nll_per_active_dimension": 0.69,
                }
            },
        },
        "audit": {
            "density": {
                "macro": {
                    "uniform_nll_per_active_dimension": 0.7,
                    "flow_nll_per_active_dimension": 0.69,
                }
            },
        },
        "validation_acceptance": {
            "density_improved_over_identity": True,
            "audit_improved_over_identity": True,
            "export_eligible": True,
            "uniform_nll": 0.7,
            "selected_nll": 0.69,
            "audit_uniform_nll": 0.7,
            "audit_selected_nll": 0.69,
            "minimum_improvement": 0.002,
        },
    }


@pytest.mark.parametrize(
    "field,value",
    [
        ("audit_improved_over_identity", False),
        ("selected_nll", 0.701),
        ("audit_selected_nll", 0.699),
        ("minimum_improvement", 0.0001),
        ("uniform_nll", math.nan),
        ("selected_nll", True),
    ],
)
def test_flags_cannot_override_failed_measured_gate(field, value):
    good = model()
    verify_density_acceptance(good)
    bad = copy.deepcopy(good)
    bad["validation_acceptance"][field] = value
    with pytest.raises(ValueError):
        verify_density_acceptance(bad)


def test_identity_checkpoint_is_not_a_trained_export():
    bad = model()
    bad["selected_step"] = 0
    with pytest.raises(ValueError):
        verify_density_acceptance(bad)


@pytest.mark.parametrize("split", ["validation", "audit"])
@pytest.mark.parametrize("defect", ["missing", "stale_summary", "nan", "bool"])
def test_summary_cannot_disagree_with_actual_held_out_macro(split, defect):
    bad = model()
    if defect == "missing":
        del bad[split]["density"]["macro"]
    else:
        value = {"stale_summary": 0.71, "nan": math.nan, "bool": True}[defect]
        bad[split]["density"]["macro"]["flow_nll_per_active_dimension"] = value
    with pytest.raises(ValueError, match="macro"):
        verify_density_acceptance(bad)
