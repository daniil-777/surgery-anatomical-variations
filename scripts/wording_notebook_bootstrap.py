"""Colab setup without a dependency on the runtime's optional ensurepip package."""

import subprocess
import sys
from pathlib import Path


def ensure_wording_environment(environment):
    environment = Path(environment).absolute()
    python = environment / "bin/python"

    def checked(command):
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode:
            details = "\n".join(part.strip() for part in (result.stdout, result.stderr) if part)
            raise RuntimeError(
                f"Wording environment setup failed (exit {result.returncode}): "
                f"{command!r}\n{details}"
            )
        return result.stdout.strip()

    # Re-running this also repairs a partial venv left by a failed ensurepip step.
    # No --clear: installed packages and every Drive training checkpoint survive.
    checked([sys.executable, "-m", "venv", "--without-pip", str(environment)])
    checked([
        str(python), "-c",
        "import sys; from pathlib import Path; "
        "assert sys.prefix != sys.base_prefix, 'Expected an isolated environment'; "
        "assert Path(sys.prefix).resolve() == Path(sys.argv[1]).resolve(), "
        "'Unexpected environment prefix'",
        str(environment),
    ])
    probe = subprocess.run(
        [str(python), "-m", "pip", "--version"], capture_output=True, text=True
    )
    if probe.returncode:
        # pip's documented --python support can seed a pip-free environment.
        # This installs only into the target environment, not the Colab kernel.
        checked([
            sys.executable, "-m", "pip", "--python", str(python), "install",
            "--disable-pip-version-check", "--index-url", "https://pypi.org/simple",
            "pip==25.2",
        ])
    print("Wording environment ready:", python)
    print(checked([str(python), "-m", "pip", "--version"]))
    return python
