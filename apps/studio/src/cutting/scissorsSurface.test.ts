import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ScissorsSurfaceEngine, SCISSORS_SURFACE_PROVENANCE, type ScissorsSnip, type ScissorsSurfaceGeometry } from './scissorsSurface';

const stroke: ScissorsSnip = { positionMm: [0, 0, 0], quaternion: [0, 0, 0, 1], openingRadians: 44 * Math.PI / 180, closingRadians: 0 };
const sheet = () => ({ positionsMm: [-10, 1, 0, 10, 1, 0, 10, 1, 25, -10, 1, 25], indices: [0, 2, 1, 0, 3, 2], colors: Array(12).fill(.5) });
function area(geometry: ScissorsSurfaceGeometry) {
  let sum = 0; const p = geometry.restPositionsMm;
  for (let i = 0; i < geometry.indices.length; i += 3) {
    const [a, b, c] = [...geometry.indices.subarray(i, i + 3)].map(id => 3 * id);
    const u = [0, 1, 2].map(k => p[b! + k]! - p[a! + k]!), v = [0, 1, 2].map(k => p[c! + k]! - p[a! + k]!);
    sum += .5 * Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!);
  }
  return sum;
}
function edges(geometry: ScissorsSurfaceGeometry) {
  const counts = new Map<string, number>();
  for (let i = 0; i < geometry.indices.length; i += 3) for (let j = 0; j < 3; j++) {
    const a = geometry.indices[i + j]!, b = geometry.indices[i + (j + 1) % 3]!, key = a < b ? `${a}:${b}` : `${b}:${a}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

describe('finite laparoscopic surface incisions', () => {
  it('splits the actual surface, retains its area, joins finite tips and adds finite-depth walls', () => {
    const engine = new ScissorsSurfaceEngine(sheet()), before = engine.geometry(), originalArea = area(before);
    expect(engine.snip(stroke)).toMatchObject({ changed: true, reason: 'cut' });
    const geometry = engine.geometry(), count = engine.metrics().nodeCount;
    expect(geometry.revision).toBeGreaterThan(before.revision);
    expect(area(geometry)).toBeCloseTo(originalArea, 4);
    expect(Math.max(...edges(geometry).values())).toBe(2);
    expect(engine.metrics().woundBoundaryEdges).toBeGreaterThan(0);
    expect(geometry.wallIndices.length).toBe(engine.metrics().woundBoundaryEdges * 6);
    expect(geometry.positionsMm.every(Number.isFinite)).toBe(true);
    expect([...geometry.indices, ...geometry.wallIndices].every(id => id >= 0 && id < geometry.positionsMm.length / 3)).toBe(true);
    // Crack tips are shared; only points strictly inside the finite sector have
    // coincident distinct mechanical nodes. Outside the slit, no lip is cut.
    const materialPoints = new Map<string, number[]>();
    for (let id = 0; id < count; id++) {
      const p = geometry.restPositionsMm.subarray(3 * id, 3 * id + 3), key = [...p].map(v => v.toFixed(5)).join(':');
      materialPoints.set(key, [...(materialPoints.get(key) ?? []), id]);
    }
    const separated = [...materialPoints.values()].filter(ids => ids.length > 1);
    expect(separated.length).toBeGreaterThan(3);
    for (const ids of separated) {
      const p = geometry.restPositionsMm.subarray(3 * ids[0]!, 3 * ids[0]! + 3);
      expect(Math.abs(p[0]!)).toBeLessThan(1e-6); expect(p[2]!).toBeGreaterThan(2.5); expect(Math.hypot(p[1]!, p[2]!)).toBeLessThan(18);
    }
    expect(SCISSORS_SURFACE_PROVENANCE.volumetric).toBe(false);
  });

  it('does not allocate or mutate on opening, a miss, an identical closure or an invalid pose', () => {
    const engine = new ScissorsSurfaceEngine(sheet()), before = engine.snapshot(), view = engine.geometry();
    expect(engine.snip({ ...stroke, openingRadians: 0, closingRadians: .7 }).changed).toBe(false);
    expect(engine.snip({ ...stroke, closingRadians: .2 }).changed).toBe(false);
    expect(engine.snip({ ...stroke, positionMm: [50, 50, 50] }).reason).toBe('miss');
    expect(() => engine.snip({ ...stroke, quaternion: [0, 0, 0, 0] })).toThrow();
    expect(() => engine.snip({ ...stroke, quaternion: [1e308, 1e308, 1e308, 1e308] })).toThrow();
    expect(() => engine.snip({ ...stroke, positionMm: [NaN, 0, 0] })).toThrow();
    expect(engine.geometry()).toBe(view); expect(engine.snapshot()).toEqual(before);
    engine.snip(stroke); const cut = engine.snapshot(), cutView = engine.geometry();
    expect(engine.snip({ ...stroke, quaternion: [0, 0, 0, -2] }).reason).toBe('already-cut');
    expect(engine.snapshot()).toEqual(cut); expect(engine.geometry()).toBe(cutView);
  });

  it('cuts exactly along an existing shared mesh edge without perturbing the tool', () => {
    const positionsMm = [-2, 0, 5, 0, 0, 5, 2, 0, 5, -2, 0, 15, 0, 0, 15, 2, 0, 15];
    const engine = new ScissorsSurfaceEngine({ positionsMm, indices: [0, 1, 3, 1, 4, 3, 1, 2, 4, 2, 5, 4], colors: Array(18).fill(.5) });
    const originalArea = area(engine.geometry());
    expect(engine.snip(stroke).changed).toBe(true);
    expect(engine.metrics().woundBoundaryEdges).toBeGreaterThan(2);
    expect(area(engine.geometry())).toBeCloseTo(originalArea, 5);
    expect(Math.max(...edges(engine.geometry()).values())).toBe(2);
    const geometry = engine.geometry();
    for (let i = 0; i < engine.metrics().nodeCount; i++) {
      const x = geometry.restPositionsMm[3 * i]!;
      if (Math.abs(x) < .01) expect(x).toBe(0);
    }
  });

  it('rejects material inside a rectangular wedge but beyond the rendered radial jaw tip', () => {
    const positionsMm = [-1, 6, 17.9, 1, 6, 17.9, 0, 6.1, 18.1];
    const engine = new ScissorsSurfaceEngine({ positionsMm, indices: [0, 1, 2], colors: Array(9).fill(.5) });
    const view = engine.geometry();
    expect(engine.snip({ ...stroke, depthMm: 10 }).reason).toBe('miss');
    expect(engine.geometry()).toBe(view);
  });

  it('captures the full jaw sector independently of the visual wound-wall depth', () => {
    // Y5/Z15 is inside the44-degree,18mm radial jaw sector, despite exceeding
    // the default4mm wall depth. Wall depth is not a hidden capture slab.
    const source = { positionsMm: [-2, 5, 14, 2, 5, 14, 2, 5, 16, -2, 5, 16], indices: [0, 2, 1, 0, 3, 2], colors: Array(12).fill(.5) };
    const shallow = new ScissorsSurfaceEngine(source), deep = new ScissorsSurfaceEngine(source);
    expect(shallow.snip({ ...stroke, depthMm: .5 })).toMatchObject({ changed: true });
    expect(deep.snip({ ...stroke, depthMm: 8 })).toMatchObject({ changed: true });
    expect(shallow.geometry().indices).toEqual(deep.geometry().indices);
    expect(shallow.metrics()).toEqual(deep.metrics());
    const coordinates = 3 * shallow.metrics().nodeCount;
    expect(shallow.geometry().positionsMm.subarray(0, coordinates)).toEqual(deep.geometry().positionsMm.subarray(0, coordinates));
    expect(shallow.geometry().positionsMm.subarray(coordinates)).not.toEqual(deep.geometry().positionsMm.subarray(coordinates));
    expect(shallow.snip({ ...stroke, depthMm: 8 }).reason).toBe('already-cut');
    for (let i = 0; i < 30; i++) { shallow.step(1 / 120); deep.step(1 / 120); }
    expect(shallow.geometry().positionsMm.subarray(0, coordinates)).toEqual(deep.geometry().positionsMm.subarray(0, coordinates));
    expect(shallow.metrics()).toEqual(deep.metrics());
  });

  it('is covariant under a rigid translation and rotation of both tool and surface', () => {
    const angle = .73, c = Math.cos(angle), s = Math.sin(angle), input = sheet();
    const transformed = [...input.positionsMm];
    for (let i = 0; i < transformed.length; i += 3) {
      const x = input.positionsMm[i]!, y = input.positionsMm[i + 1]!;
      transformed[i] = c * x - s * y + 35; transformed[i + 1] = s * x + c * y - 17; transformed[i + 2]! += 8;
    }
    const original = new ScissorsSurfaceEngine(input), turned = new ScissorsSurfaceEngine({ ...input, positionsMm: transformed });
    expect(turned.snip({ ...stroke, positionMm: [35, -17, 8], quaternion: [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)] })).toEqual(original.snip(stroke));
    expect(turned.geometry().indices).toEqual(original.geometry().indices);
    expect(turned.geometry().wallIndices).toEqual(original.geometry().wallIndices);
    expect(area(turned.geometry())).toBeCloseTo(area(original.geometry()), 3);
  });

  it('keeps incision topology during finite shell relaxation and restores intact state on reset', () => {
    const engine = new ScissorsSurfaceEngine(sheet()), original = engine.snapshot(); engine.snip(stroke);
    const view = engine.geometry(), ids = view.indices.slice(), revision = view.revision;
    for (let i = 0; i < 60; i++) engine.step(1 / 120);
    expect(engine.geometry()).toBe(view); expect(view.indices).toEqual(ids); expect(view.revision).toBe(revision);
    expect(view.positionsMm.every(Number.isFinite)).toBe(true);
    expect(engine.metrics().maximumDisplacementMm).toBeGreaterThan(.001);
    expect(engine.metrics().maximumDisplacementMm).toBeLessThan(5);
    const beforeInvalid = engine.snapshot(); expect(() => engine.step(Infinity)).toThrow(); expect(engine.snapshot()).toEqual(beforeInvalid);
    engine.reset(); expect(engine.metrics().cutCount).toBe(0); expect(engine.geometry().wallIndices.length).toBe(0);
    expect(engine.geometry().positionsMm).toEqual(Float32Array.from(original.geometry.positionsMm));
    expect(engine.geometry().indices).toEqual(Uint32Array.from(original.geometry.indices));
  });

  it('restores the prepared liver seam once, then makes a local lobe incision without a global cut', () => {
    const reference = JSON.parse(readFileSync('apps/studio/public/cutting/liver-reference.json', 'utf8'));
    const engine = new ScissorsSurfaceEngine(reference.skin), initial = engine.metrics(), areaBefore = area(engine.geometry());
    expect(initial.nodeCount).toBeLessThan(reference.skin.positionsMm.length / 3);
    expect(initial.originalBoundaryEdges).toBe(230);
    const result = engine.snip({ ...stroke, positionMm: [70, 48.5, -9] });
    expect(result.changed).toBe(true);
    expect(result.cutSegments).toBeLessThan(150);
    expect(area(engine.geometry())).toBeCloseTo(areaBefore, 1);
    expect(Math.max(...edges(engine.geometry()).values())).toBe(2);
    for (let i = 0; i < 60; i++) engine.step(1 / 120);
    expect(engine.geometry().positionsMm.every(Number.isFinite)).toBe(true);
    expect(engine.metrics().maximumDisplacementMm).toBeGreaterThan(1.4);
    expect(engine.metrics().maximumDisplacementMm).toBeLessThan(5);
    expect(engine.metrics().maximumLipOpeningMm).toBeGreaterThan(2.4);
    expect(engine.metrics().maximumLipOpeningMm).toBeLessThan(5.5);
    const relaxed = engine.geometry().positionsMm.slice();
    for (let i = 0; i < 60; i++) engine.step(1 / 120);
    expect(Math.max(...engine.geometry().positionsMm.map((value, i) => Math.abs(value - relaxed[i]!)))).toBeLessThan(.005);
  });

  it('orients wound walls outward into the cleft and couples simultaneous 3D tool-tissue deformation during cutting', () => {
    const engine = new ScissorsSurfaceEngine(sheet());
    engine.setToolInteraction({ positionMm: [0, 0, 0], quaternion: [0, 0, 0, 1], openingRadians: 30 * Math.PI / 180, insertionDepthMm: 2.5, phase: 'closing', intensity: .85 });
    for (let i = 0; i < 20; i++) engine.step(1 / 120);
    // Before topology split, closing jaws indent and pinch the 3D surface.
    expect(engine.metrics().cutCount).toBe(0);
    expect(engine.metrics().maximumDisplacementMm).toBeGreaterThan(.4);
    expect(engine.snip(stroke).changed).toBe(true);
    engine.setToolInteraction({ positionMm: [0, 0, 0], quaternion: [0, 0, 0, 1], openingRadians: 12 * Math.PI / 180, insertionDepthMm: 2.5, phase: 'opening', intensity: .5 });
    for (let i = 0; i < 20; i++) engine.step(1 / 120);
    engine.setToolInteraction(null);
    for (let i = 0; i < 60; i++) engine.step(1 / 120);
    expect(engine.metrics().maximumLipOpeningMm).toBeGreaterThan(2.5);
    // Verify that left and right parenchymal walls have opposing outward X normals facing into the cleft.
    const view = engine.geometry(), p = view.positionsMm, w = view.wallIndices;
    let positiveNormalWalls = 0, negativeNormalWalls = 0;
    for (let i = 0; i < w.length; i += 6) {
      const a = 3 * w[i]!, b = 3 * w[i + 1]!, c = 3 * w[i + 2]!;
      const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
      const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
      const nx = uy * vz - uz * vy;
      if (nx > 1e-3) positiveNormalWalls++;
      else if (nx < -1e-3) negativeNormalWalls++;
    }
    expect(positiveNormalWalls).toBeGreaterThan(0);
    expect(negativeNormalWalls).toBe(positiveNormalWalls);
  });

  it('preserves the first slit during a second crossing incision and finite relaxation', () => {
    const engine = new ScissorsSurfaceEngine(sheet()); engine.snip(stroke);
    const firstBoundary = engine.metrics().woundBoundaryEdges, originalArea = area(engine.geometry());
    const second = engine.snip({ ...stroke, positionMm: [-9, 0, 10], quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2] });
    expect(second.changed).toBe(true); expect(engine.metrics().cutCount).toBe(2);
    expect(engine.metrics().woundBoundaryEdges).toBeGreaterThan(firstBoundary);
    expect(area(engine.geometry())).toBeCloseTo(originalArea, 4);
    expect(Math.max(...edges(engine.geometry()).values())).toBe(2);
    for (let i = 0; i < 60; i++) engine.step(1 / 120);
    expect(engine.geometry().positionsMm.every(Number.isFinite)).toBe(true);
    expect(engine.metrics().maximumDisplacementMm).toBeLessThan(5);
  });

  it('couples calibrated bulk and cohesive material parameters to shell retraction and stiffness', () => {
    const tough = new ScissorsSurfaceEngine(sheet()), brittle = new ScissorsSurfaceEngine(sheet());
    tough.setMaterialParameters({ youngPa: 6000, relaxationFraction: .4, relaxationTimeS: .7, fractureEnergyJm2: 40, peakTractionPa: 12000 });
    brittle.setMaterialParameters({ youngPa: 6000, relaxationFraction: .4, relaxationTimeS: .7, fractureEnergyJm2: 8, peakTractionPa: 24000 });
    expect(() => tough.setMaterialParameters({ youngPa: -10, fractureEnergyJm2: 20, peakTractionPa: 16000 })).toThrow(/material/);
    tough.snip(stroke); brittle.snip(stroke);
    for (let i = 0; i < 60; i++) { tough.step(1 / 120); brittle.step(1 / 120); }
    expect(tough.metrics().maximumLipOpeningMm).toBeGreaterThan(brittle.metrics().maximumLipOpeningMm + .8);
    tough.setMaterialParameters(null);
    for (let i = 0; i < 60; i++) tough.step(1 / 120);
    expect(tough.metrics().maximumLipOpeningMm).toBeLessThan(4.5);
  });

  it('unzips the intermediate crack tip when advancing along an incision to form a wider continuous cleft', () => {
    const engine = new ScissorsSurfaceEngine(sheet());
    expect(engine.snip(stroke).changed).toBe(true);
    for (let i = 0; i < 60; i++) engine.step(1 / 120);
    const firstOpening = engine.metrics().maximumLipOpeningMm;
    expect(firstOpening).toBeGreaterThan(3.2);
    const second = engine.snip({ ...stroke, positionMm: [0, 0, 8] });
    expect(second.changed).toBe(true);
    for (let i = 0; i < 60; i++) engine.step(1 / 120);
    expect(engine.metrics().maximumLipOpeningMm).toBeGreaterThan(firstOpening + .8);
  });
});
