#!/usr/bin/env python3
"""Rebuild the fixed-condition spectral blood transport LUT from attributed data.

Offline by default. --import-bosschaart-xml accepts the corrected Europe PMC XML;
the imported CSV retains published precision and columns, without reapplying the
absorption-flattening correction. --check verifies generated outputs byte-for-byte.
"""
from __future__ import annotations

import argparse
import bisect
import csv
import hashlib
import io
import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "blood/optics/data"
OUTPUT = ROOT / "apps/studio/src/blood/opticsLut.generated.ts"
EVIDENCE = ROOT / "blood/optics/lut-validation.json"
SAMPLES = 512
SCALE_M = 1e-6
MAX_M = 0.05
LOG_MAX = math.log1p(MAX_M / SCALE_M)
CIE_HASHES = {
    "CIE_xyz_1931_2deg.csv": "fa663e3535a7e0763a745993a1f0a192eb0275ac46ad2d1befd7626841e713c1",
    "CIE_std_illum_D65.csv": "e76f210bffff3d552ef7113025da5f325d5dfec200dd4b878b1a2f3a507032cb",
}
# Linear sRGB, D65. Coefficients are mathematical color-space conversion,
# not fitted blood colour. The computed D65 white is normalized per channel.
XYZ_TO_RGB = (
    (3.2404542, -1.5371385, -0.4985314),
    (-0.9692660, 1.8760108, 0.0415560),
    (0.0556434, -0.2040259, 1.0572252),
)


def slab(absorption: float, reduced_scattering: float, thickness: float) -> tuple[float, float]:
    """Exact solution of the declared two-ordinate *approximation*, not full RTE."""
    if thickness == 0 or max(absorption, reduced_scattering) == 0:
        return 0.0, 1.0
    if absorption == 0:
        t = 1 / (1 + math.sqrt(3) * reduced_scattering * thickness / 2)
        return 1 - t, t
    a = absorption + reduced_scattering / 2
    b = reduced_scattering / 2
    gamma = math.sqrt(absorption * (absorption + reduced_scattering))
    x = math.sqrt(3) * gamma * thickness
    r_inf = b / (a + gamma)
    c = 2 * gamma / (a + gamma)
    loss = -math.expm1(-2 * x)
    denominator = c + (1 - c) * loss
    return r_inf * loss / denominator, c * math.exp(-x) / denominator


def import_bosschaart(source: Path) -> None:
    root = ET.parse(source).getroot()
    permission = " ".join(root.find(".//permissions").itertext())
    if "Attribution 4.0 International" not in permission:
        raise ValueError("Expected corrected article's explicit CC BY 4.0 permission")
    table = root.find('.//table-wrap[@id="Taba"]')
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(["wavelength_nm", "absorption_oxy_mm_inv", "scattering_oxy_theory_mm_inv", "anisotropy_oxy_theory"])
    for row in table.findall(".//tr"):
        cells = ["".join(cell.itertext()) for cell in row]
        if cells[0].isdigit() and 360 <= int(cells[0]) <= 830:
            writer.writerow([cells[0], cells[1], cells[5], cells[7]])
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "bosschaart2014-oxygenated-visible.csv").write_text(out.getvalue())


def interpolate(rows: list[list[float]], wavelength: float) -> list[float]:
    i = max(1, min(len(rows) - 1, bisect.bisect_left([row[0] for row in rows], wavelength)))
    lo, hi = rows[i - 1], rows[i]
    t = (wavelength - lo[0]) / (hi[0] - lo[0])
    return [lo[j] + t * (hi[j] - lo[j]) for j in range(1, len(lo))]


def load_spectrum() -> list[tuple[float, float, tuple[float, float, float]]]:
    for name, expected in CIE_HASHES.items():
        if hashlib.sha256((DATA / name).read_bytes()).hexdigest() != expected:
            raise ValueError(f"CIE checksum mismatch: {name}")
    with (DATA / "bosschaart2014-oxygenated-visible.csv").open() as stream:
        rows = [[float(value) for value in row] for row in list(csv.reader(stream))[1:]]
    cie = {int(row[0]): tuple(map(float, row[1:])) for row in csv.reader((DATA / "CIE_xyz_1931_2deg.csv").open())}
    d65 = {int(row[0]): float(row[1]) for row in csv.reader((DATA / "CIE_std_illum_D65.csv").open())}
    normalization = sum((0.5 if nm in (360, 830) else 1) * cie[nm][1] * d65[nm] for nm in range(360, 831))
    result = []
    for nm in range(360, 831):
        absorption_mm, scattering_mm, g = interpolate(rows, nm)
        assert absorption_mm >= 0 and scattering_mm >= 0 and 0 <= g < 1
        weight = (0.5 if nm in (360, 830) else 1) * d65[nm] / normalization
        result.append((1000 * absorption_mm, 1000 * scattering_mm * (1 - g),
                       tuple(weight * component for component in cie[nm])))
    return result


def rgb(xyz: list[float]) -> list[float]:
    return [sum(a * b for a, b in zip(row, xyz)) for row in XYZ_TO_RGB]


def project_passive(reflection: list[float], transmission: list[float]) -> tuple[list[float], list[float], float]:
    """Explicit display-space approximation; physical passivity is also checked spectrally."""
    r, t, maximum_adjustment = [], [], 0.0
    for before_r, before_t in zip(reflection, transmission):
        after_r, after_t = max(0.0, before_r), max(0.0, before_t)
        scale = max(1.0, after_r + after_t)
        after_r, after_t = after_r / scale, after_t / scale
        maximum_adjustment = max(maximum_adjustment, abs(after_r - before_r), abs(after_t - before_t))
        r.append(after_r)
        t.append(after_t)
    return r, t, maximum_adjustment


def build() -> tuple[str, str]:
    spectrum = load_spectrum()
    white = rgb([sum(row[2][channel] for row in spectrum) for channel in range(3)])
    max_spectral_excess = 0.0
    max_projection = 0.0

    def evaluate(thickness: float) -> list[float]:
        nonlocal max_spectral_excess, max_projection
        reflection, transmission = [0.0] * 3, [0.0] * 3
        for absorption, reduced, weights in spectrum:
            r, t = slab(absorption, reduced, thickness)
            max_spectral_excess = max(max_spectral_excess, r + t - 1)
            for channel in range(3):
                reflection[channel] += weights[channel] * r
                transmission[channel] += weights[channel] * t
        r, t, adjustment = project_passive([value / white[i] for i, value in enumerate(rgb(reflection))],
                                          [value / white[i] for i, value in enumerate(rgb(transmission))])
        max_projection = max(max_projection, adjustment)
        return r + t

    entries = [evaluate(SCALE_M * math.expm1(LOG_MAX * i / (SAMPLES - 1))) for i in range(SAMPLES)]
    entries[0] = [0, 0, 0, 1, 1, 1]
    # Round-trip the actual stored precision for interpolation validation.
    entries = [[float(f"{value:.10g}") for value in entry] for entry in entries]
    maximum_error = 0.0
    worst_thickness = 0.0
    # Four non-node probes per interval: this validates the compressed lookup
    # against the spectral solver, not against samples from the same lookup.
    for i in range(SAMPLES - 1):
        for fraction in (0.125, 0.375, 0.625, 0.875):
            d = SCALE_M * math.expm1(LOG_MAX * (i + fraction) / (SAMPLES - 1))
            exact = evaluate(d)
            estimate = [entries[i][c] * (1 - fraction) + entries[i + 1][c] * fraction for c in range(6)]
            error = max(abs(a - b) for a, b in zip(exact, estimate))
            if error > maximum_error:
                maximum_error, worst_thickness = error, d
    if maximum_error > 2e-4:
        raise ValueError(f"LUT interpolation error exceeds budget: {maximum_error}")
    hashes = {name: hashlib.sha256((DATA / name).read_bytes()).hexdigest()
              for name in [*CIE_HASHES, "bosschaart2014-oxygenated-visible.csv"]}
    generated = (
        "// Generated by scripts/generate_blood_optics.py; do not hand-tune.\n"
        "// Data/derived LUT: CC BY-SA 4.0. Bosschaart et al.: CC BY 4.0; CIE: CC BY-SA 4.0.\n"
        "// Attribution and changes: blood/OPTICS.md and public/blood-optics-attribution.json.\n"
        f"export const BLOOD_LUT_SCALE_M = {SCALE_M!r};\n"
        f"export const BLOOD_LUT_MAX_M = {MAX_M!r};\n"
        f"export const BLOOD_LUT_LOG_MAX = {LOG_MAX!r};\n"
        "export const BLOOD_LUT = [\n"
        + "".join("  [" + ", ".join(f"{v:.10g}" for v in entry) + "],\n" for entry in entries)
        + "] as const;\n"
    )
    evidence = {
        "schema": "viscera.blood-optics-lut-validation/v1",
        "model": "two-ordinate reduced-scattering slab; fixed oxygenated endpoint; Hct 45%; D65/1931 observer",
        "spectralSamples": len(spectrum), "wavelengthRangeNm": [360, 830], "spectralStepNm": 1,
        "lutEntries": SAMPLES, "thicknessRangeM": [0, MAX_M], "logScaleM": SCALE_M,
        "interpolationProbes": 4 * (SAMPLES - 1), "maxAbsoluteRgbInterpolationError": maximum_error,
        "worstInterpolationThicknessM": worst_thickness, "interpolationErrorBudget": 2e-4,
        "maxSpectralPassivityExcess": max_spectral_excess,
        "maxRgbGamutProjectionAdjustment": max_projection,
        "sourceSha256": hashes,
        "checks": {
            "cieMetadataChecksums": True, "spectralPassivity": max_spectral_excess < 1e-12,
            "rgbInterpolation": maximum_error <= 2e-4,
        },
        "limitations": "No measured camera/light calibration, no Monte Carlo comparison or clinical realism validation.",
        "selectedThicknesses": [{"thicknessM": d, "reflectance": evaluate(d)[:3], "transmittance": evaluate(d)[3:]}
                               for d in (0, 1e-6, 1e-5, 1e-4, 1e-3, 1e-2, MAX_M)],
    }
    return generated, json.dumps(evidence, indent=2) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--import-bosschaart-xml", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.import_bosschaart_xml:
        import_bosschaart(args.import_bosschaart_xml)
    generated, evidence = build()
    for path, content in [(OUTPUT, generated), (EVIDENCE, evidence)]:
        if args.check:
            if not path.exists() or path.read_text() != content:
                raise SystemExit(f"Generated file differs: {path}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
    print("Blood spectral LUT verified" if args.check else "Blood spectral LUT generated")


if __name__ == "__main__":
    main()
