"""Local tile generation service: validated requests in, data-only Studio bundles out.

The service owns one loaded pipeline and runs one job at a time. It writes each job into its own
directory (tile, receipt, exported study, bundle) and returns the bundle text, which the browser
validates exactly like a manually imported .tissue-pbr.json. No model code reaches the browser.
"""

from __future__ import annotations

import json
import math
import re
import secrets
import shutil
import threading
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path

from . import postprocess
from .captions import FAMILY_PHRASES
from .data import sha256_file
from .pbr import browser_bundle, export_study
from .sample import lora_rights, sample_tiles

SCHEMA_HEALTH = "viscera.tissue-generator/v1"
MODES = {
    "clean": {"guide": None, "clean": "clean-colour"},
    "guided": {"guide": "authored", "clean": "clean-colour"},
    "delit": {"guide": None, "clean": "delit-colour"},
    "raw": {"guide": None, "clean": None},
}
MAX_REQUEST_BYTES = 4096


class BusyError(RuntimeError):
    pass


@dataclass(frozen=True)
class GenerateRequest:
    family: str
    seed: str
    mode: str = "clean"
    guidance: float = 7.0
    steps: int = 20  # 20 DPM-Solver++ steps match 30 within ~1 grey level per pixel and are 35 % faster (Metal benchmark)
    guide_strength: float = 0.6


def parse_request(raw: bytes, families: list[str]) -> GenerateRequest:
    """Strict JSON request validation; unknown fields, wrong types and out-of-range values are refused."""
    if len(raw) > MAX_REQUEST_BYTES:
        raise ValueError("request too large")
    try:
        data = json.loads(raw.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("request is not JSON") from error
    if not isinstance(data, dict):
        raise ValueError("request must be a JSON object")
    allowed = {"family", "seed", "mode", "guidance", "steps", "guide_strength"}
    unknown = set(data) - allowed
    if unknown:
        raise ValueError(f"unknown fields: {sorted(unknown)}")
    family = data.get("family")
    if family not in families:
        raise ValueError(f"family must be one of {families}")
    seed = data.get("seed")
    if seed is None:
        seed = str(secrets.randbits(64))
    if not isinstance(seed, str) or not re.fullmatch(r"0|[1-9][0-9]{0,19}", seed) or int(seed) >= 2**64:
        raise ValueError("seed must be a decimal uint64 string")
    mode = data.get("mode", "clean")
    if mode not in MODES:
        raise ValueError(f"mode must be one of {sorted(MODES)}")
    def number(key, default, low, high, integer=False):
        value = data.get(key, default)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"{key} must be a number")
        if integer and int(value) != value:
            raise ValueError(f"{key} must be an integer")
        if not low <= value <= high:
            raise ValueError(f"{key} must be in [{low}, {high}]")
        return int(value) if integer else float(value)
    return GenerateRequest(family=family, seed=seed, mode=mode, guidance=number("guidance", 7.0, 1.5, 15.0),
                           steps=number("steps", 20, 10, 50, integer=True),
                           guide_strength=number("guide_strength", 0.6, 0.3, 0.9))


class TileService:
    def __init__(self, snapshot: Path, lora_dir: Path, work_dir: Path, *, colour_stats: Path | None = None,
                 device: str | None = None, precision: str | None = None, sampler=sample_tiles, keep_jobs: int = 50):
        self.snapshot, self.lora_dir, self.work_dir = Path(snapshot), Path(lora_dir), Path(work_dir)
        self.work_dir.mkdir(parents=True, exist_ok=True)
        meta = json.loads((self.lora_dir / "lora.json").read_text())
        self.families = [f for f in meta.get("families") or sorted(FAMILY_PHRASES) if f in FAMILY_PHRASES]
        self.rights = lora_rights(self.lora_dir)
        self.lora_sha256 = sha256_file(self.lora_dir / "pytorch_lora_weights.safetensors")
        self.run_id = meta.get("run_id")
        self.colour_stats = postprocess.load_colour_stats(colour_stats) if colour_stats else None
        self.device, self.precision, self.sampler, self.keep_jobs = device, precision, sampler, keep_jobs
        self._lock = threading.Lock()
        self.jobs = 0

    def health(self) -> dict:
        modes = [m for m in MODES if self.colour_stats or MODES[m]["clean"] is None]
        return {"schema": SCHEMA_HEALTH, "ready": True, "busy": self._lock.locked(), "families": self.families,
                "modes": modes, "run_id": self.run_id, "lora_sha256": self.lora_sha256, "rights": self.rights,
                "defaults": asdict(GenerateRequest(family=self.families[0], seed="0")) | {"seed": None},
                "meaning": "local research generator; outputs are learned appearance, not measured albedo or clinical material"}

    def generate(self, request: GenerateRequest) -> tuple[str, dict]:
        if not self._lock.acquire(blocking=False):
            raise BusyError("the generator is busy with another tile")
        try:
            mode = MODES[request.mode]
            if mode["clean"] and not self.colour_stats:
                raise ValueError("this server has no colour statistics; use mode 'raw'")
            job = self.work_dir / f"{time.strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:8]}"
            tiles = job / "tiles"
            started = time.time()
            self.sampler(self.snapshot, self.lora_dir, tiles, families=[request.family], seeds=[int(request.seed)],
                         size=512, steps=request.steps, guidance=request.guidance, device=self.device,
                         precision=self.precision, guide=mode["guide"], guide_strength=request.guide_strength,
                         clean=mode["clean"], colour_stats=self.colour_stats)
            sample_dir = tiles / f"{request.family}-seed{request.seed}"
            study = job / "study"
            export_study(sample_dir, study, rights=self.rights)
            bundle = browser_bundle(study)
            source = bundle.read_text()
            receipt = {"job": job.name, "request": asdict(request), "seconds": round(time.time() - started, 2),
                       "bundle_sha256": sha256_file(bundle), "bundle_bytes": bundle.stat().st_size,
                       "run_id": self.run_id, "rights": self.rights}
            (job / "job.json").write_text(json.dumps(receipt, indent=2) + "\n")
            self.jobs += 1
            self._prune()
            return source, receipt
        finally:
            self._lock.release()

    def _prune(self) -> None:
        jobs = sorted(p for p in self.work_dir.iterdir() if p.is_dir() and (p / "job.json").is_file())
        for old in jobs[:-self.keep_jobs]:
            shutil.rmtree(old, ignore_errors=True)
