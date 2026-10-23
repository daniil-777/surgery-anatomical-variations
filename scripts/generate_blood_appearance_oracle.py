#!/usr/bin/env python3
"""Independent optical fixture: matrix exponential + layer doubling.

Uses numpy/scipy in the repository Python environment. Does not import the LUT
generator, its slab equation, coefficient loader, or display integration code.
This validates the declared approximation numerically, not its physical fidelity.
"""
from __future__ import annotations

import argparse
import bisect
import csv
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from scipy.linalg import expm

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "blood/optics/data"
OUTPUT = ROOT / "blood/optics/appearance-matrix-oracle.json"


def build():
    csv_path = DATA / "bosschaart2014-oxygenation-visible.csv"
    with csv_path.open() as f:
        rows = [[float(v) for v in row] for row in list(csv.reader(f))[1:]]
    cie = {int(row[0]): list(map(float, row[1:])) for row in csv.reader((DATA / "CIE_xyz_1931_2deg.csv").open())}
    d65 = {int(row[0]): float(row[1]) for row in csv.reader((DATA / "CIE_std_illum_D65.csv").open())}
    coefficients, weights = [], []
    for nm in range(360, 831):
        i = max(1, min(len(rows) - 1, bisect.bisect_left([r[0] for r in rows], nm)))
        lower, upper = rows[i - 1], rows[i]
        fraction = (nm - lower[0]) / (upper[0] - lower[0])
        values = [lower[c] * (1 - fraction) + upper[c] * fraction for c in range(1, 7)]
        ao, ad, so, sd, go, gd = values
        coefficients.append([ao * 1000, ad * 1000, so * (1 - go) * 1000, sd * (1 - gd) * 1000])
        weights.append([c * d65[nm] * (.5 if nm in (360, 830) else 1) for c in cie[nm]])
    weights = np.array(weights)
    normalization = sum(weights[:, 1])
    weights /= normalization
    coefficients = np.array(coefficients)
    matrix = np.array([[3.2404542, -1.5371385, -.4985314],
                       [-.9692660, 1.8760108, .0415560],
                       [.0556434, -.2040259, 1.0572252]])
    white = matrix @ np.sum(weights, axis=0)
    max_passivity = 0.
    cases = []
    for saturation in (0., .37, .75, .98, 1.):
        absorption = coefficients[:, 0] * saturation + coefficients[:, 1] * (1 - saturation)
        reduced = coefficients[:, 2] * saturation + coefficients[:, 3] * (1 - saturation)
        a, b = absorption + reduced / 2, reduced / 2
        operator = np.zeros((471, 2, 2))
        operator[:, 0, 0] = -a
        operator[:, 0, 1] = b
        operator[:, 1, 0] = -b
        operator[:, 1, 1] = a
        operator *= math.sqrt(3)
        for thickness in (1e-6, .0001, .001, .012, .05):
            # Keep expm's arguments small, then stack identical passive layers.
            # For trace(A)=0 the determinant of exp(A d) is 1. Solving
            # I+(0)=1, I-(d)=0 gives R=-M10/M11 and T=1/M11.
            levels = max(0, math.ceil(math.log2(max(1, float(np.max(abs(operator))) * thickness / .125))))
            transfer = expm(operator * (thickness / 2 ** levels))
            r, t = -transfer[:, 1, 0] / transfer[:, 1, 1], 1 / transfer[:, 1, 1]
            for _ in range(levels):
                denominator = 1 - r * r
                r, t = r + t * t * r / denominator, t * t / denominator
            max_passivity = max(max_passivity, float(np.max(r + t - 1)))
            raw_r = (matrix @ np.sum(weights * r[:, None], axis=0)) / white
            raw_t = (matrix @ np.sum(weights * t[:, None], axis=0)) / white
            projected_r, projected_t = np.maximum(0, raw_r), np.maximum(0, raw_t)
            scale = np.maximum(1, projected_r + projected_t)
            cases.append({"oxygenationFraction": saturation, "thicknessM": thickness,
                          "reflectance": (projected_r / scale).tolist(),
                          "transmittance": (projected_t / scale).tolist(),
                          "matrixDoublingLevels": levels})
    return json.dumps({
        "schema": "viscera.blood-appearance-matrix-oracle/v1",
        "method": "Scipy matrix exponential of the independent two-direction ODE operator on short slabs; repeated symmetric layer adding; independently loaded spectral coefficients and D65/CIE integration",
        "notImported": ["generate_blood_appearance_optics", "generate_blood_optics", "generated LUT"],
        "maxSpectralPassivityExcess": max_passivity,
        "sourceCsvSha256": hashlib.sha256(csv_path.read_bytes()).hexdigest(),
        "cases": cases,
        "limits": "Binary64 numerical reference of the specified closure only; no measured-camera or full-RTE validation.",
    }, indent=2) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    content = build()
    if args.check:
        if OUTPUT.read_text() != content:
            raise SystemExit("Independent optical reference changed")
    else:
        OUTPUT.write_text(content)
    print("Independent spectral matrix oracle verified" if args.check else "Independent spectral matrix oracle generated")


if __name__ == "__main__":
    main()
