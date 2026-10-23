"""Unchanged schema3 decoder export, with explicit objective/warm-start provenance."""

import json
import tempfile
from pathlib import Path

from viscera_core.tissue_learning.checkpoint import digest, load_checkpoint
from viscera_core.tissue_learning.config import identity
from viscera_core.tissue_learning_conv.artifact import export_decoder as original_export
from viscera_core.tissue_learning_conv.artifact import load_artifact


def export_decoder(checkpoint, output):
    _, request = load_checkpoint(checkpoint)
    if "refinement" not in request:
        raise ValueError("expected isolated refinement checkpoint")
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="refine-export-") as directory:
        path = Path(directory) / "model.json"
        original_export(checkpoint, path)
        value = json.loads(path.read_text())
        value["provenance"]["refinement"] = request["refinement"]
        value["provenance"]["request_sha256"] = identity(request)
        payload = json.dumps(value, indent=2, allow_nan=False).encode() + b"\n"
        if len(payload) > 20_000_000:
            raise ValueError("refinement export exceeds bound")
        path.write_bytes(payload)
        load_artifact(path)
        with output.open("xb") as handle:
            handle.write(payload)
    return {
        "path": str(output),
        "sha256": digest(output),
        "bytes": output.stat().st_size,
        "training_steps": value["provenance"]["training_steps"],
        "parent_training_steps": request["refinement"]["parent"]["training_steps"],
        "qualification": "engineering_unqualified",
    }
