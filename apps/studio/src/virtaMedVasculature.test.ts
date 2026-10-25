import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildSerosalBranches, rasterSerosalBranches, serosalVascularTexture } from "./virtaMedVasculature";

describe("authored superficial vascular hierarchy", () => {
  it("replays seeds, varies topology, and attaches every daughter to a wider parent", () => {
    const branches = buildSerosalBranches(763);
    expect(branches).toEqual(buildSerosalBranches(763)); expect(branches).not.toEqual(buildSerosalBranches(764));
    for (const [i, branch] of branches.entries()) {
      expect(branch.radii.at(-1)).toBe(0); expect(branch.points.flat().every(Number.isFinite)).toBe(true);
      expect(branch.radii.every(r => Number.isFinite(r) && r >= 0)).toBe(true);
      if (branch.parent === null) continue;
      expect(branch.parent).toBeLessThan(i); const parent = branches[branch.parent]!;
      expect(branch.points[0]).toEqual(parent.points[branch.parentSample]);
      expect(branch.radii[0]!).toBeLessThan(parent.radii[branch.parentSample]!);
    }
  });
  it("wraps complete branches across tile boundaries and keeps the halo wider than the lumen", () => {
    const branches = buildSerosalBranches(), bytes = rasterSerosalBranches(branches, 128);
    const shifted = branches.map(b => ({ ...b, points: b.points.map(([x, y]) => [x + 1, y - 1] as [number, number]) }));
    expect(rasterSerosalBranches(shifted, 128)).toEqual(bytes);
    let vessels = 0, halo = 0;
    for (let i = 0; i < bytes.length; i += 4) { vessels += Number(Math.max(bytes[i]!, bytes[i + 1]!) > 30); halo += Number(bytes[i + 2]! > 20); }
    expect(vessels).toBeGreaterThan(30); expect(vessels).toBeLessThan(128 * 128 * .2); expect(halo).toBeGreaterThan(vessels);
  });
  it("shares one texture per scene and disposes it with its owner", () => {
    const owner = new THREE.Texture(), a = serosalVascularTexture(owner);
    expect(serosalVascularTexture(owner)).toBe(a); expect(a.image.width).toBe(1024);
    let disposed = 0; a.addEventListener("dispose", () => disposed++); owner.dispose(); owner.dispose();
    expect(disposed).toBe(1);
  });
});
