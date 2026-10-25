"""Shared, bounded wire contract; no model import is needed to validate a request."""

from __future__ import annotations

import base64
import io
import math
import re

from PIL import Image

SCHEMA = "viscera.visual-skills/1"
SKILLS = ("look", "grasp", "release", "finish", "wait")
INSTRUCTIONS = (
    "Look at the liver, grasp gently, and release.",
    "Inspect the liver, gently grasp it, then let go.",
    "Approach the liver with the camera, grasp carefully, and release.",
)


def parse_request(value: object) -> dict:
    if not isinstance(value, dict) or value.get("schema") != SCHEMA:
        raise ValueError("Unsupported observation schema")
    request_id = value.get("requestId")
    if not isinstance(request_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", request_id):
        raise ValueError("Invalid request identity")
    state = value.get("state")
    if (
        not isinstance(state, list)
        or len(state) != 16
        or any(
            isinstance(x, bool)
            or not isinstance(x, (int, float))
            or not math.isfinite(x)
            or abs(x) > 10
            for x in state
        )
    ):
        raise ValueError("Invalid instrument state")
    if value.get("instruction") not in INSTRUCTIONS:
        raise ValueError("Choose a supported liver-task instruction")
    encoded = value.get("image")
    if (
        not isinstance(encoded, str)
        or not encoded.startswith("data:image/jpeg;base64,")
        or len(encoded) > 180000
    ):
        raise ValueError("Expected a bounded 256-pixel JPEG observation")
    raw = base64.b64decode(encoded.split(",", 1)[1], validate=True)
    with Image.open(io.BytesIO(raw)) as source:
        if source.format != "JPEG" or source.size != (256, 256):
            raise ValueError("Invalid observation image size or format")
        image = source.convert("RGB")
    return {
        "requestId": request_id,
        "state": state,
        "instruction": value["instruction"],
        "image": image,
    }


def decode_action(scores: list[float], threshold: float = 0.5) -> dict:
    if len(scores) != 5 or any(not math.isfinite(x) for x in scores):
        raise ValueError("Nonfinite model action")
    order = sorted(range(5), key=lambda i: scores[i], reverse=True)
    margin = scores[order[0]] - scores[order[1]]
    # Flow-matching action coordinates are not calibrated probabilities.
    return {
        "skill": SKILLS[order[0]],
        "scores": scores,
        "margin": margin,
        "accepted": margin >= threshold and max(abs(x) for x in scores) < 3,
    }


def promotion_ready(manifest: dict) -> bool:
    try:
        counts = manifest["training"]["episodes"]
        test = manifest["test"]
        latency = manifest["latency"]["p95Ms"]
        return bool(
            manifest.get("ready") is True
            and counts["train"] >= 12
            and counts["validation"] >= 3
            and counts["test"] >= 5
            and test["accuracy"] >= 0.98
            and test["coverage"] >= 0.95
            and test["wrongAccepted"] == 0
            and math.isfinite(latency)
            and 0 <= latency <= 1500
        )
    except (KeyError, TypeError, ValueError):
        return False
