"""Publish the staged VISCERA web app to a Hugging Face Space (Docker SDK).

    .venv/bin/python scripts/publish_space.py <user-or-org>/<space> [--private] [--stage DIR]

Needs a write token: `hf auth login` once (or HF_TOKEN in the environment). Creates the Space when it does not exist,
uploads the staged tree as one commit (large files go through LFS automatically), and prints the build-log and app
URLs. Hugging Face builds the Dockerfile on its side; the first build takes 10–20 minutes.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from huggingface_hub import HfApi
from huggingface_hub.utils import RepositoryNotFoundError

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("space", help="<user-or-org>/<space-name>")
    parser.add_argument("--private", action="store_true")
    parser.add_argument("--stage", default=os.path.join(tempfile.gettempdir(), "viscera-space"))
    parser.add_argument("--no-stage", action="store_true", help="upload the existing stage directory as is")
    args = parser.parse_args()
    api = HfApi()
    try:
        user = api.whoami()["name"]
    except Exception as error:  # noqa: BLE001 - every failure here means "not logged in"
        print(f"not logged in ({error}); run  hf auth login  with a write token", file=sys.stderr)
        return 2
    if not args.no_stage:
        subprocess.run([sys.executable, str(ROOT / "scripts/stage_deploy.py"), "--out", args.stage], check=True)
    stage = Path(args.stage)
    if not (stage / "Dockerfile").is_file() or not (stage / "README.md").is_file():
        print(f"{stage} is not a staged tree (Dockerfile and README.md expected)", file=sys.stderr)
        return 2
    try:
        api.repo_info(args.space, repo_type="space")
        print(f"updating existing Space {args.space} as {user}")
    except RepositoryNotFoundError:
        api.create_repo(args.space, repo_type="space", space_sdk="docker", private=args.private)
        print(f"created {'private ' if args.private else ''}Space {args.space} as {user}")
    head = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"], capture_output=True, text=True)
    label = head.stdout.strip() if head.returncode == 0 else "workspace"
    api.upload_folder(
        folder_path=str(stage), repo_id=args.space, repo_type="space",
        commit_message=f"VISCERA web app ({label})", ignore_patterns=["**/__pycache__/**", "**/.DS_Store"],
    )
    host = args.space.replace("/", "-").lower()
    print(f"uploaded. Build log: https://huggingface.co/spaces/{args.space}?logs=build")
    print(f"App (once built): https://{host}.hf.space   then: python scripts/probe_web_app.py https://{host}.hf.space")
    return 0


if __name__ == "__main__":
    sys.exit(main())
