"""numpy's draws for the browser generator, recorded from numpy itself (apps/studio/src/numpyRandom.ts replays them).

    .venv/bin/python scripts/export_numpy_random_fixtures.py
    .venv/bin/python -I scripts/export_numpy_random_fixtures.py --ziggurat-header /path/to/ziggurat_constants.h

Writes apps/studio/src/__fixtures__/numpy-random.json: for twelve seeds the raw PCG64 outputs, standard normals,
normal(loc, scale), bounded integers on numpy's 32-bit Lemire, raw-uint32 and 64-bit Lemire paths, doubles,
uniforms and permutations from fresh generators, plus one mixed stream that interleaves every draw type on a
single generator (the bit generator's shared uint32 half-buffer); choice without replacement on both of numpy's
algorithms (tail shuffle and Floyd); the first seeds whose first standard normal takes the ziggurat's wedge or
tail; and exactly rounded a·b + c cases for the fused multiply-add the browser emulates (numpy's wheel is
compiled with clang's default -ffp-contract=on, so loc + scale·x is one rounding). With --ziggurat-header it also
regenerates apps/studio/src/numpyZigguratTables.ts from numpy's numpy/random/src/distributions/
ziggurat_constants.h; fetch that header for the installed tag (numpy.__version__) first. numpyRandom.test.ts
asserts equality bit for bit.
"""
from __future__ import annotations

import argparse
import json
import re
from fractions import Fraction
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "apps/studio/src/__fixtures__/numpy-random.json"
TABLES = ROOT / "apps/studio/src/numpyZigguratTables.ts"

# 0, 1, 42, 2**31 and 2**32 - 1 span the uint32 seed range; 20873 is the template pool's fixed seed and 104729 the
# shape sampler's retry stride; the rest are ordinary request seeds.
SEEDS = [0, 1, 42, 2**31, 2**32 - 1, 7, 1729, 10007, 20873, 104729, 123456789, 2**31 - 1]
JOINT_LOW, JOINT_HIGH = -1 + 1e-6, 1 - 1e-6  # the joint flow's uniform bounds


def fresh_draws(seed: int) -> dict:
    """Every draw type from its own fresh generator, as the samplers call them."""
    g = lambda: np.random.default_rng(seed)  # noqa: E731
    return {
        "seed": seed,
        "raw_uint64": [str(int(v)) for v in g().bit_generator.random_raw(4)],
        "standard_normal_8": g().standard_normal(8).tolist(),
        "normal_3p5_0p25_6": g().normal(3.5, 0.25, 6).tolist(),
        # a scale that is not a power of two: the fused multiply-add shows in the last bit
        "normal_m2_0p37_6": g().normal(-2.0, 0.37, 6).tolist(),
        "integers_0_7_5": g().integers(0, 7, size=5).tolist(),
        # range 2**31: Lemire's threshold is 2**31 - 1, so about half of the 32-bit words are rejected
        "integers_0_2p31p1_6": g().integers(0, 2**31 + 1, size=6).tolist(),
        # the full 32-bit range: a raw next_uint32 per element
        "integers_0_2p32_3": g().integers(0, 2**32, size=3).tolist(),
        "integers_0_2p40": int(g().integers(0, 2**40)),
        "integers_0_2p52p1_4": g().integers(0, 2**52 + 1, size=4).tolist(),
        "random_5": g().random(5).tolist(),
        "uniform_joint_4": g().uniform(JOINT_LOW, JOINT_HIGH, 4).tolist(),
        "permutation_10": g().permutation(10).tolist(),
        "permutation_37": g().permutation(np.arange(1000, 1037)).tolist(),
        "mixed": mixed_stream(seed),
    }


def mixed_stream(seed: int) -> dict:
    """One generator through every draw type: the uint32 half left pending by the first draw must feed the Lemire
    draw after it, and the 64-bit draws in between must leave it alone."""
    g = np.random.default_rng(seed)
    return {
        "spatial_seed": int(g.integers(0, 2**32, size=1, dtype=np.uint64)[0]),
        "lemire_after_half": int(g.integers(0, 7)),
        "permutation_5": g.permutation(5).tolist(),
        "standard_normal": float(g.standard_normal()),
        "random": float(g.random()),
        "integers_2p40": int(g.integers(0, 2**40)),
        "uint32_again": int(g.integers(0, 2**32, size=1, dtype=np.uint64)[0]),
        "integers_3_10_3": g.integers(3, 10, size=3).tolist(),
        "normal": float(g.normal(-2.0, 0.5)),
        "choice_200_9": g.choice(200, 9, replace=False).tolist(),
        "uniform": float(g.uniform(2.0, 5.0)),
        "raw_after": str(int(g.bit_generator.random_raw())),
    }


def choice_cases() -> list[dict]:
    """numpy takes the tail shuffle for a population over 10000 with a count above a fiftieth of it, Floyd otherwise;
    the pairs sit on both sides of that rule, including the count == population // 50 boundary and count == population."""
    cases = []
    for seed, population, count in [(20873, 10500, 300), (20873, 5000, 120), (20873, 50, 50), (20873, 1000, 7),
                                    (42, 12000, 240), (7, 16, 16), (1, 10001, 201)]:
        indices = np.random.default_rng(seed).choice(population, count, replace=False)
        cases.append({"seed": seed, "population": population, "count": count, "indices": indices.tolist()})
    return cases


def raw_draws_consumed(seed: int) -> int:
    """How many 64-bit outputs one standard_normal() took, read off the PCG64 state."""
    g = np.random.default_rng(seed)
    g.standard_normal()
    after = g.bit_generator.state["state"]["state"]
    probe = np.random.default_rng(seed)
    for consumed in range(1, 64):
        probe.bit_generator.random_raw()
        if probe.bit_generator.state["state"]["state"] == after:
            return consumed
    raise RuntimeError(f"seed {seed}: more than 63 outputs for one normal")


def ziggurat_branches(per_branch: int = 4) -> list[dict]:
    """The first seeds whose first standard normal leaves the ziggurat's fast path: layer 0 is the tail, any other
    layer the wedge. The fast path consumes one output; anything more went through a slow branch."""
    found: dict[str, list[dict]] = {"wedge": [], "tail": []}
    seed = 0
    while any(len(v) < per_branch for v in found.values()):
        consumed = raw_draws_consumed(seed)
        if consumed > 1:
            layer = int(np.random.default_rng(seed).bit_generator.random_raw()) & 0xFF
            branch = "tail" if layer == 0 else "wedge"
            if len(found[branch]) < per_branch:
                found[branch].append({"seed": seed, "branch": branch, "raw_draws": consumed,
                                      "standard_normal_3": np.random.default_rng(seed).standard_normal(3).tolist()})
        seed += 1
    return found["wedge"] + found["tail"]


def fma_cases() -> list[list[float]]:
    """a, b, c and a·b + c rounded once (exact rationals, then Python's correctly rounded float()): magnitudes across
    sixty binary orders, cancellations, and the samplers' own shapes."""
    rng = np.random.default_rng(2024)
    triples = [(float(rng.normal() * 2.0 ** rng.integers(-30, 30)), float(rng.random()),
                float(rng.normal() * 2.0 ** rng.integers(-30, 30))) for _ in range(40)]
    triples += [(0.37, 1.2345678901234567, -2.0), (JOINT_HIGH - JOINT_LOW, 0.5000000000000001, JOINT_LOW),
                (3.0, 1 / 3, -1.0), (1e16, 1.0, 1.0), (0.1, 0.1, -0.01), (1e-200, 1e-200, 1e-300), (-0.25, 4.0, 1.0)]
    return [[a, b, c, float(Fraction(a) * Fraction(b) + Fraction(c))] for a, b, c in triples]


def export_fixtures() -> None:
    fixture = {
        "numpy_version": np.__version__,
        "seeds": [fresh_draws(seed) for seed in SEEDS],
        "choice": choice_cases(),
        "ziggurat_branches": ziggurat_branches(),
        "permutation_4097": {"seed": 3, "values": np.random.default_rng(3).permutation(4097).tolist()},
        "fma_cases": fma_cases(),
    }
    FIXTURES.parent.mkdir(parents=True, exist_ok=True)
    FIXTURES.write_text(json.dumps(fixture, indent=0) + "\n")
    print(f"fixtures: {len(SEEDS)} seeds, {len(fixture['choice'])} choice cases, "
          f"{len(fixture['ziggurat_branches'])} ziggurat branch seeds → {FIXTURES.relative_to(ROOT)}")


def write_ziggurat_tables(header: Path) -> None:
    """ki_double, wi_double, fi_double and the two radii from numpy's header as a TypeScript module. ki are the
    header's integers (all below 2**53, so exact doubles); the doubles are re-emitted as Python's shortest repr,
    which parses to the same double in C and JavaScript (the header's 21-digit literals exceed what ECMAScript
    guarantees to round exactly)."""
    text = header.read_text()

    def tokens(name: str) -> list[str]:
        match = re.search(rf"static const \w+ {name}\[\] = \{{(.*?)\}};", text, re.S)
        if match is None:
            raise SystemExit(f"{header}: no {name}[]")
        return [tok for tok in re.split(r"[,\s]+", match.group(1).strip()) if tok]

    def scalar(name: str) -> float:
        match = re.search(rf"static const double {name} =\s*([0-9.]+);", text)
        if match is None:
            raise SystemExit(f"{header}: no {name}")
        return float(match.group(1))

    ki = [int(tok[:-3], 16) for tok in tokens("ki_double")]
    wi = [float(tok) for tok in tokens("wi_double")]
    fi = [float(tok) for tok in tokens("fi_double")]
    if not (len(ki) == len(wi) == len(fi) == 256) or max(ki) >= 2**53:
        raise SystemExit("unexpected ziggurat tables")

    def rows(values: list, fmt) -> str:
        chunks = [", ".join(fmt(v) for v in values[i:i + 4]) for i in range(0, len(values), 4)]
        return "\n".join(f"  {chunk}," for chunk in chunks)

    body = (
        f"/** numpy's ziggurat tables for the standard normal: ki_double, wi_double and fi_double from numpy "
        f"v{np.__version__}\n"
        " *  numpy/random/src/distributions/ziggurat_constants.h, written by scripts/export_numpy_random_fixtures.py\n"
        " *  --ziggurat-header. ki as the header's integers (all below 2^53, so exact doubles); wi, fi and the radii as\n"
        " *  the shortest decimal that parses to the header's double. Generated: do not edit by hand. */\n\n"
        f"export const KI_DOUBLE: readonly number[] = [\n{rows(ki, str)}\n];\n\n"
        f"export const WI_DOUBLE: readonly number[] = [\n{rows(wi, repr)}\n];\n\n"
        f"export const FI_DOUBLE: readonly number[] = [\n{rows(fi, repr)}\n];\n\n"
        f"export const ZIGGURAT_NOR_R = {scalar('ziggurat_nor_r')!r};\n"
        f"export const ZIGGURAT_NOR_INV_R = {scalar('ziggurat_nor_inv_r')!r};\n"
    )
    TABLES.write_text(body)
    print(f"ziggurat tables: 3 × 256 entries → {TABLES.relative_to(ROOT)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ziggurat-header", type=Path, help="numpy's ziggurat_constants.h for the installed tag")
    args = parser.parse_args()
    if args.ziggurat_header is not None:
        write_ziggurat_tables(args.ziggurat_header)
    export_fixtures()
