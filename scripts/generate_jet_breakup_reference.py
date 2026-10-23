#!/usr/bin/env python3
"""80-digit independent root fixtures for the declared long-wave jet model.

The exact inviscid Bessel-cylinder maximum is included to quantify a known model
approximation; agreement with these numerical fixtures is not blood validation.
"""
import argparse
import json
from pathlib import Path

import mpmath as mp

mp.mp.dps = 80
ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "blood/jet-breakup-reference.json"


def build():
    rho, sigma, amplitude = mp.mpf(1060), mp.mpf(".055"), mp.mpf(".01")
    cases = []
    for radius in (".0002", ".0004", ".0006"):
        for viscosity in (".00345", ".01", ".03"):
            r, mu = mp.mpf(radius), mp.mpf(viscosity)
            oh = mu / mp.sqrt(rho * sigma * r)
            kappa = (2 + 3 * mp.sqrt(2) * oh) ** -mp.mpf(".5")
            wave = kappa / r
            drive = sigma / (2 * rho * r ** 3) * (kappa ** 2 - kappa ** 4)
            # Independent root of ω²+3νk²ω−drive, rather than the runtime's
            # rationalized nondimensional expression.
            growth = mp.findroot(lambda omega: omega ** 2 + 3 * mu / rho * wave ** 2 * omega - drive,
                                 (mp.sqrt(drive) / 4, mp.sqrt(drive)))
            cases.append({"radiusM": float(r), "densityKgM3": 1060, "viscosityPaS": float(mu),
                          "surfaceTensionNM": .055, "initialRelativeAmplitude": .01,
                          "ohnesorge": float(oh), "dimensionlessWavenumber": float(kappa),
                          "wavelengthM": float(2 * mp.pi / wave), "growthRateSInv": float(growth),
                          "capillaryTimeSeconds": float(mp.sqrt(rho * r ** 3 / sigma)),
                          "breakupAgeSeconds": float(-mp.log(amplitude) / growth)})
    exact_growth = lambda x: mp.sqrt(x * (1 - x * x) * mp.besseli(1, x) / mp.besseli(0, x))
    exact_kappa = mp.findroot(lambda x: mp.diff(exact_growth, x), (.65, .75))
    approximate_growth = 1 / (2 * mp.sqrt(2))
    return json.dumps({
        "schema": "viscera.jet-breakup-reference/v1",
        "precisionDigits": 80,
        "source": "Driessen et al. 2013, equations 2–5, https://arxiv.org/pdf/1307.3139",
        "inviscidReferenceSource": "Pekker 2017, equation 2 (Rayleigh inviscid Bessel form), https://arxiv.org/pdf/1712.07069",
        "method": "mpmath root of dimensional quadratic growth equation; exact inviscid Bessel-cylinder maximum separately solved",
        "cases": cases,
        "knownInviscidLongWaveApproximation": {
            "exactKappa": float(exact_kappa), "exactOmegaTimesCapillaryTime": float(exact_growth(exact_kappa)),
            "longWaveKappa": float(1 / mp.sqrt(2)), "longWaveOmegaTimesCapillaryTime": float(approximate_growth),
            "relativeGrowthOverestimate": float(approximate_growth / exact_growth(exact_kappa) - 1),
            "exactWavelengthOverRadius": float(2 * mp.pi / exact_kappa),
        },
        "limits": "Numerical equation reference only; no measured blood disturbance, breakup-length, drop-size or nonlinear pinch validation.",
    }, indent=2) + "\n"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    content = build()
    if args.check:
        if OUTPUT.read_text() != content:
            raise SystemExit("Jet reference differs")
    else:
        OUTPUT.write_text(content)
    print("Jet breakup reference verified" if args.check else "Jet breakup reference generated")
