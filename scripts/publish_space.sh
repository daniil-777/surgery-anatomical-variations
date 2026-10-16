#!/usr/bin/env bash
# Publish the VISCERA web app to a Hugging Face Space (Docker). Once: `hf auth login` with a write token.
#   scripts/publish_space.sh <user-or-org>/<space-name> [--private]
# Stages the deployable tree (scripts/stage_deploy.py), creates the Space if needed, uploads the tree
# (scripts/publish_space.py, huggingface_hub). Hugging Face then builds the Dockerfile and serves it.
set -euo pipefail
cd "$(dirname "$0")/.."
exec .venv/bin/python scripts/publish_space.py "$@"
