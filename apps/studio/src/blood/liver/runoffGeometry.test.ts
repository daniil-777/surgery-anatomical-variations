import { describe, expect, it } from "vitest";
import { attachedRunoffGeometry, dryCollectorGeometry, prepareDryCollectorDisplay, ATTACHED_FLOAT32_ZERO_HEIGHT_M } from "./runoffGeometry";
import { runoffAttachedGeometry } from "./runoff";
import { DryCollectorFilm } from "./dryCollector";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { AtlasGeneration } from "../../atlas";
import { adaptLiverAnatomy } from "./anatomy";
import { LiverFlowExperiment } from "./liverFlow";
import { prepareLiverCut } from "./wounds";

// Independent oriented tetrahedral first moment, with the known local-mm origin.
function integrate(positions: Float32Array, indices: Uint32Array) {
  let volume = 0, firstY = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]! * 3, b = indices[i + 1]! * 3, c = indices[i + 2]! * 3;
    const ax = positions[a]!, ay = positions[a + 1]!, az = positions[a + 2]!;
    const bx = positions[b]!, by = positions[b + 1]!, bz = positions[b + 2]!;
    const cx = positions[c]!, cy = positions[c + 1]!, cz = positions[c + 2]!;
    const dv = (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
    volume += dv; firstY += dv * (ay + by + cy) / 4;
  }
  return { volumeM3: volume / 1e9, centreYM: firstY / volume / 1000 };
}
describe("accepted runoff shape tessellation", () => {
  it("represents every accepted support during the actual two-second coarse experiment, including a rejected-step display", () => {
    const generation = JSON.parse(gunzipSync(readFileSync(new URL(
      "../../../../../public-copy/static/api/atlas/specimens/hra-liver-female.json.gz", import.meta.url))).toString()) as AtlasGeneration;
    const anatomy = adaptLiverAnatomy(generation), target = anatomy.targets.find(t => t.id === "liver-target-1")!;
    const cut = prepareLiverCut(anatomy, [], {
      pick: target.pick, radiusM: .00125, depthM: .001, timeSeconds: 0,
    });
    expect(cut.accepted).toBe(true);
    const model = new LiverFlowExperiment(anatomy, { kind: "vein", viscosityPaS: .00345,
      heartRateBpm: 72, fixedDtSeconds: .002 });
    model.setWounds([cut.wound!]);
    let rejection: { step: number; reason: string | undefined } | null = null;
    for (let step = 0; step < 1000; step++) {
      const result = model.step();
      if (!result.accepted) {
        rejection = { step, reason: result.reason };
        break;
      }
    }
    const state = model.snapshot();
    expect(state.timeSeconds).toBeGreaterThan(0);
    expect(state.runoff.attached.length).toBeGreaterThan(0);
    let accepted = 0, measured = 0, unresolved = 0, bound = 0;
    for (const shape of state.runoff.attached) {
      const data = attachedRunoffGeometry(shape);
      accepted += shape.volumeM3; measured += data.reconstructedVolumeM3;
      unresolved += data.unresolvedVolumeM3; bound += data.unresolvedVolumeBoundM3;
      expect(data.resolved ? data.relativeVolumeError < .004 : data.positions.length === 0,
        JSON.stringify({ timeSeconds: state.timeSeconds, shape, data })).toBe(true);
    }
    expect(unresolved).toBeLessThanOrEqual(bound);
    expect(Math.abs(measured - accepted)).toBeLessThanOrEqual(.004 * (accepted - unresolved) + bound);
    if (process.env.LIVER_RUNOFF_GEOMETRY_EVIDENCE)
      writeFileSync(process.env.LIVER_RUNOFF_GEOMETRY_EVIDENCE, JSON.stringify({
        requestedTimeSeconds: 2, acceptedTimeSeconds: state.timeSeconds, rejection,
        acceptedVolumeM3: accepted, meshVolumeM3: measured,
        unresolvedVolumeM3: unresolved, unresolvedVolumeBoundM3: bound,
        supports: state.runoff.attached.map(shape => {
          const data = attachedRunoffGeometry(shape);
          return { shape, resolved: data.resolved, relativeVolumeError: data.relativeVolumeError,
            unresolvedVolumeM3: data.unresolvedVolumeM3 };
        }),
      }, null, 2));
  }, 60000);
  it("keeps underflow inventory explicit without inventing a minimum size or optical coverage", () => {
    const a = .0005;
    for (const volume of [3.362328649924974e-135, 1e-200, Number.MIN_VALUE,
      Math.PI * a * a * ATTACHED_FLOAT32_ZERO_HEIGHT_M / 2]) {
      const shape = runoffAttachedGeometry([.1, .2, .3], [0, -1, 0], volume, a, .00025);
      const before = JSON.stringify(shape), data = attachedRunoffGeometry(shape);
      expect(data.resolved).toBe(false);
      expect(data.unresolvedVolumeM3).toBe(volume);
      expect(data.unresolvedVolumeM3).toBeLessThanOrEqual(data.unresolvedVolumeBoundM3);
      expect(data.positions.length + data.indices.length + data.normals.length).toBe(0);
      expect(data.physicalAxialThicknessM).toBeGreaterThan(0);
      expect(data.axialOpticalThicknessM).toBe(0);
      expect(data.reconstructedVolumeM3).toBe(0);
      expect(JSON.stringify(shape)).toBe(before);
      expect(() => attachedRunoffGeometry({ ...shape, volumeM3: volume * 2 })).toThrow();
    }
    // The very first positive Float32 metre depth is not discarded. Its local
    // millimetre positions have 1000 subnormal quanta and retain a closed shape.
    const heightM = 2 * ATTACHED_FLOAT32_ZERO_HEIGHT_M;
    const shape = runoffAttachedGeometry([0, 0, 0], [0, 1, 0], Math.PI * a * a * heightM, a, .00025);
    const data = attachedRunoffGeometry(shape);
    expect(data.resolved).toBe(true);
    expect(data.relativeVolumeError).toBeLessThan(.004);
    expect(data.unresolvedVolumeM3).toBe(0);
    expect(Math.fround(data.axialOpticalThicknessM)).toBeGreaterThan(0);
  });
  it("keeps physical dimensions and positive closed volume across neck and spherical-cap regimes", () => {
    for (const volume of [1e-24, 1e-15, 1e-10, 1e-9, 2e-9, 1e-8, 3.3e-8]) {
      const shape = runoffAttachedGeometry([.1, .2, -.3], [0, 1, 0], volume, .001, .0005);
      const preserved = JSON.stringify(shape), data = attachedRunoffGeometry(shape);
      const integral = integrate(data.positions, data.indices);
      expect(integral.volumeM3).toBeGreaterThan(0);
      expect(Math.abs(integral.volumeM3 / volume - 1)).toBeLessThan(.004);
      expect(integral.volumeM3).toBeCloseTo(data.reconstructedVolumeM3, 20);
      const analyticHeight = shape.neckLengthM + shape.capHeightM;
      const ys = Array.from(data.positions).filter((_, i) => i % 3 === 1);
      expect(Math.min(...ys)).toBe(0);
      expect(Math.abs(Math.max(...ys) / 1000 / analyticHeight - 1)).toBeLessThan(1e-7);
      expect(Math.abs(integral.centreYM - (shape.centreOfMassM[1] - shape.anchorM[1])))
        .toBeLessThan(Math.max(1e-16, analyticHeight * .003));
      expect(data.axialOpticalThicknessM).toBe(analyticHeight);
      for (let i = 0; i < data.normals.length; i += 3)
        expect(Math.hypot(data.normals[i]!, data.normals[i + 1]!, data.normals[i + 2]!)).toBeCloseTo(1, 6);
      // Weld normal seams by positions and independently check that every
      // geometric edge occurs twice with opposite orientation.
      const keys = Array.from({ length: data.positions.length / 3 }, (_, i) =>
        Array.from(data.positions.slice(i * 3, i * 3 + 3)).join(","));
      const edges = new Map<string, number>();
      for (let i = 0; i < data.indices.length; i += 3) for (let k = 0; k < 3; k++) {
        const a = keys[data.indices[i + k]!]!, b = keys[data.indices[i + (k + 1) % 3]!]!;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        edges.set(key, (edges.get(key) ?? 0) + (a < b ? 1 : -1));
      }
      expect([...edges.values()].every(v => v === 0)).toBe(true);
      expect(JSON.stringify(shape)).toBe(preserved);
    }
  });
  it("converges geometrically without moving the accepted circular radius or height", () => {
    for (const h of [.0001, .001, .004]) {
      const a = .001, neck = .0005, volume = Math.PI * a * a * neck + Math.PI * h * (3 * a * a + h * h) / 6;
      const shape = runoffAttachedGeometry([0, 0, 0], [0, -1, 0], volume, a, neck);
      const errors = [16, 32, 64, 128].map(n => attachedRunoffGeometry(shape, n, n / 2).relativeVolumeError);
      for (let i = 1; i < errors.length; i++) expect(errors[i]!).toBeLessThan(errors[i - 1]! * .3);
      expect(errors[3]).toBeLessThan(.001);
    }
  });
  it("rejects impossible inventories and exact zero instead of fabricating a visible shape", () => {
    const shape = runoffAttachedGeometry([0, 0, 0], [0, 1, 0], 1e-9, .001, .0005);
    expect(() => attachedRunoffGeometry({ ...shape, volumeM3: shape.volumeM3 * 2 })).toThrow();
    expect(() => attachedRunoffGeometry({ ...shape, volumeM3: 0 })).toThrow();
    expect(() => attachedRunoffGeometry({ ...shape, capHeightM: NaN })).toThrow();
  });
});

describe("authoritative true-dry collector display", () => {
  const state = () => new DryCollectorFilm({ nx: 8, nz: 10, widthM: .08, depthM: .06,
    originXM: -.03, originZM: .11, collectionPlaneYM: -.07 }).snapshot();
  it("is exactly absent initially and transforms from the accepted domain", () => {
    const source = state(), result = dryCollectorGeometry(source);
    expect(result.reconstructedVolumeM3).toBe(0);
    expect(result.positionMm.toArray()).toEqual([10.000000000000002, -70, 140]);
    for (let i = 1; i < result.data.positions.length; i += 3) expect(result.data.positions[i]).toBe(0);
  });
  it("skips only exact dry geometry while preserving domain and full input validation", () => {
    const source = state(), dense = dryCollectorGeometry(source), before = source.heightM.slice();
    const dry = prepareDryCollectorDisplay(source);
    expect(dry.data).toBeNull();
    expect(dry.reconstructedVolumeM3).toBe(dense.reconstructedVolumeM3);
    expect(dry.positionMm).toEqual(dense.positionMm);
    expect(source.heightM).toEqual(before);
    for (const h of [NaN, -1e-10, Infinity, 2.001]) {
      source.heightM[source.heightM.length - 1] = h;
      expect(() => prepareDryCollectorDisplay(source)).toThrow();
    }
    source.heightM.fill(0);
    expect(() => prepareDryCollectorDisplay({ ...source, heightM: new Float64Array(1) })).toThrow();
    expect(() => prepareDryCollectorDisplay({ ...source, domain: { ...source.domain, widthM: 0 } })).toThrow();
    expect(() => prepareDryCollectorDisplay({ ...source, domain: { ...source.domain, nx: 3 } })).toThrow();
    expect(() => prepareDryCollectorDisplay({ ...source, domain: { ...source.domain, originXM: NaN } })).toThrow();
    expect(() => prepareDryCollectorDisplay({ ...source, filmVolumeM3: .001 })).toThrow();
    for (const h of [1e-30, .0003]) {
      source.heightM[0] = h;
      source.filmVolumeM3 = h * source.domain.widthM * source.domain.depthM / source.heightM.length;
      const wet = prepareDryCollectorDisplay(source), reference = dryCollectorGeometry(source);
      expect(wet.data).not.toBeNull();
      expect(wet.data).toEqual(reference.data);
      expect(wet.reconstructedVolumeM3).toBe(reference.reconstructedVolumeM3);
    }
  });
  it("preserves every cell basis including all corners, without mutating accepted state", () => {
    const source = state(), area = source.domain.widthM * source.domain.depthM / source.heightM.length;
    for (let cell = 0; cell < source.heightM.length; cell++) {
      source.heightM.fill(0); source.heightM[cell] = .0003;
      source.filmVolumeM3 = .0003 * area;
      const before = source.heightM.slice(), result = dryCollectorGeometry(source);
      expect(Math.abs(result.reconstructedVolumeM3 / source.filmVolumeM3 - 1)).toBeLessThan(2e-7);
      expect(source.heightM).toEqual(before);
      expect(result.data.positions.every(Number.isFinite)).toBe(true);
    }
  });
  it("rejects inconsistent or invalid heights before modifying reusable buffers", () => {
    const source = state(), data = dryCollectorGeometry(source).data, positions = data.positions.slice();
    source.heightM[0] = -1;
    expect(() => dryCollectorGeometry(source, data)).toThrow();
    expect(data.positions).toEqual(positions);
    source.heightM[0] = NaN;
    expect(() => dryCollectorGeometry(source, data)).toThrow();
    expect(data.positions).toEqual(positions);
    source.heightM[0] = .001;
    expect(() => dryCollectorGeometry(source, data)).toThrow();
    expect(data.positions).toEqual(positions);
  });
});
