"""Batch mechanics and dispatch tests, not evidence of trained-model quality."""
import copy
import importlib.util
import json
from pathlib import Path

import pytest
import torch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('wording_batched_evaluation_tested', ROOT/'scripts/wording_batched_evaluation.py')
B = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(B)
W = B.original


class TokenizerFixture:
    pad_token_id = 0

    def apply_chat_template(self, messages, *, tokenize, add_generation_prompt):
        assert tokenize is True and add_generation_prompt is True
        return json.loads(messages[-1]['content'])['context']['tokens']

    def decode(self, tokens, *, skip_special_tokens):
        assert skip_special_tokens is True
        return ','.join(str(int(t)) for t in tokens if int(t) != self.pad_token_id)


def test_manual_left_padding_mask_and_new_token_extraction():
    class Model:
        def __init__(self):
            self.calls = []
        def eval(self):
            return self
        def generate(self, **kwargs):
            self.calls.append(kwargs)
            ids = kwargs['input_ids']
            assert kwargs['do_sample'] is False
            assert kwargs['use_cache'] is True
            assert kwargs['max_new_tokens'] == 3
            assert kwargs['pad_token_id'] == 0
            suffix = torch.stack([ids[:, -1]+100, torch.zeros(len(ids),dtype=torch.long)], dim=1)
            return torch.cat([ids,suffix],dim=1)
    model = Model()
    rows = [{'context':{'tokens':ids},'text':'fixture'} for ids in ([1,2],[3,4,5,6],[7])]
    outputs = B.predictions_batched(model,TokenizerFixture(),rows,'cpu',batch_size=2,maximum_new_tokens=3)
    assert outputs == ['102','106','107']
    assert model.calls[0]['input_ids'].tolist() == [[0,0,1,2],[3,4,5,6]]
    assert model.calls[0]['attention_mask'].tolist() == [[0,0,1,1],[1,1,1,1]]
    assert model.calls[1]['input_ids'].tolist() == [[7]]
    assert model.calls[1]['attention_mask'].tolist() == [[1]]
    assert all(c['input_ids'].dtype == torch.long for c in model.calls)


def test_real_tiny_qwen_cpu_greedy_single_batch_parity():
    from transformers import AutoTokenizer, Qwen2Config, Qwen2ForCausalLM

    tokenizer = AutoTokenizer.from_pretrained(W.BASE_MODEL,revision=W.BASE_REVISION,local_files_only=True)
    tokenizer.pad_token = tokenizer.eos_token
    with torch.random.fork_rng():
        torch.manual_seed(20261008)
        config = Qwen2Config(vocab_size=len(tokenizer),hidden_size=16,intermediate_size=32,
            num_hidden_layers=1,num_attention_heads=2,num_key_value_heads=1,
            max_position_embeddings=2048,bos_token_id=tokenizer.bos_token_id,
            eos_token_id=tokenizer.eos_token_id,pad_token_id=tokenizer.pad_token_id)
        model = Qwen2ForCausalLM(config).eval()
    rows = [{'context':{'organ':'liver','disease':None},'text':text} for text in (
        'Wetter.',
        'Make this organ five percent wider and preserve its disease appearance.',
        'Please make the organ somewhat healthier, with the material left unchanged and every geometric control preserved.')]
    lengths = [len(tokenizer.apply_chat_template(W.messages(r),tokenize=True,add_generation_prompt=True)) for r in rows]
    assert len(set(lengths)) == len(rows)
    sequential = W.predictions(model,tokenizer,rows,'cpu',maximum_new_tokens=8)
    batched = B.predictions_batched(model,tokenizer,rows,'cpu',batch_size=2,maximum_new_tokens=8)
    assert batched == sequential
    assert all(text for text in sequential)


@pytest.mark.parametrize('mismatch',[False,True])
def test_parity_decision_before_audit_and_unchanged_quality_gates(tmp_path,monkeypatch,mismatch):
    held = ROOT/'artifacts/wording-integration-2026-10-08/v3-independent-heldout'
    parts = {name:[json.loads(l) for l in (held/(name+'.jsonl')).read_text().splitlines()] for name in ('audit','challenge')}
    validation = []
    for i,row in enumerate(parts['audit'][:16]):
        item = copy.deepcopy(row)
        item.update(id=f'validation-{i}',family_id=f'validation-{i}',text=f'Validation fixture {i}',split='val')
        validation.append(item)
    parts.update(val=validation,train=[{**validation[0],'id':'train','family_id':'train','text':'Training fixture','split':'train'}])
    data,out = tmp_path/'data',tmp_path/'out'
    data.mkdir();out.mkdir()
    contract={'helper_sha256':W.digest(ROOT/'scripts/wording_batched_evaluation.py'),
        'method':'left_padded_greedy_batch_v1','batch_size':8,'validation_parity_rows':16,
        'audit_limit':512,'fallback':'original_sequential_on_any_parity_mismatch'}
    W.atomic_json(data/'release.json',{'evaluation_contract':contract})
    identity={'tiny_fixture':False,'dataset_release_sha256':W.digest(data/'release.json'),'config':{'seed':20261008}}
    W.atomic_json(out/'training_report.json',{'identity':identity,'pretrained_base_loaded':True,
        'steps':576,'required_steps':576,'training_rows':18432,'examples_seen':18432})
    events=[]
    def read_split(_data,name):
        events.append('read:'+name)
        return parts[name]
    def sequential(_model,_tokenizer,rows,_device):
        events.append('sequential:'+rows[0]['split'])
        return [W.canonical(r['target']) for r in rows]
    def batched(_model,_tokenizer,rows,_device,_batch_size):
        events.append('batch:'+rows[0]['split'])
        values=[W.canonical(r['target']) for r in rows]
        if mismatch and rows[0]['split']=='val':values[0]='{}'
        return values
    monkeypatch.setattr(W,'verify_adapter',lambda *_a,**_k:{'identity':identity,'artifact_hashes':{}})
    monkeypatch.setattr(W,'load_adapter',lambda *_a,**_k:(None,None))
    monkeypatch.setattr(W,'read_split',read_split)
    monkeypatch.setattr(W,'predictions',sequential)
    monkeypatch.setattr(B,'predictions_batched',batched)
    result=B.evaluate(data,out,device='cpu')
    assert result['passed'] is True
    assert result['audit']['rows']==512
    assert result['challenge']['rows']==96
    assert len(result['audit_example_ids'])==512
    assert len(result['challenge_example_ids'])==96
    assert events.index('batch:val') < events.index('read:audit')
    expected='sequential' if mismatch else 'batch'
    assert f'{expected}:audit' in events and f'{expected}:challenge' in events
    assert result['generation_execution']['exact_output_matches']==(15 if mismatch else 16)
    expected_gates=W.promotion_gates(result['audit'],result['challenge'])
    expected_gates.update({'runtime_'+key:value for key,value in W.promotion_gates(result['runtime_audit'],result['runtime_challenge']).items()})
    assert result['gates']==expected_gates
    assert all(expected_gates.values())
