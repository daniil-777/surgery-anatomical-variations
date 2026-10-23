"""Bounded local/Drive transport helpers. No cloud clients or implicit downloads."""

from __future__ import annotations

import codecs
import hashlib
import json
import os
import re
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import uuid
import zipfile
from pathlib import Path, PurePosixPath


def run_notebook_command(command: list[str], *, env: dict | None = None, check: bool = True,
                         capture_stdout: bool = False, log_directory: Path | None = None,
                         max_capture_bytes: int = 2 * 1024**2,
                         max_display_bytes: int = 1024**2) -> subprocess.CompletedProcess:
    """Drain both pipes and write through notebook streams, with bounded evidence.

    Inherited OS stderr is not reliably forwarded by notebook kernels. Captured
    JSON stdout stays separate from live stderr. Non-JSON output and each saved
    tail are bounded; an oversized JSON response fails rather than being parsed
    after truncation. Intended for the Linux Colab and macOS testing environments.
    """
    if (not isinstance(command, list) or not command or not all(isinstance(x, str) for x in command)
            or type(max_capture_bytes) is not int or not 1024 <= max_capture_bytes <= 16 * 1024**2
            or type(max_display_bytes) is not int or not 0 <= max_display_bytes <= 16 * 1024**2):
        raise ValueError("invalid bounded notebook command")
    logs = None
    if log_directory is not None:
        reject_symlinks(Path(log_directory))
        logs = Path(log_directory) / ("command-" + uuid.uuid4().hex)
        logs.mkdir(parents=True, exist_ok=False)
    child_env = {**(os.environ if env is None else env), "PYTHONUNBUFFERED": "1"}
    tails = {name: bytearray() for name in ("stdout", "stderr")}
    totals, displayed = dict.fromkeys(tails, 0), dict.fromkeys(tails, 0)
    decoders = {name: codecs.getincrementaldecoder("utf-8")(errors="replace") for name in tails}
    process = subprocess.Popen(command, env=child_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               start_new_session=True)
    failure = None
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ, "stdout")
            selector.register(process.stderr, selectors.EVENT_READ, "stderr")
            while selector.get_map():
                for selected, _ in selector.select(timeout=.25):
                    name = selected.data
                    raw = os.read(selected.fileobj.fileno(), 8192)
                    if not raw:
                        selector.unregister(selected.fileobj)
                        if not (name == "stdout" and capture_stdout) and displayed[name] <= max_display_bytes:
                            stream = sys.stdout if name == "stdout" else sys.stderr
                            stream.write(decoders[name].decode(b"", final=True))
                            stream.flush()
                        continue
                    totals[name] += len(raw)
                    tails[name].extend(raw)
                    if capture_stdout and name == "stdout" and totals[name] > max_capture_bytes:
                        del tails[name][:-max_capture_bytes]
                        raise ValueError("Notebook command JSON stdout exceeds its bounded capture size")
                    if len(tails[name]) > max_capture_bytes:
                        del tails[name][:-max_capture_bytes]
                    if name == "stdout" and capture_stdout:
                        continue
                    available = max(0, max_display_bytes - displayed[name])
                    stream = sys.stdout if name == "stdout" else sys.stderr
                    if available:
                        shown = raw[:available]
                        stream.write(decoders[name].decode(shown))
                        stream.flush()
                        displayed[name] += len(shown)
                    if len(raw) > available and displayed[name] <= max_display_bytes:
                        stream.write("\n[Notebook output limit reached; bounded diagnostic tail retained.]\n")
                        stream.flush()
                        displayed[name] = max_display_bytes + 1
        process.wait()
    except BaseException as error:
        failure = type(error).__name__ + ": " + str(error)
        # The leader may already have exited while a descendant retains a pipe.
        # Signal the group independently, then ensure stubborn descendants stop.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.wait(timeout=5)
        raise
    finally:
        process.stdout.close()
        process.stderr.close()
        if logs is not None:
            for name, raw in tails.items():
                (logs / (name + ".tail.txt")).write_bytes(raw)
            (logs / "receipt.json").write_text(json.dumps({"command": command, "returncode": process.returncode,
                "failure": failure, "observed_bytes": totals,
                "tail_truncated": {name: totals[name] > len(raw) for name, raw in tails.items()},
                "capture_stdout": capture_stdout, "max_capture_bytes": max_capture_bytes,
                "max_display_bytes": max_display_bytes}, indent=2) + "\n")
    stdout, stderr = (bytes(tails[name]).decode("utf-8", errors="replace") for name in ("stdout", "stderr"))
    if check and process.returncode:
        diagnostic = stderr[-8192:] or stdout[-8192:] or "Child produced no diagnostic text."
        sys.stderr.write(f"\nCommand failed (exit {process.returncode}). Diagnostic tail:\n{diagnostic}\n")
        if logs is not None:
            sys.stderr.write(f"Bounded logs: {logs}\n")
        sys.stderr.flush()
        raise subprocess.CalledProcessError(process.returncode, command, output=stdout, stderr=stderr)
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


def sha256(path: Path) -> str:
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def safe_relative(value: str) -> str:
    if (not isinstance(value, str) or not value or "\\" in value or ":" in value
            or PurePosixPath(value).is_absolute()
            or any(part in ("", ".", "..") for part in value.split("/"))):
        raise ValueError("unsafe package path")
    return value


def reject_symlinks(path: Path) -> None:
    if any(part.is_symlink() for part in (path, *path.parents)):
        raise ValueError("transport symlinks are forbidden")


def validate_record(record: dict) -> None:
    if (type(record.get("bytes")) is not int or not 0 <= record["bytes"] <= 1024**4
            or not isinstance(record.get("sha256"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", record["sha256"])):
        raise ValueError("invalid transport file declaration")


def experiment_identity(data_mode: str, bundle_sha256: str, release_sha256: str,
                        config: dict, environment_sha256: str, training_manifest_sha256: str) -> dict:
    """Different source/data/config/runtime locks cannot share a restart directory."""
    if data_mode not in ("engineering_real_smoke", "prepared_group_split", "acquire_dsad_research"):
        raise ValueError("unsupported experiment data mode")
    if any(not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value)
           for value in (bundle_sha256, release_sha256, environment_sha256, training_manifest_sha256)):
        raise ValueError("experiment identities require exact SHA256 values")
    payload = {"schema": "viscera.tissue-notebook-run/v1", "data_mode": data_mode,
               "source_bundle_sha256": bundle_sha256, "dataset_release_sha256": release_sha256,
               "training_manifest_sha256": training_manifest_sha256,
               "config": config, "environment_lock_manifest_sha256": environment_sha256}
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False)
    checksum = hashlib.sha256(encoded.encode()).hexdigest()
    payload = json.loads(encoded)  # Tuple-valued configs must round-trip through persistent JSON.
    return {**payload, "run_id": f"{data_mode}-{checksum[:24]}"}


def ensure_run_identity(directory: Path, identity: dict) -> None:
    directory = Path(directory)
    reject_symlinks(directory)
    marker = directory / "run-identity.json"
    if directory.exists():
        if marker.is_file() and not marker.is_symlink() and json.loads(marker.read_text()) == identity:
            return
        if any(directory.iterdir()):
            raise ValueError("existing run directory has missing or conflicting identity; preserve it")
    directory.mkdir(parents=True, exist_ok=True)
    temporary = directory / (".identity-" + uuid.uuid4().hex)
    temporary.write_text(json.dumps(identity, indent=2, allow_nan=False) + "\n")
    temporary.replace(marker)


def completed_result(directory: Path, identity: dict) -> bool:
    """Only a matching, byte-verified completion receipt permits output reuse."""
    directory = Path(directory)
    reject_symlinks(directory)
    marker = directory / "completed-result.json"
    if not marker.exists():
        return False
    reject_symlinks(marker)
    receipt = json.loads(marker.read_text())
    if receipt.get("identity") != identity or not receipt.get("files"):
        raise ValueError("completed output identity differs")
    expected = set(receipt["files"])
    actual = {p.name for p in directory.iterdir() if p.name != marker.name}
    if expected != actual:
        raise ValueError("completed output inventory differs")
    for name, record in receipt["files"].items():
        safe_relative(name)
        validate_record(record)
        path = directory / name
        reject_symlinks(path)
        if not path.is_file() or path.stat().st_size != record["bytes"] or sha256(path) != record["sha256"]:
            raise ValueError("completed output file integrity failure")
    return True


def prepare_result_attempt(directory: Path, identity: dict) -> bool:
    """Return true for verified completion; preserve an interrupted directory aside."""
    directory = Path(directory)
    if completed_result(directory, identity):
        return True
    if directory.exists():
        directory.rename(directory.with_name(directory.name + ".incomplete-" + uuid.uuid4().hex[:12]))
    return False


def complete_result(directory: Path, identity: dict) -> None:
    directory = Path(directory)
    reject_symlinks(directory)
    files = {}
    for path in directory.iterdir():
        if path.name == "completed-result.json":
            raise FileExistsError("result completion must not be overwritten")
        safe_relative(path.name)
        reject_symlinks(path)
        if not path.is_file():
            raise ValueError("result inventory must contain regular files")
        files[path.name] = {"bytes": path.stat().st_size, "sha256": sha256(path)}
    if not files:
        raise ValueError("cannot publish an empty result")
    marker = directory / "completed-result.json"
    temporary = directory / (".completion-" + uuid.uuid4().hex)
    temporary.write_text(json.dumps({"identity": identity, "files": files}, indent=2) + "\n")
    temporary.replace(marker)
    completed_result(directory, identity)


def mirror_completed_result(source: Path, destination: Path, identity: dict) -> None:
    if not completed_result(source, identity):
        raise ValueError("cannot mirror incomplete output")
    if completed_result(destination, identity):
        if sha256(Path(source) / "completed-result.json") != sha256(Path(destination) / "completed-result.json"):
            raise ValueError("existing mirrored result differs from this completed output")
        return
    source, destination = Path(source), Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(".result-" + uuid.uuid4().hex)
    shutil.copytree(source, temporary)
    if not completed_result(temporary, identity):
        raise ValueError("transferred output verification failed")
    prepare_result_attempt(destination, identity)
    temporary.rename(destination)


def publish_verified_file(source: Path, destination: Path) -> str:
    source, destination = Path(source), Path(destination)
    reject_symlinks(source)
    reject_symlinks(destination)
    checksum = sha256(source)
    if destination.exists():
        if sha256(destination) != checksum:
            raise ValueError("existing published file differs; preserve both for review")
        return checksum
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(".transfer-" + uuid.uuid4().hex)
    shutil.copyfile(source, temporary)
    if sha256(temporary) != checksum:
        raise ValueError("published file readback failed")
    temporary.rename(destination)
    return checksum


def prepare_dsad_research(source_root: Path, archive_root: Path, prepared: Path,
                          python: str, environment: dict, *, runner=subprocess.run) -> dict:
    """Explicit research-mode orchestration; source adapters own acquisition/splits."""
    source_root, archive_root, prepared = Path(source_root), Path(archive_root), Path(prepared)
    asset_id = "dsad-original-research"
    reject_symlinks(archive_root)
    reject_symlinks(prepared)
    archive_root.mkdir(parents=True, exist_ok=True)
    runner([python, str(source_root / "scripts/acquire_tissue_v3.py"),
            "--catalog", str(source_root / "research/tissue-v3/acquisition-catalog.json"),
            "--destination", str(archive_root), "--asset", asset_id, "--execute"],
           env=environment, check=True)
    # parallel_acquire creates one subdirectory per asset under destination.
    archive = archive_root / asset_id / "DSAD.zip"
    prepared.parent.mkdir(parents=True, exist_ok=True)
    if not (prepared / "release.json").is_file():
        runner([python, str(source_root / "scripts/prepare_tissue_v3_dataset.py"),
                "--archive", str(archive), "--receipt", str(archive.with_suffix(".zip.provenance.json")),
                "--output", str(prepared)], env=environment, check=True)
    release = json.loads((prepared / "release.json").read_text())
    acquisition = json.loads(archive.with_suffix(".zip.provenance.json").read_text())
    if (release.get("schema") != "viscera.observed-rgb-dataset/v3" or release.get("dataset_id") != "dsad"
            or release.get("source_archive_sha256") != acquisition.get("sha256")
            or release.get("source_archive_bytes") != acquisition.get("bytes")
            or release.get("preparation_script_sha256") != sha256(source_root / "scripts/prepare_tissue_v3_dataset.py")
            or "max_per_organ_surgery" not in release
            or release.get("max_per_organ_surgery") is not None):
        raise ValueError("prepared DSAD source/preprocessing/budget identity differs; use a new version directory")
    return {"source": str(prepared), "release_sha256": sha256(prepared / "release.json"),
            "archive": str(archive), "licence_profile": "research_only"}


def stage_training_release(source: Path, destination: Path, expected_release_sha256: str,
                           *, include_test: bool = False) -> dict:
    """Verify and stage split shards locally; never read batches directly from Drive."""
    source, destination = Path(source), Path(destination)
    reject_symlinks(source)
    reject_symlinks(destination)
    release_path = source / "release.json"
    reject_symlinks(release_path)
    if release_path.stat().st_size > 4 * 1024**2:
        raise ValueError("oversized dataset release")
    if sha256(release_path) != expected_release_sha256:
        raise ValueError("dataset release identity mismatch")
    release = json.loads(release_path.read_text())
    if release.get("schema") != "viscera.observed-rgb-dataset/v3":
        raise ValueError("unsupported prepared data release")
    declarations = dict(release["manifests"])
    seen = set(declarations)
    for shard in release["shards"]:
        safe_relative(shard["path"])
        validate_record(shard)
        if shard["split"] not in ("train", "val", "test") or shard["path"] in seen:
            raise ValueError("invalid or duplicate release shard")
        seen.add(shard["path"])
        if shard["split"] in ("train", "val") or include_test:
            declarations[shard["path"]] = {"bytes": shard["bytes"], "sha256": shard["sha256"]}
    destination.mkdir(parents=True, exist_ok=True)
    missing_bytes = 0
    for name, record in declarations.items():
        safe_relative(name)
        validate_record(record)
        reject_symlinks(source / name)
        reject_symlinks(destination / name)
        if not (destination / name).exists():
            missing_bytes += record["bytes"]
    if shutil.disk_usage(destination).free < missing_bytes + 1024**3:
        raise ValueError("insufficient local scratch for data plus 1 GiB checkpoint reserve")
    copied, reused = [], []
    for name, record in declarations.items():
        src, dst = source / name, destination / name
        if src.is_symlink() or dst.is_symlink():
            raise ValueError("release symlinks are forbidden")
        if dst.exists():
            if dst.stat().st_size != record["bytes"] or sha256(dst) != record["sha256"]:
                raise ValueError("existing local shard differs from the pinned release")
            reused.append(name)
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".shard-", dir=dst.parent)
        try:
            with os.fdopen(fd, "wb") as output, src.open("rb") as input_file:
                shutil.copyfileobj(input_file, output, length=1024 * 1024)
            temporary = Path(temporary)
            if temporary.stat().st_size != record["bytes"] or sha256(temporary) != record["sha256"]:
                raise ValueError("transferred shard/manifest integrity failure")
            temporary.replace(dst)
            copied.append(name)
        finally:
            Path(temporary).unlink(missing_ok=True)
    (destination / "release.json").write_bytes(release_path.read_bytes())
    return {"release_sha256": expected_release_sha256, "copied": copied, "reused": reused,
            "test_payloads_staged": include_test,
            "assurance": "same-session mounted-file readback; reverify after reconnect"}


def extract_source_bundle(bundle: Path, destination: Path, expected_sha256: str) -> Path:
    """The notebook verifies its pinned source ZIP before importing any package code."""
    if sha256(bundle) != expected_sha256:
        raise ValueError("source bundle SHA256 mismatch")
    reject_symlinks(destination)
    with zipfile.ZipFile(bundle) as archive:
        members = archive.infolist()
        names = [info.filename for info in members]
        if len(names) != len(set(names)) or sum(info.file_size for info in members) > 50_000_000:
            raise ValueError("duplicate or oversized source bundle")
        for info in members:
            safe_relative(info.filename)
            if info.is_dir() or (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError("source bundle must contain regular files only")
        manifest = json.loads(archive.read("bundle-manifest.json"))
        if set(names) != {*manifest["files"], "bundle-manifest.json"}:
            raise ValueError("source bundle inventory mismatch")
        for name, record in manifest["files"].items():
            validate_record(record)
            raw = archive.read(name)
            if len(raw) != record["bytes"] or hashlib.sha256(raw).hexdigest() != record["sha256"]:
                raise ValueError("source bundle file integrity failure")
        if destination.exists():
            for name, record in manifest["files"].items():
                reject_symlinks(destination / name)
                if sha256(destination / name) != record["sha256"]:
                    raise ValueError("existing source extraction differs")
            return destination
        temporary = Path(tempfile.mkdtemp(prefix=".source-", dir=destination.parent))
        try:
            for name in names:
                target = temporary / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(name))
            temporary.rename(destination)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
    return destination
