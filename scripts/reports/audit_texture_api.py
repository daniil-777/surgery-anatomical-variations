"""Exercise real texture API routes and licensed photo inputs without publishing assets.

This is a reproducible correctness/appearance inspection panel, not a tissue-realism
benchmark. Photo tile construction is still an offline pipeline, not an HTTP endpoint.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import struct
from pathlib import Path

import numpy as np
import trimesh
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from viscera_core.atlas_materials import make_recipe

from pipelines.textures import photo_tiles
from services.api import atlas, reference_material

ROOT = Path(__file__).resolve().parents[2]


def pngs(raw: bytes):
    length = struct.unpack_from('<I', raw, 12)[0]
    header = json.loads(raw[20:20 + length])
    binary = raw[28 + length:]
    material = header['materials'][0]
    ids = {'base_color': material['pbrMetallicRoughness']['baseColorTexture']['index'],
           'orm': material['pbrMetallicRoughness']['metallicRoughnessTexture']['index'],
           'normal': material['normalTexture']['index']}
    images = {}
    for key, index in ids.items():
        image = header['images'][header['textures'][index]['source']]
        view = header['bufferViews'][image['bufferView']]
        start = view.get('byteOffset', 0)
        images[key] = binary[start:start + view['byteLength']]
    return header, images


def audit(out: Path, selected: list[str] | None = None, resolution: int = 512):
    out.mkdir(parents=True, exist_ok=True)
    app = FastAPI()
    app.include_router(atlas.router)
    app.include_router(reference_material.router)
    records, photos = [], []
    with TestClient(app) as client:
        def post(route, payload):
            response = client.post(route, json=payload)
            if response.status_code != 200:
                raise ValueError(f'{route}: {response.status_code}: {response.text[:400]}')
            return response

        catalog = client.get('/api/atlas/catalog').json()
        if selected is not None:
            known = {organ['id'] for organ in catalog['organs']}
            if len(set(selected)) != len(selected) or not set(selected) <= known:
                raise ValueError('Unknown or duplicate selected organ')
        for organ in catalog['organs']:
            identifier = organ['id']
            if selected is not None and identifier not in selected:
                continue
            template = organ['templates'][0]['id']
            geometry = set()
            signatures = set()
            last = None
            for seed in (0, 4294967295):
                for preset in ('balanced', 'rich', 'moist'):
                    recipe = make_recipe(identifier, preset, seed).model_dump(mode='json')
                    result = post('/api/atlas/generate', {'template_id': template, 'seed': 42, 'material': recipe}).json()
                    item = result['scene']['organs'][0]
                    colors = np.asarray(item['colors'])
                    assert np.isfinite(colors).all() and np.all((colors >= 0) & (colors <= 1))
                    geometry.add(result['scene']['metadata']['geometry_sha256'])
                    signatures.add(hashlib.sha256(colors.tobytes()).hexdigest())
                    replay = post('/api/atlas/generate', result['spec']).json()
                    assert replay == result
                    last = result
            assert len(geometry) == 1 and len(signatures) > 1
            raw = post('/api/atlas/export', {'spec': last['spec'], 'texture_resolution': resolution}).content
            header, maps = pngs(raw)
            folder = out / 'exports' / identifier
            folder.mkdir(parents=True, exist_ok=True)
            (folder / 'organ.glb').write_bytes(raw)
            stats = {}
            for name, data in maps.items():
                (folder / f'{name}.png').write_bytes(data)
                pixels = np.asarray(Image.open(io.BytesIO(data)).convert('RGB'))
                assert pixels.shape == (resolution, resolution, 3)
                stats[name] = {'sha256': hashlib.sha256(data).hexdigest(),
                               'channel_min': pixels.min(axis=(0, 1)).tolist(),
                               'channel_max': pixels.max(axis=(0, 1)).tolist()}
            mesh = trimesh.load(io.BytesIO(raw), file_type='glb', force='scene').to_geometry()
            positions = np.asarray(last['scene']['organs'][0]['positions']).reshape(-1, 3)
            np.testing.assert_allclose(mesh.extents, np.ptp(positions, axis=0) / 1000, rtol=3e-6)
            metadata = header['scenes'][0]['extras']
            assert metadata['geometry_sha256'] == next(iter(geometry))
            records.append({'organ': identifier, 'template_id': template, 'generated_cases': 6,
                            'distinct_vertex_color_payloads': len(signatures), 'deterministic_replays': 6,
                            'geometry_preserved': True, 'maps': stats, 'bake': metadata['material_bake']})
            print(f'API generation/replay/export PASS: {identifier}', flush=True)

        public = ROOT / 'apps/studio/public'
        sources = json.loads((public / 'body-reference/catalog.json').read_text())
        old_out = photo_tiles.OUT
        photo_tiles.OUT = out / 'photo-candidates'
        try:
            for source in sources['sources']:
                photo = public / 'body-reference' / Path(source['src']).name
                for region in source['regions']:
                    if selected is not None and region['organ'] not in selected:
                        continue
                    mask = public / 'body-reference' / f"{region['id']}-mask.png"
                    if not mask.is_file():
                        continue
                    payload = {'image_base64': base64.b64encode(photo.read_bytes()).decode(),
                               'organ': region['organ'], 'mask_base64': base64.b64encode(mask.read_bytes()).decode(),
                               'selection': region['selection']}
                    response = post('/api/atlas/reference-material/analyze', payload).json()
                    assert response['quality']['semantic_confidence'] is None
                    candidate = photo_tiles.build_tile(photo, mask, None, region['organ'],
                        {k: source.get(k) for k in ('id', 'credit', 'license', 'license_url', 'source_url')} |
                        {'region': region['id'], 'collection': 'DSAD'}, 512)
                    candidate['reference_color'] = response['reference_color']
                    candidate['api_accepted_pixels'] = response['quality']['accepted_pixels']
                    photos.append(candidate)
                    print(f"Photo region {region['id']}: {candidate.get('skipped', 'prepared')}", flush=True)
            publication = photo_tiles.publish_manifest(photos) if any('skipped' not in item for item in photos) else {'organs': {}}
            for item in publication['organs'].values():
                tile = np.asarray(Image.open(photo_tiles.OUT / item['files']['albedo']))
                gauss = np.asarray(Image.open(photo_tiles.OUT / item['files']['gauss']))
                lut = np.asarray(Image.open(photo_tiles.OUT / item['files']['lut']))[0]
                error = [float(np.mean(np.abs(lut[gauss[..., c], c].astype(float) - tile[..., c]))) for c in range(3)]
                item['diagnostic_lut_roundtrip_mae_8bit'] = error
                assert max(error) < 2.5
        finally:
            photo_tiles.OUT = old_out
    result = {'status': 'PASS', 'scope': 'Actual API correctness and a fixed appearance panel; no anatomical-realism qualification',
              'generated_cases': sum(r['generated_cases'] for r in records),
              'deterministic_replays': sum(r['deterministic_replays'] for r in records),
              'textured_glb_roundtrips': len(records), 'organs': records,
              'export_resolution': resolution,
              'photo_regions': len(photos), 'photo_publication': publication,
              'photo_http_generation_available': False,
              'limitations': ['Reference color API plus offline photo builder; no photo synthesis HTTP endpoint.',
                              'Photo detail remains a browser-only layer omitted by the legacy GLB exporter.',
                              'Export metrics include chart gutters and are not intrinsic tissue measurements.',
                              'No new training, independent clinical data, or realism threshold is asserted.']}
    (out / 'results.json').write_text(json.dumps(result, indent=2, allow_nan=False) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--organs', nargs='+')
    parser.add_argument('--resolution', type=int, choices=(512, 1024, 2048, 4096), default=512)
    args = parser.parse_args()
    audit(args.out.resolve(), args.organs, args.resolution)
