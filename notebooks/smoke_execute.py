"""Execute every notebook code cell locally with a small CPU dataset.

This verifies Python cells and artifact flow, not Colab authentication/GPU policy.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--run-id",
        default="cpu-notebook-smoke-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
    )
    args = parser.parse_args()
    if Path(args.run_id).name != args.run_id or args.run_id in (".", ".."):
        parser.error("--run-id must be a single directory name")
    project = Path(__file__).resolve().parents[1]
    path = project / "notebooks/VISCERA_original_dataset_and_shape_training.ipynb"
    notebook = json.loads(path.read_text())
    os.environ["MPLBACKEND"] = "Agg"
    context = {"__name__": "__notebook__"}
    runs = []
    started = time.perf_counter()
    for index, cell in enumerate(notebook["cells"]):
        if cell["cell_type"] != "code":
            continue
        source = "".join(cell["source"])
        capture = io.StringIO()
        before = time.perf_counter()
        with contextlib.redirect_stdout(capture):
            exec(compile(source, f"{path.name}:cell-{index}", "exec"), context)
        if index == 1:
            context.update(
                {
                    "SOURCE_MODE": "existing",
                    "EXISTING_PROJECT": str(project),
                    "INSTALL_DEPENDENCIES": False,
                    "DATASET_COUNT": 32,
                    "RESOLUTION": "low",
                    "TRAIN_STEPS": 40,
                    "RUN_ID": args.run_id,
                    "USE_DRIVE": False,
                    "DOWNLOAD_RESULTS": False,
                }
            )
        cell["execution_count"] = len(runs) + 1
        cell["outputs"] = [{"output_type": "stream", "name": "stdout", "text": capture.getvalue()}]
        runs.append({"cell": index, "status": "PASS", "wall_time_s": time.perf_counter() - before})
        print(f"cell {index} PASS ({runs[-1]['wall_time_s']:.2f}s)", flush=True)
    output = project / "artifacts/notebook" / args.run_id
    output.mkdir(parents=True, exist_ok=True)
    (output / "executed.ipynb").write_text(json.dumps(notebook, indent=2) + "\n")
    (output / "notebook_smoke_report.json").write_text(
        json.dumps(
            {
                "status": "PASS",
                "cells": runs,
                "wall_time_s": time.perf_counter() - started,
                "environment": "local CPU; existing pinned project environment",
                "not_run": [
                    "Colab upload",
                    "pip installation on Colab",
                    "GPU runtime",
                    "Drive authentication",
                    "browser download",
                ],
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
