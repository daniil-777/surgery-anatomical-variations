#!/usr/bin/env bash
# Run the staged tree the way the container does, without Docker: the same entry point, environment and port, from
# the stage directory, with this workspace's Python environment and a prebuilt apps/studio/dist. Then probe every API
# feature the public app promises (scripts/probe_web_app.py).
#   scripts/verify_stage.sh [port=8011]
set -euo pipefail
PORT="${1:-8011}"
cd "$(dirname "$0")/.."
STAGE="${TMPDIR:-/tmp}/viscera-space"
VENV="$PWD/.venv"
PROBE="$PWD/scripts/probe_web_app.py"
.venv/bin/python scripts/stage_deploy.py --out "$STAGE" --with-dist
cd "$STAGE"
PYTHONPATH="$STAGE/py:$STAGE" VISCERA_WEB_DB="$STAGE/web-studio.sqlite" VISCERA_WEB_DIST="$STAGE/apps/studio/dist" \
  VISCERA_WEB_PRELOAD_LANGUAGE=1 TOKENIZERS_PARALLELISM=false \
  "$VENV/bin/python" -m uvicorn services.web.app:app --host 127.0.0.1 --port "$PORT" --limit-concurrency 64 --timeout-keep-alive 75 --log-level warning &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 1; done
echo "server up on :$PORT from $STAGE"
"$VENV/bin/python" -I "$PROBE" "http://127.0.0.1:$PORT"
