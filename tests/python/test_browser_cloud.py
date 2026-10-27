"""Recovery and authentication contracts for the small cloud browser deployment."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


entry = module("browser_entry", ROOT / "deploy/browser/entrypoint.py")
stager = module("browser_stage", ROOT / "scripts/stage_browser_cloud.py")


class CloudTests(unittest.TestCase):
    def test_missing_secret_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "secret is missing"):
                entry.configure_access(Path(directory) / "data", Path(directory) / "private")

    def test_private_credentials_and_no_child_environment_secret(self):
        # Credential parsing itself belongs to the installed service's auth
        # suite. This unit test checks the deployment boundary and delegation,
        # without requiring a locally installed browser release in a checkout.
        validator = Mock()
        auth = SimpleNamespace(AccessConfig=SimpleNamespace(from_env=validator))
        payload = {"username": "cloud-fixture", "password_hash": "fixture-only-placeholder"}
        encoded = base64.b64encode(json.dumps(payload).encode()).decode()
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"VISCERA_ACCESS_CONFIG_B64": encoded, "VISCERA_AUTH_ORIGIN": "https://fixture.fly.dev"}), patch.dict(sys.modules, {"services.web.studio_access": auth}):
            entry.configure_access(Path(directory) / "data", Path(directory) / "private")
            self.assertNotIn("VISCERA_ACCESS_CONFIG_B64", os.environ)
            path = Path(os.environ["VISCERA_AUTH_CONFIG"])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text()), payload)
            validator.assert_called_once_with()

    def test_dead_server_requests_platform_restart(self):
        previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
        try:
            self.assertEqual(entry.supervise([sys.executable, "-c", "raise SystemExit(12)"], 1, "https://fixture.fly.dev"), 1)
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)

    def test_unresponsive_server_is_terminated(self):
        previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
        launched = []
        real_popen = subprocess.Popen
        def spawn(*args, **kwargs):
            child = real_popen(*args, **kwargs)
            launched.append(child)
            return child
        try:
            with patch.object(entry.subprocess, "Popen", side_effect=spawn), patch.object(entry, "healthy", return_value=False):
                result = entry.supervise([sys.executable, "-c", "import time; time.sleep(60)"], 1, "https://fixture.fly.dev", interval=.01, startup_grace=0, failure_limit=2)
            self.assertEqual(result, 1)
            self.assertIsNotNone(launched[0].poll())
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)

    def test_stage_rejects_private_state_inside_public_release(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            release = base / "release"
            for name in ("public-copy/index.html", "services/web/private_preview.py", "services/web/studio_access.py", "services/web/login/index.html", "apps/studio/public/recorder/manifest.json", "public-copy/sessions.sqlite"):
                path = release / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("fixture")
            with self.assertRaisesRegex(ValueError, "Private runtime file"):
                stager.stage(release, base / "stage", "fixture-app")


if __name__ == "__main__":
    unittest.main()
