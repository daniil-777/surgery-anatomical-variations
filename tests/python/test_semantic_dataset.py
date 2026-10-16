"""Release reproducibility, phrase-family partitions and authored-label contract."""
import hashlib
from collections import Counter
from pathlib import Path

import pytest
from viscera_core.atlas_semantic import plan_fingerprint, validate_plan
from viscera_core.atlas_semantic_dataset import FAMILIES, iter_examples, write_release


def test_dataset_contexts_and_grouped_splits_are_distinct():
    rows = list(iter_examples(4000))
    assert len({r['id'] for r in rows}) == 4000
    assert Counter(r['split'] for r in rows) == {'train': 3200, 'val': 400, 'audit': 400}
    assert {r['context']['renderer_version'] for r in rows} == {'legacy', 'disease-v2'}
    assert len({r['context']['organ'] for r in rows}) == 12
    assert not {'colon', 'bladder'} & {r['context']['organ'] for r in rows}
    assert len({r['family_id'] for r in rows}) == len(FAMILIES)
    for left, right in [('train', 'val'), ('train', 'audit'), ('val', 'audit')]:
        assert not {r['family_id'] for r in rows if r['split'] == left} & {r['family_id'] for r in rows if r['split'] == right}
        assert not {r['text'].strip().casefold() for r in rows if r['split'] == left} & {r['text'].strip().casefold() for r in rows if r['split'] == right}
    # Runtime checks validate labels; they never generate or replace them.
    for row in rows:
        actual = validate_plan(row['target'], row['context'], text=row['text'])
        assert plan_fingerprint(actual) == plan_fingerprint(row['target']), (row['text'], row['target'], actual)


def test_release_is_reproducible_immutable_and_includes_independent_challenge(tmp_path):
    fixture = Path(__file__).resolve().parents[1] / 'fixtures/anatomy-wording-challenge.jsonl'
    a = write_release(tmp_path / 'a', rows=600, challenge=fixture)
    b = write_release(tmp_path / 'b', rows=600, challenge=fixture)
    assert a == b
    assert a['challenge']['used_for_training'] is False
    assert a['challenge']['exact_text_overlap_with_train'] == 0
    assert a['scope']['clinical_review'] == 'NOT_RUN'
    assert a['rows'] == 600
    for name, expected in a['artifact_hashes'].items():
        assert hashlib.sha256((tmp_path / 'a' / name).read_bytes()).hexdigest() == expected
    with pytest.raises(FileExistsError):
        write_release(tmp_path / 'a', rows=600)
