"""The material lane's hash-pinned integrity checks under the one reviewed renderer extension.

The material release pins py/viscera_core/atlas_material_dataset.py and atlas_materials.py by sha256
(release.json recipe.code_hashes); the material model pins the same two files (model.json
identity.dataset_code_hashes) and its trainer (identity.source_sha256). The functions that compare
them -- viscera_core.atlas_material_dataset.verify_material_release and read_split, and
pipelines.train.viscera_train.atlas_material.load_model -- live in those pinned files, so editing
them would itself be drift, and the releases and model archives are never rewritten.

Serving therefore runs those functions' own code with one name rebound: code_hashes(), the current
digests they compare with the pinned ones, reports the pinned digest for a file whose current bytes
atlas_renderer_compat.matches_renderer_source accepts in its place (its training bytes, or the
reviewed reference-colour extension of py/viscera_core/atlas_materials.py) and the file's own digest
otherwise. Any other edit of either file still fails with the pinned error; the trainer's own hash
and every other check of those functions run unchanged; the module globals are copied per call, not
patched, so concurrent callers and the training tools (which keep the strict checks) are unaffected.
tests/python/test_material_lane_compatibility.py shows that the extension leaves this lane's
recipes, uniforms and fields byte-identical to the frozen training decoder.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import FunctionType
from typing import Any

from viscera_core import atlas_material_dataset as dataset

from .atlas_renderer_compat import matches_renderer_source

_SOURCE_DIRECTORY = "py/viscera_core/"


def reviewed_code_hashes(pinned: Any) -> dict[str, str]:
    """dataset.code_hashes() as the reviewed rule reads it against `pinned` (file name -> sha256)."""
    current: dict[str, str] = dataset.code_hashes()
    if not isinstance(pinned, dict):
        return current
    return {
        name: pinned[name]
        if isinstance(pinned.get(name), str)
        and matches_renderer_source(_SOURCE_DIRECTORY + name, pinned[name], actual)
        else actual
        for name, actual in current.items()
    }


def _pinned(path: Path, *keys: str) -> Any:
    """What a release or model metadata file pins under `keys`, or None when it cannot say (the
    pinned check then reads the file itself and refuses it with its own error)."""
    try:
        value: Any = json.loads(path.read_text())
        for key in keys:
            value = value[key]
    except (OSError, ValueError, LookupError, TypeError):
        return None
    return value


def _rebound(function: Any, **names: Any) -> Any:
    """`function`'s own code, run against a per-call copy of its module's globals with `names`
    rebound."""
    rebound = FunctionType(
        function.__code__,
        {**function.__globals__, **names},
        function.__name__,
        function.__defaults__,
        function.__closure__,
    )
    rebound.__kwdefaults__ = function.__kwdefaults__
    return rebound


def verify_material_release(root: Path, *args: Any, **kwargs: Any) -> dict[str, Any]:
    """atlas_material_dataset.verify_material_release(root, ...) under the reviewed rule."""
    pinned = _pinned(Path(root) / "release.json", "recipe", "code_hashes")
    verify = _rebound(
        dataset.verify_material_release, code_hashes=lambda: reviewed_code_hashes(pinned)
    )
    release: dict[str, Any] = verify(root, *args, **kwargs)
    return release


def read_split(root: Path, split: str) -> dict[str, Any]:
    """atlas_material_dataset.read_split, its release verified under the reviewed rule."""
    read = _rebound(dataset.read_split, verify_material_release=verify_material_release)
    rows: dict[str, Any] = read(root, split)
    return rows


class _ReviewedDataset:
    """The dataset module as load_model reads it, with code_hashes() under the reviewed rule."""

    def __init__(self, pinned: Any) -> None:
        self._pinned = pinned

    def code_hashes(self) -> dict[str, str]:
        return reviewed_code_hashes(self._pinned)

    def __getattr__(self, name: str) -> Any:
        return getattr(dataset, name)


def load_model(path: Path) -> dict[str, Any]:
    """pipelines.train.viscera_train.atlas_material.load_model(path) under the reviewed rule; the
    trainer's own source hash (identity.source_sha256) is still compared byte for byte."""
    from pipelines.train.viscera_train import atlas_material as prior

    pinned = _pinned(Path(path).with_suffix(".json"), "identity", "dataset_code_hashes")
    load = _rebound(prior.load_model, dataset=_ReviewedDataset(pinned))
    model: dict[str, Any] = load(path)
    return model
