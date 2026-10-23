#!/usr/bin/env python3
"""Prepare observed surgical RGB, never intrinsic albedo, into indexed TAR shards.

DSAD surgery groups are assigned the publisher's split BEFORE any image crops.
Images retain original bytes. Masks intersect the expert organ mask with a
documented conservative glare/dark-pixel exclusion. No inferred patient IDs,
camera calibration, light removal or surface reflectance targets are created.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import tarfile
import uuid
import zipfile
from collections import Counter, defaultdict
from pathlib import Path, PurePosixPath

import numpy as np
from PIL import Image, ImageFilter

SPLIT_SOURCE = "https://huggingface.co/datasets/nct-tso/dsad/blob/main/README.md#splits"
SURGERY_SPLITS = {
    **dict.fromkeys([1, 4, 5, 6, 8, 9, 10, 12, 15, 16, 17, 19, 22, 23, 24, 25, 27, 28, 29, 30, 31], "train"),
    **dict.fromkeys([3, 21, 26], "val"),
    **dict.fromkeys([2, 7, 11, 13, 14, 18, 20, 32], "test"),
}
# Anatomical exterior mapping only. Other DSAD structures remain in the source
# archive; an organ label is not evidence for a luminal or arbitrary fascia map.
REGIONS = {"liver": "liver", "pancreas": "pancreas", "spleen": "spleen",
           "stomach": "stomach", "colon": "large_bowel", "small_intestine": "small_bowel"}
MASK_POLICY = {
    "version": "dsad-organ-glare-dark-v1",
    "valid_value": 255, "excluded_value": 0,
    "organ": "publisher expert-reviewed binary organ mask >=128",
    "glare": "max RGB>=245 AND min RGB>=180 AND (max-min)/max<=0.35; dilated by 1 pixel",
    "dark": "max RGB<=16",
    "limits": "Heuristic excludes clipped/bright neutral pixels, not all specular light. No tool-specific ground-truth mask; organ masks may contain annotation errors. No illumination removal.",
}


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for data in iter(lambda: stream.read(4 * 1024**2), b""):
            h.update(data)
    return h.hexdigest()


def parse_dsad_member(name):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name:
        raise ValueError("Unsafe ZIP member name")
    if len(path.parts) < 3 or not re.fullmatch(r"image\d+\.png", path.name):
        return None
    organ, surgery = path.parts[-3:-1]
    if organ not in REGIONS or not re.fullmatch(r"\d{1,2}", surgery):
        return None
    surgery_number = int(surgery)
    if surgery_number not in SURGERY_SPLITS:
        raise ValueError(f"Unknown surgery ID: {surgery}")
    frame = re.fullmatch(r"image(\d+)\.png", path.name)[1]
    mask = str(path.with_name("mask" + frame + ".png"))
    return organ, f"{surgery_number:02d}", frame, mask


def valid_tissue_mask(image_bytes, mask_bytes):
    with Image.open(io.BytesIO(image_bytes)) as image:
        if image.width * image.height > 16_000_000:
            raise ValueError("Image exceeds pixel budget")
        rgb = np.asarray(image.convert("RGB"))
    with Image.open(io.BytesIO(mask_bytes)) as mask:
        if mask.size != (rgb.shape[1], rgb.shape[0]):
            raise ValueError("Image and mask dimensions differ")
        organ = np.asarray(mask.convert("L")) >= 128
    maximum = rgb.max(axis=-1).astype(np.float32)
    minimum = rgb.min(axis=-1).astype(np.float32)
    glare = (maximum >= 245) & (minimum >= 180) & ((maximum - minimum) <= .35 * maximum)
    glare = np.asarray(Image.fromarray(glare.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(3))) > 0
    valid = organ & ~glare & (maximum > 16)
    buf = io.BytesIO()
    Image.fromarray(valid.astype(np.uint8) * 255).save(buf, format="PNG", compress_level=6)
    stats = {"organ_pixels": int(organ.sum()), "valid_pixels": int(valid.sum()),
             "glare_pixels_in_organ": int((organ & glare).sum()),
             "dark_pixels_in_organ": int((organ & (maximum <= 16)).sum()),
             "width": rgb.shape[1], "height": rgb.shape[0]}
    return buf.getvalue(), stats


class ShardWriter:
    def __init__(self, root, split, max_bytes):
        self.root, self.split, self.max_bytes = Path(root), split, max_bytes
        self.stream = None
        self.archive = None
        self.files = []

    def add(self, name, data):
        padded = 512 + ((len(data) + 511) // 512) * 512
        if padded + 10240 > self.max_bytes:
            raise ValueError("Single member exceeds shard bound")
        if self.stream is None or self.stream.tell() + padded + 10240 > self.max_bytes:
            self.close_current()
            self.path = self.root / f"{self.split}-{len(self.files):04d}.tar"
            self.stream = self.path.open("xb")
            self.archive = tarfile.open(fileobj=self.stream, mode="w", format=tarfile.USTAR_FORMAT)
        offset = self.stream.tell() + 512
        info = tarfile.TarInfo(name)
        info.size, info.mode, info.mtime = len(data), 0o644, 0
        self.archive.addfile(info, io.BytesIO(data))
        return {"path": self.path.name, "offset": offset, "length": len(data), "sha256": sha256_bytes(data)}

    def close_current(self):
        if self.stream is not None:
            self.archive.close()
            self.stream.flush()
            os.fsync(self.stream.fileno())
            self.stream.close()
            self.files.append({"path": self.path.name, "split": self.split,
                               "bytes": self.path.stat().st_size, "sha256": sha256_file(self.path)})
            self.stream = None


def prepare_dsad(archive_path, output, *, source_receipt=None, max_shard_bytes=512 * 1024**2,
                 max_output_bytes=32 * 1024**3, max_per_group=None, reserve_bytes=2 * 1024**3):
    archive_path, output = Path(archive_path), Path(output)
    if any(part.is_symlink() for part in (output, *output.parents)):
        raise ValueError("Output symlink components are forbidden")
    if output.exists() or output.is_symlink():
        raise ValueError("Output already exists; preserve it and select a new version")
    if not output.parent.is_dir():
        raise ValueError("Output parent must already exist; mounted volumes are never created")
    if max_shard_bytes < 10240 or max_output_bytes <= 0 or reserve_bytes < 0:
        raise ValueError("Invalid byte budget")
    if max_per_group is not None and max_per_group <= 0:
        raise ValueError("max_per_group must be positive")
    source_hash = sha256_file(archive_path)
    if source_receipt:
        receipt = json.loads(Path(source_receipt).read_text())
        if receipt["sha256"] != source_hash or receipt["bytes"] != archive_path.stat().st_size:
            raise ValueError("Source archive does not match verified receipt")
    else:
        raise ValueError("A verified acquisition receipt is required")
    stage = output.with_name(output.name + ".staging-" + uuid.uuid4().hex[:12])
    stage.mkdir()
    writers = {s: ShardWriter(stage, s, max_shard_bytes) for s in ("train", "val", "test")}
    rows, source_identities, counts = [], {}, Counter()
    total_bytes = 0
    groups = defaultdict(lambda: defaultdict(set))
    try:
        with zipfile.ZipFile(archive_path) as archive:
            members = archive.infolist()
            if len(members) > 200000 or len({m.filename for m in members}) != len(members):
                raise ValueError("ZIP has duplicate names or exceeds member budget")
            names = {m.filename: m for m in members}
            for member in sorted(members, key=lambda m: m.filename):
                parsed = parse_dsad_member(member.filename)
                if parsed is None:
                    continue
                organ, surgery, frame, mask_name = parsed
                key = (organ, surgery)
                if max_per_group is not None and counts[key] >= max_per_group:
                    continue
                if mask_name not in names:
                    raise ValueError(f"Missing source mask: {mask_name}")
                if member.file_size > 32 * 1024**2 or names[mask_name].file_size > 32 * 1024**2:
                    raise ValueError("Source image member exceeds bound")
                image = archive.read(member)
                source_mask = archive.read(mask_name)
                image_hash = sha256_bytes(image)
                split = SURGERY_SPLITS[int(surgery)]
                if image_hash in source_identities and source_identities[image_hash] != split:
                    raise ValueError("Identical source content crosses publisher splits")
                source_identities[image_hash] = split
                mask, quality = valid_tissue_mask(image, source_mask)
                if quality["valid_pixels"] == 0:
                    continue
                total_bytes += len(image) + len(mask) + 2048
                if total_bytes > max_output_bytes:
                    raise ValueError("Prepared data exceeds output byte ceiling")
                if shutil.disk_usage(stage).free < reserve_bytes + len(image) + len(mask) + 10240:
                    raise ValueError("Prepared data reached disk reserve")
                identifier = f"dsad-{organ}-{surgery}-{frame}"
                image_ref = writers[split].add(identifier + ".png", image)
                mask_ref = writers[split].add(identifier + "-valid.png", mask)
                row = {"id": identifier, "dataset_id": "dsad", "source_asset_id": "dsad-original-research",
                       "source_archive_sha256": source_hash, "source_member": member.filename,
                       "source_mask_member": mask_name, "source_mask_sha256": sha256_bytes(source_mask),
                       "derivation_parent_sha256": image_hash, "group_id": f"dsad:surgery:{surgery}",
                       "group_level": "surgery", "group_provenance": "Original DSAD archive surgery directory; official DSAD mirror split",
                       "split": split, "split_provenance": SPLIT_SOURCE, "patient_id": None,
                       "surgery_id": surgery, "frame_id": frame, "species": "human", "organ": organ,
                       "condition": f"human:laparoscopic_exterior:{organ}", "condition_region": REGIONS[organ],
                       "tissue_domain": "laparoscopic_exterior", "observed_rgb": True,
                       "mask_semantics": "valid_tissue_white",
                       "licence_spdx": "CC-BY-4.0", "licence_source": receipt.get("license_sources", []),
                       "licence_conflict": "Repository CC-BY-4.0; paper Usage Notes says non-commercial usage",
                       "commercial_eligibility": "ambiguous", "training_eligible": True,
                       "training_profile": "noncommercial-research-only", "mask_policy": MASK_POLICY,
                       "quality": quality}
                for kind, ref in (("image", image_ref), ("mask", mask_ref)):
                    row.update({f"{kind}_{key}": value for key, value in ref.items()})
                rows.append(row)
                counts[key] += 1
                groups[row["condition"]][split].add(row["group_id"])
        if not rows:
            raise ValueError("No supported masked exterior-organ samples found")
        for writer in writers.values():
            writer.close_current()
        for split in ("train", "val", "test"):
            with (stage / f"{split}.jsonl").open("x") as stream:
                for row in rows:
                    if row["split"] == split:
                        stream.write(json.dumps(row, sort_keys=True) + "\n")
        with (stage / "records.jsonl").open("x") as stream:
            for row in rows:
                stream.write(json.dumps(row, sort_keys=True) + "\n")
        release = {"schema": "viscera.observed-rgb-dataset/v3", "dataset_id": "dsad",
                   "source_archive_sha256": source_hash, "source_archive_bytes": archive_path.stat().st_size,
                   "preparation_script_sha256": sha256_file(__file__),
                   "records": len(rows), "records_by_split": dict(Counter(r["split"] for r in rows)),
                   "manifests": {p.name: {"bytes": p.stat().st_size, "sha256": sha256_file(p)}
                                 for p in stage.glob("*.jsonl")},
                   "shards": [item for w in writers.values() for item in w.files],
                   "conditions": {c: {s: sorted(ids) for s, ids in values.items()} for c, values in groups.items()},
                   "split_semantics": "Surgery-disjoint; no independent patient linkage asserted. Split chosen before cropping. Test shards are held out from training transfer.",
                   "scope": "Observed RGB appearance research, not intrinsic albedo/PBR or clinical ground truth",
                   "rights_profile": "Research-only; exclude from unrestricted/commercial models pending licence clarification",
                   "max_per_organ_surgery": max_per_group, "mask_policy": MASK_POLICY}
        (stage / "release.json").write_text(json.dumps(release, indent=2, sort_keys=True) + "\n")
        if sum(p.stat().st_size for p in stage.iterdir() if p.is_file()) > max_output_bytes:
            raise ValueError("Prepared files including TAR padding and manifests exceed output byte ceiling")
        os.rename(stage, output)
        return release
    except BaseException:
        for writer in writers.values():
            writer.close_current()
        # Preserve diagnostic staging on failure; never delete source data.
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-per-group", type=int)
    parser.add_argument("--max-output-gib", type=float, default=32)
    args = parser.parse_args(argv)
    release = prepare_dsad(args.archive, args.output, source_receipt=args.receipt,
                           max_per_group=args.max_per_group,
                           max_output_bytes=int(args.max_output_gib * 1024**3))
    print(json.dumps({"output": str(args.output), "records": release["records"],
                      "records_by_split": release["records_by_split"]}))


if __name__ == "__main__":
    main()
