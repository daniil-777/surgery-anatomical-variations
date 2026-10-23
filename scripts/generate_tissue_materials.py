#!/usr/bin/env python3
"""Generate isolated layered tissue surface assets and their catalog."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py"))

from viscera_core.tissue_materials import (  # noqa: E402
    ORGAN_PROFILES,
    TissueRecipe,
    export_material,
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--resolution", type=int, default=4096)
    parser.add_argument(
        "--organs", nargs="+", choices=list(ORGAN_PROFILES), default=list(ORGAN_PROFILES)
    )
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--tile-size-mm", type=float, default=80)
    parser.add_argument("--stripe-rows", type=int, default=32)
    parser.add_argument("--vessel-opacity", type=float, default=0.70)
    parser.add_argument("--fascia-opacity", type=float, default=0.12)
    parser.add_argument("--adipose-opacity", type=float, default=0)
    parser.add_argument("--wetness", type=float, default=0.8)
    parser.add_argument("--detail", type=float, default=1)
    parser.add_argument("--transition-organ", choices=list(ORGAN_PROFILES))
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    entries = []
    for organ in args.organs:
        recipe = TissueRecipe(
            organ=organ,
            seed=args.seed,
            tile_size_mm=args.tile_size_mm,
            vessel_opacity=args.vessel_opacity,
            fascia_opacity=args.fascia_opacity,
            adipose_opacity=args.adipose_opacity,
            wetness=args.wetness,
            detail=args.detail,
            transition_organ=args.transition_organ,
        )
        export_material(
            recipe,
            args.output / organ,
            resolution=args.resolution,
            stripe_rows=args.stripe_rows,
            overwrite=args.overwrite,
        )
        entries.append(
            {
                "id": organ,
                "label": ORGAN_PROFILES[organ].label,
                "manifest": f"{organ}/manifest.json",
            }
        )
        print(f"{organ}: {args.resolution} × {args.resolution} complete", flush=True)
    catalog = {
        "schema": "viscera.tissue-catalog/v1",
        "materials": entries,
        "claim": "Procedural appearance research baseline; not clinically validated.",
    }
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "catalog.json").write_text(json.dumps(catalog, indent=2) + "\n")


if __name__ == "__main__":
    main()
