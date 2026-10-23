#!/usr/bin/env python3
"""Prepare an explicitly training-only smoke corpus from previously verified data.

Existing HyperKvasir has no reliable patient/sequence IDs: the entire segmented
collection is ONE source group and is never randomly split by frames. HeiPor's
two-image example covers two distinct animals and organs, too few for evaluation.
"""
from __future__ import annotations

import argparse
import json
import re
import zipfile
from pathlib import Path

from prepare_tissue_v3_dataset import (
    MASK_POLICY,
    ShardWriter,
    sha256_bytes,
    sha256_file,
    valid_tissue_mask,
)


def prepare_existing(source_root, output, count=64):
    source_root, output = Path(source_root), Path(output)
    if output.exists() or not output.parent.is_dir() or not 1 <= count <= 1000:
        raise ValueError("Select a new output below an existing parent and count 1..1000")
    sources = [
        ("hyperkvasir-segmented", "hyper-kvasir-segmented-images.zip"),
        ("heiporspectral-example", "HeiPorSPECTRAL_example.zip"),
    ]
    verified = []
    for asset, filename in sources:
        path = source_root / asset / filename
        receipt = json.loads(path.with_name(filename + ".provenance.json").read_text())
        if sha256_file(path) != receipt["sha256"] or path.stat().st_size != receipt["bytes"]:
            raise ValueError("Existing archive receipt mismatch")
        verified.append((asset, path, receipt))
    output.mkdir()
    writer = ShardWriter(output, "train", 512 * 1024**2)
    rows = []

    def add(asset, receipt, image_name, mask_name, image, mask, *, group, group_level,
            group_provenance, species, organ, condition, region, extra=None):
        valid, quality = valid_tissue_mask(image, mask)
        identifier = f"{asset}-{len(rows):04d}"
        row = {"id": identifier, "dataset_id": "hyperkvasir" if "hyper" in asset else "heiporspectral",
               "source_asset_id": asset, "source_archive_sha256": receipt["sha256"],
               "source_member": image_name, "source_mask_member": mask_name,
               "source_mask_sha256": sha256_bytes(mask), "derivation_parent_sha256": sha256_bytes(image),
               "group_id": group, "group_level": group_level, "group_provenance": group_provenance,
               "split": "train", "split_provenance": "Entire source group assigned train; no held-out evaluation possible",
               "condition": condition, "condition_region": region, "species": species, "organ": organ,
               "patient_id": None, "observed_rgb": True, "licence_spdx": "CC-BY-4.0",
               "mask_semantics": "valid_tissue_white",
               "licence_source": receipt["license_sources"], "commercial_eligibility": "allowed",
               "training_eligible": True, "training_profile": "smoke-only-no-generalization-evaluation",
               "quality": quality, "mask_policy": {**MASK_POLICY, "organ": "publisher ROI mask; HyperKvasir ROI is polyp, HeiPor ROI is named organ"},
               **(extra or {})}
        for kind, payload in (("image", image), ("mask", valid)):
            ref = writer.add(identifier + ("-valid" if kind == "mask" else "") + ".png", payload)
            row.update({f"{kind}_{key}": value for key, value in ref.items()})
        rows.append(row)

    for asset, path, receipt in verified:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            if asset == "hyperkvasir-segmented":
                images = sorted(n for n in names if "/images/" in n and n.lower().endswith((".jpg", ".png")))
                for name in images[:count]:
                    mask_name = name.replace("/images/", "/masks/")
                    add(asset, receipt, name, mask_name, archive.read(name), archive.read(mask_name),
                        group="hyperkvasir:segmented:unknown-patient-collection", group_level="source_collection",
                        group_provenance="Publisher provides no patient/sequence linkage; entire collection conservatively grouped",
                        species="human", organ="colonic_polyp", condition="human:colonic_mucosa:polyp",
                        region="colonic_mucosa", extra={"pathology": "polyp", "tissue_domain": "luminal"})
            else:
                for name in sorted(n for n in names if "/rgb_crops/" in n and n.endswith(".png")):
                    match = re.search(r"/(P\d+)#([^/]+)\.png$", name)
                    animal, timestamp = match.groups()
                    masks = [n for n in names if f"/{animal}/{timestamp}/annotations/" in n and "#annotator1#" in n and n.endswith("#binary.png")]
                    if len(masks) != 1:
                        raise ValueError("Expected one reviewed example organ ROI")
                    mask_name = masks[0]
                    organ = mask_name.split("#")[-2]
                    add(asset, receipt, name, mask_name, archive.read(name), archive.read(mask_name),
                        group="heiporspectral:animal:" + animal, group_level="animal",
                        group_provenance="Publisher subject ID in original archive path; no pig-to-human inference",
                        species="porcine", organ=organ, condition=f"porcine:exposed_organ:{organ}", region=organ,
                        extra={"animal_id": animal, "timestamp": timestamp, "tissue_domain": "exposed_organ",
                               "rgb_origin": "Publisher RGB reconstruction from HSI; not intrinsic reflectance",
                               "mask_annotator": "annotator1", "mask_selection": "One annotator for smoke only; other annotators retained in source archive"})
    writer.close_current()
    if not rows:
        raise ValueError("No source images found")
    text = "".join(json.dumps(r, sort_keys=True) + "\n" for r in rows)
    (output / "records.jsonl").write_text(text)
    (output / "train.jsonl").write_text(text)
    release = {"schema": "viscera.observed-rgb-dataset/v3", "records": len(rows),
               "records_by_split": {"train": len(rows)}, "shards": writer.files,
               "manifests": {p.name: {"bytes": p.stat().st_size, "sha256": sha256_file(p)} for p in output.glob("*.jsonl")},
               "preparation_script_sha256": sha256_file(__file__),
               "conditions": sorted({r["condition"] for r in rows}),
               "scope": "Training mechanics smoke only. No validation/test groups, realism or generalization claim. HyperKvasir masks are polyps, not healthy mucosa.",
               "grouping_limit": "No condition has three known independent groups. HyperKvasir unknown-patient collection is one source group.",
               "sources": [{"asset_id": asset, "bytes": receipt["bytes"], "sha256": receipt["sha256"]} for asset, _, receipt in verified]}
    (output / "release.json").write_text(json.dumps(release, indent=2, sort_keys=True) + "\n")
    return release


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--count", type=int, default=64)
    args = parser.parse_args()
    print(json.dumps(prepare_existing(args.source_root, args.output, args.count)))


if __name__ == "__main__":
    main()
