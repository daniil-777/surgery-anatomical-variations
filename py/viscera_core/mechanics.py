"""Verified polynomial Neo-Hookean Eq. 13 pilot, in metres–kg–seconds.

This is the rest-stable quadratic-J variant in Smith et al. (2018), not the
final log(Ic+1)-regularized Eq. 14 model or its collapse-handling guarantees.

This module does not implement organ contact, viscoelasticity or human tissue
validation. Its patch-compression fixture is deliberately NOT canonical T1.
"""

from __future__ import annotations

import argparse
import itertools
import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np
from scipy.optimize import minimize


@dataclass(frozen=True)
class Material:
    young_pa: float = 5000.0
    poisson: float = 0.35

    def coefficients(self) -> tuple[float, float]:
        if not np.isfinite(self.young_pa) or self.young_pa <= 0:
            raise ValueError("Young modulus must be finite and positive")
        if not np.isfinite(self.poisson) or not -0.99 < self.poisson < 0.499:
            raise ValueError("Pilot Poisson ratio must lie in (-0.99, .499)")
        mu = self.young_pa / (2 * (1 + self.poisson))
        lame = self.young_pa * self.poisson / ((1 + self.poisson) * (1 - 2 * self.poisson))
        return mu, lame + mu


def cofactor(f: np.ndarray) -> np.ndarray:
    """Polynomial cofactor; remains defined for singular deformation gradients."""
    return np.stack(
        (
            np.cross(f[..., :, 1], f[..., :, 2]),
            np.cross(f[..., :, 2], f[..., :, 0]),
            np.cross(f[..., :, 0], f[..., :, 1]),
        ),
        axis=-1,
    )


def energy_stress(f: np.ndarray, material: Material) -> tuple[np.ndarray, np.ndarray]:
    """Return rest-offset SNH energy [Pa] and first Piola stress [Pa]."""
    f = np.asarray(f, dtype=np.float64)
    if f.shape[-2:] != (3, 3) or not np.isfinite(f).all():
        raise ValueError("F must contain finite 3x3 matrices")
    mu, lam = material.coefficients()
    j = np.linalg.det(f)
    alpha = 1 + mu / lam
    energy = mu / 2 * (np.sum(f * f, axis=(-2, -1)) - 3) + lam / 2 * (
        (j - alpha) ** 2 - (1 - alpha) ** 2
    )
    stress = mu * f + (lam * (j - alpha))[..., None, None] * cofactor(f)
    return energy, stress


def tangent_action(f: np.ndarray, df: np.ndarray, material: Material) -> np.ndarray:
    """Exact directional derivative of Piola stress, including cofactor terms."""
    mu, lam = material.coefficients()
    c = cofactor(f)
    dc = np.stack(
        (
            np.cross(df[:, 1], f[:, 2]) + np.cross(f[:, 1], df[:, 2]),
            np.cross(df[:, 2], f[:, 0]) + np.cross(f[:, 2], df[:, 0]),
            np.cross(df[:, 0], f[:, 1]) + np.cross(f[:, 0], df[:, 1]),
        ),
        axis=-1,
    )
    return np.asarray(mu * df + lam * (np.sum(c * df) * c + (np.linalg.det(f) - 1 - mu / lam) * dc))


def block_mesh(
    nx: int = 3, ny: int = 3, nz: int = 2, size_m: tuple[float, float, float] = (0.03, 0.03, 0.02)
) -> tuple[np.ndarray, np.ndarray]:
    if min(nx, ny, nz) < 1 or min(size_m) <= 0:
        raise ValueError("Positive mesh dimensions required")
    points = np.array(
        list(
            itertools.product(
                np.linspace(0, size_m[0], nx + 1),
                np.linspace(0, size_m[1], ny + 1),
                np.linspace(0, size_m[2], nz + 1),
            )
        )
    )

    def idx(q: np.ndarray) -> int:
        return int((q[0] * (ny + 1) + q[1]) * (nz + 1) + q[2])

    cells = []
    for cell in itertools.product(range(nx), range(ny), range(nz)):
        for permutation in itertools.permutations(range(3)):
            p = np.array(cell)
            nodes = [idx(p)]
            for axis in permutation:
                p = p.copy()
                p[axis] += 1
                nodes.append(idx(p))
            if np.linalg.det((points[nodes[1:]] - points[nodes[0]]).T) < 0:
                nodes[1], nodes[2] = nodes[2], nodes[1]
            cells.append(nodes)
    return points, np.asarray(cells, dtype=np.int64)


class TetEnergy:
    """Linear tetrahedra with exact energy/force assembly; no contact model."""

    def __init__(self, reference: np.ndarray, tets: np.ndarray, material: Material):
        self.reference = np.asarray(reference, dtype=np.float64)
        self.tets = np.asarray(tets, dtype=np.int64)
        self.material = material
        edges = np.transpose(
            self.reference[self.tets[:, 1:]] - self.reference[self.tets[:, :1]], (0, 2, 1)
        )
        self.volumes = np.linalg.det(edges) / 6
        if not np.isfinite(self.volumes).all() or np.any(self.volumes <= 0):
            raise ValueError("Reference tetrahedra must have positive finite volume")
        self.inverse = np.linalg.inv(edges)

    def evaluate(self, current: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
        edges = np.transpose(current[self.tets[:, 1:]] - current[self.tets[:, :1]], (0, 2, 1))
        f = edges @ self.inverse
        e, p = energy_stress(f, self.material)
        corners = np.transpose(
            self.volumes[:, None, None] * (p @ np.transpose(self.inverse, (0, 2, 1))), (0, 2, 1)
        )
        gradient = np.zeros_like(current)
        np.add.at(gradient, self.tets[:, 0], -corners.sum(axis=1))
        for k in range(3):
            np.add.at(gradient, self.tets[:, k + 1], corners[:, k])
        return float(np.sum(e * self.volumes)), gradient, np.linalg.det(f)


def patch_compression(
    material: Material = Material(),
    resolution: int = 3,
    depths_mm: tuple[float, ...] = (0.0, 0.5, 1.0, 1.5, 2.0),
) -> dict[str, Any]:
    """Quasi-static fixed circular-node-patch displacement test on a block.

    Bottom nodes are clamped, selected top nodes have prescribed z; their x/y
    remain free. This is not sphere contact, anatomical indentation, or a
    near-incompressible convergence certificate. Failed trials are retained.
    """
    if not depths_mm or depths_mm[0] != 0 or any(b <= a for a, b in zip(depths_mm, depths_mm[1:])):
        raise ValueError("Depths must start at zero and increase")
    reference, tets = block_mesh(resolution, resolution, max(2, resolution - 1))
    fem = TetEnergy(reference, tets, material)
    top = np.isclose(reference[:, 2], 0.02)
    patch = top & (np.sum((reference[:, :2] - 0.015) ** 2, axis=1) <= 0.0101**2)
    if not patch.any():
        raise ValueError("Resolution has no nodes in the loading patch")
    fixed = np.repeat(np.isclose(reference[:, 2], 0)[:, None], 3, axis=1)
    fixed[patch, 2] = True
    free = ~fixed
    current = reference.copy()
    length = 0.03
    variable_scale = 0.001  # millimetre-scale optimization coordinates bound initial search motion
    energy_scale = material.young_pa * length**3
    rows = []
    started = time.perf_counter()
    for depth in depths_mm:
        candidate = current.copy()
        candidate[patch, 2] = reference[patch, 2] - depth * 0.001

        def objective(values: np.ndarray) -> tuple[float, np.ndarray]:
            x = candidate.copy()
            x[free] = values * variable_scale
            e, g, j = fem.evaluate(x)
            # Reject infeasible line-search points; never accept folded labels.
            if np.min(j) <= 0.05:
                return float("inf"), g[free] * variable_scale / energy_scale
            return e / energy_scale, g[free] * variable_scale / energy_scale

        opt = minimize(
            objective,
            current[free] / variable_scale,
            jac=True,
            method="L-BFGS-B",
            options={"maxiter": 1200, "ftol": 1e-14, "gtol": 1e-8, "maxls": 40},
        )
        candidate[free] = opt.x * variable_scale
        energy, gradient, jacobians = fem.evaluate(candidate)
        force = float(-gradient[patch, 2].sum())
        residual = float(np.max(np.abs(gradient[free])))
        valid = bool(
            np.isfinite(energy)
            and np.min(jacobians) > 0.05
            and residual <= 1e-6 + 1e-4 * abs(force)
        )
        rows.append(
            {
                "depth_mm": depth,
                "compressive_force_n": force,
                "free_residual_n": residual,
                "min_j": float(np.min(jacobians)),
                "energy_j": energy,
                "converged": valid,
                "optimizer_success": bool(opt.success),
                "iterations": int(opt.nit),
                "optimizer_message": str(opt.message),
            }
        )
        if not valid:
            break
        current = candidate
    return {
        "protocol": "T1d_block_patch_v1",
        "energy_id": "snh_quadratic_j",
        "evidence_kind": "simulated",
        "review_status": "unreviewed",
        "scope": "numerical synthetic block fixture; not canonical organ T1 or tissue validation",
        "material": asdict(material),
        "units": "m-kg-s; outputs explicitly tagged",
        "reference_state": "authored block assumed stress-free; no gravity",
        "resolution": resolution,
        "nodes": len(reference),
        "tets": len(tets),
        "patch_node_ids": np.flatnonzero(patch).tolist(),
        "requested_depth_count": len(depths_mm),
        "attempted_depth_count": len(rows),
        "converged": len(rows) == len(depths_mm) and all(x["converged"] for x in rows),
        "curves": rows,
        "wall_time_s": time.perf_counter() - started,
    }


def verification_report() -> dict[str, Any]:
    material = Material()
    rng = np.random.default_rng(184)
    f = np.eye(3) + 0.1 * rng.normal(size=(3, 3))
    d = rng.normal(size=(3, 3))
    eps = 1e-6
    _, p = energy_stress(f, material)
    de = (energy_stress(f + eps * d, material)[0] - energy_stress(f - eps * d, material)[0]) / (
        2 * eps
    )
    dp = (energy_stress(f + eps * d, material)[1] - energy_stress(f - eps * d, material)[1]) / (
        2 * eps
    )
    q, _ = np.linalg.qr(rng.normal(size=(3, 3)))
    q[:, 0] *= np.linalg.det(q)
    rest_e, rest_p = energy_stress(np.eye(3), material)
    errors = {
        "rest_energy_pa": abs(float(rest_e)),
        "rest_stress_pa": float(np.max(abs(rest_p))),
        "energy_gradient_relative": abs(float(de - np.sum(p * d))) / max(1, abs(float(de))),
        "tangent_relative": float(
            np.linalg.norm(dp - tangent_action(f, d, material)) / np.linalg.norm(dp)
        ),
        "objectivity_energy_relative": abs(
            float(energy_stress(q @ f, material)[0] - energy_stress(f, material)[0])
        )
        / material.young_pa,
        "objectivity_stress_relative": float(
            np.linalg.norm(energy_stress(q @ f, material)[1] - q @ p) / material.young_pa
        ),
    }
    return {
        "energy_id": "snh_quadratic_j",
        "checks": errors,
        "passed": all(v < 1e-6 for v in errors.values()),
        "evidence": "numerical verification only; no tissue measurements",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--resolutions", default="3,4,5")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    verification = verification_report()
    (args.out / "verification.json").write_text(json.dumps(verification, indent=2) + "\n")
    trials = [
        patch_compression(Material(e, 0.35), n)
        for n in map(int, args.resolutions.split(","))
        for e in (3000.0, 5000.0, 8000.0)
    ]
    (args.out / "trials.jsonl").write_text("".join(json.dumps(r) + "\n" for r in trials))
    report = {
        "attempted": len(trials),
        "converged": sum(r["converged"] for r in trials),
        "constitutive_verification": verification,
        "trials_path": "trials.jsonl",
        "limitations": [
            "linear tetrahedral locking not characterized at high Poisson ratio",
            "resolution changes loaded-node patch discretization; not a convergence proof",
            "no anatomical tissue data, contact, relaxation, organ attachment or expert validation",
        ],
    }
    (args.out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    if not verification["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
