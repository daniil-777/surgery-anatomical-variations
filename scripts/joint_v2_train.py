"""Run joint spline flow training, exact renderer checks and a Studio-compatible export."""

from __future__ import annotations

import argparse
import json
import shutil
import zipfile
from pathlib import Path

from viscera_core.atlas_joint_quality_v2 import verify_density_acceptance
from viscera_core.atlas_joint_v2 import digest, load_model, verify_release

from pipelines.train.viscera_train.joint_v2 import Config, train
from scripts.qa_joint_model_v2 import audit


def export_weights(
    model_dir: Path, baseline: Path, disease: Path, templates: Path, out: Path
) -> dict:
    model = load_model(model_dir / "model.npz")
    if model["training_profile"] != "full":
        raise ValueError("Smoke weights are diagnostic and cannot be released")
    verify_density_acceptance(model)
    for lane, directory in (("baseline", baseline), ("disease", disease)):
        verify_release(directory)
        if model["dataset_hashes"][lane + "/release.json"] != digest(directory / "release.json"):
            raise ValueError("Training dataset mismatch")
    report = audit(model_dir / "model.npz", templates, out / "exact-renderer-audit.json")
    if not report.get("passed"):
        raise ValueError("Joint flow did not pass exact renderer integration checks")
    export = out / "export"
    export.mkdir(parents=True, exist_ok=True)
    files = {name: model_dir / name for name in ("model.npz", "model.json", "training_report.json")}
    files["exact-renderer-audit.json"] = out / "exact-renderer-audit.json"
    dependencies = {}
    for lane, directory in (("baseline", baseline), ("disease", disease)):
        for name in ("release.json", "dataset_card.json", "reference_catalog.json"):
            files[f"data/{lane}-{name}"] = directory / name
        dependencies[lane] = digest(directory / "release.json")
    for relative, source in files.items():
        destination = export / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
    manifest = {
        "format": "viscera-joint-flow-v2",
        "profile": "full",
        "smoke_only": False,
        "dataset_dependencies": dependencies,
        "artifact_hashes": {name: digest(path) for name, path in files.items()},
        "scope": "conditional spline flow for bounded shape, authored colour/material and severity-stratified disease designs; no physics model",
    }
    (export / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    archive_path = out / "viscera-joint-v2-weights.zip"
    with zipfile.ZipFile(archive_path.with_suffix(".tmp"), "w", zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(set(files) | {"manifest.json"}):
            archive.write(export / name, "viscera-joint-v2-weights/" + name)
    archive_path.with_suffix(".tmp").replace(archive_path)
    completion = {
        "status": "complete",
        "weights_sha256": digest(archive_path),
        "export_manifest_sha256": digest(export / "manifest.json"),
        "model_sha256": model["artifact_sha256"],
        "selected_method": model["selected_method"],
        "dataset_dependencies": dependencies,
        "exact_renderer_passed": True,
    }
    (out / "completion.json").write_text(json.dumps(completion, indent=2) + "\n")
    return completion


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--disease", type=Path, required=True)
    parser.add_argument("--templates", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path)
    parser.add_argument("--steps", type=int, default=Config().steps)
    parser.add_argument("--surrogate-steps", type=int, default=Config().surrogate_steps)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    model_dir = args.model_dir or args.out / "model"
    if not (model_dir / "model.npz").exists():
        train(
            [args.baseline, args.disease],
            model_dir,
            Config(steps=args.steps, surrogate_steps=args.surrogate_steps, device=args.device),
        )
    else:
        model = load_model(model_dir / "model.npz")
        if (
            model["completed_steps"] != args.steps
            or model["config"]["surrogate_steps"] != args.surrogate_steps
        ):
            raise ValueError(
                "Existing model configuration differs; choose a fresh output directory"
            )
        print("Reusing checksum-verified completed joint training stage", flush=True)
    print(
        json.dumps(
            export_weights(model_dir, args.baseline, args.disease, args.templates, args.out),
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
