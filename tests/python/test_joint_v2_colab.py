"""Expanded-release notebook and extraction boundaries, without hidden state."""

import ast
import json

import pytest

from scripts import build_joint_v2_notebook as notebook
from scripts import joint_v2_notebook_bootstrap as bootstrap
from scripts.package_joint_colab import write_archive


def test_v2_notebook_pins_three_archives_and_keeps_original_weights_filename_separate(tmp_path):
    packages = {}
    for lane, prefix in (("baseline", "baseline"), ("disease", "disease"), ("runtime", "viscera")):
        data = tmp_path / f"{lane}.json"
        data.write_text(json.dumps({"lane": lane}))
        packages[lane] = write_archive(tmp_path / f"{lane}.zip", prefix, {"data.json": data})
    index = tmp_path / "release-index.json"
    index.write_text(json.dumps({"packages": packages, "datasets": {"baseline": {"samples": 13824}, "disease": {"samples": 69120}}, "drive_folder": "VISCERA Expanded Disease Training 2026-10-07"}))
    output = notebook.build(index, tmp_path / "run.ipynb")
    document = json.loads(output.read_text())
    cells = [cell["source"] for cell in document["cells"] if cell["cell_type"] == "code"]
    assert len(cells) == 4
    for source in cells:
        ast.parse(source)
    assert "viscera-joint-v2-weights.zip" in cells[-1]
    assert document["metadata"]["colab"]["gpuType"] == "A100"
    assert all(package["sha256"] in cells[0] for package in packages.values())
    first = packages["baseline"]
    extracted = bootstrap.extract_package(tmp_path / first["filename"], first["sha256"], tmp_path / "unpacked", first["prefix"])
    assert json.loads((extracted / "data.json").read_text())["lane"] == "baseline"
    (extracted / "data.json").write_text("tampered")
    with pytest.raises(ValueError, match="checksum"):
        bootstrap.extract_package(tmp_path / first["filename"], first["sha256"], tmp_path / "unpacked", first["prefix"])
