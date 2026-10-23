#!/usr/bin/env python3
"""Resolve an explicit CUDA 12.6 profile once, then install its immutable hash lock.

Run inside Colab, not on the development Mac. The first run uses pip's report to
resolve exact wheels from the official PyTorch and PyPI hosts. It freezes every
URL, version and SHA256 before installation. Reconnects use the same persisted
lock with --require-hashes and --no-deps; they never silently re-resolve packages.
This helper has offline contract tests; network resolution/GPU execution have
not been performed in the development environment.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import subprocess
import sys
import tempfile
import uuid
import venv
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urldefrag, urlparse
from urllib.request import HTTPRedirectHandler, build_opener

ALLOWED_HOSTS = {"download.pytorch.org", "download-r2.pytorch.org", "files.pythonhosted.org"}
ALLOWED_PACKAGES = {
    "torch", "numpy", "pillow", "safetensors", "packaging", "filelock", "typing-extensions", "sympy",
    "mpmath", "networkx", "jinja2", "markupsafe", "fsspec", "setuptools", "triton",
    "nvidia-cuda-nvrtc-cu12", "nvidia-cuda-runtime-cu12", "nvidia-cuda-cupti-cu12",
    "nvidia-cudnn-cu12", "nvidia-cublas-cu12", "nvidia-cufft-cu12", "nvidia-curand-cu12",
    "nvidia-cusolver-cu12", "nvidia-cusparse-cu12", "nvidia-cusparselt-cu12",
    "nvidia-nccl-cu12", "nvidia-nvtx-cu12", "nvidia-nvjitlink-cu12", "nvidia-cufile-cu12",
}
# safetensors 0.6.2 imports packaging.version in its Torch integration but omits
# that runtime dependency from distribution metadata. Pin it explicitly so pip
# check and a model-only GPU probe cannot leave checkpoint imports untested.
APPLICATION_PINS = {"numpy": "2.2.6", "pillow": "11.3.0", "safetensors": "0.6.2", "packaging": "25.0"}
PIP_BOOTSTRAP = {
    "name": "pip", "version": "26.2", "bytes": 1816475,
    "url": "https://files.pythonhosted.org/packages/62/36/a3aed958d60531cb442b7ab4596cda7b3621cfb916f8ae1d6769795c7dc1/pip-26.2-py3-none-any.whl",
    "sha256": "931c303696af6fa3417112103b1cad26890e5a07eccb5b99783700e33f2b8aad",
    "metadata_source": "https://pypi.org/pypi/pip/26.2/json",
}


def validate_profile(profile):
    if (profile.get("id") != "pytorch-2.8.0-cu126-linux-x86_64"
            or profile.get("torch_version") != "2.8.0+cu126"
            or profile.get("cuda_runtime") != "12.6"
            or profile.get("application_pins") != APPLICATION_PINS
            or profile.get("bootstrap_installer") != PIP_BOOTSTRAP):
        raise ValueError("The requested profile differs from the explicit reviewed version pins")
    for abi in ("cp311", "cp312"):
        expected = f"https://download-r2.pytorch.org/whl/cu126/torch-2.8.0%2Bcu126-{abi}-{abi}-manylinux_2_28_x86_64.whl"
        if profile.get("wheels", {}).get(abi, {}).get("url") != expected:
            raise ValueError("The requested Torch wheel is not the reviewed official URL")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def canonical_name(name):
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name):
        raise ValueError("Invalid package name")
    return re.sub(r"[-_.]+", "-", name).lower()


def runtime_identity():
    if sys.version_info[:2] not in ((3, 11), (3, 12)):
        raise ValueError("The explicit cu126 profile supports Python 3.11 or 3.12")
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise ValueError("The explicit cu126 profile requires Linux x86_64")
    libc, version = platform.libc_ver()
    if libc != "glibc" or tuple(int(x) for x in version.split(".")[:2]) < (2, 28):
        raise ValueError("Official wheels require glibc >=2.28")
    return {"python": platform.python_version(), "abi": f"cp{sys.version_info.major}{sys.version_info.minor}",
            "platform": "linux-x86_64", "glibc": version}


def reviewed_wheel(url, sha256, *, name, version):
    if (not isinstance(url, str) or any(c.isspace() or ord(c) < 32 for c in url)
            or "\\" in url or not isinstance(sha256, str)
            or not re.fullmatch(r"[0-9a-f]{64}", sha256)):
        raise ValueError("A persistent URL and SHA256 are required for every wheel")
    parsed = urlparse(url)
    if (parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS or parsed.username
            or parsed.password or parsed.port not in (None, 443) or parsed.query):
        raise ValueError("Unreviewed or nonpersistent wheel URL")
    if parsed.fragment not in ("", "sha256=" + sha256):
        raise ValueError("Wheel fragment does not match report SHA256")
    filename = unquote(Path(parsed.path).name)
    parts = filename.removesuffix(".whl").split("-")
    if not filename.endswith(".whl") or len(parts) not in (5, 6):
        raise ValueError("Only binary wheels are allowed; no source, editable or VCS installs")
    if canonical_name(parts[0]) != name or parts[1] != version:
        raise ValueError("Wheel filename and distribution identity differ")
    return urldefrag(url)[0]


def validate_report(report, profile, runtime):
    validate_profile(profile)
    if (report.get("version") != "1" or not isinstance(report.get("install"), list)
            or len(report["install"]) > len(ALLOWED_PACKAGES)
            or runtime.get("abi") not in ("cp311", "cp312")):
        raise ValueError("Unsupported pip installation report")
    expected = {**profile["application_pins"], "torch": profile["torch_version"]}
    wheels = {}
    for item in report["install"]:
        info, metadata = item.get("download_info", {}), item.get("metadata", {})
        if item.get("is_yanked") or "dir_info" in info or "vcs_info" in info:
            raise ValueError("Yanked, editable, directory and VCS packages are forbidden")
        name = canonical_name(metadata.get("name"))
        version = metadata.get("version")
        if (name not in ALLOWED_PACKAGES or name in wheels or not isinstance(version, str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.!+_]*", version)):
            raise ValueError("Unexpected or duplicate distribution in resolved profile")
        checksum = info.get("archive_info", {}).get("hashes", {}).get("sha256", "")
        url = reviewed_wheel(info.get("url", ""), checksum, name=name, version=version)
        if name in expected and version != expected[name]:
            raise ValueError(f"Explicit version pin changed: {name}")
        if name == "torch":
            expected_url = profile["wheels"][runtime["abi"]]["url"]
            if url != expected_url or not item.get("is_direct"):
                raise ValueError("Torch must use the selected official direct cu126 wheel")
            if not unquote(url).endswith(f'-{runtime["abi"]}-{runtime["abi"]}-manylinux_2_28_x86_64.whl'):
                raise ValueError("Torch ABI/platform does not match the selected runtime")
        wheels[name] = {"name": name, "version": version, "url": url, "sha256": checksum,
                        "requires_dist": metadata.get("requires_dist", [])}
    if not set(expected).issubset(wheels):
        raise ValueError("Pip report omits an explicitly pinned application distribution")
    return [wheels[name] for name in sorted(wheels)]


def lock_text(wheels):
    return ("# Runtime-resolved once; immutable exact URLs and SHA256. No dependency re-resolution.\n"
            + "\n".join(f'{row["name"]} @ {row["url"]} --hash=sha256:{row["sha256"]}'
                         for row in wheels) + "\n")


def publish_state(path, profile, runtime, report, wheels):
    path = Path(path)
    if path.exists():
        raise ValueError("Frozen environment already exists")
    temporary = path.with_name(path.name + ".resolving-" + uuid.uuid4().hex)
    temporary.mkdir()
    files = {"profile.json": canonical(profile) + b"\n", "runtime.json": canonical(runtime) + b"\n",
             "pip-report.json": canonical(report) + b"\n", "wheels.json": canonical(wheels) + b"\n",
             "requirements.lock": lock_text(wheels).encode()}
    for name, raw in files.items():
        with (temporary / name).open("xb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
    manifest = {"schema": "viscera.colab-environment-lock/v1", "runtime_resolved": True,
                "profile_sha256": hashlib.sha256(canonical(profile)).hexdigest(),
                "runtime": runtime, "files": {name: {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
                                                for name, raw in files.items()},
                "scope": "Resolved by pip on first Colab setup; installation and GPU validity are separate checks"}
    (temporary / "manifest.json").write_bytes(canonical(manifest) + b"\n")
    # Publication follows readback, including Drive-mounted persistent storage.
    verify_state(temporary, profile, runtime)
    temporary.rename(path)
    return manifest


def verify_state(path, profile, runtime):
    path = Path(path)
    if path.is_symlink() or (path / "manifest.json").is_symlink():
        raise ValueError("Frozen environment directory cannot be a symlink")
    manifest = json.loads((path / "manifest.json").read_text())
    expected_names = {"profile.json", "runtime.json", "pip-report.json", "wheels.json", "requirements.lock"}
    if (manifest.get("schema") != "viscera.colab-environment-lock/v1"
            or set(manifest.get("files", {})) != expected_names
            or manifest.get("profile_sha256") != hashlib.sha256(canonical(profile)).hexdigest()
            or manifest.get("runtime") != runtime):
        raise ValueError("Frozen profile/runtime identity mismatch; do not silently resolve a replacement")
    for name, item in manifest["files"].items():
        file = path / name
        if file.is_symlink() or file.stat().st_size != item["bytes"] or digest(file) != item["sha256"]:
            raise ValueError("Frozen environment file integrity failure")
    if (json.loads((path / "profile.json").read_text()) != profile
            or json.loads((path / "runtime.json").read_text()) != runtime):
        raise ValueError("Frozen profile/runtime payload differs from its manifest")
    report = json.loads((path / "pip-report.json").read_text())
    wheels = validate_report(report, profile, runtime)
    if (canonical(wheels) + b"\n" != (path / "wheels.json").read_bytes()
            or lock_text(wheels) != (path / "requirements.lock").read_text()):
        raise ValueError("Frozen lock does not match the validated report")
    return manifest


def run(command):
    subprocess.run(command, check=True, stdout=sys.stderr)


class NoBootstrapRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Pinned pip bootstrap must not redirect")


def download_bootstrap_wheel(destination):
    """Fetch only the reviewed, bounded official wheel; never execute a downloader."""
    expected = PIP_BOOTSTRAP
    with build_opener(NoBootstrapRedirect()).open(expected["url"], timeout=60) as response:
        if response.status != 200 or response.geturl() != expected["url"]:
            raise ValueError("Unexpected pip bootstrap HTTP response")
        length = response.headers.get("Content-Length")
        if length is not None and int(length) != expected["bytes"]:
            raise ValueError("Pip bootstrap publisher byte count differs")
        size = 0
        with Path(destination).open("xb") as stream:
            while block := response.read(min(65536, expected["bytes"] - size + 1)):
                size += len(block)
                if size > expected["bytes"]:
                    raise ValueError("Pip bootstrap exceeds its fixed byte bound")
                stream.write(block)
    if size != expected["bytes"] or digest(destination) != expected["sha256"]:
        raise ValueError("Pip bootstrap wheel SHA256 or byte count mismatch")


def bootstrap_pip(python, environment):
    """Install reviewed pip with a pipless interpreter, including partial-venv recovery.

    The verified wheel is imported directly using Python's ZIP importer. This
    does not depend on ensurepip, inherited notebook packages, get-pip.py, or an
    already installed pip. Every invocation re-establishes the same installer.
    """
    with tempfile.TemporaryDirectory(prefix="viscera-pip-bootstrap-") as directory:
        wheel = Path(directory) / Path(PIP_BOOTSTRAP["url"]).name
        download_bootstrap_wheel(wheel)
        # Verify at the execution boundary too, including supplied test transports.
        if wheel.stat().st_size != PIP_BOOTSTRAP["bytes"] or digest(wheel) != PIP_BOOTSTRAP["sha256"]:
            raise ValueError("Pip bootstrap wheel SHA256 or byte count mismatch")
        requirements = Path(directory) / "pip-bootstrap.lock"
        requirements.write_text(f"pip @ {wheel.as_uri()} --hash=sha256:{PIP_BOOTSTRAP['sha256']}\n")
        code = "import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module('pip',run_name='__main__')"
        run([str(python), "-I", "-c", code, str(wheel), "--isolated", "install",
             "--require-hashes", "--no-deps", "--no-index", "--only-binary=:all:",
             "--disable-pip-version-check", "--no-input", "--no-cache-dir", "--force-reinstall", "-r", str(requirements)])
    check = subprocess.run([str(python), "-I", "-c",
                            "import pip,json;print(json.dumps({'version':pip.__version__,'file':pip.__file__}))"],
                           check=True, capture_output=True, text=True)
    actual = json.loads(check.stdout)
    if (actual["version"] != PIP_BOOTSTRAP["version"]
            or not Path(actual["file"]).resolve().is_relative_to(Path(environment).resolve())):
        raise ValueError("Bootstrapped pip version or installation location differs")
    receipt = {"schema": "viscera.pip-bootstrap/v1", **PIP_BOOTSTRAP,
               "python": str(python), "installed_module": actual["file"], "verified_wheel": True}
    (Path(environment) / "viscera-pip-bootstrap.json").write_bytes(canonical(receipt) + b"\n")
    return receipt


def frozen_state(state, profile, runtime, python):
    """Serialize publication only; verified immutable state has no writer lock."""
    if state.exists():
        return verify_state(state, profile, runtime), True
    lock_path = state.with_name(state.name + ".lock")
    try:
        lock_fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as error:
        raise ValueError(
            f"Environment resolution lock already exists: {lock_path}. "
            "Another Colab kernel may still be resolving this profile. No lock was removed. "
            "Confirm that all other kernels using this lock directory are stopped before manual recovery. "
            "If a published state exists, rerun to verify and reuse it without acquiring this lock. "
            "Otherwise inspect the lock metadata and retained .resolving-* evidence, then manually "
            "remove only this stale .lock file before retrying first resolution. "
            "See research/tissue-v3/colab-environment.md; training checkpoint resume is a separate operation."
        ) from error
    try:
        with os.fdopen(lock_fd, "wb") as stream:
            stream.write(canonical({"schema": "viscera.colab-resolution-writer/v1",
                                    "created_utc": datetime.now(timezone.utc).isoformat(),
                                    "pid": os.getpid(), "hostname": platform.node(),
                                    "state_directory": str(state), "runtime": runtime,
                                    "profile_sha256": hashlib.sha256(canonical(profile)).hexdigest()}) + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        # Another completed writer may have published between the first exists()
        # and our exclusive acquisition. Never re-resolve a published state.
        if state.exists():
            return verify_state(state, profile, runtime), True
        with tempfile.TemporaryDirectory(prefix="viscera-cu126-report-") as directory:
            report_path = Path(directory) / "pip-report.json"
            command = [str(python), "-I", "-m", "pip", "--isolated", "install", "--dry-run",
                       "--ignore-installed", "--only-binary=:all:", "--disable-pip-version-check",
                       "--no-input", "--index-url", "https://pypi.org/simple", "--report", str(report_path),
                       "torch @ " + profile["wheels"][runtime["abi"]]["url"],
                       *[f"{name}=={version}" for name, version in sorted(profile["application_pins"].items())]]
            run(command)
            if report_path.stat().st_size > 5_000_000:
                raise ValueError("Pip report exceeds the bounded profile size")
            report = json.loads(report_path.read_text())
            wheels = validate_report(report, profile, runtime)
            publish_state(state, profile, runtime, report, wheels)
        return verify_state(state, profile, runtime), False
    finally:
        # No persistent writer lock is held during local installation or training.
        lock_path.unlink(missing_ok=True)


def resolve_and_install(profile_path, state, environment, *, install=True):
    profile = json.loads(Path(profile_path).read_text())
    validate_profile(profile)
    runtime = runtime_identity()
    state, environment = Path(state), Path(environment)
    if not state.parent.is_dir():
        raise ValueError("Persistent parent must exist after the explicit Drive mount")
    if any(p.is_symlink() for p in (state, environment)):
        raise ValueError("Environment output paths cannot be symlinks")
    # Fail on corrupted persisted state before any local bootstrap/install mutation.
    if state.exists():
        verify_state(state, profile, runtime)
    if environment.exists() and not (environment / "pyvenv.cfg").is_file():
        raise ValueError("Local environment path exists but is not an isolated venv")
    if not environment.exists():
        venv.EnvBuilder(with_pip=False, system_site_packages=False).create(environment)
    if "include-system-site-packages = false" not in (environment / "pyvenv.cfg").read_text().lower():
        raise ValueError("The training environment must not inherit notebook packages")
    python = environment / "bin/python"
    try:
        check = subprocess.run([str(python), "-I", "-c", "import sys,json;print(json.dumps({'python':'.'.join(map(str,sys.version_info[:3])),'prefix':sys.prefix}))"],
                               check=True, capture_output=True, text=True)
    except (OSError, subprocess.CalledProcessError) as error:
        raise ValueError("Existing venv interpreter is missing or unusable. It was preserved; choose a new --venv directory or inspect this partial environment before retrying.") from error
    actual = json.loads(check.stdout)
    if actual["python"] != runtime["python"] or Path(actual["prefix"]).resolve() != environment.resolve():
        raise ValueError("Existing venv Python/runtime identity differs")
    bootstrap = bootstrap_pip(python, environment)
    manifest, reused = frozen_state(state, profile, runtime, python)
    if not install:
        return {"resolved_only": True, "lock_directory": str(state),
                "requirements_path": str(state / "requirements.lock"), "python": str(python),
                "manifest_sha256": digest(state / "manifest.json"), "runtime": runtime,
                "reused_frozen_lock": reused, "pip_bootstrap": bootstrap, "gpu_executed": False}
    # Identical command on first setup and resume; no persistent resolution lock
    # survives if this local installation is killed by a Colab VM restart.
    run([str(python), "-I", "-m", "pip", "--isolated", "install", "--require-hashes", "--no-deps",
         "--only-binary=:all:", "--disable-pip-version-check", "--no-input", "--no-index", "--force-reinstall",
         "-r", str(state / "requirements.lock")])
    run([str(python), "-I", "-m", "pip", "--isolated", "check"])
    installed = subprocess.run([str(python), "-I", "-c", "import importlib.metadata as m,json;print(json.dumps({d.metadata['Name'].lower().replace('_','-'):d.version for d in m.distributions()}))"],
                               check=True, capture_output=True, text=True)
    versions = {canonical_name(k): v for k, v in json.loads(installed.stdout).items()}
    wheels = json.loads((state / "wheels.json").read_text())
    if any(versions.get(row["name"]) != row["version"] for row in wheels):
        raise ValueError("Installed distribution versions differ from the frozen lock")
    if versions.get("pip") != PIP_BOOTSTRAP["version"]:
        raise ValueError("Installed pip differs from the reviewed bootstrap pin")
    if set(versions) - {row["name"] for row in wheels} - {"pip", "setuptools"}:
        raise ValueError("Isolated environment contains packages outside the frozen lock")
    receipt = {"schema": "viscera.colab-environment-install/v1", "python": str(python),
               "runtime": runtime, "state": str(state), "reused_frozen_lock": reused,
               "lock_directory": str(state), "requirements_path": str(state / "requirements.lock"),
               "lock_sha256": digest(state / "requirements.lock"),
               "manifest_sha256": digest(state / "manifest.json"), "packages": versions,
               "profile_sha256": manifest["profile_sha256"], "gpu_executed": False,
               "pip_bootstrap": bootstrap,
               "assurance": "Exact hashed wheels installed in isolated venv; GPU and training preflight still required"}
    (environment / "viscera-installation.json").write_bytes(canonical(receipt) + b"\n")
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--state-dir", "--lock-root", dest="state_dir", type=Path, required=True)
    parser.add_argument("--venv", type=Path, required=True)
    parser.add_argument("--install", action="store_true", help="Install the frozen hash lock; default resolves/freezes only")
    args = parser.parse_args()
    print(json.dumps(resolve_and_install(args.profile, args.state_dir, args.venv, install=args.install), indent=2))


if __name__ == "__main__":
    main()
