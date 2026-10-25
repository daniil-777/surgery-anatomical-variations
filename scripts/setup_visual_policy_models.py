#!/usr/bin/env python3
"""Fetch pinned Apache-2.0 base assets; keep the trained adapter local.

Run after installing deploy/visual-policy-requirements.lock in a Python 3.11
environment. No Hugging Face account, token, or remote-code execution is used.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import urllib.request
from pathlib import Path

BASE = ("lerobot/smolvla_base", "5e8d12a6e2975b0e5e5fce7c8caf47c371d257b6")
VLM = ("HuggingFaceTB/SmolVLM2-500M-Video-Instruct", "7b375e1b73b11138ff12fe22c8f2822d8fe03467")
BASE_SHA = "7cd549ac2351fb069c0ddb3c34ad2d09cfc92b56a15dccdfc2e41467aaca01eb"
TOKEN_FILES = (
    "added_tokens.json",
    "chat_template.json",
    "config.json",
    "generation_config.json",
    "merges.txt",
    "preprocessor_config.json",
    "processor_config.json",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
)


def sha(path):
    result = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    for folder, model, files in [
        ("base", BASE, ("config.json", "model.safetensors")),
        ("vlm", VLM, TOKEN_FILES),
    ]:
        target = args.root / "models" / folder
        target.mkdir(parents=True, exist_ok=True)
        for filename in files:
            path = target / filename
            if path.exists():
                continue
            temporary = path.with_suffix(path.suffix + ".part")
            urllib.request.urlretrieve(
                f"https://huggingface.co/{model[0]}/resolve/{model[1]}/{filename}", temporary
            )
            temporary.replace(path)
            print(folder, filename, flush=True)
    if sha(args.root / "models/base/model.safetensors") != BASE_SHA:
        raise ValueError("Base checkpoint integrity check failed")
    source = Path(__file__).resolve().parents[1] / "apps/studio/public/visual-policies/skill-1"
    manifest = json.loads((source / "manifest.json").read_text())
    if sha(source / "adapter.safetensors") != manifest["adapterSha256"]:
        raise ValueError("Adapter integrity check failed")
    destination = args.root / "trained"
    destination.mkdir(exist_ok=True)
    for name in ("adapter.safetensors", "manifest.json"):
        shutil.copy2(source / name, destination / name)
    print("Models installed; use visual_policy_server.py with --models and --run.", flush=True)


if __name__ == "__main__":
    main()
