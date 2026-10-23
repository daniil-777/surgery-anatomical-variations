#!/usr/bin/env python3
"""Independent tube-flow oracles. Never imports the application solver.

Requires mpmath; scipy is used only as an independent double-precision check.
Run from viscera: .venv/bin/python scripts/generate_artery_references.py [--check]
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import mpmath as mp

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "apps/studio/src/blood/artery"
WOMERSLEY_SOURCE = "https://doi.org/10.1113/jphysiol.1955.sp005276"
WOMERSLEY_PDF = "https://pdodds.w3.uvm.edu/files/papers/others/1955/womersley1955a.pdf"
WEDDELL_SOURCE = "https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0124575"
RADII = ["0", "0.25", "0.5", "0.75", "0.9", "1"]


def real(value):
    return float(value)


def scalar(value):
    return {"value": real(value), "decimal": mp.nstr(value, 45)}


def complex_value(value):
    return {
        "re": real(mp.re(value)),
        "im": real(mp.im(value)),
        "reDecimal": mp.nstr(mp.re(value), 45),
        "imDecimal": mp.nstr(mp.im(value), 45),
        "amplitude": real(abs(value)),
        "phaseRad": real(mp.arg(value)) if value else 0,
    }


def provenance():
    return {
        "generator": "scripts/generate_artery_references.py",
        "generatorSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "mpmathVersion": mp.__version__,
        "decimalPrecision": mp.mp.dps,
        "independence": "Direct analytical Bessel / constitutive quadrature; no application solver imports.",
        "purpose": "Numerical verification fixtures, not patient-specific or experimental blood measurements.",
    }


def womersley_reference():
    radius, density, mu = map(mp.mpf, [".003", "1060", ".00345"])
    heart_rate, mean_g, harmonic_g = map(mp.mpf, ["72", "300", "200"])
    omega = 2 * mp.pi * heart_rate / 60
    period = 2 * mp.pi / omega
    alpha = radius * mp.sqrt(density * omega / mu)
    z = alpha * mp.exp(3 * mp.pi * 1j / 4)
    j0 = mp.besselj(0, z)
    prefactor = harmonic_g / (1j * density * omega)

    def mean_u(x):
        return mean_g * radius**2 * (1 - x**2) / (4 * mu)

    def harmonic_u(x):
        return prefactor * (1 - mp.besselj(0, z * x) / j0)

    mean_q = mp.pi * mean_g * radius**4 / (8 * mu)
    harmonic_q = mp.pi * radius**2 * prefactor * (1 - 2 * mp.besselj(1, z) / (z * j0))
    mean_tau = mean_g * radius / 2
    harmonic_tau = -mu * prefactor * z * mp.besselj(1, z) / (radius * j0)
    integrated_q = 2 * mp.pi * radius**2 * mp.quad(lambda x: harmonic_u(x) * x, [0, 1])
    balance = 1j * omega * density * harmonic_q - (mp.pi * radius**2 * harmonic_g - 2 * mp.pi * radius * harmonic_tau)
    residuals = []
    for x in map(mp.mpf, [".1", ".25", ".5", ".75", ".9"]):
        viscous = mu / radius**2 * (mp.diff(harmonic_u, x, 2) + mp.diff(harmonic_u, x) / x)
        residuals.append(abs(1j * omega * density * harmonic_u(x) - harmonic_g - viscous) / harmonic_g)
    quadrature_error = abs(integrated_q - harmonic_q) / abs(harmonic_q)
    balance_error = abs(balance) / abs(mp.pi * radius**2 * harmonic_g)
    assert quadrature_error < mp.mpf("1e-65")
    assert balance_error < mp.mpf("1e-65")
    assert max(residuals) < mp.mpf("1e-65")
    assert harmonic_u(mp.mpf(1)) == 0
    assert mp.re(harmonic_q) > 0 and mp.im(harmonic_q) < 0

    profiles = [
        {
            "radiusFraction": real(x),
            "radiusM": real(x * radius),
            "meanVelocityMS": scalar(mean_u(x)),
            "harmonicVelocityMS": complex_value(harmonic_u(x)),
        }
        for x in map(mp.mpf, RADII)
    ]
    phases = []
    for fraction in [mp.mpf(i) / 8 for i in range(8)]:
        phase = 2 * mp.pi * fraction
        exponential = mp.exp(1j * phase)
        phases.append({
            "cycleFraction": real(fraction),
            "timeSeconds": real(fraction * period),
            "pressureGradientPaPerM": real(mean_g + harmonic_g * mp.cos(phase)),
            "flowRateM3S": real(mean_q + mp.re(harmonic_q * exponential)),
            "wallTractionOnSolidPa": real(mean_tau + mp.re(harmonic_tau * exponential)),
            "velocityMS": [real(mean_u(mp.mpf(x)) + mp.re(harmonic_u(mp.mpf(x)) * exponential)) for x in RADII],
        })

    # Separate implementation/library: scipy's double-precision Bessel routine.
    import scipy
    from scipy.special import jv
    z64, prefactor64 = complex(z), complex(prefactor)
    scipy_values = [prefactor64 * (1 - jv(0, z64 * float(x)) / jv(0, z64)) for x in RADII]
    scaled_errors = [abs(value - complex(harmonic_u(mp.mpf(x)))) / float(abs(prefactor)) for value, x in zip(scipy_values, RADII)]
    assert max(scaled_errors) < 2e-14

    return {
        "schema": "viscera.artery.womersley-reference/v1",
        "provenance": provenance(),
        "sources": [
            {"title": "Womersley 1955, Journal of Physiology 127:553–563", "url": WOMERSLEY_SOURCE, "fullText": WOMERSLEY_PDF, "equationsChecked": "Eqs. 3–9 on p. 554; Eq. 9 velocity solution read directly from original scan."},
            {"title": "Weddell et al. 2015: density and Newtonian infinite-shear viscosity", "url": WEDDELL_SOURCE},
        ],
        "inputs": {
            "radiusM": real(radius), "densityKgM3": real(density), "dynamicViscosityPaS": real(mu),
            "heartRateBpm": real(heart_rate), "meanPressureGradientPaPerM": real(mean_g), "harmonicPressureGradientPaPerM": real(harmonic_g),
        },
        "phaseConvention": {
            "pressureGradient": "G(t)=-dp/dz=G0+G1*cos(omega*t); positive G drives positive axial flow.",
            "response": "u(r,t)=meanU(r)+Re[harmonicU(r)*exp(i*omega*t)]; same convention for Q and wall traction.",
            "coefficientInterpretation": "Re(harmonic) is the cosine coefficient; -Im(harmonic) is the sine coefficient. phaseRad<0 indicates lag.",
            "wallTraction": "Positive axial traction exerted by fluid on the solid wall: tau=-mu*du/dr at r=R. Solid-on-fluid traction has the opposite sign.",
            "initialization": "Periodic steady state; not the solution immediately after starting from rest.",
        },
        "equations": {
            "pde": "rho*du/dt=G(t)+(mu/r)*d/dr(r*du/dr)",
            "boundaryConditions": "du/dr(0,t)=0; u(R,t)=0; straight, rigid, circular, fully developed, axisymmetric tube.",
            "alpha": "R*sqrt(rho*omega/mu)",
            "z": "alpha*exp(3*pi*i/4); z^2=-i*alpha^2",
            "meanU": "G0*(R^2-r^2)/(4*mu)",
            "harmonicU": "G1/(i*rho*omega)*(1-J0(z*r/R)/J0(z))",
            "meanQ": "pi*G0*R^4/(8*mu)",
            "harmonicQ": "pi*R^2*G1/(i*rho*omega)*(1-2*J1(z)/(z*J0(z)))",
            "meanWallTraction": "G0*R/2",
            "harmonicWallTraction": "-mu*G1/(i*rho*omega)*(z/R)*J1(z)/J0(z)",
            "integratedMomentum": "rho*dQ/dt=pi*R^2*G(t)-2*pi*R*tau(t)",
        },
        "derived": {
            "omegaRadS": scalar(omega), "periodSeconds": scalar(period), "womersleyAlpha": scalar(alpha),
            "kinematicViscosityM2S": scalar(mu / density),
            "meanVelocityMS": scalar(mean_q / (mp.pi * radius**2)),
            "meanReynoldsNumberUsingDiameter": scalar(density * mean_q / (mp.pi * radius**2) * 2 * radius / mu),
            "slowestNewtonianStartupDecaySeconds": scalar(density * radius**2 / (mu * mp.besseljzero(0, 1)**2)),
        },
        "flowRate": {"meanM3S": scalar(mean_q), "harmonicM3S": complex_value(harmonic_q)},
        "wallTractionOnSolid": {"meanPa": scalar(mean_tau), "harmonicPa": complex_value(harmonic_tau)},
        "radialProfiles": profiles,
        "phaseSamples": phases,
        "selfChecks": {
            "harmonicFlowClosedFormVsRadialQuadratureRelativeError": real(quadrature_error),
            "integratedMomentumRelativeResidual": real(balance_error),
            "maximumLocalPdeRelativeResidual": real(max(residuals)),
            "independentScipyVersion": scipy.__version__,
            "maximumScipyVelocityErrorScaledByHarmonicPrefactor": max(scaled_errors),
            "noSlipExact": True,
        },
    }


def carreau_steady_reference():
    radius, gradient = mp.mpf(".003"), mp.mpf("300")
    mu0, mu_inf, lam, a, n = map(mp.mpf, [".056", ".00345", "1.902", "1.25", ".22"])

    def viscosity(gamma):
        return mu_inf + (mu0 - mu_inf) * (1 + (lam * gamma)**a)**((n - 1) / a)

    def tau(gamma):
        return viscosity(gamma) * gamma

    def tau_prime(gamma):
        x = (lam * gamma)**a
        return mu_inf + (mu0 - mu_inf) * (1 + x)**((n - 1) / a - 1) * (1 + n * x)

    def inverse_tau(target):
        if not target:
            return mp.mpf(0)
        # Bracket is rigorous for a CY profile bounded by mu_inf and mu0.
        return mp.findroot(lambda gamma: tau(gamma) - target, (target / mu0, target / mu_inf), solver="illinois", tol=mp.mpf("1e-72"), maxsteps=1000)

    wall_tau = gradient * radius / 2
    wall_gamma = inverse_tau(wall_tau)

    def velocity(x):
        gamma = inverse_tau(wall_tau * x)
        return 2 / gradient * mp.quad(lambda g: g * tau_prime(g), [gamma, wall_gamma])

    # Change variables from r to shear rate using r=2*tau(gamma)/G.
    flow = 8 * mp.pi / gradient**3 * mp.quad(lambda g: g * tau(g)**2 * tau_prime(g), [0, wall_gamma])
    profiles = []
    for x in map(mp.mpf, RADII):
        gamma = inverse_tau(wall_tau * x)
        assert abs(tau(gamma) - wall_tau * x) < mp.mpf("1e-65")
        profiles.append({
            "radiusFraction": real(x), "velocityMS": scalar(velocity(x)),
            "shearRatePerS": scalar(gamma), "viscosityPaS": scalar(viscosity(gamma)),
            "shearStressMagnitudePa": scalar(wall_tau * x),
        })
    assert flow > 0 and flow < mp.pi * gradient * radius**4 / (8 * mu_inf)
    # Independent double-precision radial-space inversion and integration, rather
    # than the high-precision shear-rate variable change used above.
    from scipy.integrate import quad
    from scipy.optimize import brentq
    mu0_f, mu_inf_f, lam_f, a_f, n_f = map(float, [mu0, mu_inf, lam, a, n])

    def gamma_at_r(r):
        target = float(gradient) * r / 2
        if target == 0:
            return 0.0

        def constitutive_residual(g):
            viscosity_f = mu_inf_f + (mu0_f - mu_inf_f) * (1 + (lam_f * g)**a_f)**((n_f - 1) / a_f)
            return viscosity_f * g - target

        return brentq(constitutive_residual, target / mu0_f, target / mu_inf_f, xtol=1e-14, rtol=1e-14)

    radial_flow = float(mp.pi) * quad(lambda r: gamma_at_r(r) * r**2, 0, float(radius), epsabs=1e-16, epsrel=1e-12)[0]
    radial_centre_u = quad(gamma_at_r, 0, float(radius), epsabs=1e-14, epsrel=1e-12)[0]
    flow_error = abs(radial_flow - float(flow)) / float(flow)
    centre_error = abs(radial_centre_u - float(velocity(mp.mpf(0)))) / float(velocity(mp.mpf(0)))
    assert flow_error < 1e-11 and centre_error < 1e-11
    return {
        "schema": "viscera.artery.carreau-steady-reference/v1", "provenance": provenance(),
        "source": WEDDELL_SOURCE,
        "inputs": {
            "radiusM": real(radius), "pressureGradientPaPerM": real(gradient),
            "mu0PaS": real(mu0), "muInfPaS": real(mu_inf), "lambdaSeconds": real(lam), "a": real(a), "n": real(n),
        },
        "equations": {
            "viscosity": "mu(gamma)=muInf+(mu0-muInf)*(1+(lambda*gamma)^a)^((n-1)/a)",
            "steadyStress": "tau(r)=G*r/2=mu(gamma)*gamma; gamma=-du/dr>=0",
            "velocity": "u(r)=integral(r,R,gamma(s) ds)",
            "flowRate": "Q=pi*integral(0,R,gamma(r)*r^2 dr)",
            "quadratureVariableChange": "r=2*tau(gamma)/G; u=2/G*integral(gamma(r),gammaWall,gamma*tauPrime dgamma); Q=8*pi/G^3*integral(0,gammaWall,gamma*tau^2*tauPrime dgamma)",
            "boundaryConditions": "Rigid straight circular tube; no slip at physical R; symmetry at r=0; fully developed steady flow.",
        },
        "flowRateM3S": scalar(flow), "meanVelocityMS": scalar(flow / (mp.pi * radius**2)),
        "wallTractionOnSolidPa": scalar(wall_tau), "wallShearRatePerS": scalar(wall_gamma),
        "radialProfiles": profiles,
        "selfChecks": {
            "independentScipyRadialFlowRelativeError": flow_error,
            "independentScipyRadialCentreVelocityRelativeError": centre_error,
            "method": "scipy brentq constitutive inversion at each physical radius, then scipy quad in radius; distinct from mpmath shear-rate-variable integration.",
        },
        "interpretation": "Independent constitutive inversion and quadrature. No radial grid and no time integration are used. Density does not enter this steady oracle.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify checked-in numerical oracles without rewriting them.")
    args = parser.parse_args()
    mp.mp.dps = 80
    fixtures = {
        "womersley-reference.json": womersley_reference(),
        "carreau-steady-reference.json": carreau_steady_reference(),
    }
    for name, fixture in fixtures.items():
        text = json.dumps(fixture, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        path = OUTPUT / name
        if args.check:
            if path.read_text() != text:
                raise SystemExit(f"Reference differs: {path}")
        else:
            OUTPUT.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        print(f"{'verified' if args.check else 'wrote'} {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
