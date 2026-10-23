"""Export the deterministic text compiler ("Anatomy with words", POST /api/atlas/compile) for the browser port.

    .venv/bin/python scripts/export_text_compiler_web.py            # tables + fixture
    .venv/bin/python scripts/export_text_compiler_web.py --tables   # tables only

Writes apps/studio/public/models/text-compiler/tables.json — everything apps/studio/src/atlasTextCompiler.ts reads
that is data rather than code: Python's own Unicode classes (re's \\w, \\d and \\s, str.lower with its final-sigma
context, the decimal digits float() and int() accept), the disease-v2 profile fields the guards and grammars read,
the alias tables in their dict order (viscera_core.atlas_semantic PROFILE_ALIASES and ORGAN_ALIASES,
viscera_core.atlas_disease_text_v2 ALIASES), the template metadata the compilers read from the versioned library
(templates-v3: organ, sex label, side, control limits, normalisation, artifact hash, vertex count), the catalogue's
organ order, the material presets and the disease-v2 recipe defaults — and apps/studio/src/__fixtures__/
text-compiler.json: the route's own answers (services.api.atlas.compile, called in-process exactly as FastAPI calls
it for a disease-v2 spec without a trained wording bundle) for a stratified selection of the tracked wording phrases
and of adversarial phrases, on contexts that cover healthy and diseased specs, non-default and photo-derived
surface recipes, clay and source appearance, shape controls at their bounds and the two repaired templates.
atlasTextCompiler.test.ts replays the fixture and compares with the running API.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import random
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "py"), str(ROOT)]

import pydantic  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from fastapi.encoders import jsonable_encoder  # noqa: E402
from services.api import atlas as route  # noqa: E402
from viscera_core import atlas_disease_text_v2 as disease_text  # noqa: E402
from viscera_core import atlas_disease_v2 as disease_v2  # noqa: E402
from viscera_core import atlas_materials as materials  # noqa: E402
from viscera_core import atlas_scene  # noqa: E402
from viscera_core import atlas_semantic as semantic  # noqa: E402
from viscera_core import atlas_text  # noqa: E402

FORMAT = "viscera-atlas-text-compiler-web-1"
OUT = ROOT / "apps/studio/public/models/text-compiler"
FIXTURE = ROOT / "apps/studio/src/__fixtures__/text-compiler.json"
TEMPLATES = route.versioned_template_root(route.template_root())
SOURCES = [
    "services/api/atlas.py", "services/api/atlas_wording_model.py",
    "py/viscera_core/atlas_semantic.py", "py/viscera_core/atlas_disease_text_v2.py", "py/viscera_core/atlas_disease_text.py",
    "py/viscera_core/atlas_material_text.py", "py/viscera_core/atlas_text.py", "py/viscera_core/atlas_scene.py",
    "py/viscera_core/atlas_surface_scene.py", "py/viscera_core/atlas_disease_scene_v2.py", "py/viscera_core/atlas_disease_v2.py",
    "py/viscera_core/atlas_materials.py", "py/viscera_core/reference_color.py", "py/viscera_core/atlas.py",
    "py/viscera_core/disease_profiles_v2.json",
]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ---------------------------------------------------------------------------------------------- Python's Unicode
def _ranges(predicate) -> list[list[int]]:
    out: list[list[int]] = []
    start = None
    for cp in range(0x110000):
        ok = predicate(cp)
        if ok and start is None:
            start = cp
        elif not ok and start is not None:
            out.append([start, cp - 1])
            start = None
    if start is not None:
        out.append([start, 0x10FFFF])
    return out


def unicode_tables() -> dict[str, Any]:
    """What CPython's re (str patterns) and str methods decide per code point, read from CPython itself."""
    word, digit, space = re.compile(r"\w"), re.compile(r"\d"), re.compile(r"\s")
    surrogate = range(0xD800, 0xE000)
    w = _ranges(lambda cp: word.fullmatch(chr(cp)) is not None)
    d = _ranges(lambda cp: digit.fullmatch(chr(cp)) is not None)
    s = _ranges(lambda cp: space.fullmatch(chr(cp)) is not None)
    if s != _ranges(lambda cp: chr(cp).isspace()):
        raise SystemExit("re's \\s and str.isspace disagree: str.strip would need its own table")
    zeros = [cp for cp in range(0x110000) if digit.fullmatch(chr(cp)) and unicodedata.decimal(chr(cp), -1) == 0]
    for lo, hi in d:   # every \d character is zero + its decimal value for the nearest zero below it
        for cp in range(lo, hi + 1):
            zero = max(z for z in zeros if z <= cp)
            if unicodedata.decimal(chr(cp)) != cp - zero or int(chr(cp)) != cp - zero:
                raise SystemExit(f"U+{cp:04X}: its decimal value is not its offset from a zero digit")
    lower = [[cp, [ord(c) for c in chr(cp).lower()]] for cp in range(0x110000)
             if cp not in surrogate and cp != 0x3A3 and chr(cp).lower() != chr(cp)]
    # str.lower maps U+03A3 by context (handle_capital_sigma): final when a cased letter precedes it across
    # case-ignorable characters and none follows. Both properties, read back from str.lower itself:
    # 'A'+c+'Σ' is final iff c is case-ignorable or cased; 'AΣ'+c iff c is case-ignorable or not cased;
    # c+'Σ' iff c is cased and not case-ignorable (the cased test only ever sees non-ignorable characters).
    ignorable = _ranges(lambda cp: cp not in surrogate and ("A" + chr(cp) + "Σ").lower()[-1] == "ς"
                        and ("AΣ" + chr(cp)).lower()[1] == "ς")
    cased = _ranges(lambda cp: cp not in surrogate and (chr(cp) + "Σ").lower()[-1] == "ς")
    return {"python": platform.python_version(), "unicodedata": unicodedata.unidata_version,
            "word": w, "digit": d, "digit_zeros": zeros, "space": s, "lower": lower,
            "cased": cased, "case_ignorable": ignorable}


# ---------------------------------------------------------------------------------------------- the tables
def export_tables() -> dict[str, Any]:
    if TEMPLATES.resolve() != (ROOT / route.V2_TEMPLATES_DEFAULT).resolve():
        raise SystemExit(f"the route's versioned library is {TEMPLATES}, not {route.V2_TEMPLATES_DEFAULT}")
    library = atlas_scene.list_templates(TEMPLATES)
    templates = []
    for entry in library:
        meta = atlas_scene.get_template(TEMPLATES, entry["template_id"]).metadata
        if entry["organ"] != meta["organ"] or entry["control_limits"] != meta["control_limits"]:
            raise SystemExit(f"{entry['template_id']}: catalogue and metadata disagree")
        templates.append({
            "template_id": entry["template_id"], "organ": entry["organ"], "sex_label": entry.get("sex_label"),
            "laterality": entry.get("laterality"), "control_limits": meta["control_limits"],
            "normalization_mm": meta["normalization_mm"], "artifact_sha256": meta["artifact_sha256"],
            "vertex_count": meta["vertex_count"],
        })
    catalog = atlas_scene.catalog(TEMPLATES)
    profile_fields = ("id", "organ", "label", "pattern", "mechanism", "supported", "unavailable_reason")
    if set(semantic.PROFILES) != set(disease_v2.PROFILES) or any(
            semantic.PROFILES[k].get(f) != disease_v2.PROFILES[k].get(f) for k in semantic.PROFILES for f in profile_fields):
        raise SystemExit("atlas_semantic and atlas_disease_v2 read different disease-v2 profiles")
    defaults = {k: f.default for k, f in disease_v2.DiseaseSpecV2.model_fields.items() if k != "profile_id"}
    tables = {
        "format": FORMAT,
        "pydantic": pydantic.VERSION,
        "sources": {name: digest(ROOT / name) for name in SOURCES},
        "template_root": route.V2_TEMPLATES_DEFAULT,
        "unicode": unicode_tables(),
        # a field a profile lacks stays absent (the guards read profile.get(key, ""))
        "profiles": [{f: p[f] for f in profile_fields if f in p} for p in disease_v2._PROFILES],
        "profile_aliases": [[alias, pid] for alias, pid in semantic.PROFILE_ALIASES.items()],
        "organ_aliases": [[alias, organ] for alias, organ in semantic.ORGAN_ALIASES.items()],
        "disease_text_aliases": [[key, list(aliases)] for key, aliases in disease_text.ALIASES.items()],
        "geometry_aliases": [[alias, organ] for alias, organ in atlas_text.ALIASES.items()],
        "disease_defaults": {k: list(v) if isinstance(v, tuple) else v for k, v in defaults.items()},
        "material_organs": list(materials.PROFILES),
        "material_presets": {name: {c: preset[c] for c in materials.CONTROL_NAMES} for name, preset in materials.PRESETS.items()},
        "templates": templates,
        "catalog_organs": [{"id": o["id"], "templates": [t["id"] for t in o["templates"]]} for o in catalog["organs"]],
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "tables.json").write_text(json.dumps(tables, separators=(",", ":"), ensure_ascii=False) + "\n")
    print(f"tables.json: {(OUT / 'tables.json').stat().st_size} B ({len(templates)} templates, {len(tables['profiles'])} profiles, "
          f"{len(tables['profile_aliases'])} profile aliases, Python {tables['unicode']['python']}, Unicode {tables['unicode']['unicodedata']})")
    return tables



# ---------------------------------------------------------------------------------------------- the bundled references
def verify_bundled_references(public_copy: Path) -> None:
    """The browser measures a template on its bundled reference specimen's rest_positions; the route on templates-v3
    vertices_mm. Both must be the same float64 values, bit for bit, and the specimen bound to the same artifact."""
    import gzip

    import numpy as np

    folder = public_copy / "static/api/atlas/specimens"
    if not folder.is_dir():
        print(f"bundled references: {folder.relative_to(ROOT)} absent (build the public copy to check them)")
        return
    checked = 0
    for entry in atlas_scene.list_templates(TEMPLATES):
        template = atlas_scene.get_template(TEMPLATES, entry["template_id"])
        path = folder / f"{entry['template_id']}.json.gz"
        if not path.exists():
            raise SystemExit(f"{path.name}: not bundled")
        specimen = json.loads(gzip.decompress(path.read_bytes()))
        rest = np.asarray(specimen["scene"]["organs"][0].get("rest_positions", []), dtype=np.float64).reshape(-1, 3)
        vertices = np.asarray(template.vertices_mm, dtype=np.float64)
        if rest.shape != vertices.shape or not np.array_equal(rest.view(np.uint64), vertices.view(np.uint64)):
            raise SystemExit(f"{path.name}: rest_positions differ from {TEMPLATES.name} vertices_mm")
        if specimen["spec"].get("template_sha256") != template.metadata["artifact_sha256"]:
            raise SystemExit(f"{path.name}: bound to another artifact than {TEMPLATES.name}")
        checked += 1
    print(f"bundled references: all {checked} specimens carry the {TEMPLATES.name} vertices bit for bit")


# ---------------------------------------------------------------------------------------------- the route's answers
def route_result(text: str, spec: dict[str, Any]) -> dict[str, Any]:
    """POST /api/atlas/compile in-process: the request model FastAPI validates, the route function, the JSON FastAPI
    writes (an HTTPException or a refused request as {"http_status", "detail"})."""
    try:
        request = route.CompileRequest.model_validate({"text": text, "spec": spec})
    except pydantic.ValidationError as error:
        return {"http_status": 422, "detail": [e["msg"] for e in error.errors()]}
    try:
        result = route.compile(request)
    except HTTPException as error:
        return {"http_status": error.status_code, "detail": error.detail}
    return json.loads(json.dumps(jsonable_encoder(result), ensure_ascii=False, allow_nan=False))


ZERO = {name: 0.0 for name in atlas_text.CONTROL_NAMES}


def recipe(organ: str, preset: str = "balanced", seed: int = 42, **values: Any) -> dict[str, Any]:
    return materials.make_recipe(organ, preset, seed, **values).model_dump(mode="json")


def disease(profile_id: str, **values: Any) -> dict[str, Any]:
    return disease_v2.DiseaseSpecV2(profile_id=profile_id, **values).model_dump(mode="json")


def spec(template_id: str, *, seed: int = 42, controls: dict[str, float] | None = None, appearance: str = "tissue",
         material: dict[str, Any] | None = None, pathology: dict[str, Any] | None = None, bound: bool = False) -> dict[str, Any]:
    """A disease-v2 spec as the studio sends it (bound: the displayed spec, carrying its template and realized hashes)."""
    out: dict[str, Any] = {"renderer_version": "disease-v2", "template_id": template_id, "seed": seed,
                           "controls": {**ZERO, **(controls or {})}, "appearance": appearance}
    if material is not None:
        out["material"] = material
    if pathology is not None:
        out["disease"] = pathology
    if bound:
        out["template_sha256"] = atlas_scene.get_template(TEMPLATES, template_id).metadata["artifact_sha256"]
        out["realized_id"] = hashlib.sha256(json.dumps(out, sort_keys=True).encode()).hexdigest()
    return out


PHOTO_COLOUR = {"source_sha256": "3c" * 32, "mask_sha256": "a7" * 32, "organ": "spleen",
                "observed_srgb": [0.62, 0.31, 0.27], "strength": 0.75, "mode": "color"}
# name, spec, weight: light contexts carry the bulk; the large templates (heart-male 59k, pancreas 26k, brain 212k
# vertices) a few cases each, the two repaired templates (heart-male, bladder-male) among them
CONTEXTS: list[tuple[str, dict[str, Any], str]] = [
    ("liver-default", spec("hra-liver-female", material=recipe("liver")), "medium"),
    ("liver-male-cirrhosis-bound", spec("hra-liver-male", seed=7, controls={"scale_x": 0.2, "bend": -0.3, "twist": 0.1}, material=recipe("liver", "rich", 11, tint=0.3),
                                        pathology=disease("liver-cirrhosis", seed=7, severity=0.7, size=0.4, spread=0.6, irregularity=0.2, contrast=0.5, count=4), bound=True), "medium"),
    ("stomach-shaped", spec("bp3d-stomach-male", controls={"scale_y": -0.4, "taper": 0.3}, material=recipe("stomach")), "light"),
    ("stomach-distension", spec("bp3d-stomach-male", material=recipe("stomach"), pathology=disease("stomach-distension")), "light"),
    ("gallbladder-clay", spec("bp3d-gallbladder-male", controls={"scale_z": 0.5, "asymmetry": -0.2}, appearance="clay"), "light"),
    ("gallbladder-source-carcinoma", spec("bp3d-gallbladder-male", appearance="source", pathology=disease("gallbladder-carcinoma", seed=3)), "light"),
    ("kidney-cancer-soft", spec("hra-kidney-female-left", material=recipe("kidney", "soft", 5), pathology=disease("kidney-cancer", severity=0.9, count=2)), "light"),
    ("heart-male-repaired", spec("hra-heart-male", material=recipe("heart")), "heavy"),
    ("bladder-male-repaired-distension", spec("hra-urinary-bladder-male", controls={"scale_x": 0.1}, material=recipe("urinary-bladder"),
                                              pathology=disease("bladder-distension", severity=0.3)), "light"),
    ("spleen-photo-colour-at-bounds", spec("hra-spleen-female", controls={"scale_x": 1.0, "scale_y": -1.0, "twist": 1.0},
                                           material=recipe("spleen", reference_color=PHOTO_COLOUR), bound=True), "light"),
    ("pancreas-moist-pseudocyst", spec("hra-pancreas-female", controls={"bend": 0.5}, material=recipe("pancreas", "moist", 99), pathology=disease("pancreas-pseudocyst")), "heavy"),
    ("lung-emphysema-no-recipe", spec("hra-lung-female", pathology=disease("lung-emphysema", size=0.95, spread=0.05)), "medium"),
    ("brain-default", spec("hra-brain-female", material=recipe("brain")), "heavy"),
    ("small-intestine-crohn", spec("hra-small-intestine-male", material=recipe("small-intestine"), pathology=disease("small-intestine-crohn")), "medium"),
    ("large-intestine-clay", spec("hra-large-intestine-female", appearance="clay"), "medium"),
    ("heart-female-infarction", spec("hra-heart-female", material=recipe("heart"), pathology=disease("heart-infarction")), "medium"),
    ("kidney-male-right-shaped", spec("hra-kidney-male-right", controls={"scale_z": -0.25}, material=recipe("kidney")), "light"),
    ("spleen-male-recipe-at-bounds", spec("hra-spleen-male", material=recipe("spleen", wetness=0.95, tint=-0.95, pigment_contrast=0.05),
                                          pathology=disease("spleen-enlargement", severity=1.0, contrast=0.0)), "light"),
]


def tracked_phrases() -> list[str]:
    """The distinct phrases of the tracked wording files, in file order."""
    files = ["tests/fixtures/anatomy-wording-challenge.jsonl",
             "artifacts/wording-integration-2026-10-08/v3-independent-heldout/challenge.jsonl",
             "artifacts/wording-integration-2026-10-08/v3-independent-heldout/audit.jsonl",
             *[f"datasets/atlas/language-v1/{name}.jsonl" for name in ("pairs", "train", "val", "audit")]]
    seen: dict[str, None] = {}
    for name in files:
        for line in (ROOT / name).read_text().splitlines():
            if line.strip():
                seen.setdefault(json.loads(line)["text"], None)
    return list(seen)


def adversarial_phrases() -> list[str]:
    """Phrases written against the port: whitespace and length limits, non-ASCII digits, letters, spaces and
    punctuation, units and decimals, several and unreachable dimensions, contradictions and repeats, resets,
    appearances, every disease profile name and alias, health and negated wording, clinical refusals."""
    out = ["", " ", "\t", "\n\n", "\u3000", "\u00a0", "\u2028", "\x1c", "\ufeff", "\x00wider", "make it wider \ud800", "\udc00", "a" * 4000, "a" * 4001, "x" * 3999 + " ",
           "😀" * 4000, "😀" * 4001, "wider " * 666, "make it " + "very " * 1000 + "wider", "?", "...", "!!!", "please", "make it", "5%", "liver",
           "wider.", "wider!", "WIDER!!!", "make it wider, please.", "Make the liver 5% WIDER", "make it slightly wider", "a little taller",
           "somewhat healthier", "much healthier", "make it 5 % wider", "make it 5％ wider", "width ２００ mm", "width ٢٠٠ mm", "width २०० mm",
           "make it 10\u00a0% wider", "make it wider\u2028and taller", "make it wider\x1cplease", "make it wider\ufeff", "make it wider\u200b",
           "ΣΑΣ wider", "ΟΔΟΣ ΣΤΟ wider", "Σ", "make it ΟΔΟΣ.", "İstanbul wider", "naïve wider", "café au lait", "make the liver ﬁner",
           "😀 wider", "make it 5% wider 😀", "make it 😀 5% 😀 wider", "WIDTH 200 MM", "Wïdth 200 mm", "make it wider’s", "don’t make it wider",
           "make it 5 – 10% wider", "width −5 mm", "twist −0.5", "Twist 0.5", "TWIST 0.5", "bend\t0.3", "bend\n0.3",
           "width 20 cm", "width 2.5 cm", "width 25.5 mm", "height of 30mm", "height=30 mm", "depth: 3 cm", "20 cm wide", "35mm tall",
           "4.5 cm deep", "width 200.123456 mm", "width .5 cm", "width 0 mm", "width -5 mm", "width 5e2 mm", "width 1,5 cm", "width 24,5 mm",
           "width 0.00001 mm", "width 1999.9999 mm", "width 2000 mm", "width 2001 mm", "width 99999999999999999999 mm",
           "width 200 mm and height 150 mm", "20 cm wide, 15 cm tall and 10 cm deep", "width 200 mm, 5% taller", "5% wider and 3% taller and 2% deeper",
           "width 5 mm", "50% wider", "99% wider", "100% wider", "0% wider", "0.00001% wider", "12.34375% wider", "0.5% narrower", "3% flatter",
           "wider and narrower", "5% wider and 10% wider", "healthier and sicker", "wetter and drier", "make it wetter wetter", "tint 0.3 and tint 0.5",
           "twist 0.2 twist 0.3", "clay and source appearance", "cirrhosis and hcc", "healthy cirrhosis", "larger and smaller", "taller, shorter",
           "reset", "reset the shape", "original", "reference shape", "undeformed", "reset disease", "restore the normal", "return to baseline",
           "clear pathology", "disease-free", "disease free", "normal", "normalize it", "healthy", "baseline", "clear disease and 5% wider",
           "healthy and width 200 mm", "clear disease, width 60 mm", "remove the disease", "remove pathology appearance",
           "clay", "source", "tissue", "clay appearance", "source appearance and wider", "tissue appearance and wetter", "balanced surface",
           "soft texture preset", "rich material", "moist surface", "soft surface and drier", "clay and wetter", "clay appearance and larger",
           "source and bigger", "clay and 5% wider", "source appearance, twist 0.2", "tissue and 3% taller",
           "healthier", "slightly healthier", "20% healthier", "healthier by 30%", "less diseased", "more diseased", "sicker", "worse", "better",
           "improved", "recovering", "less healthy", "more healthy", "less severe", "more severe", "milder", "less pathological", "unhealthier",
           "96% healthier", "0% healthier", "95% healthier", "10% sicker", "a little sicker", "much worse", "less sick", "more unhealthy",
           "not wider", "don't make it wider", "do not change the material", "never make it taller", "without changing the shape",
           "keep the disease unchanged and make it wider", "preserve the texture and make it wetter", "don't change the width but make it taller",
           "no disease", "except the color", "do not change the shape and make it healthier", "keep the shape the same, healthier",
           "preserving its geometry make it wetter", "leave the colour alone and make it 5% wider", "don't make it healthier",
           "severity 0.8", "severity to 1.5", "severity -0", "count 3", "count 2.5", "count 9", "lesion count 4", "site count 0", "spread 0.2",
           "contrast 0.9", "irregularity: 0.3", "disease seed 7", "disease seed 1.5", "disease seed 4294967296", "morphology strength 0.4",
           "region size 0.6", "lesion size 50%", "size 0.3", "count three", "severity 0.5 and count 2 and spread 0.4", "pigment contrast 0.3 and contrast 0.5",
           "tint 0.5", "tint -1", "tint 2", "pigment contrast 0.3", "mottle scale 20 mm", "mottle scale 1", "wetness 1", "fine detail 0",
           "structure strength 0.75", "texture seed 12", "surface seed 3.5", "warmer", "cooler", "redder", "more mottled", "less mottling",
           "more fine detail", "more tissue grain", "glossier", "more matte", "less red", "more moist", "warmer and wetter", "tint 0.5 and warmer",
           "bend 0.5", "twist -0.3", "taper 1", "asymmetry 0.25", "scale_x 0.4", "scale_y = -0.2", "bend: 1.5", "bend -0", "more bent",
           "less twisted", "more tapered", "less asymmetric", "bend 1e-5", "bend 0.00001", "scale_x 0.3 and width 200 mm", "twist 1 and more twisted",
           "the liver", "the male liver", "female heart", "left kidney", "right kidney", "the male kidney left", "lungs", "colon", "small bowel",
           "the brain", "the bladder 5% wider", "the liver and the kidney", "the female male liver", "the left right kidney", "male", "female",
           "the female liver 5% wider", "the kidney, width 60 mm", "the stomach with cirrhosis", "the heart wetter",
           "resect the tumor", "remove the gallbladder", "cut", "biopsy", "stage 3", "grade 2", "child-pugh", "child pugh", "blood flow",
           "stiffness 5 kpa", "make it bleed", "clone it", "split", "hollow", "tumor 20 mm", "20 mm cyst", "lesion of 5 mm", "cyst diameter 2 cm",
           "larger tumors", "smaller cysts", "tumor 20% larger", "cysts 10% smaller", "lesions 15% bigger", "more prominent lesions",
           "less prominent nodules", "smaller lesions", "regions 5% larger",
           "reduce severity by 20%", "increase contrast by 10%", "decrease the spread by 5%", "increase lesion size by 30%", "20% less severe",
           "10% more contrast", "reduce the disease severity by 25%", "increase irregularity by 15%", "more irregular", "less widespread",
           "more localized", "less regular", "subtler color", "stronger disease color", "less nodular", "more swollen", "less scarred",
           "more nodular", "5% wider and healthier", "healthier and wetter", "healthier, 3% taller and warmer", "show cirrhosis and wetter",
           "make it look healthier please", "Please make this liver look healthier.", "can you make it a bit bigger", "make it larger",
           "make it smaller", "make it bigger and wetter", "bigger tumors and healthier", "larger lesions", "make the lesions smaller",
           "make it 5% wider; 3% taller", "make it wider: please", "wider while taller", "wider but taller", "wider also deeper",
           "wider with drier surface", "wider and and taller", "for me make it wider", "i want it wider", "make it wider for me"]
    profiles = disease_v2._PROFILES
    # every profile name and alias the two grammars know, alone and in context
    for alias in [*semantic.PROFILE_ALIASES, *[a for aliases in disease_text.ALIASES.values() for a in aliases]]:
        out.extend([alias, f"show {alias}", f"{alias} with severity 0.8", f"{alias}, count 5", f"{alias} and 5% wider", f"healthier {alias}"])
    for p in profiles:
        out.extend([p["label"], p["label"].upper(), f"make it {p['id']}"])
    seen: dict[str, None] = {}
    for text in out:
        seen.setdefault(text, None)
    return list(seen)


def python_numbers(rng: random.Random) -> list[list[Any]]:
    """[x, round(x, 8), format(x, "g"), repr(x)] for exact ties, tiny and huge values, signed zeros and noise."""
    values = [0.0, -0.0, 1.0, -1.0, 0.5, 2.5, 0.001953125, -0.001953125, 3 / 512, 12.34375, 123456.5, 1234565.0, 1234575.0,
              0.1, 0.2, 0.3, 1 / 3, 2 / 3, 1e-5, 1.5e-5, 1e-4, 9.99999e-5, 0.00012345678, 1e15, 1e16, 1.5e16, 123456789.0, 1e100,
              5e-324, 2.2250738585072014e-308, 1.7976931348623157e308, 0.95, 0.05, 0.15000000000000002, 0.30000000000000004,
              1e-7, 1e-8, 5e-9, 1.5e-9, 2.5e-9, 0.123456785, 0.123456775, 999999.5, 9999995.0, 0.000123456785, 100.0, 1e6, 1e-6]
    values += [rng.uniform(-1, 1) for _ in range(60)] + [rng.uniform(0, 2000) for _ in range(30)] + [10 ** rng.uniform(-12, 18) for _ in range(30)]
    values += [k / 512 for k in range(1, 40, 2)] + [k / 2 ** 20 for k in range(1, 30, 2)]
    return [[v, round(v, 8), format(v, "g"), repr(v)] for v in values]


def python_strings() -> list[list[str]]:
    """[s, s.lower(), s.strip()] for final sigma, special casing, Unicode spaces."""
    samples = ["ΣΑΣ", "ΟΔΟΣ ΣΤΟ ΣΠΙΤΙ", "Σ", "ΑΣ.", "Σ.Σ",
               "ΑΣ\u0301", "Α\u0301Σ", "İstanbul", "ẞ", "Ǆ", "ǅ", "Å", "Ω", "K", "ﬁ",
               "ΣΑΣ\U0001f600", " \t\n\x1c\x1d\x1e\x1f\x85\xa0\u1680\u2000\u200a\u2028\u2029\u202f\u205f\u3000x \ufeff",
               "\ufeffx\u200b", "ＡＢＣ", "MAKE IT WIDER"]
    return [[t, t.lower(), t.strip()] for t in samples]


def signature(result: dict[str, Any]) -> str:
    """The shape of an answer: status, policy, which fields it carries, its message with numbers and quoted words
    folded, the operation kinds of its plan."""
    if "http_status" in result:
        return f"http {result['http_status']}"
    message = re.sub(r"\d+(?:\.\d+)?(?:e[-+]\d+)?", "#", str(result.get("message", "")))
    message = re.sub(r"clarification: .*?\. No partial", "clarification: … No partial", message)
    message = re.sub(r"Prepared [a-z0-9-]+", "Prepared T", message)
    message = re.sub(r"input_value=.*?, input_type", "input_value=…, input_type", message)
    ops = sorted({(o["op"], o.get("field")) for o in result.get("semantic_plan", {}).get("operations", [])}, key=str)
    return json.dumps([result.get("status"), result.get("policy_version"), sorted(result), message[:160], ops], default=str)


def export_fixture(tables: dict[str, Any], target: int) -> None:
    """A stratified selection: every adversarial phrase on one rotating context, the tracked phrases on two, then at
    most a few cases per answer signature (status, policy, fields, message shape, operation kinds) up to `target`."""
    rng = random.Random(20261016)
    names = [name for name, _, _ in CONTEXTS]
    light = [i for i, (_, _, weight) in enumerate(CONTEXTS) if weight == "light"]
    medium = [i for i, (_, _, weight) in enumerate(CONTEXTS) if weight == "medium"]
    heavy = [i for i, (_, _, weight) in enumerate(CONTEXTS) if weight == "heavy"]
    tracked, adversarial = tracked_phrases(), adversarial_phrases()
    pool: list[tuple[str, int, str]] = []
    for k, text in enumerate(adversarial):
        pool.append((text, light[k % len(light)], "adversarial"))
        pool.append((text, (medium + light)[(k * 7 + 3) % (len(medium) + len(light))], "adversarial"))
    for k, text in enumerate(tracked):
        pool.append((text, light[(k * 5 + 1) % len(light)], "tracked"))
        if k % 3 == 0:
            pool.append((text, medium[k % len(medium)], "tracked"))
    shape_words = re.compile(r"wider|narrower|taller|shorter|deeper|flatter|larger|bigger|smaller|width|height|depth|\bmm\b|\bcm\b|clay|healthier|cirrhosis|twist|bend")
    heavy_texts = [t for t in tracked + adversarial if shape_words.search(t.lower()) and len(t) < 200]
    for k, text in enumerate(rng.sample(heavy_texts, 60)):
        pool.append((text, heavy[k % len(heavy)], "heavy"))
    print(f"fixture pool: {len(pool)} cases ({len(adversarial)} adversarial and {len(tracked)} tracked phrases, {len(CONTEXTS)} contexts)")
    results = []
    for n, (text, context, origin) in enumerate(pool):
        results.append((text, context, origin, route_result(text, CONTEXTS[context][1])))
        if n % 2000 == 1999:
            print(f"  {n + 1} answered")
    groups: dict[str, list[int]] = {}
    for i, (_, _, _, result) in enumerate(results):
        groups.setdefault(signature(result), []).append(i)
    # every heavy-template case and every request the route refuses outright (HTTP 422) are kept
    chosen: set[int] = {i for i, (_, _, origin, result) in enumerate(results) if origin == "heavy" or "http_status" in result}
    for members in groups.values():   # up to three of each signature
        chosen.update(rng.sample(members, min(3, len(members))))
    adversarial_cases = [i for i, (_, _, origin, _) in enumerate(results) if origin == "adversarial" and i not in chosen]
    chosen.update(rng.sample(adversarial_cases, min(len(adversarial_cases), max(0, target // 3 - len(chosen)))))
    rest = [i for i in range(len(results)) if i not in chosen]
    chosen.update(rng.sample(rest, max(0, min(len(rest), target - len(chosen)))))
    cases = [{"text": results[i][0], "context": results[i][1], "origin": results[i][2], "result": results[i][3]} for i in sorted(chosen)]
    library = atlas_scene.catalog(TEMPLATES)
    numbers = python_numbers(rng)
    for organ in library["organs"]:
        for template in organ["templates"]:
            template["normalization_mm"] = atlas_scene.get_template(TEMPLATES, template["id"]).metadata["normalization_mm"]
    fixture = {
        "format": FORMAT, "tables_sha256": digest(OUT / "tables.json"), "pydantic": pydantic.VERSION, "python": platform.python_version(),
        "route": "services.api.atlas.compile (disease-v2 spec, use_trained_language false, no wording bundle)",
        "library": {"renderer_version": "disease-v2", "organs": library["organs"], "controls": library["controls"]},
        "contexts": [{"name": name, "spec": s} for name, s, _ in CONTEXTS],
        "signatures": len(groups), "pool": len(pool), "cases": cases,
        # Python's own answers for the arithmetic and string semantics the port reimplements
        "python_numbers": numbers, "python_strings": python_strings(),
    }
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    # ASCII-escaped, so that a lone surrogate (a phrase the route refuses) survives as \\udXXX
    FIXTURE.write_text(json.dumps(fixture, separators=(",", ":")) + "\n")
    statuses: dict[str, int] = {}
    for case in cases:
        key = str(case["result"].get("status", case["result"].get("http_status")))
        statuses[key] = statuses.get(key, 0) + 1
    print(f"fixture: {len(cases)} cases of {len(groups)} answer signatures, {statuses}, {sum(1 for c in cases if c['context'] in heavy)} on heavy "
          f"templates → {FIXTURE.relative_to(ROOT)} ({FIXTURE.stat().st_size / 1e6:.2f} MB); contexts: {', '.join(names)}")



if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--tables", action="store_true", help="write the tables only")
    parser.add_argument("--cases", type=int, default=2600, help="fixture size")
    parser.add_argument("--public-copy", type=Path, default=ROOT / "public-copy", help="a built public copy whose references to check")
    args = parser.parse_args()
    exported = export_tables()
    verify_bundled_references(args.public_copy)
    if not args.tables:
        export_fixture(exported, args.cases)
