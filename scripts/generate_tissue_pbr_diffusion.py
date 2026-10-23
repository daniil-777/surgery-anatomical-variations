#!/usr/bin/env python3
"""Optional StableMaterials pilot. `plan`/metadata audit never fetch weights.

Examples from viscera/:
  .venv/bin/python scripts/generate_tissue_pbr_diffusion.py plan
  .venv/bin/python scripts/generate_tissue_pbr_diffusion.py download --snapshot /external/model --allow-weights
  .venv/bin/python scripts/generate_tissue_pbr_diffusion.py sample --snapshot /external/model --output /external/review/liver42 --device mps --seed 42 --steps 20
  .venv/bin/python scripts/generate_tissue_pbr_diffusion.py package --output /tmp/tissue-pbr-runner.zip

Review output before catalog integration. This does not train, certify anatomy,
install dependencies, run remote code from an unpinned revision, or publish.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "py"))
from viscera_core.tissue_diffusion.contract import PilotRequest
from viscera_core.tissue_diffusion.runtime import download_snapshot, plan, run_pilot, verify_snapshot


def package(output: Path) -> dict:
    """Freeze this isolated runner for the notebook, with no model or patient data."""
    selected = [Path(__file__), *sorted((ROOT / "py/viscera_core/tissue_diffusion").glob("*.py")),
        ROOT / "py/viscera_core/tissue_diffusion/stablematerials-lock.json"]
    files = {path.relative_to(ROOT).as_posix(): path.read_bytes() for path in selected}
    inventory = {name: hashlib.sha256(raw).hexdigest() for name, raw in files.items()}
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, raw in sorted(files.items()):
            archive.writestr(name, raw)
        archive.writestr("runner-inventory.json", json.dumps(inventory, indent=2) + "\n")
    return {"file": str(output), "sha256": hashlib.sha256(output.read_bytes()).hexdigest(), "files": len(files)}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("plan")
    for command in ("download", "verify", "sample"):
        sub = commands.add_parser(command)
        sub.add_argument("--snapshot", type=Path, required=True)
        if command == "download":
            sub.add_argument("--allow-weights", action="store_true", help="explicitly download the pinned 4.27GB text-only checkpoint")
        if command == "sample":
            sub.add_argument("--output", type=Path, required=True)
            sub.add_argument("--device", choices=("cuda", "mps", "cpu"), required=True)
            sub.add_argument("--organ", default="liver")
            sub.add_argument("--seed", type=int, default=42)
            sub.add_argument("--prompt", default=PilotRequest.prompt)
            sub.add_argument("--negative-prompt", default=PilotRequest.negative_prompt)
            sub.add_argument("--steps", type=int, default=50)
            sub.add_argument("--guidance", type=float, default=7.5)
            sub.add_argument("--tile-size-mm", type=float, default=80)
            sub.add_argument("--height-scale-mm", type=float, default=.08)
    sub = commands.add_parser("package")
    sub.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "plan":
        result = plan()
    elif args.command == "download":
        result = download_snapshot(args.snapshot, allow_weights=args.allow_weights)
    elif args.command == "verify":
        result = verify_snapshot(args.snapshot)
    elif args.command == "package":
        result = package(args.output)
    else:
        request = PilotRequest(**{key: getattr(args, key) for key in
            ("organ", "seed", "prompt", "negative_prompt", "steps", "guidance", "tile_size_mm", "height_scale_mm")})
        manifest = run_pilot(args.snapshot, args.output, request, device=args.device)
        result = {"output": str(args.output), "resolution": manifest["resolution"], "provenance": manifest["provenance"], "diagnostics": manifest["diagnostics"]}
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
