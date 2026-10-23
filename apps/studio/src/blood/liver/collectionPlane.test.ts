import { describe, expect, it } from "vitest";
import { liverCollectionPlaneYM, LIVER_COLLECTION_CLEARANCE_M } from "./collectionPlane";
import { LiverSurfaceCollision } from "./surfaceCollision";
import { intactLiverFilmGeometry } from "./surfaceFlow";
import type { LiverSurface } from "./types";

const surface = (): LiverSurface => ({
  positionsM: new Float64Array([0, -.03, 0, .02, -.03, 0, 0, -.03, .02]),
  normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 2, 1]),
});

describe("shared liver stage and physical collection plane", () => {
  it("uses the canonical minimum Y with exactly twenty millimetres clearance in SI", () => {
    const mesh = surface(), original = mesh.positionsM.slice();
    expect(LIVER_COLLECTION_CLEARANCE_M).toBe(.02);
    expect(liverCollectionPlaneYM(mesh)).toBe(-.05);
    expect(mesh.positionsM).toEqual(original);
    const subdivided = { positionsM: Float64Array.from([...mesh.positionsM, .01, -.03, 0, 0, -.03, .01]) };
    expect(liverCollectionPlaneYM(subdivided)).toBe(liverCollectionPlaneYM(mesh));
    const translated = { positionsM: mesh.positionsM.map((x, i) => i % 3 === 1 ? x + .123 : x) };
    expect(liverCollectionPlaneYM(translated)).toBeCloseTo(.073, 15);
  });

  it("rejects empty, malformed and non-finite geometry without returning an invalid plane", () => {
    for (const positionsM of [new Float64Array(), new Float64Array(8),
      new Float64Array([0, 0, 0, 1, NaN, 0, 0, 0, 1]),
      new Float64Array([Infinity, 0, 0, 1, 0, 0, 0, 0, 1])])
      expect(() => liverCollectionPlaneYM({ positionsM })).toThrow(/finite metre-scale/);
  });

  it.each([0, .0007])("lands an off-organ ballistic packet on the visible stage with support radius %s", radius => {
    const mesh = surface(), plane = liverCollectionPlaneYM(mesh);
    const collision = new LiverSurfaceCollision(mesh, intactLiverFilmGeometry(mesh), plane);
    const birth = .4, clearance = .012, downwardSpeed = .08, gravity = 9.81;
    // Independently solve clearance − u t − g t²/2 = 0.
    const elapsed = (Math.sqrt(downwardSpeed ** 2 + 2 * gravity * clearance) - downwardSpeed) / gravity;
    const origin: [number, number, number] = [.1, plane + radius + clearance, .1];
    const hit = collision.contact(origin, [.02, -downwardSpeed, -.01], [0, -gravity, 0],
      birth, birth, birth + .2, radius)!;
    expect(hit.surface).toBeUndefined();
    expect(hit.timeSeconds).toBeCloseTo(birth + elapsed, 13);
    expect(hit.positionM[0]).toBeCloseTo(.1 + .02 * elapsed, 13);
    expect(hit.positionM[1]).toBe(plane);
    expect(hit.positionM[2]).toBeCloseTo(.1 - .01 * elapsed, 13);
    // A later interval sees the same absolute crossing, not a new trajectory.
    expect(collision.contact(origin, [.02, -downwardSpeed, -.01], [0, -gravity, 0],
      birth, birth + elapsed / 2, birth + .2, radius)!.timeSeconds).toBeCloseTo(hit.timeSeconds, 13);
  });

  it("keeps a real organ contact ahead of the lower laboratory stage", () => {
    const mesh = surface(), collision = new LiverSurfaceCollision(mesh, intactLiverFilmGeometry(mesh),
      liverCollectionPlaneYM(mesh));
    const hit = collision.contact([.005, -.01, .005], [0, -.2, 0], [0, 0, 0], 0, 0, .2, 0)!;
    expect(hit.surface).toBeDefined();
    expect(hit.timeSeconds).toBeCloseTo(.1, 14);
    expect(hit.positionM[1]).toBeCloseTo(-.03, 14);
  });
});
