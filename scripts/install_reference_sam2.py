"""Install the pinned official SAM 2.1 tiny safetensors checkpoint, with checksums.

Run explicitly from the command line. The API never invokes this downloader.
Only hardcoded official public URLs are used; no credentials or images are sent.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
import urllib.request
from pathlib import Path

MODEL_ID = "facebook/sam2.1-hiera-tiny"
REVISION = "de431c4043854a71d8101e17995dfe596bf101a5"
BASE_URL = f"https://huggingface.co/{MODEL_ID}/resolve/{REVISION}"
LICENSE_URL = (
    "https://raw.githubusercontent.com/facebookresearch/sam2/"
    "2b90b9f5ceec907a1c18123530e92e794ad901a4/LICENSE"
)
FILES = {
    "config.json": (5695, "860aff9751b139d83a4ad7df1e5535416fded533e0ead02625edbefcb9953cce"),
    "preprocessor_config.json": (
        683,
        "6ebf229ee259368ce4a8d4f2fe893a72b053023710853e257253939e601f583d",
    ),
    "processor_config.json": (
        95,
        "f8a68e865cfad115c1c2763f3d93eca7b1c622da06da2a9273eb437fb2389b6d",
    ),
    "model.safetensors": (
        155908064,
        "48c14467e5cf9e51870511feb72c89688e82dd74523142c0538b663e193ac2a7",
    ),
    "README.md": (19965, "dfa401b1b9358b9650ae487dd2f2bb336fd745c3609e3244adf2e97a22343857"),
    "LICENSE.txt": (11357, "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4"),
}


def verify(path: Path, size: int, digest: str) -> bool:
    if not path.is_file() or path.stat().st_size != size:
        return False
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest() == digest


def install(directory: Path, check_only: bool) -> None:
    if not check_only:
        directory.mkdir(parents=True, exist_ok=True)
    manifest = {
        "model_id": MODEL_ID,
        "revision": REVISION,
        "source": f"https://huggingface.co/{MODEL_ID}",
        "license": "Apache-2.0",
        "files": {},
    }
    for name, (size, digest) in FILES.items():
        target = directory / name
        url = LICENSE_URL if name == "LICENSE.txt" else f"{BASE_URL}/{name}"
        if not verify(target, size, digest):
            if check_only:
                raise SystemExit(f"Missing or mismatched checkpoint file: {name}")
            descriptor, temporary = tempfile.mkstemp(
                prefix=f".{name}.", suffix=".part", dir=directory
            )
            try:
                with os.fdopen(descriptor, "wb") as stream:
                    with urllib.request.urlopen(url, timeout=60) as response:
                        received = 0
                        while chunk := response.read(1024 * 1024):
                            received += len(chunk)
                            if received > size:
                                raise RuntimeError(f"Unexpected download size for {name}")
                            stream.write(chunk)
                if not verify(Path(temporary), size, digest):
                    raise RuntimeError(f"Checksum verification failed for {name}")
                os.replace(temporary, target)
            finally:
                Path(temporary).unlink(missing_ok=True)
        manifest["files"][name] = {"bytes": size, "sha256": digest, "url": url}
        print(f"Verified {name}")
    if not check_only:
        (directory / "download-provenance.json").write_text(json.dumps(manifest, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "artifacts/reference-material/models/sam2.1-hiera-tiny",
    )
    parser.add_argument("--check-only", action="store_true", help="Verify installed files offline.")
    args = parser.parse_args()
    install(args.output, args.check_only)


if __name__ == "__main__":
    main()
