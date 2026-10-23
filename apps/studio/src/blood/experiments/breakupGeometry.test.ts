import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { ligamentGeometryData, validateDroplets, type LigamentGeometryInput } from "./breakupGeometry";
import { tankSurfaceData } from "./geometry";

const metreVolume = (data: ReturnType<typeof ligamentGeometryData>) => {
  let sum = 0;
  for (let i = 0; i < data.indices.length; i += 3) {
    const a = new Vector3().fromArray(data.positions, data.indices[i]! * 3);
    const b = new Vector3().fromArray(data.positions, data.indices[i + 1]! * 3);
    const c = new Vector3().fromArray(data.positions, data.indices[i + 2]! * 3);
    sum += a.dot(b.cross(c)) / 6e9;
  }
  return Math.abs(sum);
};

describe("authoritative breakup geometry", () => {
  it("preserves the supplied neck profile and independently measured closed volume", () => {
    for (const curved of [false, true]) {
      const points = Array.from({ length: 17 }, (_, i) => ({
        positionM: [i * .001, .03 - i * .0002, curved ? i * i * .00002 : 0] as const,
        radiusM: .0003 * (1 + .25 * Math.cos(i * Math.PI / 4)),
      }));
      let volumeM3 = 0;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!, b = points[i]!, length = new Vector3(...a.positionM).distanceTo(new Vector3(...b.positionM));
        volumeM3 += Math.PI * length * (a.radiusM ** 2 + a.radiusM * b.radiusM + b.radiusM ** 2) / 3;
      }
      const data = ligamentGeometryData([{ id: 1, holeId: "a", volumeM3, points }]);
      expect(Math.abs(metreVolume(data) / volumeM3 - 1)).toBeLessThan(4e-6);
      expect(data.volumeM3).toBeCloseTo(metreVolume(data), 14);
      for (let i = 0; i < points.length; i++) {
        const centre = new Vector3();
        for (let j = 0; j < 32; j++) centre.add(new Vector3().fromArray(data.positions, (i * 32 + j) * 3));
        centre.multiplyScalar(1 / 32000);
        expect(centre.distanceTo(new Vector3(...points[i]!.positionM))).toBeLessThan(2e-9);
        expect(data.thicknessM[i * 32]! / data.thicknessM[0]!).toBeCloseTo(points[i]!.radiusM / points[0]!.radiusM, 6);
      }
      for (let i = 0; i < data.normals.length; i += 3)
        expect(Math.hypot(data.normals[i]!, data.normals[i + 1]!, data.normals[i + 2]!)).toBeCloseTo(1, 6);
    }
  });
  it("does not bridge disconnected ligaments or mutate accepted points", () => {
    const a: LigamentGeometryInput = { id: 1, holeId: "a", volumeM3: Math.PI * .0002 ** 2 * .005,
      points: [{ positionM: [0, .02, 0], radiusM: .0002 }, { positionM: [.005, .02, 0], radiusM: .0002 }] };
    const b: LigamentGeometryInput = { ...a, id: 2, points: a.points.map(p => ({ ...p, positionM: [p.positionM[0] + .03, p.positionM[1], p.positionM[2]] as const })) };
    const input = [a, b], before = JSON.stringify(input), data = ligamentGeometryData(input);
    expect(JSON.stringify(input)).toBe(before);
    for (let i = 0; i < data.indices.length; i += 3) {
      const xs = [0, 1, 2].map(k => data.positions[data.indices[i + k]! * 3]!);
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(.0051 * 1000);
    }
    expect(ligamentGeometryData([]).volumeM3).toBe(0);
  });
  it("rejects nonfinite, degenerate or negative geometry", () => {
    const bad = { id: 1, holeId: "a", volumeM3: -1, points: [] };
    expect(() => ligamentGeometryData([bad])).toThrow();
    expect(() => ligamentGeometryData([{ ...bad, volumeM3: 1, points: [
      { positionM: [0, 0, 0], radiusM: .001 }, { positionM: [0, 0, 0], radiusM: .001 },
    ] }])).toThrow();
    const radiusM = .0004, volumeM3 = 4 * Math.PI * radiusM ** 3 / 3;
    const drop = { id: 1, holeId: "a", positionM: [0, .02, 0] as const, radiusM, volumeM3 };
    expect(() => validateDroplets([drop])).not.toThrow();
    expect(() => validateDroplets([{ ...drop, volumeM3: volumeM3 * 2 }])).toThrow();
    expect(() => validateDroplets([{ ...drop, radiusM: NaN }])).toThrow();
  });
});

describe("conservative collector display", () => {
  it("preserves cell inventory for every basis cell, including all four corners", () => {
    const config = { widthM: .16, depthM: .2, heightM: 2, nx: 8, nz: 6 }, heights = new Float64Array(48);
    let reuse: ReturnType<typeof tankSurfaceData> | undefined;
    for (let cell = 0; cell < heights.length; cell++) {
      heights.fill(.00002); heights[cell] = heights[cell]! + .0008;
      const data = tankSurfaceData(config, heights, reuse, .98, [.24, .27, .29], true);
      if (reuse) expect(data).toBe(reuse); reuse = data;
      let integralMM3 = 0;
      for (let i = 0; i < data.indices.length; i += 3) {
        const a = new Vector3().fromArray(data.positions, data.indices[i]! * 3);
        const b = new Vector3().fromArray(data.positions, data.indices[i + 1]! * 3);
        const c = new Vector3().fromArray(data.positions, data.indices[i + 2]! * 3);
        const areaXZ = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) / 2;
        integralMM3 += areaXZ * (a.y + b.y + c.y) / 3;
        expect(b.clone().sub(a).cross(c.clone().sub(a)).y).toBeGreaterThan(0);
      }
      const expectedM3 = heights.reduce((s, v) => s + v, 0) * config.widthM * config.depthM / heights.length;
      expect(Math.abs(integralMM3 / 1e9 / expectedM3 - 1)).toBeLessThan(2e-7);
    }
  });
  it("keeps a dry field at zero and rejects an invalid field before mutation", () => {
    const config = { widthM: .16, depthM: .2, heightM: 2, nx: 4, nz: 4 }, heights = new Float64Array(16);
    const data = tankSurfaceData(config, heights, undefined, .75, [.24, .27, .29], true), before = data.positions.slice();
    for (let i = 1; i < data.positions.length; i += 3) expect(data.positions[i]).toBe(0);
    heights[15] = -1e-6;
    expect(() => tankSurfaceData(config, heights, data, .75, [.24, .27, .29], true)).toThrow();
    expect(data.positions).toEqual(before);
  });
});
