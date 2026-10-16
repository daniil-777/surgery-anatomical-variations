"""Build a visual evidence PDF and searchable local gallery from captured atlas witnesses.

Requires reportlab 5.0.1 and Pillow. All pictures must be real browser captures;
this script arranges existing evidence and never synthesizes anatomy images.
"""

from __future__ import annotations

import argparse
import html
import io
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

from PIL import Image
from reportlab.lib import colors
from reportlab.lib.pagesizes import A3, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph

ORGANS = [
    "liver",
    "gallbladder",
    "stomach",
    "pancreas",
    "spleen",
    "kidney",
    "small-intestine",
    "large-intestine",
    "heart",
    "lung",
    "brain",
    "urinary-bladder",
]
NOTES = {
    "liver": (
        "Lobes, tapered margins, inferior surface and attached ligaments.",
        "The selected capsule and ligaments preserve the atlas outline. Bile ducts and vascular trees are not added.",
    ),
    "gallbladder": (
        "Fundus, body and neck, including the transition to the cystic duct.",
        "This source is a reduced display mesh. It does not resolve a layered wall, mucosa or duct lumen.",
    ),
    "stomach": (
        "Both curvatures, fundus, cardia and pyloric region in multiple views.",
        "One oblique silhouette can look oval. The source is coarse; wall thickness and mucosal folds are not modeled.",
    ),
    "pancreas": (
        "Head, body and tapering tail; relation to the duodenal curve.",
        "The external atlas shape is retained. Fine lobular tissue architecture and ducts are not resolved.",
    ),
    "spleen": (
        "Superior margin, surface notches, poles and hilar depression.",
        "Atlas-scale surface detail remains. Authored pigment is not a calibrated tissue photograph.",
    ),
    "kidney": (
        "Side-specific outline, poles, medial concavity and hilum.",
        "Capsule/hilum display surfaces, not filled parenchymal solids. Four side/sex references do not mean four independent population samples.",
    ),
    "small-intestine": (
        "Loop arrangement, local diameter and inter-loop clearance.",
        "No measured mesentery, vessel network or validated bowel-wall mechanics is included.",
    ),
    "large-intestine": (
        "Overall course, bends and visible haustral surface structure.",
        "Female and male colon references have different construction histories. They do not establish prevalence.",
    ),
    "heart": (
        "Apex, external chambers and junctions between selected surfaces.",
        "Male source defects were cleaned with face maps. Coronary vessels and calibrated myocardium are absent.",
    ),
    "lung": (
        "Lobar outlines, fissures and hilum; distinguish lobes from source patch seams.",
        "Coincident segment normals are averaged on a copy to remove artificial shading seams. Geometry is unchanged.",
    ),
    "brain": (
        "Gyri, sulci, hemispheric separation and posterior structures.",
        "Both sex-labelled files reuse one mirrored Allen reference fitted to different bodies. They are one lineage.",
    ),
    "urinary-bladder": (
        "Dome, base, outlet and degree of distension represented.",
        "These flattened reference shapes must not be treated as a validated continuum of filling states.",
    ),
}
INK = colors.HexColor("#152a30")
TEAL = colors.HexColor("#167f79")
MUTED = colors.HexColor("#526b70")
PALE = colors.HexColor("#eef4f3")
DARK = colors.HexColor("#131b22")
BODY = ParagraphStyle("body", fontName="Helvetica", fontSize=10.5, leading=15, textColor=INK)
SMALL = ParagraphStyle("small", parent=BODY, fontSize=8, leading=11)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text())


def rows(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line]


class Report:
    def __init__(self, path: Path, release: str):
        self.c = canvas.Canvas(str(path), pagesize=landscape(A3), pageCompression=1)
        self.c.setTitle("VISCERA Atlas Dataset — Visual Evidence and Training Audit")
        self.c.setAuthor("VISCERA project; atlas credits recorded per source")
        self.release = release
        self.page = 0
        self.w, self.h = landscape(A3)

    def start(self, title: str, kicker: str = "VISCERA / ATLAS DATASET", portrait: bool = False):
        if self.page:
            self.c.showPage()
        self.page += 1
        self.w, self.h = A3 if portrait else landscape(A3)
        self.c.setPageSize((self.w, self.h))
        self.c.setFillColor(colors.white)
        self.c.rect(0, 0, self.w, self.h, fill=1, stroke=0)
        self.c.setFillColor(TEAL)
        self.c.setFont("Helvetica-Bold", 9)
        self.c.drawString(42, self.h - 39, kicker)
        self.c.setFillColor(INK)
        self.c.setFont("Helvetica-Bold", 26)
        self.c.drawString(42, self.h - 75, title)
        self.c.setStrokeColor(colors.HexColor("#dce7e6"))
        self.c.line(42, 39, self.w - 42, 39)
        self.c.setFont("Helvetica", 8)
        self.c.setFillColor(MUTED)
        self.c.drawString(
            42, 25, f"Release {self.release}   •   Development evidence; anatomical review pending"
        )
        self.c.drawRightString(self.w - 42, 25, f"{self.page:02d}")

    def text(self, text: str, x: float, y: float, width: float, small: bool = False):
        p = Paragraph(text, SMALL if small else BODY)
        _, height = p.wrap(width, 1000)
        p.drawOn(self.c, x, y - height)
        return height

    def image(
        self, path: Path, x: float, y: float, width: float, height: float, dark: bool = False
    ):
        if dark:
            self.c.setFillColor(DARK)
            self.c.rect(x, y, width, height, fill=1, stroke=0)
        with Image.open(path) as img:
            iw, ih = img.size
            r = min(width / iw, height / ih)
            w, h = iw * r, ih * r
            flattened = Image.new("RGB", img.size, "#131b22" if dark else "#ffffff")
            if img.mode == "RGBA":
                flattened.paste(img, mask=img.getchannel("A"))
            else:
                flattened.paste(img.convert("RGB"))
            encoded = io.BytesIO()
            flattened.save(encoded, format="JPEG", quality=93, optimize=True)
            encoded.seek(0)
            self.c.drawImage(
                ImageReader(encoded), x + (width - w) / 2, y + (height - h) / 2, w, h, mask="auto"
            )

    def table(
        self,
        headers: list[str],
        body: list[list[str]],
        x: float,
        y: float,
        widths: list[float],
        rowheight: float = 28,
    ):
        for index, row in enumerate([headers, *body]):
            top = y - index * rowheight
            self.c.setFillColor(TEAL if index == 0 else (PALE if index % 2 else colors.white))
            self.c.rect(x, top - rowheight, sum(widths), rowheight, fill=1, stroke=0)
            xx = x
            for text, width in zip(row, widths, strict=True):
                self.c.setFillColor(colors.white if index == 0 else INK)
                self.c.setFont("Helvetica-Bold" if index == 0 else "Helvetica", 9)
                self.c.drawString(xx + 10, top - rowheight / 2 - 3, text)
                xx += width

    def save(self):
        self.c.save()


def gallery(witness: Path, output: Path, manifest: list[dict[str, Any]]) -> None:
    cards = []
    for r in manifest:
        label = f"{r['organ']} / {r['template_id']} / {r['sample_id']}"
        cards.append(
            f'<article data-organ="{html.escape(r["organ"])}" data-search="{html.escape(label)}"><a href="{html.escape(r["image"])}"><img loading="lazy" src="{html.escape(r["image"])}" width="768" height="256" alt="{html.escape(label)}; oblique, back and top views"></a><h2>{html.escape(r["template_id"])}</h2><p>{html.escape(r["sample_id"])} · {html.escape(r["split"])}</p><details><summary>Exact recipe and evidence</summary><pre>{html.escape(json.dumps({k: r[k] for k in ["spec", "geometry_sha256", "image_sha256"]}, indent=2))}</pre></details></article>'
        )
    options = "".join(f'<option value="{o}">{o.replace("-", " ").title()}</option>' for o in ORGANS)
    document = """<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VISCERA — all organ variants</title><style>
:root{font:16px/1.5 system-ui;background:#f3f6f5;color:#162d30}body{margin:0}header{padding:32px 4vw;background:#14252b;color:#ecf4f2}h1{font-size:34px;margin:0 0 12px}header p{max-width:900px;color:#b9d0ce}nav{position:sticky;top:0;padding:16px 4vw;display:flex;flex-wrap:wrap;gap:16px;background:#fff;border-bottom:1px solid #cededb;z-index:2}input,select{font:inherit;padding:10px;border:1px solid #94b1ac;border-radius:6px}main{padding:28px 4vw;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:20px}article{background:white;border:1px solid #d6e3df;border-radius:10px;overflow:hidden}img{display:block;width:100%;height:auto;background:#131b22}article h2,article p,details{margin:12px 16px}h2{font-size:16px}p{font-size:13px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}summary{cursor:pointer}article[hidden]{display:none}a:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #2fb6a6}#count{align-self:center}</style>
<header><h1>Every organ. Three views. Exact recipes.</h1><p>1,536 atlas-derived designs across 24 templates and 12 organ groups. Click a picture for its full three-view capture. These are actual rendered dataset objects, with automatic geometry/image integrity checks. Materials are authored display approximations; independent anatomy and mechanical validation remain pending.</p></header><nav><select id="organ" aria-label="Filter by organ"><option value="">All organs</option>OPTIONS</select><input id="search" placeholder="Search reference or specimen" aria-label="Search references"><span id="count"></span></nav><main>CARDS</main><script>const cards=[...document.querySelectorAll('article')];const organ=document.querySelector('#organ'),search=document.querySelector('#search');function filter(){let n=0;for(const card of cards){card.hidden=(organ.value&&card.dataset.organ!==organ.value)||!card.dataset.search.toLowerCase().includes(search.value.toLowerCase());if(!card.hidden)n++}document.querySelector('#count').textContent=n+' specimens'}organ.addEventListener('change',filter);search.addEventListener('input',filter);filter();</script></html>""".replace(
        "OPTIONS", options
    ).replace("CARDS", "".join(cards))
    output.write_text(document)


def build(data: Path, model: Path, witness: Path, identity: Path, out: Path) -> dict[str, Any]:
    release = read_json(data / "release.json")
    catalog = read_json(data / "templates/catalog.json")["templates"]
    captures = rows(witness / "witness.jsonl")
    shape = rows(data / "manifest.jsonl")
    assert len(captures) == len(shape) == release["accepted"]
    by_id = {r["sample_id"]: r for r in shape}
    assert len({r["sample_id"] for r in captures}) == len(captures)
    for r in captures:
        assert r["geometry_sha256"] == by_id[r["sample_id"]]["geometry_sha256"]
    heroes = {r["template_id"]: r for r in read_json(witness / "heroes.json")["heroes"]}
    groups = defaultdict(list)
    for r in captures:
        groups[r["template_id"]].append(r)
    training = read_json(model / "training_report.json")
    audit = read_json(model / "audit_geometry.json")["methods"]["ridge"]
    measured = audit["decoded_geometry"]["conditions"]
    axis_errors = " / ".join(
        f"{measured[f'extent_{axis}_mm']['mae_original_units']:.3f}" for axis in "xyz"
    )
    area_error = measured["surface_area_mm2"]["mae_original_units"]
    out.parent.mkdir(parents=True, exist_ok=True)
    report = Report(out, release["release_id"])
    report.start(
        "Atlas anatomy, made inspectable.", "VISCERA / VISUAL DATASET AUDIT / 06 OCTOBER 2026"
    )
    report.text(
        "<b>1,536 realized designs · 24 reference templates · 12 organ groups · 4,608 captured views</b>",
        42,
        report.h - 100,
        1100,
    )
    report.image(identity / "all-24-templates.png", 42, 84, 590, report.h - 210)
    report.text(
        "<b>What improved</b><br/>Source-based organ surfaces replace the two-organ ellipsoid pilot. Selected source surfaces retain their detail, with documented face repairs, reversible deformation controls, deterministic replay, paired text recipes and traceable credits.",
        670,
        report.h - 150,
        460,
    )
    report.text(
        "<b>What the evidence supports</b><br/>Numerically stable bounded surface deformation; all-organ rendering coverage; exact geometry identity checks; millimetre-based dimension control; measured validation of a trained inverse model.",
        670,
        report.h - 277,
        460,
    )
    report.text(
        "<b>What it does not establish</b><br/>Photographic realism, clinical plausibility of the variation distribution, material calibration, novel anatomy generation, global intersection freedom, volumetric mechanics or expert acceptance. The atlas references are not a population cohort.",
        670,
        report.h - 406,
        460,
    )
    report.text(
        "<b>Read this report</b><br/>The opening pages explain measurements and review limits. Organ pages show full-resolution renders of dataset specimens and selected three-view variants. The appendix covers every variant; the companion HTML gallery links full captures and exact recipes.",
        670,
        report.h - 550,
        460,
    )
    report.start("Evidence and model selection")
    body = [
        [
            name,
            f"{row['macro_template_control_nrmse']:.5f}",
            "Selected" if name == training["selected_method"] else "Compared",
        ]
        for name, row in training["comparisons"].items()
    ]
    report.table(
        ["Candidate", "Validation control NRMSE", "Decision"],
        body,
        42,
        report.h - 112,
        [360, 280, 400],
        35,
    )
    report.text(
        "<b>Selection was made on validation only.</b> The neural candidate did not beat per-template ridge regression. A model hash was frozen before opening the 240-object audit split. This choice is based on measured performance, not model complexity.",
        42,
        report.h - 325,
        530,
    )
    report.text(
        f"<b>Actual mesh audit</b><br/>Mean absolute width / height / depth errors: <b>{axis_errors} mm</b>. Surface-area error: <b>{area_error:.1f} mm²</b>. These are generated-atlas interpolation errors, not errors against real patient organs. Volume and compactness were masked because the surfaces are not certified tissue envelopes.",
        630,
        report.h - 325,
        500,
    )
    report.text(
        "<b>Reproducibility</b><br/>Full templates are stored once; each instance has explicit controls, seed, group, source and geometry hashes. Training uses 1,056 instances; validation and audit each use 240. Render, material and language descendants stay with their parent split. All splits share source lineages.",
        42,
        report.h - 480,
        530,
    )
    report.text(
        "<b>Geometry and visual checks</b><br/>3,840 development stress meshes passed; minimum design-map Jacobian 0.65989. All 1,536 cohort instances passed the scoped checks. Every final screenshot is bound to the exact server mesh and uploaded normal array. 576 additional model draws passed surface QA; this count includes empirical unconditional draws.",
        630,
        report.h - 480,
        500,
    )
    report.text(
        "Control NRMSE is divided by the full normalized control range of two. Several shape controls cannot be uniquely inferred from four observed measurements. Small dimension error therefore does not mean unique 3D shape recovery.",
        42,
        150,
        1060,
    )
    if (identity / "lung-before.png").exists():
        report.start("A visual defect corrected without changing anatomy")
        report.text(
            "The source lung is assembled from labeled segment patches. Computing each patch’s normals separately introduced broad artificial seams. Normal vectors were recalculated on a geometrically welded copy and transferred back to the untouched source vertices.",
            42,
            report.h - 112,
            1080,
        )
        report.image(identity / "lung-before.png", 42, 210, 535, 420, dark=True)
        report.image(identity / "hra-lung-male-tissue.png", 605, 210, 535, 420, dark=True)
        report.text("<b>Before</b> · artificial segment shading boundaries", 42, 194, 535)
        report.text("<b>After</b> · continuous shading; lobar separation retained", 605, 194, 535)
        report.text(
            "No vertex displacement, triangle removal, new faces or smoothing of organ geometry occurred in this correction. The normal-array SHA-256 is now recorded and independently verified against the actual GPU input for every final capture. Colors and lighting are still authored display approximations.",
            42,
            135,
            1080,
        )
    report.start("Source quality, physical scope and next requirements")
    report.table(
        ["Track", "Status", "Interpretation"],
        [
            [
                "Atlas geometry",
                "Retained + audited",
                "24 display templates; original bytes and modifications traced",
            ],
            [
                "Bounded variation",
                "Numerically checked",
                "Invertible continuous maps; authored bounds, not population intervals",
            ],
            [
                "Tissue appearance",
                "Authored approximation",
                "Per-organ pigment / roughness; no calibrated photographs",
            ],
            [
                "Anatomical expert review",
                "Pending",
                "Inspect multi-view silhouettes, landmarks and source omissions",
            ],
            [
                "Physical mechanics",
                "Not validated",
                "No volumetric domain, measured constitutive law or interaction validation",
            ],
            [
                "Text to shape",
                "Bounded compiler + paired corpus",
                "Measured dimension edits; unsupported constraints rejected atomically",
            ],
            [
                "Population generalization",
                "Not evaluated",
                "Few shared atlas lineages; brain references reuse one Allen source",
            ],
        ],
        42,
        report.h - 115,
        [190, 210, 650],
        40,
    )
    report.text(
        "<b>Detail has a source limit.</b> The stomach and gallbladder come from the current BodyParts3D 99%-reduced release. Their 1,810 and 2,396 triangles cannot represent fine tissue structure. Older five-times-denser candidates were located, but historical ShareAlike terms remain quarantined from this project’s commercial track. Subdivision would add polygons without adding anatomical evidence. HRA glTF metres are converted to millimetres; BodyParts3D assumes one source unit equals one millimetre, pending independent unit verification.",
        42,
        report.h - 480,
        525,
    )
    report.text(
        "<b>Photorealism needs additional evidence.</b> The useful next inputs are licensed multi-view gross-anatomy photographs with lighting/scale metadata, specialist-reviewed surfaces, local tissue-detail references and measured optical and mechanical parameters. Adding pigment noise cannot replace those measurements.",
        625,
        report.h - 480,
        505,
    )
    report.text(
        "The grid PDF supplied the initial source collection and visual reference scope. The present captures come from those versioned model files. No independent normal-organ photograph set was available for a defensible image-similarity score; none is reported.",
        42,
        132,
        1080,
    )
    for organ in ORGANS:
        templates = [t for t in catalog if t["organ"] == organ]
        report.start(
            organ.replace("-", " ").title(),
            f"VISCERA / ORGAN REVIEW / {len(templates)} REFERENCE TEMPLATE"
            + ("S" if len(templates) > 1 else ""),
        )
        n = len(templates)
        gap = 18
        cw = (report.w - 84 - gap * (n - 1)) / n
        for i, t in enumerate(templates):
            hero = heroes[t["template_id"]]
            original = by_id[hero["sample_id"]]
            assert hero["geometry_sha256"] == original["geometry_sha256"]
            p = witness / hero["image"]
            report.image(p, 42 + i * (cw + gap), report.h - 416, cw, 294, dark=True)
            report.text(
                f"<b>{t['template_id']}</b> · {hero['sample_id']}<br/>{t['vertex_count']:,} vertices · {t['face_count']:,} triangles<br/>X / Y / Z extents: "
                + " / ".join(
                    f"{v:.1f}" for v in [original["measurements"][f"extent_{a}_mm"] for a in "xyz"]
                )
                + " mm · views fitted independently",
                42 + i * (cw + gap),
                report.h - 426,
                cw,
                small=True,
            )
        selected = []
        for t in templates:
            available = sorted(groups[t["template_id"]], key=lambda r: r["sample_id"])
            selected.extend(
                [available[0], available[-1]] if len(templates) <= 2 else [available[0]]
            )
        for i, r in enumerate(selected):
            cw = (report.w - 84 - 18 * (len(selected) - 1)) / len(selected)
            report.image(witness / r["image"], 42 + i * (cw + 18), 155, cw, 112, dark=True)
            report.text(
                r["sample_id"] + "<br/>" + r["split"] + " · oblique / back / top",
                42 + i * (cw + 18),
                149,
                cw,
                small=True,
            )
        focus, limit = NOTES[organ]
        report.text(
            "<b>Review focus:</b> "
            + html.escape(focus)
            + "<br/><b>Known limit:</b> "
            + html.escape(limit),
            42,
            104,
            report.w - 84,
            small=True,
        )
    report.start("Versioned source credits")
    y = report.h - 108
    for t in catalog:
        meta = read_json(data / "templates" / f"{t['template_id']}.json")
        citation = html.escape(meta["attribution"])
        url = html.escape(meta["source_url"], quote=True)
        text = f'<b>{t["template_id"]}</b> · {html.escape(meta["license"])}<br/>{citation} <link href="{url}" color="#167f79">Model source</link>'
        used = report.text(text, 42, y, report.w - 84, small=True)
        y -= used + 10
        if y < 100 and t != catalog[-1]:
            report.start("Versioned source credits, continued")
            y = report.h - 108
    for t in catalog:
        report.start(
            t["template_id"],
            "VISCERA / COMPLETE VARIATION CONTACT SHEET / 64 SPECIMENS",
            portrait=True,
        )
        path = witness / "contacts" / f"{t['template_id']}.png"
        report.image(path, 35, 72, report.w - 70, report.h - 177)
        report.text(
            "All 64 recipes are shown. Each tile contains oblique, back and top views. Full-resolution captures, source-bound specs and cryptographic identities are in the companion gallery. Contact sheets are coverage evidence, not specialist anatomy approval.",
            42,
            65,
            report.w - 84,
            small=True,
        )
    report.save()
    gallery(witness, witness / "index.html", captures)
    result = {
        "pdf": str(out),
        "pages": report.page,
        "specimens": len(captures),
        "views": sum(len(r["views"]) for r in captures),
        "release_id": release["release_id"],
    }
    out.with_suffix(".json").write_text(json.dumps(result, indent=2) + "\n")
    return result


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--data", type=Path, required=True)
    p.add_argument("--model", type=Path, required=True)
    p.add_argument("--witness", type=Path, required=True)
    p.add_argument("--identity", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    print(json.dumps(build(a.data, a.model, a.witness, a.identity, a.out), indent=2))
