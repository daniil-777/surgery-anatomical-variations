"""Build an illustrated PDF from actual mesh renders and recorded editor evidence.

Run with reportlab and pymupdf in an isolated authoring environment. No model or
dataset artifacts are modified. The report is a visual engineering review.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from xml.sax.saxutils import escape

import pymupdf
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph, Table, TableStyle

ROOT = Path(__file__).resolve().parents[2]
REPORTS = ROOT.parent / "reports"
ASSETS = REPORTS / "viscera-organ-review-2026-10-06"
PDF = REPORTS / "VISCERA Organ Realism Review 2026-10-06.pdf"
EVIDENCE = ROOT / "benchmarks/results/code-review-2026-10-06"
SOURCES = json.loads((ASSETS / "sources.json").read_text())
MEASURE = SOURCES["default"]["measurements"]
PROBE = json.loads((EVIDENCE / "probe-metrics.json").read_text())
AUDIT = json.loads(
    (ROOT / "artifacts/models/shape-pilot-v1/postfreeze_evaluation.json").read_text()
)
W, H = A4
MARGIN = 42
WIDTH = W - 2 * MARGIN
INK, MUTED, ACCENT = "#182F3D", "#52636D", "#247C77"
STYLE = ParagraphStyle(
    "body", fontName="Helvetica", fontSize=10.2, leading=14.5, textColor=colors.HexColor(INK)
)
SMALL = ParagraphStyle(
    "small", parent=STYLE, fontSize=8.8, leading=12.5, textColor=colors.HexColor(MUTED)
)
c = canvas.Canvas(str(PDF), pagesize=A4, pageCompression=1)
c.setTitle("VISCERA Organ Realism Review 6 October 2026")
c.setAuthor("VISCERA development workspace")
c.setSubject(
    "Actual generated liver and gallbladder renders, variation and numerical preview evidence"
)
page_number = 0
used_images: list[str] = []
text_boxes: list[dict] = []


def text(
    value: str, x: float, top: float, width: float = WIDTH, style: ParagraphStyle = STYLE
) -> float:
    paragraph = Paragraph(value, style)
    _, height = paragraph.wrap(width, H)
    if top - height < 35:
        raise ValueError(f"Text exceeds page {page_number}: {value[:80]}")
    paragraph.drawOn(c, x, top - height)
    text_boxes.append({"page": page_number, "x": x, "top": top, "width": width, "height": height})
    return top - height


def page(title: str, subtitle: str) -> None:
    global page_number
    if page_number:
        c.showPage()
    page_number += 1
    c.setFillColor(colors.HexColor(ACCENT))
    c.setFont("Helvetica-Bold", 8)
    c.drawString(MARGIN, H - 30, "VISCERA  /  ORGAN VISUAL REVIEW")
    c.setFillColor(colors.HexColor(INK))
    c.setFont("Helvetica-Bold", 23)
    c.drawString(MARGIN, H - 64, title)
    text(subtitle, MARGIN, H - 78, style=SMALL)
    c.setFont("Helvetica", 8)
    c.setFillColor(colors.HexColor(MUTED))
    c.drawString(
        MARGIN, 20, "6 October 2026  |  Unreviewed procedural anatomy  |  Development preview"
    )
    c.drawRightString(W - MARGIN, 20, f"{page_number:02d} / 12")
    c.bookmarkPage(f"page-{page_number}")
    c.addOutlineEntry(title, f"page-{page_number}", 0)


def image(name: str | Path, x: float, bottom: float, width: float, height: float) -> None:
    source = name if isinstance(name, Path) else ASSETS / "images" / f"{name}.png"
    c.setFillColor(colors.HexColor("#E7E9EB"))
    c.rect(x, bottom, width, height, fill=1, stroke=0)
    reader = ImageReader(str(source))
    iw, ih = reader.getSize()
    scale = min(width / iw, height / ih)
    c.drawImage(
        reader,
        x + (width - iw * scale) / 2,
        bottom + (height - ih * scale) / 2,
        width=iw * scale,
        height=ih * scale,
        mask="auto",
    )
    used_images.append(str(source))


def label(value: str, x: float, y: float, width: float = WIDTH) -> None:
    text(value, x, y, width, SMALL)


def table(rows: list[list[str]], top: float, widths: list[float]) -> float:
    cells = [[Paragraph(escape(str(v)).replace("\n", "<br/>"), SMALL) for v in row] for row in rows]
    t = Table(cells, colWidths=widths, hAlign="LEFT")
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E4F0EE")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 9),
                ("RIGHTPADDING", (0, 0), (-1, -1), 9),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                ("LINEBELOW", (0, 0), (-1, -1), 0.35, colors.HexColor("#D7E0E3")),
            ]
        )
    )
    _, height = t.wrap(WIDTH, H)
    if top - height < 40:
        raise ValueError("Table exceeds page")
    t.drawOn(c, MARGIN, top - height)
    return top - height


def six_panels(entries: list[tuple[str, str]]) -> None:
    width = (WIDTH - 16) / 2
    for i, (name, caption) in enumerate(entries):
        x = MARGIN + (i % 2) * (width + 16)
        top = 720 - (i // 2) * 211
        label(caption, x, top + 17, width)
        image(name, x, top - 184, width, 184)


page(
    "Organ realism review",
    "Actual meshes, 34 dedicated review renders, and recorded studio evidence",
)
image("hero", MARGIN, 316, WIDTH, 383)
text(
    "<b>Current assessment</b><br/>The controls and mesh pipeline work, but the organs still read as smooth, stylized procedural assets. The visible form, tissue appearance and vascular detail are not yet at the photorealistic quality target.",
    MARGIN,
    287,
)
text(
    "This report makes the present quality inspectable. Every organ picture is a render of the actual geometry. No generated photograph, artist paint-over, reference scan or independent anatomical approval is presented.",
    MARGIN,
    207,
)
table(
    [
        ["Default liver", "Default gallbladder", "Dataset coverage"],
        [
            "235 x 145 x 125 mm\n1,847 mL outer envelope",
            "80 mm neck to fundus\n26.47 mL outer envelope",
            "128 accepted designs\nOne construction lineage",
        ],
    ],
    137,
    [WIDTH / 3] * 3,
)

page(
    "Assembly from six directions",
    "Neutral shaded surfaces reveal the silhouette and layout without pigment or wet highlights",
)
six_panels(
    [
        (f"assembly-{name}", label_)
        for name, label_ in (
            ("anterior", "A  Anterior   camera from +Y"),
            ("posterior", "B  Posterior   camera from -Y"),
            ("right", "C  Patient right   camera from +X"),
            ("left", "D  Patient left   camera from -X"),
            ("superior", "E  Superior   camera from +Z"),
            ("inferior", "F  Inferior   camera from -Z"),
        )
    ]
)
text(
    "All six views use a 340 mm orthographic horizontal span. R, A and S indicate positive patient axes. The 50 mm bars are calibrated to the generated geometry; organ position is an authored scene arrangement.",
    MARGIN,
    91,
    style=SMALL,
)

page(
    "Liver exterior and visceral surface",
    "Default seed 1234  |  36,480 surface triangles  |  1,847.19 mL outer envelope",
)
image("liver-anterior", MARGIN, 397, WIDTH, 335)
label("A  Isolated liver exterior with the stored procedural pigment field", MARGIN, 387)
cw = (WIDTH - 16) / 2
image("liver-inferior", MARGIN, 156, cw, 185)
image("liver-inferior-clay", MARGIN + cw + 16, 156, cw, 185)
label("B  Inferior view with pigment", MARGIN, 146, cw)
label("C  Same geometry with a matte surface", MARGIN + cw + 16, 146, cw)
text(
    "<b>Visible limitation:</b> the broad outline is controlled, but the underside contains rounded, softened depressions and grooves. These features are authored targets; their names and mesh resolution do not establish anatomical fidelity. No internal liver segmentation or tissue microstructure is represented.",
    MARGIN,
    111,
)

page(
    "Gallbladder exterior and cavity",
    "The same default organ is isolated in every image; the cutaway changes visibility only",
)
image("gb-right", MARGIN, 515, cw, 185)
image("gb-oblique", MARGIN + cw + 16, 515, cw, 185)
label("A  Patient-right view", MARGIN, 505, cw)
label("B  Oblique view", MARGIN + cw + 16, 505, cw)
image("gb-section", MARGIN, 192, WIDTH, 281)
label("C  Uncapped clipping cutaway showing the actual inner and outer surfaces", MARGIN, 182)
text(
    "<b>Measured geometry:</b> length 80 mm; outer envelope 26.47 mL; sealed lumen 19.29 mL. The 1.5 mm wall input is a homothetic shrink control, not a verified constant wall thickness. The lumen ends at an authored neck cap and is not joined to a fluid-ready duct.",
    MARGIN,
    141,
)
text(
    "<b>Review concern:</b> the surface is very regular. The inner cavity is a scaled construction, with no modeled tissue layers, mucosal detail, or measured deformation response.",
    MARGIN,
    74,
    style=SMALL,
)

page(
    "Vessels and ducts are schematic",
    "Transparency exposes the supplied display meshes; it does not create internal anatomy",
)
image("scaffold", MARGIN, 307, WIDTH, 383)
text(
    "Five named display structures are present: common hepatic duct, common bile duct, cystic duct, portal vein trunk and proper hepatic artery. Their short, simplified tubes help identify the intended arrangement.",
    MARGIN,
    284,
)
text(
    "<b>Major realism gap:</b> this is not a connected branching system. There are no verified junction walls, intraparenchymal trees or physiological flow paths. Open tube ends, simple curves and approximate attachments are visible in this view. These structures must not be interpreted as a complete anatomical reconstruction.",
    MARGIN,
    217,
)
table(
    [
        ["What the picture supports", "What remains absent"],
        [
            "Visible named tube meshes and their authored placement",
            "Independent review of anatomy and branching variants",
        ],
        [
            "A transparent inspection of existing geometry",
            "Connected ducts, vessel walls and internal branching",
        ],
    ],
    126,
    [WIDTH / 2] * 2,
)

page(
    "Variation in the original dataset",
    "Six stored pilot-v1 meshes selected by volume rank; all use the same physical display scale",
)
entries = []
for i in range(6):
    m = SOURCES[f"cohort-{i}"]["measurements"]
    entries.append(
        (
            f"cohort-{i}",
            f"{i + 1}   Liver {m['liver_volume_ml']:,.0f} mL   |   width {m['liver_width_mm']:.0f} mm",
        )
    )
six_panels(entries)
text(
    "Selected ranks span the smallest through largest accepted designs; this is deliberate coverage, not a random population sample. Median release volume is 2,001 mL, range 1,270-2,543 mL. These are engineering design values. Every mesh comes from one recipe and remains unreviewed.",
    MARGIN,
    91,
    style=SMALL,
)

page(
    "Sensitivity of the liver controls",
    "Only one control changes within each row; the inferior camera, scale and matte material stay fixed",
)
settings = [
    ("left_lobe_ratio", "Left lobe ratio", (0.30, 0.48, 0.78)),
    ("inferior_concavity", "Inferior concavity", (0.10, 0.30, 0.55)),
    ("fissure_depth_mm", "Fissure depth in mm", (2, 7, 12)),
]
pw = (WIDTH - 20) / 3
for row, (key, title, values) in enumerate(settings):
    top = 716 - row * 194
    text(f"<b>{title}</b>", MARGIN, top + 18, style=SMALL)
    for col, value in enumerate(values):
        x = MARGIN + col * (pw + 10)
        image(f"control-{key}-{col}", x, top - 136, pw, 126)
        label(f"{value:g}" + ("   default" if col == 1 else ""), x, top - 144, pw)
text(
    "The controls produce real geometric changes; they are not merely color changes. This grid also exposes a limitation: all variants retain the same authored topology and feature pattern. Strong parameter sensitivity is not evidence of the range or prevalence of biological variation.",
    MARGIN,
    110,
)

page(
    "Gallbladder form controls",
    "Four deliberately chosen construction examples at the same 140 mm horizontal span",
)
for i, caption in enumerate(
    (
        "55 mm length  /  10 mm radius control",
        "80 mm length  /  15 mm radius control",
        "110 mm length  /  10 mm radius control",
        "60 mm length  /  22 mm radius control",
    )
):
    x = MARGIN + (i % 2) * (cw + 16)
    top = 720 - (i // 2) * 251
    image(f"gb-control-{i}", x, top - 185, cw, 185)
    label(caption, x, top - 195, cw)
    volume = SOURCES[f"gb-control-{i}"]["measurements"]["gallbladder_enclosed_ml"]
    label(f"Measured outer envelope {volume:.2f} mL", x, top - 211, cw)
text(
    "Length and radius change the mesh and enclosed volume. The examples are control-range demonstrations, not labels of normal anatomy or disease. Differences in neck position, wall organization, attachment and surrounding structures remain simplified by the shared construction.",
    MARGIN,
    187,
)
text(
    "<b>Inspection task:</b> compare the fundus, taper and neck between examples. Decide which silhouettes need additional original base designs before expanding the dataset. Repeating this one family at larger scale will not add missing anatomy.",
    MARGIN,
    110,
)

page(
    "Resolution and material appearance",
    "Neutral review views above; an actual Studio screenshot below",
)
image("liver-inferior-clay", MARGIN, 526, cw, 185)
image("liver-wire", MARGIN + cw + 16, 526, cw, 185)
label("A  Matte surface", MARGIN, 516, cw)
label("B  Actual triangle edges", MARGIN + cw + 16, 516, cw)
image(EVIDENCE / "studio-overview.png", MARGIN, 159, WIDTH, 319)
label("C  Current editor material and lighting, recorded locally after code review", MARGIN, 149)
text(
    "A dense mesh samples the existing shape more finely. It does not supply new anatomical features. Stored vertex pigment and a procedural shading field create color and highlights, but no measured tissue optical maps are used. The current surface still appears smooth and stylized. Review lighting intentionally differs from the editor, illustrating how strongly appearance depends on illumination.",
    MARGIN,
    113,
)

page(
    "Deformation and recovery",
    "Real editor frames from a distributed displacement probe with a fixed simulation timestep",
)
image(EVIDENCE / "probe-loading.png", MARGIN, 448, WIDTH, 289)
label(
    "A  Early recorded response; this screenshot is not asserted to be the exact peak", MARGIN, 438
)
image(EVIDENCE / "probe-recovery.png", MARGIN, 115, WIDTH, 289)
label("B  Retained terminal state after release, before any manual reset", MARGIN, 105)
text(
    f"Peak displacement {PROBE['maxDisplacementMm']:.2f} mm; terminal residual {PROBE['recoveryResidualMm']:.2f} mm. Minimum J {PROBE['minJacobian']:.4f}; maximum volume drift {100 * PROBE['maxVolumeDrift']:.4f}%; rejected steps {PROBE['rejectedSteps']}. The XPBD preview uses heuristic material and support settings. These numbers establish numerical behavior for this test, not tissue calibration.",
    MARGIN,
    79,
    style=SMALL,
)

page(
    "Measurements and evidence",
    "Geometry measurements, numerical checks and anatomical credibility must be assessed separately",
)
y = table(
    [
        ["Default generated asset", "Measured value", "Interpretation"],
        ["Liver RAS extents", "235 x 145 x 125 mm", "Bounding extent of the generated mesh"],
        [
            "Liver volume",
            f"{MEASURE['liver_volume_ml']:.2f} mL",
            "Closed outer envelope; not observed patient data",
        ],
        ["Gallbladder outer / lumen", "26.47 / 19.29 mL", "Two different enclosed volumes"],
        [
            "Inter-organ vertical clearance",
            "0.80 mm",
            "Scoped projected-surface construction audit",
        ],
        [
            "Liver / gallbladder triangles",
            "36,480 / 9,024",
            "Surface sampling density, not anatomical accuracy",
        ],
        [
            "Browser simulation proxy",
            "267 nodes / 528 tetrahedra",
            "Separate coarse deformation approximation",
        ],
    ],
    725,
    [165, 116, WIDTH - 281],
)
y = text(
    "<b>Learned variation</b><br/>The frozen compact flow passed decoded geometry gates on 32/32 fresh procedural examples and 12/12 unconditional samples. Its mean absolute liver-volume error was 93.69 mL and width error 4.87 mm; conditional PCA was more accurate at 75.42 mL and 3.55 mm. All five tested conditioning directions were correct. This is generalization to new seeds of the same recipe, not independently observed anatomy.",
    MARGIN,
    y - 26,
)
y = text(
    "<b>Code review</b><br/>116 Python tests, 21 TypeScript unit tests and 9 browser tests passed after fixes to imports, state preservation, asynchronous requests, API boundaries, dataset integrity, checkpoints and notebook loading. Passing software tests does not certify the pictures as anatomically correct.",
    MARGIN,
    y - 24,
)
text(
    "<b>Unperformed checks</b><br/>Independent anatomical review, independently authored reference families, measured tissue optics and mechanics, general self-contact, and biological variation coverage remain unverified. The report deliberately assigns no invented realism percentage or expert approval.",
    MARGIN,
    y - 24,
)

page(
    "Review priorities and reproducibility",
    "Use the figures to record specific defects before investing in a larger synthetic corpus",
)
y = table(
    [
        ["Priority", "What to inspect", "What would improve credibility"],
        [
            "1  Shape and relationships",
            "Rounded underside features, neck form, placement and attachments",
            "Several independently authored base designs with recorded anatomical review",
        ],
        [
            "2  Structural detail",
            "Short schematic tubes, capped lumen and absent internal liver structures",
            "Connected, reviewed topology and verified wall / lumen relationships",
        ],
        [
            "3  Appearance",
            "Uniform smoothness, broad highlights and synthetic pigment",
            "Licensed independent tissue references and physically scaled material maps",
        ],
        [
            "4  Variation",
            "Repeated topology and feature pattern across every example",
            "Reviewed distinct form families and held-out reference designs",
        ],
        [
            "5  Mechanics",
            "One probe response under heuristic supports and material values",
            "Measured loading / recovery targets, convergence and contact tests",
        ],
    ],
    725,
    [94, 191, WIDTH - 285],
)
y = text(
    "<b>Reviewer notes</b><br/>For each finding, record the page and view, affected feature, observed defect, supporting reference, severity, and requested correction. Keep geometric validity, visual appearance and physical behavior as separate judgments. Reviewer identity and sign-off remain blank until an actual review is performed.",
    MARGIN,
    y - 25,
)
y = text(
    "<b>Provenance</b><br/>Sources are the unchanged high-resolution procedural generator and exact stored pilot-v1 meshes (release fc8425726f7e665c). Dataset examples on page 6 were selected by realized volume rank. All cameras are orthographic with explicit scale bars; screenshots retain the editor's perspective camera. Render inputs and image settings are listed in the adjoining sources.json and renders.json files.",
    MARGIN,
    y - 25,
)
text(
    "<b>Files</b><br/>Report assets: reports/viscera-organ-review-2026-10-06/<br/>Editor video and metrics: viscera/benchmarks/results/code-review-2026-10-06/<br/>Model audit: viscera/artifacts/models/shape-pilot-v1/postfreeze_evaluation.json<br/>Reproduction scripts: viscera/scripts/reports/",
    MARGIN,
    y - 25,
    style=SMALL,
)

assert page_number == 12
c.save()
document = pymupdf.open(PDF)
qa = ASSETS / "pdf-pages"
qa.mkdir(exist_ok=True)
page_metrics = []
for number, pdf_page in enumerate(document, start=1):
    pdf_page.get_pixmap(matrix=pymupdf.Matrix(1.4, 1.4)).save(qa / f"page-{number:02d}.png")
    extracted = pdf_page.get_text()
    assert len(extracted) > 100, f"Missing report text on page {number}"
    page_metrics.append(
        {
            "page": number,
            "characters": len(extracted),
            "embedded_images": len(pdf_page.get_images()),
        }
    )
manifest = {
    "pdf": str(PDF.relative_to(ROOT.parent)),
    "sha256": hashlib.sha256(PDF.read_bytes()).hexdigest(),
    "pages": len(document),
    "image_placements": len(used_images),
    "unique_images": len(set(used_images)),
    "page_metrics": page_metrics,
    "review_status": "unreviewed_procedural_engineering_assessment",
    "inputs": {
        str(Path(p).relative_to(ROOT.parent)): hashlib.sha256(Path(p).read_bytes()).hexdigest()
        for p in set(used_images)
    },
}
(ASSETS / "report-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(
    json.dumps(
        {
            "pdf": str(PDF),
            "pages": len(document),
            "unique_images": len(set(used_images)),
            "bytes": PDF.stat().st_size,
        },
        indent=2,
    )
)
