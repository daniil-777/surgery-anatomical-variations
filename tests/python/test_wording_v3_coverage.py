"""Regressions for the missing qualitative/context coverage in wording v2."""
import json
from pathlib import Path
import re

import pytest

DATA = Path(__file__).resolve().parents[2] / "datasets/atlas/wording-v3-coverage-2026-10-08"


@pytest.fixture(scope="module")
def rows():
    if not DATA.is_dir():
        pytest.skip("Build the separately versioned v3 coverage release first")
    return {split: [json.loads(line) for line in (DATA / f"{split}.jsonl").open()]
            for split in ("train", "val")}


def test_qualitative_health_edits_cover_all_contexts_and_use_default_magnitudes(rows):
    for split, examples in rows.items():
        for name, value in (("health_down_default", -.2), ("health_up_default", .2),
                            ("health_down_slight", -.1), ("health_up_slight", .1)):
            selected = [r for r in examples if r["family_id"] == f"v3.{split}.{name}"]
            assert len({(r["context"]["organ"], r["context"]["renderer_version"],
                         bool(r["context"]["disease"])) for r in selected}) == 48
            assert all("%" not in r["text"] for r in selected)
            for row in selected:
                target = row["target"]
                if row["context"]["disease"]:
                    assert target["status"] == "accepted"
                    assert {op["field"] for op in target["operations"]} == {"severity", "contrast"}
                    assert all(op["value"] == value for op in target["operations"])
                else:
                    assert target["operations"] == []
                    assert target["status"] == ("clarify" if value > 0 else "accepted")


def test_split_and_reserved_context_seed_boundaries(rows):
    normalize = lambda text: re.sub(r"[^\w%.+-]+", " ", text.lower()).strip()
    assert not {normalize(r["text"]) for r in rows["train"]} & {normalize(r["text"]) for r in rows["val"]}
    assert not {r["family_id"] for r in rows["train"]} & {r["family_id"] for r in rows["val"]}
    for examples in rows.values():
        for row in examples:
            for section in (row["context"]["material"], row["context"]["disease"]):
                assert section is None or not 3_100_000_000 <= section["seed"] < 3_200_000_000


def test_unsupported_requests_never_get_partial_edits(rows):
    for examples in rows.values():
        rejected = [r for r in examples if "unsupported_" in r["family_id"] or "contradiction" in r["family_id"]]
        assert rejected
        assert all(r["target"]["status"] == "unsupported" and not r["target"]["operations"] for r in rejected)
