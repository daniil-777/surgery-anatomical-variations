"""Exercise the exact source-loading notebook cell without Colab or installs."""

import hashlib
import json
import os
import runpy
import sys
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest


@pytest.mark.parametrize("failure", [None, "checksum", "path"])
def test_notebook_upload_verifies_manifest_before_extracting(tmp_path, failure):
    project = Path(__file__).resolve().parents[2]
    cells = runpy.run_path(str(project / "notebooks/make_notebooks.py"))["cells"]
    source = "".join(cells[2]["source"])
    files = {
        "viscera/pyproject.toml": b"[project]\nname='viscera'\n",
        "viscera/py/viscera_core/geometry.py": b"# inert geometry fixture\n",
    }
    if failure == "path":
        files["../escaped.py"] = b"must not extract"
    manifest = {"files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
    if failure == "checksum":
        files["viscera/py/viscera_core/geometry.py"] += b"# corrupt"
    upload = tmp_path / "source.zip"
    with zipfile.ZipFile(upload, "w") as archive:
        for name, data in files.items():
            archive.writestr(name, data)
        archive.writestr("MANIFEST.json", json.dumps(manifest))
    extraction = tmp_path / "fresh-source"
    extraction.mkdir()
    context = {
        "SOURCE_MODE": "upload",
        "IN_COLAB": True,
        "INSTALL_DEPENDENCIES": False,
        "files": SimpleNamespace(upload=lambda: {str(upload): upload.read_bytes()}),
        "tempfile": SimpleNamespace(mkdtemp=lambda **kwargs: str(extraction)),
        "os": SimpleNamespace(chdir=lambda path: None, environ={}, pathsep=os.pathsep),
        "sys": SimpleNamespace(executable=sys.executable, path=[]),
        "Path": Path,
        "zipfile": zipfile,
        "json": json,
        "hashlib": hashlib,
    }
    if failure is not None:
        with pytest.raises(ValueError, match="checksum" if failure == "checksum" else "Unsafe"):
            exec(compile(source, "notebook:source-upload", "exec"), context)
        assert not list(extraction.iterdir())
        assert not (tmp_path / "escaped.py").exists()
    else:
        exec(compile(source, "notebook:source-upload", "exec"), context)
        assert context["PROJECT"] == extraction / "viscera"
        assert context["os"].environ["PYTHONPATH"].split(os.pathsep) == [
            str(context["PROJECT"]),
            str(context["PROJECT"] / "py"),
        ]
        assert (context["PROJECT"] / "py/viscera_core/geometry.py").read_bytes() == files[
            "viscera/py/viscera_core/geometry.py"
        ]
