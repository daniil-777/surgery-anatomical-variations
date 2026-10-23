"""Deterministic captions, family mapping and rights profiles for crops."""

from __future__ import annotations

import hashlib

TOKEN = "vscrtex"

# Renderer family -> prompt phrase. Exterior families come from DSAD organ labels,
# mucosa families from HyperKvasir landmark classes. No family is invented from a
# label that the renderer does not have.
FAMILY_PHRASES = {
    "liver": "liver capsule surface",
    "spleen": "spleen capsule surface",
    "stomach": "stomach serosa surface",
    "small_bowel": "small bowel serosa surface",
    "large_bowel": "colon serosa surface",
    "pancreas": "pancreas lobular surface",
    "colonic_mucosa": "colon mucosa",
    "gastric_mucosa": "gastric mucosa",
}
EXTERIOR_FAMILIES = ("liver", "spleen", "stomach", "small_bowel", "large_bowel", "pancreas")
MUCOSA_FAMILIES = ("colonic_mucosa", "gastric_mucosa")

DSAD_FAMILIES = {"liver": "liver", "spleen": "spleen", "stomach": "stomach",
                 "small_bowel": "small_bowel", "large_bowel": "large_bowel", "pancreas": "pancreas"}
# HyperKvasir class directory -> (family, condition tag or None)
HYPERKVASIR_CLASSES = {
    "lower-gi-tract/anatomical-landmarks/cecum": ("colonic_mucosa", None),
    "lower-gi-tract/anatomical-landmarks/retroflex-rectum": ("colonic_mucosa", None),
    "lower-gi-tract/quality-of-mucosal-views/bbps-2-3": ("colonic_mucosa", None),
    "upper-gi-tract/anatomical-landmarks/pylorus": ("gastric_mucosa", None),
    "upper-gi-tract/anatomical-landmarks/retroflex-stomach": ("gastric_mucosa", None),
    "lower-gi-tract/pathological-findings/ulcerative-colitis-grade-1": ("colonic_mucosa", "mild ulcerative colitis"),
    "lower-gi-tract/pathological-findings/ulcerative-colitis-grade-2": ("colonic_mucosa", "ulcerative colitis"),
    "lower-gi-tract/pathological-findings/ulcerative-colitis-grade-3": ("colonic_mucosa", "severe ulcerative colitis"),
}

RIGHTS_PROFILES = {
    # DSAD: Figshare/HF declare CC BY 4.0; the article's usage note says non-commercial.
    # The project keeps DSAD-derived weights and tiles research-only until clarified.
    "dsad": {"licence_spdx": "CC-BY-4.0", "training_profile": "noncommercial-research",
             "licence_conflict": "Repository CC-BY-4.0; paper Usage Notes says non-commercial usage",
             "attribution": "Carstens et al., Scientific Data 10, 3 (2023), DSAD, CC BY 4.0"},
    "hyperkvasir": {"licence_spdx": "CC-BY-4.0", "training_profile": "unrestricted",
                    "licence_conflict": None,
                    "attribution": "Borgli et al., Scientific Data 7, 283 (2020), HyperKvasir, CC BY 4.0"},
}


CAPTION_STYLES = ("v1", "v2")


def caption(family: str, condition: str | None = None, style: str = "v1") -> str:
    """v1: shared trigger token first (the mixed pilot learned a style but little organ identity).
    v2: the organ phrase leads and is repeated, the shared suffix comes last."""
    if family not in FAMILY_PHRASES:
        raise ValueError(f"unsupported tissue family: {family}")
    if condition is not None and (not isinstance(condition, str) or not condition.strip()
                                  or len(condition) > 80 or "," in condition):
        raise ValueError("condition must be a short comma-free phrase")
    if style not in CAPTION_STYLES:
        raise ValueError(f"unsupported caption style: {style}")
    phrase = FAMILY_PHRASES[family]
    tag = f", {condition.strip()}" if condition else ""
    if style == "v2":
        return f"{phrase}{tag}, {phrase} texture, {TOKEN} close-up"
    return f"{TOKEN} {phrase}{tag}, laparoscopic tissue surface close-up"


def stable_split(name: str, val_fraction: float = 0.1) -> str:
    """Content-independent, name-keyed split for sources without specimen identifiers."""
    if not 0 < val_fraction < 0.5:
        raise ValueError("val_fraction must be in (0, 0.5)")
    digest = hashlib.sha256(name.encode("utf-8")).digest()
    return "val" if int.from_bytes(digest[:8], "big") / 2**64 < val_fraction else "train"
