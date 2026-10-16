"""Regressions for the Colab partial-venv failure before training starts."""

import subprocess

import pytest

from scripts import wording_notebook_bootstrap as bootstrap


@pytest.mark.parametrize("pip_ready", [False, True])
def test_existing_python_does_not_skip_environment_repair(tmp_path, monkeypatch, pip_ready):
    environment = tmp_path / "environment"
    python = environment / "bin/python"
    python.parent.mkdir(parents=True)
    python.touch()  # This existed after the user's failed venv invocation.
    calls = []
    seeded = []

    def run(command, **kwargs):
        calls.append(command)
        if "--python" in command:
            seeded.append(command)
        missing = command == [str(python), "-m", "pip", "--version"] and not (
            pip_ready or seeded
        )
        return subprocess.CompletedProcess(
            command, int(missing), stdout="pip test" if not missing else "",
            stderr="No module named pip" if missing else "",
        )

    monkeypatch.setattr(bootstrap.subprocess, "run", run)
    assert bootstrap.ensure_wording_environment(environment) == python
    assert calls[0] == [
        bootstrap.sys.executable, "-m", "venv", "--without-pip", str(environment),
    ]
    assert len(seeded) == (0 if pip_ready else 1)
    if seeded:
        assert seeded[0][seeded[0].index("--python") + 1] == str(python)
    assert calls[-1] == [str(python), "-m", "pip", "--version"]
    assert all("--clear" not in command for command in calls)


def test_bootstrap_failure_preserves_underlying_diagnostic(tmp_path, monkeypatch):
    def failed(command, **kwargs):
        return subprocess.CompletedProcess(
            command, 1, stdout="Environment creation failed", stderr="No space left on device"
        )

    monkeypatch.setattr(bootstrap.subprocess, "run", failed)
    with pytest.raises(RuntimeError, match="(?s)exit 1.*Environment creation failed.*No space"):
        bootstrap.ensure_wording_environment(tmp_path / "environment")
