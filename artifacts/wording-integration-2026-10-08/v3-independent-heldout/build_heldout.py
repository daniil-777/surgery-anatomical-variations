"""Independently authored v3 language audit. Never reads model predictions.

Gold operations are written explicitly below. The frozen semantic validator is
used only to reject invalid gold, never to generate/repair target labels.
This is synthetic authoring, not a clinician-reviewed clinical benchmark.
"""
from __future__ import annotations
import copy
import hashlib
import json
import random
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / 'py'), str(ROOT / 'pipelines/train')]
from viscera_core import atlas_semantic as S

OUT = Path(__file__).resolve().parent
NEW = ROOT / 'datasets/atlas/wording-v3-coverage-2026-10-08'
OLD = Path('/tmp/viscera-wording-delivery-83a631a7/viscera-wording-training/dataset')
SEED_START, SEED_END = 3_100_000_000, 3_199_999_999
AUTHORING_SEED = 2026100831
O = S.operation


def canonical(v):
    return json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def normal(text):
    return re.sub(r'\s+', ' ', text.strip().casefold())


def plan(ops=(), status='accepted'):
    return S.make_plan(list(ops), status=status, message='Apply only the specified supported appearance edit; preserve other properties.' if status == 'accepted' else 'The request requires clarification or an unsupported operation; leave all properties unchanged.')


def health(value):
    return [O('disease_relative', 'severity', value), O('disease_relative', 'contrast', value)]


def context(organ, renderer, active, index):
    rng = random.Random(AUTHORING_SEED + index)
    profiles = sorted(pid for pid, p in S.PROFILES.items() if p['organ'] == organ and p['supported'] and pid in S.LEGACY_PROFILES and S.LEGACY_PROFILES[pid]['supported'])
    if not profiles:
        raise ValueError('No common supported external profile: ' + organ)
    material_seed = SEED_START + 2 * index
    disease_seed = material_seed + 1
    assert disease_seed <= SEED_END
    return {
        'organ': organ, 'renderer_version': renderer, 'appearance': 'tissue',
        'controls': {k: round(rng.uniform(-.25, .25), 3) for k in S.CONTROLS},
        'material': {'organ': organ, 'preset': 'balanced', 'seed': material_seed,
            'tint': round(rng.uniform(-.3,.3),3), 'wetness': round(rng.uniform(.25,.75),3),
            'pigment_contrast': round(rng.uniform(.25,.75),3), 'fine_detail': round(rng.uniform(.25,.75),3),
            'structure_strength': round(rng.uniform(.25,.75),3), 'mottle_scale_mm': round(rng.uniform(6,25),2)},
        'disease': {'profile_id': profiles[index % len(profiles)], 'seed': disease_seed,
            'severity': round(rng.uniform(.3,.75),3), 'contrast': round(rng.uniform(.3,.7),3),
            'size': round(rng.uniform(.3,.65),3), 'spread': round(rng.uniform(.2,.6),3),
            'irregularity': round(rng.uniform(.2,.6),3), 'count': 2 + index % 4,
            'location': [round(rng.uniform(.1,.9),3) for _ in range(3)]} if active else None,
    }


def audit_cases(organ, number):
    o = organ.replace('-', ' ')
    p = 7 + number % 9
    q = p / 100
    return [
        ('pathological-softening', f'Let this {o} become less pathological in appearance.', True, plan(health(-.2))),
        ('baseline-health', f'I would like this baseline {o} to look more healthy.', False, plan()),
        ('pathological-intensification', f'The {o} appearance should become more diseased.', True, plan(health(.2))),
        ('gentle-recovery', f'Give the {o} a somewhat healthier appearance.', True, plan(health(-.1))),
        ('quantified-pathology', f'For this {o} choose {p}% less diseased appearance.', True, plan(health(-q))),
        ('qualitative-width', f'I would like a wider {o} model.', False, plan([O('shape_relative','width',.05)])),
        ('gentle-height', f'The {o} should look a little shorter.', True, plan([O('shape_relative','height',-.03)])),
        ('quantified-depth', f'Give this {o} a {p}% deeper shape.', False, plan([O('shape_relative','depth',q)])),
        ('moisture-synonym', f'Let the {o} surface look more moist.', True, plan([O('material_relative','wetness',.15)])),
        ('matte-synonym', f'I would like the {o} material more matte.', False, plan([O('material_relative','wetness',-.15)])),
        ('pigment-wording', f'Give this {o} more mottling in its material.', True, plan([O('material_relative','pigment_contrast',.15)])),
        ('warmth-wording', f'Let this {o} material look warmer.', False, plan([O('material_relative','tint',.2)])),
        ('grain-wording', f'I would like more tissue grain on this {o}.', True, plan([O('material_relative','structure_strength',.15)])),
        ('clear-explicit-baseline', f'For the {o} appearance clear pathology to a baseline.', True, plan([O('disease_clear')])),
        ('mixed-health-depth-moisture', f'This {o} should look healthier and {p}% deeper and more glossy.', True, plan(health(-.2)+[O('shape_relative','depth',q),O('material_relative','wetness',.15)])),
        ('preserve-disease-material-edit', f'Keep the disease unchanged and make the {o} less mottled.', True, plan([O('preserve','disease'),O('material_relative','pigment_contrast',-.15)])),
        ('explicit-control', f'For the {o} shape set bend to 0.17.', False, plan([O('control_set','bend',.17)])),
        ('explicit-material', f'For the {o} material set wetness to 0.43.', True, plan([O('material_set','wetness',.43)])),
        ('ambiguous-repair', f'Improve the {o} until it seems right to me.', True, plan(status='clarify')),
        ('baseline-lesion-ambiguity', f'Make this {o} lesion size smaller by {p}%.', False, plan(status='clarify')),
        ('unsupported-physiology', f'Restore the {o} blood flow to a normal state.', True, plan(status='unsupported')),
        ('unsupported-mechanical-inference', f'Infer the {o} elasticity from its surface colour.', False, plan(status='unsupported')),
        ('unsupported-prognostic', f'Tell me the prognosis for the current {o} appearance.', True, plan(status='unsupported')),
        ('unsupported-function', f'Make this {o} regain its normal physiological function.', True, plan(status='unsupported')),
    ]


def challenge_cases(organ, number):
    o = organ.replace('-', ' ')
    p = 11 + number % 7
    q = p / 100
    return [
        ('compound-recovery-grain', f'For this {o} I want a little less pathological appearance and {p}% narrower width and less tissue grain.', True,
            plan(health(-.1)+[O('shape_relative','width',-q),O('material_relative','structure_strength',-.15)])),
        ('baseline-context-compound', f'For this {o} a more healthy appearance and more sheen would be ideal.', False,
            plan([O('material_relative','wetness',.15)])),
        ('conflicting-preservation', f'Preserve the disease while making this {o} more diseased.', True, plan(status='unsupported')),
        ('unmodelled-functional-request', f'Return the selected {o} to full physiological function and make it glossier.', True, plan(status='unsupported')),
    ]


def main():
    excluded = set()
    exclusion_sources = {}
    for path in [NEW/'train.jsonl', NEW/'val.jsonl', OLD/'audit.jsonl', OLD/'challenge.jsonl']:
        records = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]
        if not records:
            raise ValueError('Empty exclusion source ' + str(path))
        excluded.update(normal(r['text']) for r in records)
        exclusion_sources[str(path)] = {'sha256':digest(path), 'rows':len(records)}
    all_rows = {}
    index = 0
    for split, cases in [('audit',audit_cases),('challenge',challenge_cases)]:
        rows = []
        for oi, organ in enumerate(S.ORGANS):
            for ri, renderer in enumerate(('legacy','disease-v2')):
                for name,text,active,target in cases(organ,oi*2+ri):
                    ctx = context(organ,renderer,active,index)
                    family = f'v3-independent-{split}-{name}'
                    if normal(text) in excluded:
                        raise ValueError('Exact normalized text leakage: ' + text)
                    checked = S.validate_plan(target,ctx,text=text)
                    if S.plan_fingerprint(checked) != S.plan_fingerprint(target):
                        raise ValueError(canonical({'family':family,'text':text,'expected':target,'validated':checked}))
                    row = {'id':hashlib.sha256(canonical([split,family,text,ctx]).encode()).hexdigest(),
                        'split':split,'family_id':family,'text':text,'context':ctx,'target':copy.deepcopy(target),
                        'provenance':'independent_synthetic_explicit_gold_before_v3_training', 'clinical_review':'NOT_RUN'}
                    rows.append(row)
                    index += 1
        all_rows[split] = rows
        excluded.update(normal(r['text']) for r in rows)
    assert len(all_rows['audit']) >= 512 and len(all_rows['challenge']) >= 81
    assert sum(r['target']['status']!='accepted' for r in all_rows['audit']) > 50
    assert sum(r['target']['status']!='accepted' for r in all_rows['challenge']) > 8
    all_ids = [r['id'] for rows in all_rows.values() for r in rows]
    assert len(set(all_ids)) == len(all_ids)
    for split, rows in all_rows.items():
        (OUT/(split+'.jsonl')).write_text(''.join(canonical(r)+'\n' for r in rows))
    strings = sorted(set(normal(r['text']) for rows in all_rows.values() for r in rows))
    (OUT/'heldout-text-exclusions.json').write_text(canonical(strings)+'\n')
    declaration = {
        'format':'viscera-wording-independent-heldout-v3-1',
        'authoring':'independently agent-authored synthetic language; NOT human/clinical benchmark',
        'created_before_v3_training':True, 'model_outputs_used':False,
        'gold_method':'Explicit manually specified operations; frozen validator only rejects inconsistent targets; no parser-produced gold.',
        'limitations':['Template families share bounded semantics with training; exact strings, authoring family IDs, and recipe seeds are disjoint.',
            'Twelve organs and two renderers are covered; rows are synthetic perturbations, not independent patient observations.',
            'No claim of clinical accuracy or broad open-domain understanding.'],
        'generator_sha256':digest(Path(__file__)), 'generator_seed':AUTHORING_SEED,
        'reserved_recipe_seed_interval':[SEED_START,SEED_END],
        'exclusion_sources':exclusion_sources,
        'semantic_source_sha256':digest(ROOT/'py/viscera_core/atlas_semantic.py'),
        'artifact_hashes':{name:digest(OUT/name) for name in ['audit.jsonl','challenge.jsonl','heldout-text-exclusions.json']},
        'counts':{split:{'rows':len(rows),'families':len(set(r['family_id'] for r in rows)),
            'statuses':dict(Counter(r['target']['status'] for r in rows)),
            'organs':dict(Counter(r['context']['organ'] for r in rows)),
            'renderers':dict(Counter(r['context']['renderer_version'] for r in rows)),
            'disease_active':sum(r['context']['disease'] is not None for r in rows)} for split,rows in all_rows.items()},
        'unmodified_quality_gates_required':True,
    }
    (OUT/'declaration.json').write_text(canonical(declaration)+'\n')
    print(json.dumps(declaration,indent=2))


if __name__ == '__main__':
    main()
