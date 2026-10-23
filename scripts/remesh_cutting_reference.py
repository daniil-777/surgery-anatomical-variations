"""Generate an isolated cutting candidate; does not publish application assets."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from viscera_core.cutting_remesh import remesh_cutting_reference

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source", type=Path, default=ROOT / "apps/studio/public/cutting/liver-reference.json"
    )
    parser.add_argument(
        "--out",
        type=Path,
        required=True,
        help="Fresh candidate directory; existing results are refused",
    )
    parser.add_argument("--coarse-mm", type=float, default=22)
    parser.add_argument("--fine-mm", type=float, default=3)
    parser.add_argument("--radius-mm", type=float, default=5)
    parser.add_argument(
        "--algorithm", type=int, choices=[1, 10], default=1, help="Gmsh Delaunay=1 or HXT=10"
    )
    parser.add_argument(
        "--no-feature-refinement",
        action="store_true",
        help="Diagnostic only: disable local refinement of sub-mm enclosure edges",
    )
    parser.add_argument(
        "--compact-contact-cap",
        action="store_true",
        help="Add a separate exact-domain contact tessellation; render cap remains unchanged",
    )
    args = parser.parse_args()
    try:
        report = remesh_cutting_reference(
            args.source,
            args.out,
            coarse=args.coarse_mm,
            fine=args.fine_mm,
            radius=args.radius_mm,
            algorithm=args.algorithm,
            refine_features=not args.no_feature_refinement,
            compact_contact=args.compact_contact_cap,
        )
    except (ValueError, RuntimeError) as error:
        parser.error(str(error))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
