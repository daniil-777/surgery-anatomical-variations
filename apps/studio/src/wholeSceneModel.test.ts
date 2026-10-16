import { describe, expect, it } from "vitest";
import {
  BASELINE_VARIATION, createWholeSceneVariation, sceneBufferSignature, warpScenePoint,
  warpScenePositions, wholeSceneTissue, wholeSceneWarp, type WholeSceneCategory,
} from "./wholeSceneModel";

function determinantAt(point: [number, number, number], seed: number) {
  const warp = wholeSceneWarp(createWholeSceneVariation(seed, 1, 1));
  const h = .001;
  const columns = point.map((_, axis) => {
    const low = [...point] as [number, number, number], high = [...point] as [number, number, number];
    low[axis]! -= h; high[axis]! += h;
    const a = warpScenePoint(...low, warp), b = warpScenePoint(...high, warp);
    return a.map((value, i) => (b[i]! - value) / (2 * h));
  });
  const [a, b, c] = columns as [number[], number[], number[]];
  return a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - b[0]! * (a[1]! * c[2]! - a[2]! * c[1]!) + c[0]! * (a[1]! * b[2]! - a[2]! * b[1]!);
}
describe("registered whole-scene anatomy variation", () => {
  it("has a positive bounded Jacobian throughout and beyond the torso at maximum controls", () => {
    for (const seed of [0, 1, 2, 37, 401, 8192, 20261008, 0xffffffff]) {
      for (const x of [-350, 0, 350]) for (const y of [-600, -100, 100, 600]) for (const z of [-250, 0, 250]) {
        const determinant = determinantAt([x, y, z], seed);
        expect(determinant).toBeGreaterThan(.7);
        expect(determinant).toBeLessThan(1.5);
      }
    }
  });
  it("keeps atlas-coincident points identical across structures and nearby points continuous", () => {
    const variation = createWholeSceneVariation(992, 1, 1);
    const duct = warpScenePositions(new Float32Array([35, -25, 11, 36, -24, 10]), variation);
    const gallbladder = warpScenePositions(new Float32Array([-30, 80, 22, 35, -25, 11]), variation);
    expect([...duct.slice(0, 3)]).toEqual([...gallbladder.slice(3, 6)]);
    const warp = wholeSceneWarp(variation);
    const point = warpScenePoint(35, -25, 11, warp), adjacent = warpScenePoint(35.0001, -25, 11, warp);
    expect(Math.hypot(...point.map((v, i) => v - adjacent[i]!))).toBeLessThan(.00015);
  });
  it("changes every organ geometry and material, replays exactly, and restores atlas coordinates", () => {
    const organs: [string, WholeSceneCategory, number[]][] = [
      ["liver", "digestive", [-80, 10, 30]], ["gallbladder", "digestive", [-45, -20, 45]],
      ["stomach", "digestive", [65, -30, 50]], ["pancreas", "digestive", [0, -50, -20]],
      ["spleen", "digestive", [110, 30, 0]], ["colon", "digestive", [80, -200, 50]],
      ["left-kidney", "urinary", [75, -80, -65]], ["right-kidney", "urinary", [-75, -100, -65]],
      ["heart", "cardiovascular", [15, 150, 0]], ["left-lung", "respiratory", [90, 140, 0]],
      ["right-lung", "respiratory", [-90, 130, 0]], ["rib-cage", "skeleton", [-170, 130, 0]],
      ["diaphragm", "connective", [50, 65, 20]], ["bile-duct", "digestive", [-20, -50, 30]],
    ];
    for (const [id, category, center] of organs) {
      const rest = new Float32Array([...center, ...center.map(v => v + 3), ...center.map(v => v - 2)]);
      const first = warpScenePositions(rest, createWholeSceneVariation(7381));
      const replay = warpScenePositions(rest, createWholeSceneVariation(7381));
      const other = warpScenePositions(rest, createWholeSceneVariation(7382));
      expect(sceneBufferSignature(first)).not.toBe(sceneBufferSignature(rest));
      expect(first).toEqual(replay); expect(first).not.toEqual(other);
      expect(warpScenePositions(rest, BASELINE_VARIATION)).toEqual(rest);
      const tissue = wholeSceneTissue(id, category, createWholeSceneVariation(7381));
      expect(tissue).not.toEqual(wholeSceneTissue(id, category, BASELINE_VARIATION));
      expect(tissue).toEqual(wholeSceneTissue(id, category, createWholeSceneVariation(7381)));
      expect(tissue.disease).toBeGreaterThan(0);
    }
  });
  it("disease severity changes shared geometry and material while zero severity removes disease pigmentation", () => {
    const rest = new Float32Array([50, -100, 30, 30, 10, 40]);
    const healthy = createWholeSceneVariation(184, .7, 0), changed = createWholeSceneVariation(184, .7, 1);
    expect(warpScenePositions(rest, healthy)).not.toEqual(warpScenePositions(rest, changed));
    expect(wholeSceneTissue("stomach", "digestive", healthy).disease).toBe(0);
    expect(wholeSceneTissue("stomach", "digestive", changed).disease).toBe(1);
  });
  it("bounds user input and rejects broken coordinate buffers", () => {
    expect(createWholeSceneVariation(NaN, Infinity, -1)).toEqual({ seed: 1, strength: 0, severity: 0, baseline: false });
    expect(createWholeSceneVariation(-1, 9, 9)).toEqual({ seed: 0xffffffff, strength: 1, severity: 1, baseline: false });
    expect(() => warpScenePositions([1, 2], createWholeSceneVariation(2))).toThrow("XYZ triples");
    expect(() => warpScenePositions([NaN, 0, 0], createWholeSceneVariation(2))).toThrow("non-finite");
  });
});
