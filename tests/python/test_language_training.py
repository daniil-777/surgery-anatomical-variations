import copy
import json

import pytest

from pipelines.train.viscera_train import language


def test_generated_targets_use_disjoint_states_and_wording(tmp_path):
    manifest = language.prepare_data(tmp_path, (96, 48, 48))
    train = language.read_rows(tmp_path, "train")
    val = language.read_rows(tmp_path, "val")
    test = language.read_rows(tmp_path, "test")
    language.audit_rows(train, val)
    language.audit_rows(train, test)
    language.audit_rows(val, test)
    assert manifest["tracks"]["operation_family_holdout"] is False
    for rows in (train, val, test):
        assert {r["target"]["status"] for r in rows} == {
            "ready",
            "unsupported",
            "needs_clarification",
        }
        for row in rows:
            if " by " in row["request"]:
                patch = row["target"]["patches"][0]
                old = row["current"]["parameters"][patch["path"].split("/")[-1]]
                assert (patch["value"] > old) == row["request"].startswith("increase")
    with pytest.raises(ValueError, match="leakage"):
        language.audit_rows(train, [train[0]])
    path = tmp_path / "test.jsonl"
    path.write_text(path.read_text() + "\n")
    with pytest.raises(ValueError, match="checksum"):
        language.read_rows(tmp_path, "test")


def test_schema_rejects_unbounded_partial_and_unknown_proposals():
    valid = {
        "status": "ready",
        "patches": [{"op": "replace", "path": "/parameters/liver_width_mm", "value": 240}],
    }
    assert language.validate_target(valid) == valid
    for patch in (
        {"op": "replace", "path": "/parameters/liver_width_mm", "value": float("nan")},
        {"op": "replace", "path": "/parameters/liver_width_mm", "value": 800},
        {"op": "replace", "path": "/parameters/tumor", "value": 2},
        {"op": "remove", "path": "/parameters/liver_width_mm", "value": 220},
        {"op": "replace", "path": "/seed", "value": True},
        {"op": "replace", "path": "/parameters/liver_width_mm", "value": 10**1000},
    ):
        with pytest.raises(ValueError):
            language.validate_target({"status": "ready", "patches": [patch]})
    with pytest.raises(ValueError, match="partial"):
        language.validate_target({"status": "unsupported", "patches": valid["patches"]})
    with pytest.raises(ValueError, match="unique"):
        language.validate_target({"status": "ready", "patches": valid["patches"] * 2})


def test_assistant_only_loss_and_full_failure_denominator(tmp_path):
    language.prepare_data(tmp_path, (24, 16, 16))
    rows = language.read_rows(tmp_path, "test")

    class Tokenizer:
        eos_token_id = 2

        def apply_chat_template(self, messages, **kwargs):
            assert "current" in messages[1]["content"]
            return [11, 12, 13]

        def __call__(self, text, **kwargs):
            return {"input_ids": [ord(c) + 20 for c in text]}

    encoded = language.tokenize_row(Tokenizer(), rows[0])
    assert encoded["labels"][:3] == [-100, -100, -100]
    assert encoded["labels"][3:] == encoded["input_ids"][3:]
    assert encoded["labels"][-1] == 2
    with pytest.raises(ValueError, match="truncate"):
        language.tokenize_row(Tokenizer(), rows[0], maximum=5)
    predictions = [json.dumps(row["target"]) for row in rows]
    score = language.score_predictions(rows, predictions)
    assert score["exact_target_rate"] == 1
    predictions[0] = "```json\n{}\n```"
    bad_index = next(i for i, r in enumerate(rows) if r["target"]["status"] == "unsupported")
    predictions[bad_index] = '{"status":"ready","patches":[]}'
    score = language.score_predictions(rows, predictions)
    assert score["attempted"] == len(rows)
    assert score["valid_json_schema"] == len(rows) - 1
    assert score["unsafe_false_ready"] == 1
    assert score["exact_target"] == len(rows) - 2
    broken = copy.deepcopy(rows[0]["target"])
    broken["explanation"] = "unbounded addition"
    with pytest.raises(ValueError, match="exactly"):
        language.validate_target(broken)


def test_language_release_is_idempotent_and_refuses_corruption_or_new_recipe(tmp_path):
    first = language.prepare_data(tmp_path, (24, 16, 16), seed=43)
    before = {p.name: p.read_bytes() for p in tmp_path.iterdir()}
    assert language.prepare_data(tmp_path, (24, 16, 16), seed=43) == first
    assert before == {p.name: p.read_bytes() for p in tmp_path.iterdir()}
    with pytest.raises(ValueError, match="different recipe"):
        language.prepare_data(tmp_path, (24, 16, 16), seed=44)
    (tmp_path / "val.jsonl").write_text("corrupt")
    with pytest.raises(ValueError, match="checksum"):
        language.prepare_data(tmp_path, (24, 16, 16), seed=43)
    assert (tmp_path / "val.jsonl").read_text() == "corrupt"


@pytest.mark.parametrize("counts,seed", [((0, 1, 1), 4), ((2, 2), 4), ((1, 1, 1), -1)])
def test_language_recipe_validates_before_writing(tmp_path, counts, seed):
    out = tmp_path / "release"
    with pytest.raises(ValueError):
        language.prepare_data(out, counts, seed)
    assert not out.exists()


def test_scoring_accepts_equivalent_json_numbers_and_counts_giant_numbers_as_failure():
    target = {
        "status": "ready",
        "patches": [{"op": "replace", "path": "/parameters/liver_width_mm", "value": 240.0}],
    }
    rows = [{"id": "numeric", "request": "liver width 240 mm", "target": target}]
    prediction = copy.deepcopy(target)
    prediction["patches"][0]["value"] = 240
    assert language.score_predictions(rows, [json.dumps(prediction)])["exact_target"] == 1
    prediction["patches"][0]["value"] = 10**1000
    score = language.score_predictions(rows, [json.dumps(prediction)])
    assert score["attempted"] == 1 and score["valid_json_schema"] == 0
