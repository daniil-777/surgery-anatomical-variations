"""Content-addressed local snapshots with compare-and-swap project heads."""

from __future__ import annotations

import json
import sqlite3
import time
import zlib
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from .compiler import content_hash


class StaleRevision(ValueError):
    """Another edit has already changed this project."""


class SnapshotStore:
    """Each call uses a short SQLite transaction; snapshot payloads are immutable."""

    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS snapshots (
                    hash TEXT PRIMARY KEY, payload BLOB NOT NULL, created REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL,
                    head TEXT NOT NULL REFERENCES snapshots(hash), revision INTEGER NOT NULL
                );
            """)

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=10)
        try:
            connection.execute("PRAGMA foreign_keys=ON")
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def save(self, scene: dict[str, Any]) -> dict[str, Any]:
        digest = content_hash(scene)
        payload = zlib.compress(json.dumps(scene, separators=(",", ":"), allow_nan=False).encode())
        with self._connect() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO snapshots VALUES (?,?,?)", (digest, payload, time.time())
            )
        return {"id": digest, "content_hash": digest, "schema_version": "0.1.0"}

    def load(self, digest: str) -> dict[str, Any]:
        if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise KeyError("Invalid snapshot ID")
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload FROM snapshots WHERE hash=?", (digest,)
            ).fetchone()
        if row is None:
            raise KeyError("Snapshot not found")
        scene: dict[str, Any] = json.loads(zlib.decompress(row[0]))
        if content_hash(scene) != digest:
            raise ValueError("Snapshot hash mismatch")
        return scene

    def commit(
        self, project: str, title: str, digest: str, expected_revision: int | None
    ) -> dict[str, Any]:
        self.load(digest)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT revision FROM projects WHERE id=?", (project,)
            ).fetchone()
            if row is None:
                if expected_revision not in (None, 0):
                    raise StaleRevision("Project does not have the expected revision")
                connection.execute(
                    "INSERT INTO projects VALUES (?,?,?,1)", (project, title, digest)
                )
                revision = 1
            else:
                if expected_revision != row[0]:
                    raise StaleRevision("Project changed; reload before committing")
                revision = row[0] + 1
                connection.execute(
                    "UPDATE projects SET title=?,head=?,revision=? WHERE id=?",
                    (title, digest, revision, project),
                )
        return {"id": project, "title": title, "snapshot_id": digest, "revision": revision}

    def projects(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT id,title,head,revision FROM projects ORDER BY title"
            ).fetchall()
        return [
            {"id": row[0], "title": row[1], "snapshot_id": row[2], "revision": row[3]}
            for row in rows
        ]
