"""Add integration-only contact triangles to a fresh copy of a cutting reference."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from viscera_core.cutting_contact_cap import attach_contact_cap


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True, help="Fresh output directory")
    args = parser.parse_args()
    if args.out.exists():
        parser.error(
            "Choose a fresh output directory; existing qualification artifacts are retained"
        )
    raw = args.source.read_bytes()
    candidate, report = attach_contact_cap(json.loads(raw))
    args.out.mkdir(parents=True)
    target = args.out / "liver-reference-contact.json"
    target.write_text(json.dumps(candidate, separators=(",", ":"), allow_nan=False) + "\n")
    receipt = {
        **report,
        "sourceReferenceSha256": hashlib.sha256(raw).hexdigest(),
        "outputSha256": hashlib.sha256(target.read_bytes()).hexdigest(),
        "source": str(args.source.resolve()),
        "output": str(target.resolve()),
    }
    (args.out / "contact-cap-report.json").write_text(json.dumps(receipt, indent=2) + "\n")
    source = candidate["source"]
    (args.out / "NOTICE.txt").write_text(
        f"SOURCE GEOMETRY\n{source['attribution']}\nLicense: {source['license']}\n"
        "https://creativecommons.org/licenses/by/4.0/\n\n"
        "MODIFICATION\nAdded an integration-only contact tessellation within existing support tetrahedra. "
        "Source skin, rendered cap, mechanical nodes/tetrahedra and paired interface remain unchanged. "
        "Input remeshing provenance remains in the reference. No Gmsh binaries or source are included.\n\n"
        f"Input reference SHA-256: {receipt['sourceReferenceSha256']}\n"
        f"Output reference SHA-256: {receipt['outputSha256']}\n\n"
        "SCOPE\nCompaction preserves the declared reference domain; it does not independently validate "
        "cutting dynamics, visual realism, real-time performance or clinical suitability.\n"
    )
    print(json.dumps({k: v for k, v in receipt.items() if k != "groups"}, indent=2))


if __name__ == "__main__":
    main()
