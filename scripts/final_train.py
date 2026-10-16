"""Train, audit and export the independent VISCERA control models in one run.

The supplied meshes and procedural renderers remain necessary at inference. This
does not train free-form anatomy, patient disease distributions or tissue physics.
Completed stages are reused only after integrity verification; an interrupted
stage restarts in a new directory, preserving the previous attempt for inspection.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import shutil
import sys
import time
import traceback
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable

DEFAULT_PATHS = {
    "shape": "datasets/atlas/cohort-v2",
    "material": "datasets/atlas/material-v1",
    "language": "datasets/atlas/language-v1",
    "disease_recipes": "disease-releases/recipes-v2",
    "disease_geometry": "disease-releases/geometry-v1",
    "clinical": "disease-releases/clinical-ccby-v3",
}
FORMAT = "viscera-final-training-v1"


@dataclass(frozen=True)
class RunConfig:
    profile: str = "full"
    device: str = "auto"
    language: str = "auto"


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w") as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def checked_path(root: Path, relative: str) -> Path:
    path = root / relative
    if (
        not relative
        or Path(relative).is_absolute()
        or ".." in Path(relative).parts
        or "\\" in relative
        or ":" in relative
        or Path(relative).as_posix() != relative
    ):
        raise ValueError(f"Unsafe relative artifact path: {relative}")
    return path


def verify_hashes(root: Path, hashes: dict[str, str]) -> None:
    if not hashes:
        raise ValueError("Empty artifact manifest")
    for relative, expected in hashes.items():
        path = checked_path(root, relative)
        if (
            not path.resolve().is_relative_to(root.resolve())
            or not path.is_file()
            or path.is_symlink()
            or sha256(path) != expected
        ):
            raise ValueError(f"Artifact integrity mismatch: {relative}")


def code_hashes(root: Path) -> dict[str, str]:
    paths = [root / "scripts/final_train.py"]
    paths += sorted((root / "py/viscera_core").glob("*.py"))
    paths += sorted((root / "py/viscera_core").glob("*.json"))
    paths += sorted((root / "pipelines/train/viscera_train").glob("atlas_*.py"))
    return {str(p.relative_to(root)): sha256(p) for p in paths}


def _stage(
    out: Path, name: str, action: Callable[[Path], dict[str, Any]]
) -> tuple[Path, dict[str, Any]]:
    """Reuse complete verified stages; never overwrite partial weights."""
    directory = out / "stages" / name
    pointer = directory / "complete.json"
    if pointer.exists():
        completed = json.loads(pointer.read_text())
        target = checked_path(directory, completed["attempt"])
        verify_hashes(target, completed["artifact_hashes"])
        print(f"[{name}] reuse verified completed stage", flush=True)
        return target, completed["summary"]
    directory.mkdir(parents=True, exist_ok=True)
    attempt = 1
    while (directory / f"attempt-{attempt:03d}").exists():
        attempt += 1
    target = directory / f"attempt-{attempt:03d}"
    target.mkdir()
    start = time.monotonic()
    print(f"[{name}] training attempt {attempt}", flush=True)
    try:
        summary = action(target)
    except Exception as error:
        write_json(target / "failure.json", {"type": type(error).__name__, "error": str(error)})
        raise
    summary["elapsed_seconds"] = round(time.monotonic() - start, 3)
    hashes = {
        str(p.relative_to(target)): sha256(p) for p in sorted(target.rglob("*")) if p.is_file()
    }
    write_json(pointer, {"attempt": target.name, "artifact_hashes": hashes, "summary": summary})
    return target, summary


def _copy_export(stage: Path, export: Path, names: tuple[str, ...]) -> None:
    export.mkdir(parents=True, exist_ok=True)
    for name in names:
        source = stage / name
        if not source.exists():
            raise ValueError(f"Missing completed stage artifact: {source}")
        if source.is_dir():
            shutil.copytree(source, export / name)
        else:
            shutil.copyfile(source, export / name)


def inference_examples(export: Path) -> dict[str, Any]:
    """Reload the actual deployment files and exercise each supported vocabulary."""
    import numpy as np

    from pipelines.train.viscera_train import atlas_disease as disease
    from pipelines.train.viscera_train import atlas_material as material
    from pipelines.train.viscera_train import atlas_shape as shape

    geometry = shape.load_model(export / "shape/model.pt")
    appearance = material.load_model(export / "material/model.npz")
    pathology = disease.load_recipe_model(export / "disease/model.npz")
    source = disease.load_source_model(export / "clinical/source_model.json")
    results: dict[str, Any] = {"shape": {}, "material": {}, "disease": {}, "clinical": []}
    for template in geometry["preprocessing"]["templates"]:
        controls = shape.sample_controls(geometry, template, count=4, seed=913)
        assert np.array_equal(
            controls, shape.sample_controls(geometry, template, count=4, seed=913)
        )
        assert np.isfinite(controls).all() and np.all(abs(controls) <= 1)
        results["shape"][template] = controls.tolist()
    for group in appearance["group_names"]:
        organ, preset = str(group).split("|")
        recipe = material.sample_recipe(appearance, organ, preset, 914)
        assert recipe == material.sample_recipe(appearance, organ, preset, 914)
        results["material"][str(group)] = recipe
    for profile in pathology["profiles"]:
        recipes = disease.sample_recipes(pathology, profile, 915, count=4)
        assert recipes == disease.sample_recipes(pathology, profile, 915, count=4)
        results["disease"][profile] = recipes
    for group in source["groups"]:
        results["clinical"].extend(
            disease.sample_source_cases(source, group["organ"], group["disease_code"], seed=916)
        )
    return results


def _write_zip(export: Path, destination: Path) -> None:
    temporary = destination.with_suffix(".tmp")
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(export.rglob("*")):
            if path.is_file():
                info = zipfile.ZipInfo(
                    str(Path("viscera-weights") / path.relative_to(export)),
                    date_time=(2026, 10, 7, 0, 0, 0),
                )
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, path.read_bytes())
    with zipfile.ZipFile(temporary) as archive:
        if archive.testzip() is not None:
            raise ValueError("Weight ZIP CRC verification failed")
        for path in sorted(export.rglob("*")):
            if path.is_file():
                member = str(Path("viscera-weights") / path.relative_to(export))
                if hashlib.sha256(archive.read(member)).hexdigest() != sha256(path):
                    raise ValueError(f"Weight ZIP SHA256 mismatch: {member}")
    temporary.replace(destination)


def run(root: Path, out: Path, config: RunConfig = RunConfig()) -> dict[str, Any]:
    root, out = root.resolve(), out.resolve()
    if config.profile not in {"smoke", "full"}:
        raise ValueError("Unknown run profile")
    if config.language not in {"auto", "on", "off"} or config.device not in {"auto", "cpu", "cuda"}:
        raise ValueError("Invalid language or device policy")
    sys.path[:0] = [str(root / "py"), str(root)]
    import torch
    from viscera_core import (
        atlas_dataset,
        atlas_disease_dataset,
        atlas_disease_geometry_dataset,
        atlas_disease_recipe_dataset,
        atlas_material_dataset,
    )

    from pipelines.train.viscera_train import atlas_disease as disease
    from pipelines.train.viscera_train import atlas_language as language
    from pipelines.train.viscera_train import atlas_material as material
    from pipelines.train.viscera_train import atlas_shape as shape

    manifest_path = root / "final-bundle-manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    if manifest and manifest.get("format") != "viscera-final-colab-bundle-v1":
        raise ValueError("Unsupported final bundle format")
    if manifest:
        verify_hashes(root, manifest["artifact_hashes"])
    paths = manifest.get("dataset_paths", DEFAULT_PATHS)
    if set(paths) != set(DEFAULT_PATHS):
        raise ValueError("Incomplete training dataset path contract")
    data = {name: checked_path(root, value) for name, value in paths.items()}
    if any(out == d.resolve() or out.is_relative_to(d.resolve()) for d in data.values()):
        raise ValueError("Training output must not be inside a frozen dataset")
    # Integrity/lineage checks may parse audit structure; no audit metric is used
    # for fitting or selection. Held-out evaluation follows each model's freeze.
    atlas_dataset.verify_release(data["shape"])
    atlas_disease_recipe_dataset.verify_release(data["disease_recipes"])
    geometry_release = atlas_disease_geometry_dataset.verify_release(data["disease_geometry"])
    if geometry_release["parent_recipe_release_sha256"] != sha256(
        data["disease_recipes"] / "release.json"
    ):
        raise ValueError("Disease geometry is bound to a different recipe release")
    clinical_release = atlas_disease_dataset.verify_release(data["clinical"])
    if clinical_release["rights"]["contains_noncommercial"]:
        raise ValueError("This final runner intentionally accepts the CC BY clinical release only")
    atlas_material_dataset.verify_material_release(data["material"], parent=data["shape"])
    language.verify_contract(data["language"], data["shape"])
    device = "cuda" if config.device == "auto" and torch.cuda.is_available() else config.device
    if device == "auto":
        device = "cpu"
    if device == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA was requested but is unavailable")
    language_enabled = config.language == "on" or (config.language == "auto" and device == "cuda")
    identity = {
        "format": FORMAT,
        "config": asdict(config),
        "code_hashes": code_hashes(root),
        "release_hashes": {name: sha256(path / "release.json") for name, path in data.items()},
        "device": device,
        "language_enabled": language_enabled,
    }
    out.mkdir(parents=True, exist_ok=True)
    identity_path = out / "run_identity.json"
    if identity_path.exists() and json.loads(identity_path.read_text()) != identity:
        raise ValueError(
            "Run inputs changed. Choose a new output directory; frozen runs cannot be retuned"
        )
    write_json(identity_path, identity)
    completion = out / "completion.json"
    if completion.exists():
        result = json.loads(completion.read_text())
        if sha256(out / "export/manifest.json") != result["export_manifest_sha256"]:
            raise ValueError("Completed export manifest changed")
        verify_hashes(
            out / "export",
            json.loads((out / "export/manifest.json").read_text())["artifact_hashes"],
        )
        if sha256(out / "viscera-final-weights.zip") != result["weights_sha256"]:
            raise ValueError("Completed weights ZIP changed")
        return result
    smoke = config.profile == "smoke"
    summaries: dict[str, Any] = {}
    stages: dict[str, Path] = {}

    def train_shape(destination: Path) -> dict[str, Any]:
        report = shape.train(
            data["shape"],
            destination,
            shape.TrainConfig(
                steps=4 if smoke else 1200,
                checkpoint_every=2 if smoke else 100,
                device=device,
            ),
        )
        write_json(
            destination / "freeze.json",
            {"model_sha256": sha256(destination / "model.pt"), "tuning_closed": True},
        )
        audit = shape.evaluate(
            data["shape"],
            destination / "model.pt",
            "audit",
            decoder=shape.make_geometry_decoder(data["shape"] / "templates"),
        )
        write_json(destination / "audit_report.json", audit)
        return {
            "selected": report["selected_method"],
            "steps": 4 if smoke else 1200,
            "scope": "seven bounded synthetic atlas geometry controls",
            "audit": audit,
        }

    def train_material(destination: Path) -> dict[str, Any]:
        report = material.train(
            data["material"],
            destination,
            material.Config(
                steps=4 if smoke else 2000,
                checkpoint_every=2 if smoke else 250,
            ),
        )
        write_json(
            destination / "freeze.json",
            {"model_sha256": sha256(destination / "model.npz"), "tuning_closed": True},
        )
        audit_rows = atlas_material_dataset.read_split(data["material"], "audit")
        for split in ("train", "val"):
            material.ensure_groups(
                atlas_material_dataset.read_split(data["material"], split), audit_rows
            )
        audit = material.evaluate(
            data["material"], destination / "model.npz", "audit", freeze=destination / "freeze.json"
        )
        write_json(destination / "audit_report.json", audit)
        return {
            "selected": report["selected"],
            "steps": report["steps"],
            "scope": "six synthetic procedural appearance controls; no measured tissue optics",
            "audit": audit,
        }

    def train_disease(destination: Path) -> dict[str, Any]:
        report = disease.train_recipe(
            data["disease_recipes"], destination, disease.Config(steps=4 if smoke else 1600)
        )
        audit = disease.evaluate_recipe(
            data["disease_recipes"], destination / "model.npz", freeze=destination / "freeze.json"
        )
        write_json(destination / "audit_report.json", audit)
        return {
            "selected": report["selected_method"],
            "steps": 4 if smoke else 1600,
            "scope": report["scope"],
            "patient_count": 0,
            "audit": audit,
        }

    def train_clinical(destination: Path) -> dict[str, Any]:
        report = disease.train_source(data["clinical"], destination)
        audit = disease.evaluate_source(
            data["clinical"], destination / "source_model.json", freeze=destination / "freeze.json"
        )
        write_json(destination / "audit_report.json", audit)
        return {
            "selected": "conditional_empirical_case_prior",
            "scope": report["scope"],
            "training_patients": report["training_patients"],
            "audit": audit,
        }

    for name, action in (
        ("shape", train_shape),
        ("material", train_material),
        ("disease", train_disease),
        ("clinical", train_clinical),
    ):
        stages[name], summaries[name] = _stage(out, name, action)

    def train_language(destination: Path) -> dict[str, Any]:
        report = language.train_lora(
            data["language"],
            data["shape"],
            destination,
            language.LanguageConfig(
                steps=2 if smoke else 200,
                checkpoint_every=1 if smoke else 25,
                validation_limit=2 if smoke else 24,
                device=device,
            ),
        )
        write_json(
            destination / "freeze.json",
            {
                "adapter_manifest_sha256": sha256(destination / "adapter_manifest.json"),
                "tuning_closed": True,
            },
        )
        # A small fixed audit subset limits generation cost; all groups are checked.
        audit_rows = language.read_split(data["language"], "audit")
        for split in ("train", "val"):
            language.audit_groups(language.read_split(data["language"], split), audit_rows)
        selected = language.validation_subset(audit_rows, 2 if smoke else 24, 4197)
        model, tokenizer = language.load_adapter(
            data["language"], data["shape"], destination, device=device
        )
        audit = language.score(
            selected,
            language.predictions(model, tokenizer, selected, device),
            data["shape"] / "templates",
        )
        audit.update(
            split="audit",
            selected_example_ids=[r["example_id"] for r in selected],
            full_audit_rows=len(audit_rows),
        )
        write_json(destination / "audit_report.json", audit)
        del model, tokenizer
        if device == "cuda":
            torch.cuda.empty_cache()
        return {
            "status": report["status"],
            "steps": report["steps"],
            "runtime_integrated": False,
            "studio_inference": "available_after_explicit_guarded_enable",
            "audit": audit,
        }

    if language_enabled:
        try:
            stages["language"], summaries["language"] = _stage(out, "language", train_language)
        except Exception as error:
            if config.language == "on":
                raise
            summaries["language"] = {
                "status": "FAILED_OPTIONAL_ADAPTER",
                "error": str(error),
                "traceback": traceback.format_exc(),
                "weights_exported": False,
            }
            print(
                f"[language] optional adapter failed: {error}; core weights will still export",
                flush=True,
            )
    else:
        summaries["language"] = {
            "status": "SKIPPED",
            "reason": "disabled explicitly"
            if config.language == "off"
            else "No CUDA; deterministic text compiler remains available",
            "weights_exported": False,
        }

    export = out / "export"
    if export.exists():
        # Only a previous incomplete export lives here: stage artifacts stay intact.
        shutil.rmtree(export)
    for name in ("shape", "material", "disease", "clinical"):
        names = {
            "shape": ("model.pt", "model.pt.sha256.json"),
            "material": ("model.npz", "model.json"),
            "disease": ("model.npz", "model.json"),
            "clinical": ("source_model.json", "source_model.json.sha256.json"),
        }[name]
        _copy_export(
            stages[name],
            export / name,
            names + ("training_report.json", "audit_report.json", "freeze.json"),
        )
    if "language" in stages:
        _copy_export(
            stages["language"],
            export / "language",
            (
                "adapter",
                "adapter_manifest.json",
                "training_report.json",
                "audit_report.json",
                "freeze.json",
            ),
        )
    write_json(export / "inference_examples.json", inference_examples(export))
    write_json(export / "run_identity.json", identity)
    write_json(export / "metrics.json", summaries)
    write_json(
        export / "environment.json",
        {
            "python": sys.version,
            "platform": platform.platform(),
            "packages": {
                d.metadata["Name"]: d.version
                for d in importlib.metadata.distributions()
                if d.metadata.get("Name")
            },
        },
    )
    (export / "README.txt").write_text(
        "VISCERA control models, not a standalone free-form 3D foundation model.\n"
        "Keep the exact final dataset bundle: its licensed atlas templates, source code and procedural decoders are required for inference.\n"
        "shape/: seven geometry controls; material/: six procedural appearance controls; disease/: nine visual recipe controls.\n"
        "clinical/: retrieval prior from the measured training cases only, not a population generator.\n"
        "language/ exists only when optional pretrained Qwen LoRA training completed. Studio can explicitly enable it after downloading the pinned base model; every shape proposal must exactly pass the compiler guard. No automatic activation or disease/appearance text prediction.\n"
        "No tissue stiffness, contact mechanics or calibrated surgical simulator was learned.\n"
        "Smoke-profile artifacts are diagnostic only. Read metrics.json for the selected baseline/neural method and run_identity.json for the profile.\n"
        "Split holdouts for synthetic controls share source atlas lineages. Clinical cases are split by patient.\n"
    )
    # Preserve attribution without duplicating meshes or clinical cases into a weights archive.
    for name, directory in data.items():
        for pattern in (
            "*LICENSE*",
            "*ATTRIBUTION*",
            "*attribution*",
            "*rights*",
            "dataset_card.json",
            "DATASET_CARD.md",
        ):
            for source in directory.glob(pattern):
                if source.is_file():
                    target = export / "attribution" / name / source.name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, target)
        for nested in ("templates/ATTRIBUTIONS.md", "templates/attribution", "provenance"):
            source = directory / nested
            if source.exists():
                target = export / "attribution" / name / nested
                target.parent.mkdir(parents=True, exist_ok=True)
                if source.is_dir():
                    shutil.copytree(source, target)
                else:
                    shutil.copyfile(source, target)
    hashes = {
        str(p.relative_to(export)): sha256(p) for p in sorted(export.rglob("*")) if p.is_file()
    }
    write_json(
        export / "manifest.json",
        {
            "format": FORMAT,
            "artifact_hashes": hashes,
            "dataset_dependencies": identity["release_hashes"],
            "smoke_only": smoke,
        },
    )
    verify_hashes(export, hashes)
    archive = out / "viscera-final-weights.zip"
    _write_zip(export, archive)
    result = {
        "status": "complete",
        "profile": config.profile,
        "weights": str(archive),
        "weights_sha256": sha256(archive),
        "export_manifest_sha256": sha256(export / "manifest.json"),
        "bytes": archive.stat().st_size,
        "lanes": {
            name: {k: v for k, v in summary.items() if k != "audit"}
            for name, summary in summaries.items()
        },
        "physics_parameters_learned": False,
        "standalone_3d_foundation_model": False,
    }
    write_json(completion, result)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--profile", choices=("smoke", "full"), default="full")
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--language", choices=("auto", "on", "off"), default="auto")
    args = parser.parse_args()
    print(
        json.dumps(
            run(
                args.root,
                args.out,
                RunConfig(profile=args.profile, device=args.device, language=args.language),
            ),
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
