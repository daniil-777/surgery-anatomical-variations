# syntax=docker/dockerfile:1
# VISCERA Studio as one web app: the studio built by Vite and the Python API served from the same origin by
# services.web.app (model administration and the saved-project listing answer 403, as docs/WEB_DEPLOYMENT.md states).
# Built from the staged tree that scripts/stage_deploy.py assembles (only what the server reads), for Hugging Face
# Spaces (Docker, port 7860) or any container host; a CPU image, torch from PyTorch's CPU index.

# ---- 1. the studio
FROM node:24-bookworm-slim AS web
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/studio/package.json apps/studio/package.json
COPY packages ./packages
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate && pnpm install --frozen-lockfile
COPY apps/studio ./apps/studio
ENV VISCERA_SOURCEMAP=0
RUN pnpm --filter @viscera/studio build

# ---- 2. the server
FROM python:3.11-slim-bookworm AS app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
# xatlas (the textured exports' UV unwrap) ships no Linux wheel for aarch64: on ARM hosts (Oracle A1, Hetzner CAX)
# its sdist builds here, so the compiler and cmake are installed only on that architecture and removed afterwards
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
 && if [ "$(uname -m)" = "aarch64" ]; then apt-get install -y --no-install-recommends build-essential cmake; fi \
 && apt-get clean \
 && useradd -m -u 1000 app
WORKDIR /app
COPY deploy/requirements.txt ./deploy/requirements.txt
RUN pip install --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple -r deploy/requirements.txt \
 && if [ "$(uname -m)" = "aarch64" ]; then apt-get purge -y build-essential cmake && apt-get autoremove -y; fi
# the text adapter's pinned base model (pipelines/train/viscera_train/atlas_language.py BASE_MODEL / BASE_REVISION),
# fetched at build time so the running server never downloads
ENV HF_HOME=/app/hf-cache
RUN python -c "from huggingface_hub import snapshot_download; snapshot_download('Qwen/Qwen2.5-0.5B-Instruct', revision='c89bee90d9f811437d9735454613c35b4a3c4dc8', allow_patterns=['*.json', '*.safetensors', '*.txt'])" \
 && chown -R app:app /app/hf-cache
COPY --chown=app:app py ./py
COPY --chown=app:app services ./services
COPY --chown=app:app pipelines ./pipelines
COPY --chown=app:app datasets ./datasets
COPY --chown=app:app disease-releases ./disease-releases
COPY --chown=app:app artifacts ./artifacts
COPY --chown=app:app data ./data
COPY --chown=app:app --from=web /src/apps/studio/dist ./apps/studio/dist
USER app
# the demo database lives where the app user can write; nothing persists across restarts
ENV PYTHONPATH=/app/py:/app \
    VISCERA_WEB_DB=/home/app/web-studio.sqlite \
    VISCERA_WEB_DIST=/app/apps/studio/dist \
    VISCERA_WEB_PRELOAD_LANGUAGE=1 \
    HF_HUB_OFFLINE=1 \
    TOKENIZERS_PARALLELISM=false \
    OMP_NUM_THREADS=2 \
    PORT=7860
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s CMD python -c "import urllib.request,os; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"7860\")}/api/health', timeout=4)" || exit 1
CMD ["sh", "-c", "uvicorn services.web.app:app --host 0.0.0.0 --port ${PORT} --limit-concurrency 64 --timeout-keep-alive 5"]
