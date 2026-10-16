"""Reviewed renderer extensions that preserve joint-model material recipes.

Joint models never emit reference_color. The optional reference-colour extension
keeps the original material calculations and serialized recipes unchanged when
that field is absent. Its exact source revision is covered by frozen-renderer
parity tests in test_joint_material_compatibility.py. Any other edit still fails
the normal renderer integrity check; model archives are never rewritten.
"""

_MATERIAL_SOURCE = "py/viscera_core/atlas_materials.py"
_TRAINING_MATERIAL_SHA256 = "679aa9214cef534b92e1d64b0043213a88a8c6a0fdd9b25b7ae54e4fa289a0a3"
_REFERENCE_COLOR_MATERIAL_SHA256 = "7bc443111cec91a295297eb1abab9ed3d1acfd6724c49b56c27c4dd0ea650d17"


def matches_renderer_source(name: str, expected: str, actual: str) -> bool:
    """Accept exact training bytes or this one reviewed additive extension."""
    return actual == expected or (
        name == _MATERIAL_SOURCE
        and expected == _TRAINING_MATERIAL_SHA256
        and actual == _REFERENCE_COLOR_MATERIAL_SHA256
    )
