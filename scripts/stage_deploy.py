"""Assemble the deployable tree of the VISCERA web app: only what the server reads, plus the Dockerfile and host files.

    .venv/bin/python scripts/stage_deploy.py [--out DIR] [--with-dist]

Copies, from this workspace: the Python packages (py/, services/, the training package the learned samplers import),
the studio sources and lockfiles (the image builds them), the atlas cohort, material and language datasets (the learned
samplers verify their release digests), the disease recipes and the CC BY clinical lane, the trained artifacts the API
loads (physics network, joint VAE weights, shape model, atlas run, disease recipe model, language adapter), the
imported-model store with the active bundles, and the deploy files. Nothing else: no benchmarks, notebooks, reviews, datasets beyond the
templates, or the full joint-v2 delivery. --with-dist also copies a prebuilt apps/studio/dist for running the staged
tree without Docker (what scripts/verify_stage.sh does). The default output is outside the workspace (it is iCloud-
synced); pass --out to choose. Prints the size and the file count.
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INCLUDE = [
    "py", "services",
    "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", "packages",
    "apps/studio/package.json", "apps/studio/index.html", "apps/studio/tsconfig.json", "apps/studio/vite.config.ts",
    "apps/studio/src", "apps/studio/public",
    "pipelines/__init__.py", "pipelines/train/__init__.py", "pipelines/train/viscera_train",
    "datasets/atlas/cohort-v2", "datasets/atlas/material-v1", "datasets/atlas/language-v1",
    "datasets/anatomy-templates/templates-v3",   # the generation-2 joint bundle's repaired references (2 of 24 differ)
    "disease-releases/recipes-v2", "disease-releases/clinical-ccby-v3",
    "artifacts/physics", "artifacts/joint-vae/default", "artifacts/models/shape-pilot-v1", "artifacts/atlas/run-v2",
    "artifacts/disease", "artifacts/language",
    "data/imported-models",
    "deploy/requirements.txt",
]
# Never staged: disease-releases/clinical-nc-v3 (non-commercial clinical lane), disease-releases/geometry-v1 (only the
# weight importer verifies it, and importing is refused on the public server), benchmarks, notebooks, reviews.
CONFLICT = re.compile(r" \d+(\.[^.]*)?$")  # iCloud conflict copies: "name 2.json", "dist 2"
SKIP = {".DS_Store", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "node_modules", ".claude-flow"}


def copy(rel: str, out: Path) -> None:
    src = ROOT / rel
    if not src.exists():
        raise FileNotFoundError(f"{rel} is missing from the workspace")
    dst = out / rel
    if src.is_dir():
        shutil.copytree(src, dst, ignore=lambda d, names: [n for n in names if n in SKIP or n.startswith("._") or CONFLICT.search(n)], dirs_exist_ok=True)
    else:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=os.path.join(tempfile.gettempdir(), "viscera-space"))
    parser.add_argument("--with-dist", action="store_true", help="also copy apps/studio/dist (for running the stage without Docker)")
    args = parser.parse_args()
    out = Path(args.out)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    for rel in INCLUDE + (["apps/studio/dist"] if args.with_dist else []):
        copy(rel, out)
    shutil.copy2(ROOT / "deploy/Dockerfile", out / "Dockerfile")
    shutil.copy2(ROOT / "deploy/fly.toml", out / "fly.toml")
    shutil.copy2(ROOT / "deploy/space-README.md", out / "README.md")
    (out / ".dockerignore").write_text("apps/studio/dist\n.git\n**/__pycache__\n")
    (out / ".gitattributes").write_text("*.npz filter=lfs diff=lfs merge=lfs -text\n*.zip filter=lfs diff=lfs merge=lfs -text\n*.pt filter=lfs diff=lfs merge=lfs -text\n*.safetensors filter=lfs diff=lfs merge=lfs -text\n*.png filter=lfs diff=lfs merge=lfs -text\n*.glb filter=lfs diff=lfs merge=lfs -text\n*.sqlite filter=lfs diff=lfs merge=lfs -text\n")
    files = 0
    size = 0
    for p in out.rglob("*"):
        if p.is_file():
            files += 1
            size += p.stat().st_size
    print(f"staged {files} files, {size / 1048576:.1f} MB at {out}")


if __name__ == "__main__":
    main()
