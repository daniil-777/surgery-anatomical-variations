FROM python:3.11.14-slim-bookworm@sha256:65a93d69fa75478d554f4ad27c85c1e69fa184956261b4301ebaf6dbb0a3543d
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PYTHONPATH=/app PORT=8080
WORKDIR /app
RUN groupadd --gid 1000 studio && useradd --uid 1000 --gid 1000 --no-create-home studio
COPY requirements.txt .
RUN pip install --disable-pip-version-check -r requirements.txt
COPY --chown=1000:1000 services ./services
COPY --chown=1000:1000 apps ./apps
COPY --chown=1000:1000 public-copy ./public-copy
COPY --chown=1000:1000 entrypoint.py ./entrypoint.py
ENV VISCERA_WEB_DIST=/app/public-copy
EXPOSE 8080
# The entrypoint fixes the mounted state directory ownership and immediately
# drops to uid/gid 1000 before starting or monitoring the HTTP server.
ENTRYPOINT ["python", "/app/entrypoint.py"]
