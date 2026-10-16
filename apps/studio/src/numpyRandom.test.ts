/** numpy's generator in the browser against numpy itself (src/__fixtures__/numpy-random.json, written by
 *  scripts/export_numpy_random_fixtures.py): every draw type the atlas samplers take, bit for bit — fresh
 *  generators per draw type, one generator through all of them (the shared uint32 half-buffer), both choice
 *  algorithms, the ziggurat's slow branches, and the fused multiply-add numpy's wheel computes with. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fma } from "./fusedMultiplyAdd";
import { Pcg64 } from "./numpyRandom";

interface MixedStream {
  spatial_seed: number; lemire_after_half: number; permutation_5: number[]; standard_normal: number; random: number;
  integers_2p40: number; uint32_again: number; integers_3_10_3: number[]; normal: number; choice_200_9: number[];
  uniform: number; raw_after: string;
}
interface SeedRow {
  seed: number; raw_uint64: string[]; standard_normal_8: number[]; normal_3p5_0p25_6: number[]; normal_m2_0p37_6: number[];
  integers_0_7_5: number[]; integers_0_2p31p1_6: number[]; integers_0_2p32_3: number[]; integers_0_2p40: number;
  integers_0_2p52p1_4: number[]; random_5: number[]; uniform_joint_4: number[]; permutation_10: number[];
  permutation_37: number[]; mixed: MixedStream;
}
interface Fixture {
  numpy_version: string;
  seeds: SeedRow[];
  choice: { seed: number; population: number; count: number; indices: number[] }[];
  ziggurat_branches: { seed: number; branch: "wedge" | "tail"; raw_draws: number; standard_normal_3: number[] }[];
  permutation_4097: { seed: number; values: number[] };
  fma_cases: [number, number, number, number][];
}
const fixture = JSON.parse(readFileSync(new URL("./__fixtures__/numpy-random.json", import.meta.url), "utf8")) as Fixture;
const JOINT_LOW = -1 + 1e-6, JOINT_HIGH = 1 - 1e-6;

describe("numpy's generator, bit for bit", () => {
  it("replays numpy 2.x", () => expect(fixture.numpy_version).toMatch(/^2\./));

  it.each(fixture.seeds)("seed $seed: every draw type from a fresh generator", (row) => {
    const fresh = () => new Pcg64(row.seed);
    const raw = fresh();
    expect([raw.nextUint64(), raw.nextUint64(), raw.nextUint64(), raw.nextUint64()].map(String)).toEqual(row.raw_uint64);
    expect(fresh().standardNormal(8)).toEqual(row.standard_normal_8);
    expect(fresh().normal(3.5, 0.25, 6)).toEqual(row.normal_3p5_0p25_6);
    expect(fresh().normal(-2, 0.37, 6)).toEqual(row.normal_m2_0p37_6);
    expect(fresh().integers(0, 7, 5)).toEqual(row.integers_0_7_5);
    expect(fresh().integers(0, 2 ** 31 + 1, 6)).toEqual(row.integers_0_2p31p1_6);
    expect(fresh().integers(0, 2 ** 32, 3)).toEqual(row.integers_0_2p32_3);
    expect(fresh().integers(0, 2 ** 40)).toBe(row.integers_0_2p40);
    expect(fresh().integers(0, 2 ** 52 + 1, 4)).toEqual(row.integers_0_2p52p1_4);
    expect(fresh().random(5)).toEqual(row.random_5);
    expect(fresh().uniform(JOINT_LOW, JOINT_HIGH, 4)).toEqual(row.uniform_joint_4);
    expect(fresh().permutation(10)).toEqual(row.permutation_10);
    expect(fresh().permutation(Array.from({ length: 37 }, (_, i) => 1000 + i))).toEqual(row.permutation_37);
  });

  it.each(fixture.seeds)("seed $seed: one generator through every draw type keeps the shared uint32 half", (row) => {
    const g = new Pcg64(row.seed), m = row.mixed;
    expect(g.uint32s(1)).toEqual([m.spatial_seed]);
    expect(g.integers(0, 7)).toBe(m.lemire_after_half);
    expect(g.permutation(5)).toEqual(m.permutation_5);
    expect(g.standardNormal()).toBe(m.standard_normal);
    expect(g.nextDouble()).toBe(m.random);
    expect(g.integers(0, 2 ** 40)).toBe(m.integers_2p40);
    expect(g.uint32s(1)).toEqual([m.uint32_again]);
    expect(g.integers(3, 10, 3)).toEqual(m.integers_3_10_3);
    expect(g.normal(-2, 0.5, 1)).toEqual([m.normal]);
    expect(g.choiceWithoutReplacement(200, 9)).toEqual(m.choice_200_9);
    expect(g.uniform(2, 5, 1)).toEqual([m.uniform]);
    expect(String(g.nextUint64())).toBe(m.raw_after);
  });

  it("takes the ziggurat's wedge and tail where numpy does", () => {
    const branches = { wedge: 0, tail: 0 };
    for (const row of fixture.ziggurat_branches) {
      expect(new Pcg64(row.seed).standardNormal(3)).toEqual(row.standard_normal_3);
      branches[row.branch] += 1;
    }
    expect(branches).toEqual({ wedge: 4, tail: 4 });
  });

  it("draws numpy's choice without replacement on both of its algorithms", () => {
    for (const row of fixture.choice) {
      expect(new Pcg64(row.seed).choiceWithoutReplacement(row.population, row.count)).toEqual(row.indices);
    }
    expect(fixture.choice.some((row) => row.population > 10000 && row.count > Math.floor(row.population / 50))).toBe(true);
    expect(fixture.choice.some((row) => row.count === row.population)).toBe(true);
  });

  it("permutes 4097 items as numpy does", () => {
    const { seed, values } = fixture.permutation_4097;
    expect(new Pcg64(seed).permutation(values.length)).toEqual(values);
  });

  it("refuses what numpy refuses", () => {
    expect(() => new Pcg64(-1)).toThrow(/uint32/);
    expect(() => new Pcg64(1).integers(5, 5)).toThrow(/low < high/);
    expect(() => new Pcg64(1).choiceWithoutReplacement(5, 6)).toThrow(/population/);
  });
});

describe("the fused multiply-add numpy's wheel computes with", () => {
  it("rounds a·b + c once, as the exact rational does", () => {
    for (const [a, b, c, exact] of fixture.fma_cases) expect(fma(a, b, c)).toBe(exact);
  });
  it("is not the twice-rounded expression", () => {
    expect(fixture.fma_cases.some(([a, b, c, exact]) => a * b + c !== exact)).toBe(true);
  });
  it("keeps exact products and zeros as they are", () => {
    expect(fma(1, 0.1234, 0)).toBe(0.1234);
    expect(fma(0.25, 3, 0.5)).toBe(1.25);
    expect(Object.is(fma(0.5, -1, 0.5), 0)).toBe(true);
    expect(fma(2 ** -1074, 0.5, 0)).toBe(0);
    expect(fma(2 ** -1074, 0.75, 0)).toBe(2 ** -1074);
  });
});
