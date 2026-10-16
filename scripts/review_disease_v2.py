"""Full-source boundary QA and orthographic source-triangle review, not photo realism."""

import argparse
import hashlib
import json
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from viscera_core.atlas import CONTROL_NAMES, list_templates
from viscera_core.atlas_disease_v2 import (
    PROFILES,
    DiseaseSpecV2,
    _source_cache,
    apply_disease_color,
    disease_field,
    mesh_qa,
    transform_points,
)
from viscera_core.atlas_materials import make_recipe, sample_material
from viscera_core.atlas_scene import get_template
from viscera_core.atlas_surface_scene import material_regions


def draw_mesh(t, v, rgb, size=440):
    # Every source triangle is projected and painter-sorted; this is a neutral
    # shape review, with fixed camera/scale across mild/severe, not a PBR image.
    eye = np.array([0.65, 0.35, 1.0])
    eye /= np.linalg.norm(eye)
    right = np.cross([0, 1, 0], eye)
    right /= np.linalg.norm(right)
    up = np.cross(eye, right)
    basis = np.array([right, up, eye])
    p = v @ basis.T
    rest = t.vertices_mm @ basis.T
    center = (rest.min(0) + rest.max(0)) / 2
    scale = (size - 38) / (np.ptp(rest[:, :2], axis=0).max() * 1.6)
    xy = (p[:, :2] - center[:2]) * scale
    xy[:, 1] *= -1
    xy += size / 2
    faces = t.faces
    tri = v[faces]
    normal = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    normal /= np.maximum(np.linalg.norm(normal, axis=1)[:, None], 1e-30)
    light = np.array([-0.25, 0.7, 1.0])
    light /= np.linalg.norm(light)
    illumination = 0.28 + 0.72 * np.abs(normal @ light)
    color = np.clip(rgb[faces].mean(1) * illumination[:, None], 0, 1)
    image = Image.new("RGB", (size, size), (239, 242, 242))
    draw = ImageDraw.Draw(image)
    for index in np.argsort(p[faces, 2].mean(1)):
        draw.polygon(
            [tuple(x) for x in xy[faces[index]]], fill=tuple((color[index] * 255).astype(int))
        )
    return image


def main():
    pa = argparse.ArgumentParser()
    pa.add_argument("--templates", type=Path, required=True)
    pa.add_argument("--out", type=Path, required=True)
    args = pa.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    records = []
    started = time.time()
    seen = set()
    sheets = []
    font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 15)
    for entry in list_templates(args.templates):
        t = get_template(args.templates, entry["template_id"])
        cache = _source_cache(t)
        profiles = [p for p in PROFILES.values() if p["supported"] and p["organ"] == entry["organ"]]
        make_image = entry["organ"] not in seen
        seen.add(entry["organ"])
        if make_image:
            canvas = Image.new("RGB", (440 * 5, 1040), "white")
            draw = ImageDraw.Draw(canvas)
            draw.text(
                (12, 8),
                entry["organ"].upper()
                + " | mild .20 (top), severe1.00 (bottom) | fixed camera/scale | synthetic external designs",
                font=font,
                fill="black",
            )
            material = make_recipe(entry["organ"], "balanced", 27)
            color = sample_material(material, t.vertices_mm, region_ids=material_regions(t))[
                "rgb_srgb"
            ]
        for pi, profile in enumerate(profiles):
            for case in range(6):
                severity = [0.1, 0.2, 0.55, 1.0, 1.0, 1.0][case]
                spec = DiseaseSpecV2(
                    profile_id=profile["id"],
                    severity=severity,
                    size=[0.1, 0.6, 0.6, 0.6, 1.0, 1.0][case],
                    count=8,
                    spread=1.0,
                    seed=[3, 27, 49, 27, 103, 191][case],
                    location=[0.25, 0.15, 0.8] if case < 5 else [-0.65, -0.7, -0.5],
                )
                controls = (
                    dict.fromkeys(CONTROL_NAMES, 0.0)
                    if case < 4
                    else dict(
                        zip(
                            CONTROL_NAMES,
                            [0.9, -0.9, 0.9, -0.9, 0.9, -0.9, 0.9]
                            if case == 4
                            else [-0.9, 0.9, -0.9, 0.9, -0.9, 0.9, -0.9],
                        )
                    )
                )
                try:
                    field = disease_field(t, spec, controls)
                except ValueError as exc:
                    records.append(
                        {
                            "template_id": entry["template_id"],
                            "profile_id": profile["id"],
                            "case": case,
                            "recipe": spec.model_dump(mode="json"),
                            "controls": controls,
                            "status": "rejected_by_renderer_guard",
                            "reason": str(exc),
                            "qa": {"passed": False, "normal_turns_over_90_degrees": 0},
                        }
                    )
                    continue
                v = transform_points(t, controls, t.vertices_mm, field, tree=cache["tree"])
                base = transform_points(t, controls, t.vertices_mm, None)
                qa = mesh_qa(t, v, field, controls)
                delta = np.linalg.norm(v - base, axis=1)
                record = {
                    "template_id": entry["template_id"],
                    "profile_id": profile["id"],
                    "case": case,
                    "recipe": spec.model_dump(mode="json"),
                    "controls": controls,
                    "qa": qa,
                    "max_displacement_mm": float(delta.max()),
                    "rms_displacement_mm": float(np.sqrt(np.mean(delta**2))),
                    "realized_sites": field["realized_sites"],
                    "requested_sites": field["requested_sites"],
                    "applied_displacement_fraction": field["applied_displacement_fraction"],
                    "effective_morphology_strength": field["effective_morphology_strength"],
                    "strength_capacity": field["discrete_guard"]["strength_capacity"],
                    "geometry_sha256": hashlib.sha256(
                        v.astype("<f8").tobytes() + t.faces.astype("<i8").tobytes()
                    ).hexdigest(),
                }
                records.append(record)
                if make_image and case in (1, 3):
                    image = draw_mesh(t, v, apply_disease_color(color, t.vertices_mm, field))
                    y = 65 if case == 1 else 570
                    canvas.paste(image, (pi * 440, y))
                    draw.text(
                        (pi * 440 + 10, y - 24),
                        profile["id"].replace(entry["organ"] + "-", ""),
                        font=font,
                        fill="black",
                    )
                    draw.text(
                        (pi * 440 + 10, y + 417),
                        f"max {delta.max():.2f}mm | RMS {np.sqrt(np.mean(delta**2)):.2f}mm | sites {field['realized_sites']}",
                        font=font,
                        fill="black",
                    )
                    draw.text(
                        (pi * 440 + 10, y + 438),
                        f"strength {severity:.2f} -> {field['effective_morphology_strength']:.3f} | cap {field['discrete_guard']['strength_capacity']:.3f}",
                        font=font,
                        fill="black",
                    )
        if make_image:
            path = args.out / (entry["organ"] + ".jpg")
            canvas.save(path, quality=92)
            sheets.append(
                {"path": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
            )
        print(
            entry["template_id"],
            len(records),
            "cases",
            round(time.time() - started, 1),
            "s",
            flush=True,
        )
        (args.out / "progress.json").write_text(
            json.dumps(
                {"cases": len(records), "failures": sum(not r["qa"]["passed"] for r in records)}
            )
        )
    report = {
        "schema": "disease-v2-full-source-boundary-review",
        "cases": len(records),
        "passed": all(r["qa"]["passed"] for r in records),
        "failures": [r for r in records if not r["qa"]["passed"]],
        "normal_rotation_diagnostic_cases": sum(
            r["qa"]["normal_turns_over_90_degrees"] > 0 for r in records
        ),
        "clinical_validation": "NOT_RUN",
        "self_intersection": "NOT_RUN",
        "image_method": "all original triangles, fixed orthographic camera and scale, painter visibility and neutral Lambert shading; not PBR or clinical realism validation",
        "sheets": sheets,
        "records": records,
    }
    (args.out / "qa.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
