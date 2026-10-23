#!/usr/bin/env python3
"""Generate an experimental oxygenation/thickness LUT; no RGB colour fitting.

Run with the repository Python environment (numpy). --import-bosschaart-xml
imports attributed columns from the corrected article once; subsequent builds
are offline. The core fixed-oxygenation LUT and shader are not modified.
"""
from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET

import numpy as np

from generate_blood_optics import CIE_HASHES, DATA, MAX_M, ROOT, SCALE_M, XYZ_TO_RGB

CSV = DATA / "bosschaart2014-oxygenation-visible.csv"
OUTPUT = ROOT / "apps/studio/src/blood/experiments/bloodAppearanceLut.generated.ts"
EVIDENCE = ROOT / "blood/optics/appearance-lut-validation.json"
THICKNESS_COUNT = 512
SATURATION_COUNT = 65
LOG_MAX = math.log1p(MAX_M / SCALE_M)
ERROR_BUDGET = 5e-4
XML_SHA256 = "00cfdd11ae45bda9c351ce61768092177bd3522cd4a5e3e8106153f3d6c150a2"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def import_bosschaart(source: Path) -> None:
    if sha256(source) != XML_SHA256:
        raise ValueError("Expected the reviewed corrected Bosschaart XML; review changed sources first")
    root = ET.parse(source).getroot()
    if "Attribution 4.0 International" not in " ".join(root.find(".//permissions").itertext()):
        raise ValueError("Blood table CC BY 4.0 permission missing")
    table = root.find('.//table-wrap[@id="Taba"]')
    rows = [[ "".join(cell.itertext()) for cell in row] for row in table.findall(".//tr")]
    # Guard the column mapping as well as the source hash.
    if [">" in rows[1][i] for i in (1, 2, 5, 6, 7, 8)] != [True, False, True, False, True, False]:
        raise ValueError("Unexpected oxygenation table headings")
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(["wavelength_nm", "absorption_oxy_mm_inv", "absorption_deoxy_mm_inv",
                     "scattering_oxy_theory_mm_inv", "scattering_deoxy_theory_mm_inv",
                     "anisotropy_oxy_theory", "anisotropy_deoxy_theory"])
    for row in rows:
        if row[0].isdigit() and 360 <= int(row[0]) <= 830:
            writer.writerow([row[i] for i in (0, 1, 2, 5, 6, 7, 8)])
    CSV.write_text(out.getvalue())


def load_spectra():
    for name, expected in CIE_HASHES.items():
        if sha256(DATA / name) != expected:
            raise ValueError(f"CIE checksum mismatch: {name}")
    rows = np.loadtxt(CSV, delimiter=",", skiprows=1)
    wavelengths = np.arange(360, 831)
    # First interpolate the published mu_s and g separately, matching the core
    # endpoint convention, then form mu_s'. Mix oxygenation in mu_s', not in g.
    fields = np.array([np.interp(wavelengths, rows[:, 0], rows[:, i]) for i in range(1, 7)])
    a_oxy, a_deoxy, s_oxy, s_deoxy, g_oxy, g_deoxy = fields
    if np.any(fields[:4] < 0) or np.any(fields[4:] < 0) or np.any(fields[4:] >= 1):
        raise ValueError("Invalid published coefficients")
    cie_rows = np.loadtxt(DATA / "CIE_xyz_1931_2deg.csv", delimiter=",")
    d65_rows = np.loadtxt(DATA / "CIE_std_illum_D65.csv", delimiter=",")
    cie = cie_rows[(cie_rows[:, 0] >= 360) & (cie_rows[:, 0] <= 830), 1:]
    d65 = np.interp(wavelengths, d65_rows[:, 0], d65_rows[:, 1])
    weights = np.ones(len(wavelengths))
    weights[[0, -1]] = .5
    weights *= d65
    weights /= np.sum(weights * cie[:, 1])
    xyz_weights = cie * weights[:, None]
    # This is linear color integration. Negative contributions are retained
    # until the entire spectrum is integrated, then the R/T pair is projected.
    rgb_weights = xyz_weights @ np.array(XYZ_TO_RGB).T
    rgb_weights /= np.sum(rgb_weights, axis=0)
    return (1000 * a_oxy, 1000 * a_deoxy, 1000 * s_oxy * (1 - g_oxy),
            1000 * s_deoxy * (1 - g_deoxy), rgb_weights)


class SpectralEvaluator:
    def __init__(self):
        self.a_oxy, self.a_deoxy, self.s_oxy, self.s_deoxy, self.weights = load_spectra()
        self.max_spectral_excess = 0.
        self.max_projection = 0.

    def evaluate(self, thicknesses, saturation):
        d = np.asarray(thicknesses).reshape(-1, 1)
        a = self.a_deoxy + saturation * (self.a_oxy - self.a_deoxy)
        s = self.s_deoxy + saturation * (self.s_oxy - self.s_deoxy)
        gamma = np.sqrt(a * (a + s))
        denominator0 = a + s / 2 + gamma
        r_inf, c = (s / 2) / denominator0, 2 * gamma / denominator0
        x = math.sqrt(3) * d * gamma
        loss = -np.expm1(-2 * x)
        denominator = c + (1 - c) * loss
        r, t = r_inf * loss / denominator, c * np.exp(-x) / denominator
        self.max_spectral_excess = max(self.max_spectral_excess, float(np.max(r + t - 1)))
        # np.sum has deterministic reduction order; avoids BLAS configuration
        # affecting last-bit stored-data checks.
        rgb_r = np.sum(r[:, :, None] * self.weights[None, :, :], axis=1)
        rgb_t = np.sum(t[:, :, None] * self.weights[None, :, :], axis=1)
        positive_r, positive_t = np.maximum(0, rgb_r), np.maximum(0, rgb_t)
        normalization = np.maximum(1, positive_r + positive_t)
        projected_r, projected_t = positive_r / normalization, positive_t / normalization
        self.max_projection = max(self.max_projection, float(np.max(abs(projected_r - rgb_r))),
                                  float(np.max(abs(projected_t - rgb_t))))
        result = np.concatenate([projected_r, projected_t], axis=1)
        result[d[:, 0] == 0] = [0, 0, 0, 1, 1, 1]
        return result


def build():
    evaluator = SpectralEvaluator()
    # More nodes near the highly oxygenated endpoint, where red attenuation
    # changes most rapidly. Runtime interpolation is linear in actual fraction.
    saturations = 1 - (1 - np.linspace(0, 1, SATURATION_COUNT)) ** 2
    thicknesses = SCALE_M * np.expm1(np.linspace(0, LOG_MAX, THICKNESS_COUNT))
    table = np.array([evaluator.evaluate(thicknesses, float(s)) for s in saturations], dtype="<f4")
    maximum_error, worst = 0., None
    probes = 0
    # Four off-node thickness probes crossed with two off-node oxygenation
    # probes in EVERY cell; compare to fresh wavelength-domain solutions.
    for j in range(SATURATION_COUNT - 1):
        for sf in (.25, .75):
            saturation = saturations[j] + sf * (saturations[j + 1] - saturations[j])
            slice_ = table[j].astype(float) * (1 - sf) + table[j + 1].astype(float) * sf
            for df in (.125, .375, .625, .875):
                d = SCALE_M * np.expm1(LOG_MAX * (np.arange(THICKNESS_COUNT - 1) + df) / (THICKNESS_COUNT - 1))
                exact = evaluator.evaluate(d, float(saturation))
                estimate = slice_[:-1] * (1 - df) + slice_[1:] * df
                error = np.max(abs(exact - estimate), axis=1)
                index = int(np.argmax(error))
                if float(error[index]) > maximum_error:
                    maximum_error = float(error[index])
                    worst = {"thicknessM": float(d[index]), "oxygenationFraction": float(saturation)}
                probes += len(d)
    if maximum_error > ERROR_BUDGET:
        raise ValueError(f"Interpolation error {maximum_error} > {ERROR_BUDGET}; increase LUT resolution")
    binary = table.tobytes(order="C")
    b64 = base64.b64encode(binary).decode()
    generated = (
        "// Generated by scripts/generate_blood_appearance_optics.py; do not hand-tune.\n"
        "// Derived data CC BY-SA 4.0; source blood CC BY 4.0; CIE CC BY-SA 4.0.\n"
        "// Attribution: public/blood-optics-attribution.json experimentalAppearance.\n"
        f"export const APPEARANCE_THICKNESS_COUNT = {THICKNESS_COUNT};\n"
        f"export const APPEARANCE_SCALE_M = {SCALE_M!r};\n"
        f"export const APPEARANCE_MAX_M = {MAX_M!r};\n"
        f"export const APPEARANCE_LOG_MAX = {LOG_MAX!r};\n"
        "export const APPEARANCE_SATURATIONS: readonly number[] = "
        + json.dumps(saturations.tolist(), separators=(",", ":")) + ";\n"
        "// Little-endian IEEE754 float32, saturation-major / thickness / RGB,RGB.\n"
        "// Base64 whitespace is permitted by atob; a single literal avoids a deep AST.\n"
        "export const APPEARANCE_LUT_BASE64 = `\n"
        + "\n".join(b64[i:i + 120] for i in range(0, len(b64), 120)) + "\n`;\n"
    )
    selected = [{"thicknessM": d, "oxygenationFraction": s,
                 "reflectance": evaluator.evaluate([d], s)[0, :3].tolist(),
                 "transmittance": evaluator.evaluate([d], s)[0, 3:].tolist()}
                for s in (0, .6, .75, .98, 1) for d in (0, 1e-6, 1e-4, .001, .012, MAX_M)]
    evidence = {
        "schema": "viscera.blood-appearance-lut-validation/v1",
        "method": "Spectral endpoint-coefficient interpolation, two-ordinate slab, Hct45/D65/CIE1931",
        "thicknessEntries": THICKNESS_COUNT, "oxygenationEntries": SATURATION_COUNT,
        "wavelengthRangeNm": [360, 830], "spectralStepNm": 1, "spectralSamples": 471,
        "oxygenationRange": [0, 1], "thicknessRangeM": [0, MAX_M],
        "storedBytes": len(binary), "storedType": "little-endian float32",
        "storedSha256": hashlib.sha256(binary).hexdigest(),
        "sourceSha256": {**{name: sha256(DATA / name) for name in CIE_HASHES}, CSV.name: sha256(CSV)},
        "sourceXmlSha256": XML_SHA256,
        "offNodeInterpolationProbes": probes, "maxAbsoluteRgbInterpolationError": maximum_error,
        "worstInterpolationProbe": worst, "errorBudget": ERROR_BUDGET,
        "maxSpectralPassivityExcess": evaluator.max_spectral_excess,
        "maxRgbGamutProjectionAdjustment": evaluator.max_projection,
        "selectedSpectralSolutions": selected,
        "limitations": [
            "Endpoint interpolation of already-flattened absorption is approximate; not an intracellular partial-oxygenation model.",
            "Reduced scattering is linearly interpolated from theoretical endpoint coefficients; not measured intermediate-saturation scattering.",
            "Endpoint fraction 1 represents published SO2>98%, not a precisely measured 100% spectrum.",
            "No clinical, camera, illumination, angular-transport, or photorealism validation.",
        ],
    }
    return generated, json.dumps(evidence, indent=2) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--import-bosschaart-xml", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.import_bosschaart_xml:
        import_bosschaart(args.import_bosschaart_xml)
    generated, evidence = build()
    for path, content in ((OUTPUT, generated), (EVIDENCE, evidence)):
        if args.check:
            if not path.exists() or path.read_text() != content:
                raise SystemExit(f"Generated output differs: {path}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
    print("Experimental blood appearance LUT verified" if args.check else "Experimental blood appearance LUT generated")


if __name__ == "__main__":
    main()
