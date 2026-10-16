"""Optional batched-generation provenance is enforced without changing gates."""
import copy
import json
from pathlib import Path

import pytest

from services.api import atlas_wording_model as serving
from pipelines.train.viscera_train import atlas_wording as original

ROOT = Path(__file__).resolve().parents[2]


def fixture(tmp_path, *, matches=16):
    root, bundle = tmp_path/'root', tmp_path/'bundle'
    (root/'scripts').mkdir(parents=True)
    bundle.mkdir()
    (root/'scripts/wording_batched_evaluation.py').write_bytes((ROOT/'scripts/wording_batched_evaluation.py').read_bytes())
    helper = original.digest(root/'scripts/wording_batched_evaluation.py')
    release = {'counts':{'audit':576,'challenge':96},'evaluation_contract':{
        'helper_sha256':helper,'method':'left_padded_greedy_batch_v1','batch_size':8,
        'validation_parity_rows':16,'audit_limit':512,'fallback':'original_sequential_on_any_parity_mismatch'}}
    evaluation = {'evaluation_contract':copy.deepcopy(release['evaluation_contract']),
        'audit':{'rows':512},'runtime_audit':{'rows':512},'challenge':{'rows':96},'runtime_challenge':{'rows':96},
        'audit_example_ids':[f'audit-{i}' for i in range(512)],'challenge_example_ids':[f'challenge-{i}' for i in range(96)],
        'generation_execution':{'helper_sha256':helper,'requested_batch_size':8,'parity_rows':16,
            'parity_example_ids':[f'validation-{i}' for i in range(16)],'parity_checked_before_opening_audit':True,
            'maximum_new_tokens':384,'do_sample':False,'exact_output_matches':matches,
            'method':'left_padded_greedy_batch' if matches==16 else 'original_sequential_after_parity_mismatch'}}
    original.atomic_json(bundle/'dataset_release.json',release)
    original.atomic_json(bundle/'evaluation.json',evaluation)
    return root,bundle,release,evaluation


@pytest.mark.parametrize('matches',[16,15,0])
def test_exact_parity_or_honest_sequential_fallback_allowed(tmp_path,matches):
    root,bundle,_,_=fixture(tmp_path,matches=matches)
    serving._validate_evaluation_contract(root,bundle)


def test_legacy_release_without_execution_contract_unchanged(tmp_path):
    root,bundle,release,_=fixture(tmp_path)
    del release['evaluation_contract']
    original.atomic_json(bundle/'dataset_release.json',release)
    (bundle/'evaluation.json').unlink()
    serving._validate_evaluation_contract(root,bundle)


@pytest.mark.parametrize('mutation',[
    'helper_sha','batch_size','parity_count','before_audit','token_limit','sampling',
    'duplicate_parity','parity_audit_overlap','incomplete_challenge','incomplete_audit',
    'runtime_count','mismatched_but_batched','equal_but_fallback','bool_match_count',
    'missing_execution','contract_changed','local_helper_changed','echoed_contract_changed',
])
def test_tampered_execution_rejected(tmp_path,mutation):
    root,bundle,release,evaluation=fixture(tmp_path)
    execution=evaluation['generation_execution']
    if mutation=='helper_sha':execution['helper_sha256']='0'*64
    elif mutation=='batch_size':execution['requested_batch_size']=16
    elif mutation=='parity_count':execution['parity_rows']=15
    elif mutation=='before_audit':execution['parity_checked_before_opening_audit']=False
    elif mutation=='token_limit':execution['maximum_new_tokens']=512
    elif mutation=='sampling':execution['do_sample']=True
    elif mutation=='duplicate_parity':execution['parity_example_ids'][1]=execution['parity_example_ids'][0]
    elif mutation=='parity_audit_overlap':execution['parity_example_ids'][0]=evaluation['audit_example_ids'][0]
    elif mutation=='incomplete_challenge':evaluation['challenge_example_ids'].pop()
    elif mutation=='incomplete_audit':evaluation['audit_example_ids'].pop()
    elif mutation=='runtime_count':evaluation['runtime_challenge']['rows']=95
    elif mutation=='mismatched_but_batched':execution['exact_output_matches']=15
    elif mutation=='equal_but_fallback':execution['method']='original_sequential_after_parity_mismatch'
    elif mutation=='bool_match_count':execution['exact_output_matches']=True
    elif mutation=='missing_execution':del evaluation['generation_execution']
    elif mutation=='contract_changed':release['evaluation_contract']['audit_limit']=511
    elif mutation=='local_helper_changed':(root/'scripts/wording_batched_evaluation.py').write_text('changed')
    elif mutation=='echoed_contract_changed':evaluation['evaluation_contract']['audit_limit']=511
    original.atomic_json(bundle/'dataset_release.json',release)
    original.atomic_json(bundle/'evaluation.json',evaluation)
    with pytest.raises(ValueError,match='[Ww]ording|[Ii]nvalid exact'):
        serving._validate_evaluation_contract(root,bundle)


def test_import_validation_runs_additional_contract_check_after_frozen_verifier(tmp_path,monkeypatch):
    root,bundle,_,evaluation=fixture(tmp_path)
    evaluation['generation_execution']['exact_output_matches']=15
    original.atomic_json(bundle/'evaluation.json',evaluation)
    manifest={'format':serving.FORMAT,'promoted':True,'artifact_hashes':{
        name:original.digest(bundle/name) for name in ('dataset_release.json','evaluation.json')}}
    original.atomic_json(bundle/'manifest.json',manifest)
    called=[]
    def verified(*_a,**_k):
        called.append(True)
        return manifest
    monkeypatch.setattr(original,'verify_adapter',verified)
    with pytest.raises(ValueError,match='parity fallback'):
        serving._validate(root,bundle)
    assert called==[True]
