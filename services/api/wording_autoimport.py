"""Import completed, validated VISCERA wording downloads into the local Studio.

Only the named wording ZIP family is watched. A restored default stays restored:
already processed bytes are remembered, and unrelated downloads are never read.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import signal
import threading
import time
import zipfile
from pathlib import Path
from typing import Any, Callable

from . import atlas_model_registry as registry

NAME = re.compile(r"viscera-wording-weights(?:-[A-Za-z0-9_.-]+)?(?: \(\d+\))?\.zip")


def _import_wording(root: Path, archive: Path) -> dict[str, Any]:
    from .atlas_wording_model import import_weights

    return import_weights(root, archive, report_status=False)


class DownloadImporter:
    def __init__(
        self, root: Path, directory: Path, *, importer: Callable[..., Any] | None = None,
        stable_seconds: float = 5,
    ) -> None:
        self.root = root
        self.directory = directory
        self.importer = importer or _import_wording
        self.stable_seconds = stable_seconds
        self.observed: dict[str, tuple[int, int, float]] = {}
        self.receipt = registry.store_root(root) / "wording-downloads.json"

    def scan(self, now: float | None = None) -> list[dict[str, Any]]:
        now = time.monotonic() if now is None else now
        if not self.directory.is_dir():
            return []
        state = registry._read_json(self.receipt) if self.receipt.exists() else {
            "version": 1, "processed": {},
        }
        if state.get("version") != 1 or not isinstance(state.get("processed"), dict):
            raise ValueError("Invalid wording download receipt; previous selections preserved")
        events = []
        for path in sorted(self.directory.iterdir(), key=lambda item: item.name):
            if not NAME.fullmatch(path.name) or path.is_symlink() or not path.is_file():
                continue
            stat = path.stat()
            if stat.st_size == 0 or stat.st_size > registry.MAX_UPLOAD_BYTES:
                continue
            key = str(path.resolve())
            observed = self.observed.get(key)
            identity = (stat.st_size, stat.st_mtime_ns)
            if observed is None or observed[:2] != identity:
                self.observed[key] = (*identity, now)
                continue
            if now - observed[2] < self.stable_seconds:
                continue
            with path.open("rb") as stream:
                checksum = hashlib.file_digest(stream, "sha256").hexdigest()
            if checksum in state["processed"]:
                continue
            event: dict[str, Any] = {"file": path.name, "sha256": checksum}
            try:
                with zipfile.ZipFile(path) as archive:
                    if "viscera-wording-weights/manifest.json" not in archive.namelist():
                        raise ValueError("This download is not a wording model archive")
                # The import contract rejects smoke weights, failed evaluations,
                # mismatched sources and unsafe archives before switching a model.
                self.importer(self.root, path)
                event["status"] = "activated"
            except Exception as error:
                event.update(status="rejected", reason=str(error)[:500])
            state["processed"][checksum] = event
            registry._atomic_json(self.receipt, state)
            events.append(event)
        return events


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(os.environ.get(
        "VISCERA_PROJECT_ROOT", Path(__file__).resolve().parents[2],
    )))
    parser.add_argument("--directory", type=Path, default=Path.home() / "Downloads")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    watcher = DownloadImporter(args.root.resolve(), args.directory.expanduser().resolve())
    stopped = threading.Event()
    for name in (signal.SIGINT, signal.SIGTERM):
        signal.signal(name, lambda *_: stopped.set())
    print(json.dumps({"wording_autoimport": "watching", "directory": str(watcher.directory)}), flush=True)
    while not stopped.is_set():
        try:
            for event in watcher.scan():
                print(json.dumps(event), flush=True)
        except (OSError, ValueError) as error:
            print(json.dumps({"wording_autoimport": "unavailable", "reason": str(error)}), flush=True)
        if args.once:
            # A first scan only observes candidate size/mtime. Give completed
            # files the same real stability interval as the long-running watcher
            # before its final scan; signals can interrupt this wait normally.
            if not stopped.wait(watcher.stable_seconds):
                try:
                    for event in watcher.scan():
                        print(json.dumps(event), flush=True)
                except (OSError, ValueError) as error:
                    print(json.dumps({"wording_autoimport": "unavailable", "reason": str(error)}), flush=True)
            break
        stopped.wait(5)


if __name__ == "__main__":
    main()
