"""Build the visual material review from hash-verified actual Studio captures."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A3, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import Paragraph

PAGE = landscape(A3)
INK = HexColor("#13272a")
MUTED = HexColor("#536568")
PAPER = HexColor("#f7f9f8")


def build(captures: Path, output: Path) -> None:
    manifest = json.loads((captures / "manifest.json").read_text())
    for row in manifest["records"]:
        image = captures / row["image"]
        if hashlib.sha256(image.read_bytes()).hexdigest() != row["image_sha256"]:
            raise ValueError(f"Capture hash mismatch: {image}")
    output.parent.mkdir(parents=True, exist_ok=True)
    pdf = Canvas(str(output), pagesize=PAGE)
    pdf.setTitle("VISCERA organ material review")
    pdf.setAuthor("VISCERA development")
    width, height = PAGE
    style = ParagraphStyle("body", fontName="Helvetica", fontSize=13, leading=19, textColor=INK)
    small = ParagraphStyle("small", parent=style, fontSize=9, leading=12, textColor=MUTED)
    number = 0

    def paragraph(
        text: str, x: float, top: float, available: float, compact: bool = False
    ) -> float:
        item = Paragraph(text, small if compact else style)
        _, h = item.wrap(available, 2000)
        item.drawOn(pdf, x, top - h)
        return top - h

    def page(title: str, subtitle: str) -> None:
        nonlocal number
        number += 1
        pdf.setFillColor(PAPER)
        pdf.rect(0, 0, width, height, fill=1, stroke=0)
        pdf.setFillColor(INK)
        pdf.setFont("Helvetica-Bold", 25)
        pdf.drawString(38, height - 48, title)
        paragraph(subtitle, 38, height - 66, width - 76, True)
        pdf.setFillColor(MUTED)
        pdf.setFont("Helvetica", 9)
        pdf.drawString(
            38,
            22,
            "VISCERA  |  7 October 2026  |  Authored appearance under fixed inspection lighting",
        )
        pdf.drawRightString(width - 38, 22, str(number))

    page("Organ material review", "Independent texture generation and architecture update")
    y = paragraph(
        "The new surface system provides four organ-specific presets and six continuous controls, "
        "with an independent appearance seed. This report contains 48 actual Studio renders across "
        "12 organ groups, followed by eight detail and seed comparisons. Within each organ row, "
        "the shape, camera and lighting are identical: only the material recipe changes.",
        38,
        height - 119,
        width - 76,
    )
    y -= 46
    box_width = (width - 116) / 3
    for x, title, lines in [
        (
            38,
            "Shape",
            "Frozen atlas mesh and bounded deformation<br/>Original rest coordinates and normals<br/>Separate shape model and data release",
        ),
        (
            58 + box_width,
            "Surface",
            "Organ and preset plus six controls<br/>Continuous field in rest millimetres<br/>Independent seed and material prior",
        ),
        (
            78 + 2 * box_width,
            "Render and export",
            "Per-fragment color and roughness<br/>Shading-only micro-normal detail<br/>Baked PBR maps embedded in GLB",
        ),
    ]:
        pdf.setFillColor(HexColor("#e7eeeb"))
        pdf.roundRect(x, y - 133, box_width, 133, 8, fill=1, stroke=0)
        pdf.setFillColor(INK)
        pdf.setFont("Helvetica-Bold", 16)
        pdf.drawString(x + 16, y - 29, title)
        paragraph(lines, x + 16, y - 45, box_width - 32)
    y -= 172
    y = (
        paragraph(
            "<b>Controls</b>  Warmth, pigment contrast, pattern size in millimetres, surface sheen, "
            "fine detail and tissue grain. Presets initialize these controls; seeds change the spatial pattern.",
            38,
            y,
            width - 76,
        )
        - 20
    )
    y = (
        paragraph(
            "<b>Training</b>  A separate 768-recipe material release uses 480 training, 144 validation "
            "and 144 audit recipes. Each stores 1,024 actual field samples. Validation compares mean, "
            "nearest, ridge and neural models. Ridge was selected because the neural candidate exceeded "
            "the allowed regression on individual organs, despite its lower average error.",
            38,
            y,
            width - 76,
        )
        - 20
    )
    y = (
        paragraph(
            "<b>Verification</b>  Actual WebGL readback agrees with the CPU fields to within 1.4e-6 "
            "for color and roughness, and 5.6e-6 for height and gradients on the parity fixture. "
            "All 3,072 tested control corners remained finite and within declared bounds. The live "
            "material sampler preserved geometry and organ identity for all 12 families.",
            38,
            y,
            width - 76,
        )
        - 20
    )
    paragraph(
        "<b>What the images do not prove</b>  These are authored procedural appearances, not calibrated "
        "tissue photographs or a measured population model. Source faceting is still visible on some "
        "organs, including the pancreas; the texture shader does not add anatomical geometry. "
        "Optical tissue calibration, histology, disease variation and mechanical properties remain unvalidated.",
        38,
        y,
        width - 76,
    )
    pdf.showPage()
    rows = [r for r in manifest["records"] if r["group"] == "preset_grid"]
    organs = list(dict.fromkeys(r["organ"] for r in rows))
    presets = ["balanced", "soft", "rich", "moist"]
    gap, margin = 12, 38
    cell = (width - 2 * margin - 3 * gap) / 4
    for offset in range(0, len(organs), 2):
        page(
            "Organ surface presets",
            "Columns share a fixed shape and camera within each row. Appearance seed 42. Native captures are embedded without repainting.",
        )
        for row_index, organ in enumerate(organs[offset : offset + 2]):
            top = height - 111 - row_index * 345
            group = [r for r in rows if r["organ"] == organ]
            reference = group[0]
            pdf.setFillColor(INK)
            pdf.setFont("Helvetica-Bold", 14)
            pdf.drawString(margin, top, organ.replace("-", " ").title())
            pdf.setFont("Helvetica", 10)
            pdf.drawRightString(width - margin, top, reference["spec"]["template_id"])
            for col, preset in enumerate(presets):
                entry = next(r for r in group if r["label"] == preset)
                x = margin + col * (cell + gap)
                pdf.setFont("Helvetica", 11)
                pdf.drawString(x, top - 18, {"rich": "Rich pigment"}.get(preset, preset.title()))
                pdf.drawImage(
                    str(captures / entry["image"]), x, top - 29 - cell, width=cell, height=cell
                )
            source = reference["source"]
            paragraph(
                "Source geometry: "
                + source["attribution"]
                + " License: "
                + source["license"]
                + ". Material recipe and exact hashes: accompanying capture manifest.",
                margin,
                top - cell - 37,
                width - 2 * margin,
                True,
            )
        pdf.showPage()
    for organ in ("liver", "pancreas"):
        page(
            organ.title() + " fine detail and seed variation",
            "Actual 1024 pixel Studio captures. Fine detail changes shading; seeds change field placement. All panels preserve geometry.",
        )
        entries = [
            r for r in manifest["records"] if r["organ"] == organ and r["group"] != "preset_grid"
        ]
        size = 323
        for i, row in enumerate(entries):
            x = margin + (i % 2) * (size + 24)
            top = height - 111 - (i // 2) * (size + 30)
            label = {
                "fine-0": "Fine detail 0",
                "fine-1": "Fine detail 1",
                "seed-0": "Appearance seed 0",
                "seed-max": "Appearance seed 4294967295",
            }.get(row["label"], row["label"])
            pdf.setFillColor(INK)
            pdf.setFont("Helvetica", 11)
            pdf.drawString(x, top, label)
            pdf.drawImage(str(captures / row["image"]), x, top - 9 - size, width=size, height=size)
        x = margin + 2 * (size + 24) + 12
        paragraph(
            "<b>How to read this comparison</b><br/><br/>The first row changes only fine surface detail. "
            "The second row changes only the appearance seed. Inspect broad mottling and the highlight "
            "surface at close range. The silhouette and geometry hash remain fixed.<br/><br/>"
            + (
                "Source surface faceting is visible here and remains a geometry limitation. Material grain "
                "is an authored visual pattern, not a reconstruction of pancreatic tissue architecture."
                if organ == "pancreas"
                else "The pale ligament region follows source component labels. Fine surface normals alter "
                "the highlight without displacement or added anatomical structures."
            ),
            x,
            height - 113,
            width - x - margin,
        )
        pdf.showPage()
    pdf.save()
    print(
        json.dumps(
            {
                "pages": number,
                "images": len(manifest["records"]),
                "pdf": str(output),
                "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
            }
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--captures", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    build(args.captures, args.out)
