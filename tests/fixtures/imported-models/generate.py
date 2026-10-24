"""Deterministic authored interoperability fixtures; Python standard library only."""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import struct
import zlib

ROOT = Path(__file__).resolve().parent


def png() -> bytes:
    """2×2 opaque RGBA image with four distinct authored colour samples."""
    def chunk(kind: bytes, content: bytes) -> bytes:
        return struct.pack(">I", len(content)) + kind + content + struct.pack(
            ">I", zlib.crc32(kind + content) & 0xFFFFFFFF
        )

    pixels = bytes([230, 35, 45, 255, 35, 200, 80, 255,
                    35, 70, 230, 255, 240, 200, 40, 255])
    scanlines = b"\0" + pixels[:8] + b"\0" + pixels[8:]
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 6, 0, 0, 0)) + chunk(
        b"IDAT", zlib.compress(scanlines, level=9)
    ) + chunk(b"IEND", b"")


def build() -> None:
    # Each face owns its normal and UV seam. Winding faces outward.
    faces = [
        ([(-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)], (0, 0, 1)),
        ([(1, -1, -1), (-1, -1, -1), (-1, 1, -1), (1, 1, -1)], (0, 0, -1)),
        ([(1, -1, 1), (1, -1, -1), (1, 1, -1), (1, 1, 1)], (1, 0, 0)),
        ([(-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1)], (-1, 0, 0)),
        ([(-1, 1, 1), (1, 1, 1), (1, 1, -1), (-1, 1, -1)], (0, 1, 0)),
        ([(-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)], (0, -1, 0)),
    ]
    positions, normals, uv, colours, indices = [], [], [], [], []
    for face_index, (vertices, normal) in enumerate(faces):
        for index, vertex in enumerate(vertices):
            positions.extend(vertex)
            normals.extend(normal)
            uv.extend([(0, 0), (1, 0), (1, 1), (0, 1)][index])
            # Linear colour multipliers, deliberately not all-white.
            colours.extend([(1, .55, .7, 1), (.6, 1, .75, 1),
                            (.7, .65, 1, 1), (1, .9, .5, 1)][index])
        offset = face_index * 4
        indices.extend(offset + index for index in [0, 1, 2, 0, 2, 3])

    data = bytearray()
    views = []

    def append(raw: bytes, target: int | None = None) -> int:
        while len(data) % 4:
            data.append(0)
        view = {"buffer": 0, "byteOffset": len(data), "byteLength": len(raw)}
        if target:
            view["target"] = target
        views.append(view)
        data.extend(raw)
        return len(views) - 1

    for values in [positions, normals, uv, colours]:
        append(struct.pack(f"<{len(values)}f", *values), 34962)
    append(struct.pack(f"<{len(indices)}H", *indices), 34963)
    geometry = bytes(data)
    image = png()
    doc = {
        "asset": {"version": "2.0", "generator": "VISCERA authored import QA fixture v1"},
        "scene": 0,
        "scenes": [{"name": "Interchange QA", "nodes": [0]}],
        "nodes": [
            {"name": "fixture-root", "children": [1, 2], "translation": [.2, .1, -.15],
             "rotation": [0, math.sin(.15), 0, math.cos(.15)]},
            {"name": "left-cube", "mesh": 0, "translation": [-1.4, 0, 0], "scale": [.6, .85, .6]},
            {"name": "right-cube", "mesh": 1, "translation": [1.4, .2, 0], "scale": [.7, .55, .8]},
        ],
        "meshes": [
            {"name": name, "primitives": [{
                "attributes": {"POSITION": 0, "NORMAL": 1, "TEXCOORD_0": 2, "COLOR_0": 3},
                "indices": 4, "material": 0, "mode": 4,
            }]} for name in ["shared-left", "shared-right"]
        ],
        "materials": [{
            "name": "Reference PBR colour",
            "pbrMetallicRoughness": {"baseColorFactor": [.8, .9, 1, 1],
                                   "baseColorTexture": {"index": 0},
                                   "metallicFactor": .15, "roughnessFactor": .55},
            "doubleSided": False, "alphaMode": "OPAQUE",
        }],
        "textures": [{"source": 0, "sampler": 0}],
        "samplers": [{"magFilter": 9728, "minFilter": 9728, "wrapS": 10497, "wrapT": 10497}],
        "images": [{"uri": "quadrants.png", "mimeType": "image/png"}],
        "buffers": [{"uri": "colour-pbr-multipart.bin", "byteLength": len(geometry)}],
        "bufferViews": views,
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": 24, "type": "VEC3",
             "min": [-1, -1, -1], "max": [1, 1, 1]},
            {"bufferView": 1, "componentType": 5126, "count": 24, "type": "VEC3"},
            {"bufferView": 2, "componentType": 5126, "count": 24, "type": "VEC2"},
            {"bufferView": 3, "componentType": 5126, "count": 24, "type": "VEC4"},
            {"bufferView": 4, "componentType": 5123, "count": 36, "type": "SCALAR"},
        ],
    }
    outputs = {
        "quadrants.png": image,
        "colour-pbr-multipart.bin": geometry,
        "colour-pbr-multipart.gltf": (json.dumps(doc, indent=2) + "\n").encode(),
    }
    image_view = append(image)
    doc["images"] = [{"bufferView": image_view, "mimeType": "image/png"}]
    doc["buffers"] = [{"byteLength": len(data)}]
    encoded = json.dumps(doc, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    data += b"\0" * (-len(data) % 4)
    outputs["colour-pbr-multipart.glb"] = (
        struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(encoded) + 8 + len(data))
        + struct.pack("<II", len(encoded), 0x4E4F534A) + encoded
        + struct.pack("<II", len(data), 0x004E4942) + data
    )
    obj = ["mtllib colour-cube.mtl", "o authored-colour-cube"]
    for index in range(24):
        obj.append("v " + " ".join(str(v) for v in positions[index * 3:index * 3 + 3]))
    for index in range(24):
        obj.append("vt " + " ".join(str(v) for v in uv[index * 2:index * 2 + 2]))
    for index in range(24):
        obj.append("vn " + " ".join(str(v) for v in normals[index * 3:index * 3 + 3]))
    obj.append("usemtl PaintedPBRFallback")
    for offset in range(0, len(indices), 3):
        obj.append("f " + " ".join(f"{i+1}/{i+1}/{i+1}" for i in indices[offset:offset + 3]))
    outputs["colour-cube.obj"] = ("\n".join(obj) + "\n").encode()
    outputs["colour-cube.mtl"] = (
        "newmtl PaintedPBRFallback\nKd 0.8 0.9 1.0\nKs 0.1 0.1 0.1\nNs 24\n"
        "d 1.0\nillum 2\nmap_Kd quadrants.png\n"
    ).encode()
    ascii_stl = ["solid authored_cube"]
    binary_stl = bytearray(b"VISCERA authored cube; no colour/material promise".ljust(80, b"\0"))
    binary_stl.extend(struct.pack("<I", len(indices) // 3))
    for offset in range(0, len(indices), 3):
        triangle = indices[offset:offset + 3]
        normal = normals[triangle[0] * 3:triangle[0] * 3 + 3]
        ascii_stl.append("  facet normal " + " ".join(map(str, normal)))
        ascii_stl.append("    outer loop")
        coordinates = []
        for index in triangle:
            vertex = positions[index * 3:index * 3 + 3]
            coordinates.extend(vertex)
            ascii_stl.append("      vertex " + " ".join(map(str, vertex)))
        ascii_stl.extend(["    endloop", "  endfacet"])
        binary_stl.extend(struct.pack("<12fH", *normal, *coordinates, 0))
    ascii_stl.append("endsolid authored_cube")
    outputs["cube-ascii.stl"] = ("\n".join(ascii_stl) + "\n").encode()
    outputs["cube-binary.stl"] = bytes(binary_stl)
    for name, content in outputs.items():
        (ROOT / name).write_bytes(content)
    manifest = {
        "schema": "viscera.authored-import-fixtures/v1",
        "source": "Original mathematical cube and 2×2 colour image authored for tests; no external model data.",
        "generator": "generate.py",
        "generator_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "expected": {"gltf_meshes": 2, "gltf_vertices_per_mesh": 24, "gltf_triangles_per_mesh": 12,
                     "shared_materials": 1, "texture_dimensions": [2, 2], "vertex_colour_components": 4,
                     "hierarchy_nodes": 3, "stl_triangles": 12},
        "files": [{"path": name, "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
                  for name, content in sorted(outputs.items())],
    }
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    build()
