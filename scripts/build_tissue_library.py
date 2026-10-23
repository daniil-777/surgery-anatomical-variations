#!/usr/bin/env python3
"""Build the isolated Studio tissue library with native 4K and small previews.

Reuses only manifests whose recipe, revision, dimensions and file hashes match.
The material sources are original procedural fields, never patient data.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py"))
from viscera_core.tissue_materials import ORGAN_PROFILES, TissueRecipe, export_material  # noqa: E402
from viscera_core.tissue_materials.recipe import VERSION  # noqa: E402


def valid_existing(path: Path, recipe: TissueRecipe, resolution: int) -> bool:
    try:
        manifest = json.loads((path / "manifest.json").read_text())
        if (manifest["generator"] != VERSION or manifest["recipe"] != recipe.to_dict()
                or manifest["resolution"] != [resolution, resolution]):
            return False
        source_root = Path(__file__).resolve().parents[1] / "py/viscera_core/tissue_materials"
        for name, recorded_hash in manifest["provenance"]["source_sha256"].items():
            source = source_root / name
            if source.parent != source_root or hashlib.sha256(source.read_bytes()).hexdigest() != recorded_hash:
                return False
        for asset in [*manifest["channels"].values(), *manifest["layers"]]:
            file = path / asset["file"]
            if not file.is_file():
                return False
            with file.open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != asset["sha256"]:
                    return False
        return True
    except (OSError, ValueError, KeyError):
        return False


def bake(task: tuple[str, str, dict, bool]) -> dict:
    root, identifier, values, preview_only = task
    recipe, start = TissueRecipe(**values), time.perf_counter()
    for resolution, suffix in [(512, "preview"), *([] if preview_only else [(4096, "native")])]:
        target = Path(root) / identifier / suffix
        if not valid_existing(target, recipe, resolution):
            export_material(recipe, target, resolution=resolution, stripe_rows=32, overwrite=True)
    return {"id": identifier, "seconds": time.perf_counter() - start}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "apps/studio/public/tissue-materials")
    parser.add_argument("--preview-only", action="store_true")
    parser.add_argument("--jobs", type=int, choices=range(1, 5), default=2)
    parser.add_argument("--only", nargs="+")
    args = parser.parse_args()
    known = {*ORGAN_PROFILES, "liver_peritoneum", "pancreas_mesentery"}
    if args.only and (not set(args.only).issubset(known) or len(set(args.only)) != len(args.only)):
        parser.error("--only must contain unique supported material IDs")
    entries, tasks = [], []
    for organ, profile in ORGAN_PROFILES.items():
        if args.only and organ not in args.only:
            continue
        recipe = TissueRecipe(organ=organ, fascia_opacity=.025 if "mucosa" in organ or organ in ("liver", "kidney", "spleen") else .1)
        entries.append({"id": organ, "label": profile.label, "manifest": f"{organ}/native/manifest.json", "preview": f"{organ}/preview/manifest.json", "luminal": "mucosa" in organ})
        tasks.append((str(args.output), organ, recipe.to_dict(), args.preview_only))
    for source, target, identifier, label in [
        ("liver", "peritoneum", "liver_peritoneum", "Liver → peritoneum · transition study"),
        ("pancreas", "mesentery", "pancreas_mesentery", "Pancreas → mesentery · transition study"),
    ]:
        if args.only and identifier not in args.only:
            continue
        recipe = TissueRecipe(organ=source, transition_organ=target, fascia_opacity=.18, adipose_opacity=.2)
        entries.append({"id": identifier, "label": label, "manifest": f"{identifier}/native/manifest.json", "preview": f"{identifier}/preview/manifest.json", "luminal": False})
        tasks.append((str(args.output), identifier, recipe.to_dict(), args.preview_only))
    args.output.mkdir(parents=True, exist_ok=True)
    receipts = []
    with ProcessPoolExecutor(max_workers=args.jobs) as pool:
        for result in pool.map(bake, tasks):
            receipts.append(result)
            print(json.dumps(result), flush=True)
    catalog_path = args.output / "catalog.json"
    if args.only and catalog_path.exists():
        prior = json.loads(catalog_path.read_text())["materials"]
        entries = [entry for entry in prior if entry["id"] not in {item["id"] for item in entries}] + entries
    catalog_path.write_text(json.dumps({"schema": "viscera.tissue-catalog/v1", "materials": entries, "qualification": "procedural-research-baseline", "generator": VERSION}, indent=2) + "\n")
    (args.output / ("preview-build.json" if args.preview_only else "native-build.json")).write_text(json.dumps(receipts, indent=2) + "\n")


if __name__ == "__main__":
    main()
