"""Learned tissue tiles: a LoRA on a pinned Stable Diffusion 1.5 over lawful surgical crops.

Isolated from the fat generator and from the authored procedural library. Every
output carries its data rights profile, model lock and seed. Nothing here claims
measured optics, patient anatomy or clinical qualification.
"""

SCHEMA_CROPS = "viscera.tissue-crops/v1"
SCHEMA_RUN = "viscera.tissue-lora-run/v1"
SCHEMA_SAMPLE = "viscera.tissue-lora-sample/v1"
GENERATOR = "viscera.tissue-lora/v1"

__all__ = ["GENERATOR", "SCHEMA_CROPS", "SCHEMA_RUN", "SCHEMA_SAMPLE"]
