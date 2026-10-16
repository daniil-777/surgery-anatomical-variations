"""Fetch exact missing registered BP3D OBJ members without downloading 143 MB.

Uses byte ranges and verifies the ZIP CRC before saving unmodified source bytes.
Run with network access: python3 viscera/scripts/whole_scene/fetch_bp3d_supplement.py
"""
from __future__ import annotations

import hashlib
import io
import json
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'viscera/references/whole-scene/supplemental-bodyparts3d'
URL = 'https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/isa_BP3D_4.0_obj_99.zip'
SIZE = 142903898
IDS = ['FJ3477', 'FJ3478', 'FJ3577', 'FJ3578']


class RemoteZip(io.RawIOBase):
    def __init__(self):
        self.position = 0

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        self.position = offset if whence == 0 else self.position + offset if whence == 1 else SIZE + offset
        return self.position

    def read(self, size=-1):
        if size < 0:
            size = SIZE - self.position
        if not size:
            return b''
        request = urllib.request.Request(URL, headers={
            'Range': f'bytes={self.position}-{min(self.position + size - 1, SIZE - 1)}',
            'Accept-Encoding': 'identity',
        })
        with urllib.request.urlopen(request, timeout=40) as response:
            if response.status != 206:
                raise RuntimeError('Source server did not honor the exact byte range')
            data = response.read()
        self.position += len(data)
        return data


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    records = []
    with zipfile.ZipFile(RemoteZip()) as archive:
        for mesh_id in IDS:
            member = f'isa_BP3D_4.0_obj_99/{mesh_id}.obj'
            info = archive.getinfo(member)
            raw = archive.read(member)  # zipfile checks the source CRC32.
            (OUT / (mesh_id + '.obj')).write_bytes(raw)
            records.append({'id': mesh_id, 'member': member, 'bytes': len(raw),
                            'sha256': hashlib.sha256(raw).hexdigest(),
                            'zip_crc32_verified': hex(info.CRC)})
            print(mesh_id, len(raw), flush=True)
    (OUT / 'source-manifest.json').write_text(json.dumps({
        'source': 'BodyParts3D 4.0 official IS-A archive', 'source_url': URL,
        'source_archive_bytes': SIZE, 'license': 'CC-BY-4.0',
        'license_url': 'https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html',
        'attribution': 'BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International',
        'modifications': 'None; exact archive member source bytes.', 'records': records,
    }, indent=2) + '\n')


if __name__ == '__main__':
    main()
