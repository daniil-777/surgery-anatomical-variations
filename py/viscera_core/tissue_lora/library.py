"""Assemble learned studies into the Studio tissue catalog, with a rights gate.

Catalog entries follow the browser contract (contracts.ts validateEntry) and the
library layout the browser suite assumes (`<id>/preview/manifest.json`): the
native 4096 manifest is declared unavailable, the learned study is served as
the preview manifest at its own resolution.
"""

from __future__ import annotations

import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

from .captions import MUCOSA_FAMILIES, RIGHTS_PROFILES
from .pbr import LABELS, browser_bundle, export_study, sha256_file

CATALOG_SCHEMA = "viscera.tissue-catalog/v1"
PATH_RE = re.compile(r"^[a-z0-9_][a-z0-9_/-]*\.json$")


def validate_entry(entry: dict) -> dict:
    """Mirror of the TypeScript catalog validation so a bad entry never reaches the browser."""
    if not isinstance(entry.get("id"), str) or not re.fullmatch(r"[a-z0-9_-]+", entry["id"]):
        raise ValueError("invalid catalog id")
    if "manifest" not in entry or "preview" not in entry or "label" not in entry or "luminal" not in entry:
        raise ValueError("catalog entry must declare manifest, preview, label and luminal")
    if not isinstance(entry.get("label"), str) or not entry["label"] or not isinstance(entry.get("luminal"), bool):
        raise ValueError("invalid catalog label/luminal")
    if not PATH_RE.match(entry.get("preview", "")) or ".." in entry["preview"]:
        raise ValueError("invalid preview path")
    manifest = entry.get("manifest")
    if manifest is not None and (not PATH_RE.match(manifest) or ".." in manifest):
        raise ValueError("invalid manifest path")
    if "family" in entry and not re.fullmatch(r"[a-z][a-z0-9_]{1,40}", str(entry["family"])):
        raise ValueError("invalid family key")
    if "group" in entry and (not isinstance(entry["group"], str) or not entry["group"].strip() or len(entry["group"]) > 80):
        raise ValueError("invalid catalog group")
    if "thumbnail" in entry and (not isinstance(entry["thumbnail"], str) or ".." in entry["thumbnail"]
                                 or not re.fullmatch(r"[a-z0-9_][a-z0-9_/-]*\.png", entry["thumbnail"])):
        raise ValueError("invalid thumbnail path")
    resolutions = entry.get("available_resolutions")
    if resolutions is not None:
        if (not isinstance(resolutions, list) or 512 not in resolutions or len(set(resolutions)) != len(resolutions)
                or any(value not in (512, 4096) for value in resolutions)):
            raise ValueError("invalid resolution availability")
    if manifest is None and (resolutions is None or 4096 in resolutions):
        raise ValueError("missing native manifest must be declared unavailable")
    return entry


def study_id(run_label: str, family: str, seed: str, condition: str | None) -> str:
    tag = f"-{re.sub(r'[^a-z0-9]+', '_', condition.lower()).strip('_')}" if condition else ""
    return f"learned-{run_label}-{family}{tag}-s{seed}"


def build_library(samples: Path, public: Path, *, run_label: str, allow_research_only: bool = False,
                  wetness: float = 0.6, remove: bool = False, rights: dict | None = None) -> dict:
    """Export every sampled tile under samples into public/learned-<run_label>/ and merge the catalog."""
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,30}", run_label):
        raise ValueError("run label must be a short lowercase slug")
    samples, public = Path(samples), Path(public)
    catalog_path = public / "catalog.json"
    catalog = json.loads(catalog_path.read_text())
    if catalog.get("schema") != CATALOG_SCHEMA or not isinstance(catalog.get("materials"), list):
        raise ValueError("unsupported tissue catalog")
    prefix = f"learned-{run_label}"
    receipt_path = public / f"{prefix}.library.json"
    if remove:
        # Remove exactly what this label's receipt created; never match other labels by prefix.
        if not receipt_path.is_file():
            raise FileNotFoundError(f"no learned library receipt for {run_label}")
        previous = json.loads(receipt_path.read_text())
        ids = {study["id"] for study in previous["studies"]}
        kept = [entry for entry in catalog["materials"] if entry["id"] not in ids]
        for study in previous["studies"]:
            directory = public / study["id"]
            if directory.is_dir():
                shutil.rmtree(directory)
        receipt_path.unlink()
        catalog["materials"] = kept
        catalog_path.write_text(json.dumps(catalog, indent=2) + "\n")
        return {"studies": 0, "catalog_entries": len(kept), "rights": [], "removed": True}
    receipts = sorted(samples.glob("*/sample.json"))
    if not receipts:
        raise ValueError("no sampled tiles found")
    profiles = set()
    for receipt in receipts:
        data = json.loads(receipt.read_text())
        profile = (rights or {}).get("training_profile") or data.get("training_profile") or "noncommercial-research"
        profiles.add(profile)
    if profiles - {"unrestricted"} and not allow_research_only:
        raise PermissionError("research-only (or unknown-rights) studies need --allow-research-only; use it for a local "
                              "or research build, never for an unrestricted public release")
    if receipt_path.exists():
        raise FileExistsError(f"learned library {prefix} exists; remove it first (--remove)")
    entries = []
    studies = []
    skipped = []
    for receipt in receipts:
        data = json.loads(receipt.read_text())
        family, seed, condition = data["family"], data["seed"], data.get("condition")
        if data.get("size") != data.get("native_size") or data.get("size") != 512:
            skipped.append({"directory": receipt.parent.name, "reason": "catalog entries declare 512-only previews; resampled or non-512 tiles are review-only"})
            continue
        identifier = study_id(run_label, family, seed, condition)
        if (public / identifier).exists() or any(entry["id"] == identifier for entry in catalog["materials"]):
            raise FileExistsError(f"study id already present: {identifier}")
        study_dir = public / identifier / "preview"
        manifest = export_study(receipt.parent, study_dir, wetness=wetness, rights=rights or RIGHTS_PROFILES.get("dsad"))
        bundle = browser_bundle(study_dir)
        with Image.open(study_dir / "base_color.png") as image:
            image.convert("RGB").resize((128, 128), Image.Resampling.LANCZOS).save(study_dir / "thumbnail.png", optimize=True)
        label = f"{LABELS[family]} · learned {run_label}" + (f" · {condition}" if condition else "") + f" · seed {seed}"
        entry = validate_entry({"id": identifier, "label": label, "manifest": None,
                                "preview": f"{identifier}/preview/manifest.json", "luminal": family in MUCOSA_FAMILIES,
                                "available_resolutions": [512], "family": family, "group": f"Learned · {run_label}",
                                "thumbnail": f"{identifier}/preview/thumbnail.png"})
        entries.append(entry)
        studies.append({"id": identifier, "directory": study_dir.relative_to(public).as_posix(),
                        "manifest_sha256": sha256_file(study_dir / "manifest.json"), "bundle": bundle.name,
                        "resolution": manifest["resolution"], "family": family, "seed": seed, "condition": condition})
    existing = [entry for entry in catalog["materials"] if entry["id"] not in {e["id"] for e in entries}]
    catalog["materials"] = existing + entries
    catalog_path.write_text(json.dumps(catalog, indent=2) + "\n")
    receipt_doc = {"schema": "viscera.tissue-learned-library/v1", "run_label": run_label, "studies": studies,
                   "skipped": skipped, "rights": sorted(profiles), "allow_research_only": allow_research_only,
                   "created": datetime.now(timezone.utc).isoformat(),
                   "meaning": "learned appearance studies for local/research inspection; not clinically qualified"}
    receipt_path.write_text(json.dumps(receipt_doc, indent=2) + "\n")
    return {"studies": len(studies), "catalog_entries": len(catalog["materials"]), "rights": sorted(profiles),
            "skipped": len(skipped), "receipt": str(receipt_path)}
