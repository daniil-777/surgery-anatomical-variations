import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { compositeLinear, validateEntry } from "./contracts";
import { createLumenWalkthrough, type LumenProfile } from "./geometry";
import { createLumenPath } from "./lumenPath";

describe("tissue material boundary", () => {
  it("composites coverage in linear space with exact transparent/opaque endpoints", () => {
    expect(compositeLinear([0, .2, 1], [1, .8, 0], .5, .5)).toEqual([.25, .35000000000000003, .75]);
    expect(compositeLinear([0, 0, 0], [1, 1, 1], 0, 1)).toEqual([0, 0, 0]);
    expect(() => compositeLinear([0], [1], NaN, 1)).toThrow();
  });
  it("rejects catalog path traversal and remote assets", () => {
    for (const path of ["../private.json", "https://elsewhere/a.json", "/tmp/a.json?x"]) expect(() => validateEntry({ id: "x", label: "X", luminal: false, manifest: path, preview: "x/preview.json" })).toThrow();
  });
});

describe("curved lumen path", () => {
  it("has constant physical speed and continuous orthonormal frames over bends and the loop boundary", () => {
    for (const seed of [0, 1, 17, 42, 43, 0xffffffff]) {
      const path = createLumenPath(seed), start = path.sample(0), end = path.sample(path.lengthMm);
      for (const key of ["position", "tangent", "normal", "binormal"] as const) expect(end[key].distanceTo(start[key])).toBeLessThan(1e-10);
      let length = 0, minStep = Infinity, maxStep = 0, maxRotation = 0, maxFrameError = 0, maximumCurvature = 0;
      let previous = path.sample(-.25);
      for (let distance = 0; distance <= path.lengthMm; distance += .25) {
        const frame = path.sample(distance), step = frame.position.distanceTo(previous.position);
        minStep = Math.min(minStep, step); maxStep = Math.max(maxStep, step);
        maxRotation = Math.max(maxRotation, frame.normal.angleTo(previous.normal), frame.tangent.angleTo(previous.tangent));
        maximumCurvature = Math.max(maximumCurvature, frame.tangent.angleTo(previous.tangent) / step);
        maxFrameError = Math.max(maxFrameError, Math.abs(frame.normal.length() - 1), Math.abs(frame.binormal.length() - 1), Math.abs(frame.tangent.length() - 1), Math.abs(frame.normal.dot(frame.tangent)), Math.abs(frame.normal.dot(frame.binormal)), Math.abs(frame.tangent.dot(frame.binormal)));
        if (distance > 0) length += step;
        previous = frame;
      }
      expect(minStep).toBeGreaterThan(.2499); expect(maxStep).toBeLessThan(.2501);
      expect(length).toBeCloseTo(1600, 2); expect(maxRotation).toBeLessThan(.008); expect(maxFrameError).toBeLessThan(1e-10);
      // Radius times curvature below one avoids local inversion of a swept circular envelope.
      expect(maximumCurvature * 42).toBeLessThan(1);
      const epsilon = 1e-4, before = path.sample(-epsilon), after = path.sample(epsilon);
      expect(after.position.clone().sub(before.position).multiplyScalar(1 / (2 * epsilon)).distanceTo(start.tangent)).toBeLessThan(.001);
      expect(before.normal.distanceTo(after.normal)).toBeLessThan(.00001);
    }
  });

  it("rejects invalid seeds and sampling coordinates", () => {
    for (const seed of [-1, .5, 0x100000000, NaN, Infinity]) expect(() => createLumenPath(seed)).toThrow();
    const path = createLumenPath(42);
    for (const value of [NaN, Infinity, -Infinity]) expect(() => path.sample(value)).toThrow();
    for (const tileSizeMm of [0, 9.9, 500.1, NaN]) expect(() => createLumenWalkthrough(42, { tileSizeMm })).toThrow();
  });

  it("does not bring distant sections of the centerline close enough to overlap the lumen", () => {
    for (const seed of [0, 17, 42, 0xffffffff]) {
      const path = createLumenPath(seed), positions = Array.from({ length: 160 }, (_, index) => path.sample(index * 10).position);
      let minimum = Infinity;
      for (let a = 0; a < positions.length; a++) for (let b = a + 1; b < positions.length; b++) {
        const separation = Math.min(b - a, positions.length - (b - a)) * 10;
        if (separation >= 120) minimum = Math.min(minimum, positions[a]!.distanceTo(positions[b]!));
      }
      // The largest authored profile is under 42 mm radius. Nonlocal separation is independent of visual fog.
      expect(minimum).toBeGreaterThan(90);
    }
  });
});

describe("lumen surface and camera", () => {
  it("keeps axial texture scale in physical millimetres for non-divisor recipe tile sizes", () => {
    const model = createLumenWalkthrough(42, { tileSizeMm: 73 });
    expect(model.lengthMm).toBe(1606);
    const uv = model.geometry.getAttribute("uv"), stride = model.metadata.around + 1;
    expect(uv.getY(model.metadata.along * stride)).toBe(22);
    const row = 47;
    expect((uv.getY((row + 1) * stride) - uv.getY(row * stride)) * 73).toBeCloseTo(model.lengthMm / model.metadata.along, 4);
    const first = model.sampleCamera(0), last = model.sampleCamera(model.metadata.loopPeriodSeconds);
    expect(first.position.distanceTo(last.position)).toBeLessThan(1e-9);
    model.geometry.dispose();
  });
  it("is exactly reproducible with meaningful variation between adjacent seeds", () => {
    const a = createLumenWalkthrough(17), b = createLumenWalkthrough(17), c = createLumenWalkthrough(18);
    expect(a.geometry.getAttribute("position").array).toEqual(b.geometry.getAttribute("position").array);
    const delta = Array.from(a.geometry.getAttribute("position").array).reduce((sum, value, i) => sum + Math.abs(value - c.geometry.getAttribute("position").array[i]!), 0);
    expect(delta / a.geometry.getAttribute("position").count).toBeGreaterThan(1);
    for (const item of [a, b, c]) item.geometry.dispose();
  });

  for (const profile of ["colon", "small-bowel", "gastric"] as LumenProfile[]) it(profile + " has finite inward normals, physical clearance and matching geometry/UV seams", () => {
    const model = createLumenWalkthrough(42, { profile }), { around, along, tileSizeMm } = model.metadata;
    const p = model.geometry.getAttribute("position"), n = model.geometry.getAttribute("normal"), uv = model.geometry.getAttribute("uv");
    let minimumRadius = Infinity, maximumRadius = 0, maximumNormalError = 0, largestOutwardDot = -Infinity;
    for (let row = 0; row <= along; row++) {
      const center = model.sample(row / along * model.lengthMm).position;
      for (let column = 0; column <= around; column++) {
        const index = row * (around + 1) + column, offset = new THREE.Vector3().fromBufferAttribute(p, index).sub(center), normal = new THREE.Vector3().fromBufferAttribute(n, index);
        minimumRadius = Math.min(minimumRadius, offset.length()); maximumRadius = Math.max(maximumRadius, offset.length());
        maximumNormalError = Math.max(maximumNormalError, Math.abs(normal.length() - 1));
        largestOutwardDot = Math.max(largestOutwardDot, offset.normalize().dot(normal));
      }
      const first = row * (around + 1), last = first + around;
      expect(new THREE.Vector3().fromBufferAttribute(p, first).distanceTo(new THREE.Vector3().fromBufferAttribute(p, last))).toBe(0);
      expect(new THREE.Vector3().fromBufferAttribute(n, first).distanceTo(new THREE.Vector3().fromBufferAttribute(n, last))).toBe(0);
      expect(uv.getX(last) - uv.getX(first)).toBeCloseTo(model.metadata.nominalCircumferenceMm / tileSizeMm, 6);
    }
    expect(Number.isFinite(minimumRadius + maximumRadius + maximumNormalError + largestOutwardDot)).toBe(true);
    expect(minimumRadius).toBeGreaterThan(profile === "small-bowel" ? 9 : 12);
    expect(maximumRadius).toBeLessThan(42); expect(maximumNormalError).toBeLessThan(1e-6); expect(largestOutwardDot).toBeLessThan(-.35);
    for (let column = 0; column <= around; column++) {
      const end = along * (around + 1) + column;
      expect(new THREE.Vector3().fromBufferAttribute(p, column).distanceTo(new THREE.Vector3().fromBufferAttribute(p, end))).toBe(0);
      expect(new THREE.Vector3().fromBufferAttribute(n, column).distanceTo(new THREE.Vector3().fromBufferAttribute(n, end))).toBe(0);
      expect(uv.getY(end) - uv.getY(column)).toBe(model.lengthMm / tileSizeMm);
    }
    model.geometry.dispose();
  });

  it("has partial, asymmetric colonic folds and visibly different profile morphology", () => {
    const colon = createLumenWalkthrough(42), bowel = createLumenWalkthrough(42, { profile: "small-bowel" }), gastric = createLumenWalkthrough(42, { profile: "gastric" });
    let partialFolds = 0, meanColonicDiameter = 0, meanBowelDiameter = 0, meanGastricDiameter = 0;
    for (let s = 0; s < colon.lengthMm; s += 2) {
      const radii = Array.from({ length: 24 }, (_, i) => colon.surfaceRadius(s, i / 24 * Math.PI * 2));
      const low = radii.indexOf(Math.min(...radii));
      if (radii[(low + 12) % 24]! - radii[low]! > 4) partialFolds++;
      meanColonicDiameter += colon.surfaceRadius(s, 0) + colon.surfaceRadius(s, Math.PI);
      meanBowelDiameter += bowel.surfaceRadius(s, 0) + bowel.surfaceRadius(s, Math.PI);
      meanGastricDiameter += gastric.surfaceRadius(s, 0) + gastric.surfaceRadius(s, Math.PI);
    }
    expect(partialFolds).toBeGreaterThan(200);
    expect(meanColonicDiameter / meanBowelDiameter).toBeGreaterThan(1.2);
    expect(meanGastricDiameter / meanColonicDiameter).toBeGreaterThan(1.15);
    for (const model of [colon, bowel, gastric]) model.geometry.dispose();
  });

  for (const profile of ["colon", "small-bowel", "gastric"] as LumenProfile[]) it(profile + " camera repeats without a pose jump and has at least 8 mm measured radial wall clearance", () => {
    const model = createLumenWalkthrough(42, { profile }), material = new THREE.MeshBasicMaterial({ side: THREE.FrontSide }), mesh = new THREE.Mesh(model.geometry, material);
    mesh.updateMatrixWorld();
    const start = model.sampleCamera(0), end = model.sampleCamera(model.metadata.loopPeriodSeconds);
    for (const key of ["position", "target", "up"] as const) expect(start[key].distanceTo(end[key])).toBeLessThan(1e-9);
    let minimumHit = Infinity;
    for (const distance of [0, 90, 240, 570, 910, 1310, 1599]) {
      const pose = model.sampleCamera(distance / 18), frame = model.sample(distance);
      expect(pose.position.distanceTo(frame.position)).toBeLessThan(4.2);
      for (let i = 0; i < 12; i++) {
        const angle = i / 12 * Math.PI * 2, direction = frame.normal.clone().multiplyScalar(Math.cos(angle)).addScaledVector(frame.binormal, Math.sin(angle));
        const hit = new THREE.Raycaster(pose.position, direction, 0, 60).intersectObject(mesh)[0];
        expect(hit).toBeDefined(); if (hit) minimumHit = Math.min(minimumHit, hit.distance);
      }
    }
    expect(minimumHit).toBeGreaterThan(8);
    expect(() => model.sampleCamera(NaN)).toThrow(); expect(() => model.sampleCamera(0, 0)).toThrow();
    model.geometry.dispose(); material.dispose();
  });
});
