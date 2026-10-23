import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { tankBoundaryData, tankSurfaceData, vesselApertures, vesselFrame, vesselWallData, type VesselGeometryConfig } from "./geometry";
import { jetGeometryData } from "./renderer";

const tank = { widthM: .15, depthM: .12, heightM: .15, nx: 8, nz: 6 };
const vessel: VesselGeometryConfig = {
  centrelineM: [[-.03, .025, 0], [0, .025, 0], [.03, .025, 0]], innerRadiusM: .003, wallThicknessM: .0005,
  holes: [{ id: "hole", arcFraction: .5, angleRad: Math.PI * .7, radiusM: .0004 }],
};
describe("experiment render geometry", () => {
  it("uses true tank heights, correct upward winding, SI conversion and closed-wall normals", () => {
    const data = tankSurfaceData(tank, new Float64Array(48).fill(.012));
    expect(Array.from(data.positions.slice(0, 3))).toEqual([-75, 12, -60]);
    expect(Array.from(data.positions.slice(-3))).toEqual([75, 12, 60]);
    for (let i = 0; i < data.normals.length; i += 3) expect(data.normals[i + 1]).toBe(1);
    const boundary = tankBoundaryData(tank, data);
    for (const mesh of [data, boundary]) for (let i = 0; i < mesh.indices.length; i += 3) {
      const a = mesh.indices[i]!, b = mesh.indices[i + 1]!, c = mesh.indices[i + 2]!;
      const pa = new Vector3().fromArray(mesh.positions, a * 3), pb = new Vector3().fromArray(mesh.positions, b * 3), pc = new Vector3().fromArray(mesh.positions, c * 3);
      expect(pb.sub(pa).cross(pc.sub(pa)).dot(new Vector3().fromArray(mesh.normals, a * 3))).toBeGreaterThan(0);
    }
  });
  it("preserves physical slope and reuses the geometry arrays", () => {
    const heights = Float64Array.from({ length: 48 }, (_, i) => .01 + (i % 8) * .0001);
    const first = tankSurfaceData(tank, heights), index = (3 * 9 + 4) * 3;
    expect(-first.normals[index]! / first.normals[index + 1]!).toBeCloseTo(.0001 / (.15 / 8), 8);
    expect(tankSurfaceData(tank, heights, first)).toBe(first);
  });
  it("rejects invalid height data before mutating a reused buffer", () => {
    const heights = new Float64Array(48).fill(.012), data = tankSurfaceData(tank, heights), before = data.positions.slice();
    heights[47] = NaN;
    expect(() => tankSurfaceData(tank, heights, data)).toThrow();
    expect(data.positions).toEqual(before);
    expect(() => tankSurfaceData(tank, new Float64Array(48).fill(-.001))).toThrow();
    expect(() => tankSurfaceData(tank, new Float64Array(48).fill(.2))).toThrow();
  });
  it("shares exact physical outlet positions with the curved wall frame", () => {
    const curved: VesselGeometryConfig = { ...vessel, centrelineM: [[-.03, .025, 0], [0, .03, .005], [.03, .025, 0]] };
    const outlet = vesselApertures(curved)[0]!, frame = vesselFrame(curved);
    expect(new Vector3(...outlet.positionM).distanceTo(frame.curve.getPointAt(.5))).toBeCloseTo(.0035, 12);
    expect(Math.hypot(...outlet.direction)).toBeCloseTo(1, 12);
    expect(outlet.wallLengthM).toBe(.0005);
  });
  it("builds actual open wall apertures instead of covering them with polygons", () => {
    const data = vesselWallData(vessel), closed = vesselWallData({ ...vessel, holes: [] });
    const outlet = vesselApertures(vessel)[0]!, direction = new Vector3(...outlet.direction);
    const origin = new Vector3(...outlet.positionM).addScaledVector(direction, .001).multiplyScalar(1000);
    const ray = new Raycaster(origin, direction.negate());
    const firstHit = (input: typeof data) => {
      const geometry = new BufferGeometry(); geometry.setAttribute("position", new BufferAttribute(input.positions, 3));
      geometry.setIndex(new BufferAttribute(input.indices, 1));
      const material = new MeshBasicMaterial({ side: DoubleSide }), mesh = new Mesh(geometry, material);
      try { return ray.intersectObject(mesh)[0]?.distance; } finally { geometry.dispose(); material.dispose(); }
    };
    expect(firstHit(closed)).toBeCloseTo(1, 1);
    expect(firstHit(data)).toBeGreaterThan(6);
    expect(data.apertureCount).toBe(1);
    for (let i = 0; i < data.normals.length; i += 3)
      expect(Math.hypot(data.normals[i]!, data.normals[i + 1]!, data.normals[i + 2]!)).toBeCloseTo(1, 5);
  });
  it("rejects overlapping holes and malformed dimensions", () => {
    expect(() => vesselWallData({ ...vessel, holes: [vessel.holes[0]!, { ...vessel.holes[0]!, id: "duplicate" }] })).toThrow();
    expect(() => vesselApertures({ ...vessel, innerRadiusM: -1 })).toThrow();
  });
  it("reconstructs a resolved jet from the supplied parcel path and volume only", () => {
    const parcels = [
      { id: 1, holeId: "hole", positionM: [0, .02, 0] as const, velocityMS: [0, -1, 0] as const, volumeM3: 1e-9, ageSeconds: .01, emissionTimeSeconds: 0 },
      { id: 2, holeId: "hole", positionM: [0, .025, 0] as const, velocityMS: [0, -1, 0] as const, volumeM3: 1e-9, ageSeconds: .005, emissionTimeSeconds: .005 },
    ];
    const data = jetGeometryData({ jets: [], parcels, timeSeconds: .01, emissionStepSeconds: .005 });
    expect(Math.abs(data.volumeM3 / 2e-9 - 1)).toBeLessThan(2e-6);
    expect(data.positions.length).toBe((2 * 12 + 2) * 3);
    expect(Array.from(data.positions).every(Number.isFinite)).toBe(true);
    expect(jetGeometryData({ jets: [], parcels: [], timeSeconds: 0, emissionStepSeconds: .005 }).indices.length).toBe(0);
  });
  it("matches independent closed triangle-mesh volume for straight and curved parcel streams", () => {
    for (const curved of [false, true]) {
      const parcels = Array.from({ length: 9 }, (_, i) => ({
        id: i, holeId: "a", positionM: [i * .001, .03 - .001 * i, curved ? .0001 * i * i : 0] as const,
        velocityMS: [.5, -.5, curved ? .1 * i : 0] as const, volumeM3: (1 + .1 * i) * 1e-9,
        ageSeconds: .018 - i * .002, emissionTimeSeconds: i * .002,
      }));
      const data = jetGeometryData({ jets: [], parcels, timeSeconds: .018, emissionStepSeconds: .002 });
      let signedMM3 = 0;
      for (let t = 0; t < data.indices.length; t += 3) {
        const a = new Vector3().fromArray(data.positions, data.indices[t]! * 3);
        const b = new Vector3().fromArray(data.positions, data.indices[t + 1]! * 3);
        const c = new Vector3().fromArray(data.positions, data.indices[t + 2]! * 3);
        signedMM3 += a.dot(b.cross(c)) / 6;
      }
      const expected = parcels.reduce((s, p) => s + p.volumeM3, 0), measured = Math.abs(signedMM3) / 1e9;
      expect(Math.abs(measured / expected - 1)).toBeLessThan(3e-6);
      expect(Math.abs(data.volumeM3 / measured - 1)).toBeLessThan(1e-10);
    }
  });
  it("does not bridge an occlusion gap or reconnect an old detached stream to the outlet", () => {
    const parcels = [0, 1, 5, 6].map(i => ({ id: i, holeId: "a",
      positionM: [i * .01, .03, 0] as const, velocityMS: [1, 0, 0] as const,
      volumeM3: 1e-9, ageSeconds: .014 - i * .002, emissionTimeSeconds: i * .002 }));
    const frame = { timeSeconds: .1, emissionStepSeconds: .002, parcels, jets: [{
      holeId: "a", positionM: [.2, .03, 0] as const, direction: [-1, 0, 0] as const,
      radiusM: .0004, flowM3S: 1e-7, velocityMS: 1, expelledVolumeM3: 4e-9,
    }] };
    const data = jetGeometryData(frame);
    for (let t = 0; t < data.indices.length; t += 3) {
      const xs = [0, 1, 2].map(k => data.positions[data.indices[t + k]! * 3]!);
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(10.001);
      expect(Math.max(...xs)).toBeLessThan(61);
    }
    expect(Math.abs(data.volumeM3 / 4e-9 - 1)).toBeLessThan(3e-6);
  });
});
