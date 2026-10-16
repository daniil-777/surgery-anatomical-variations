import { describe, expect, it } from "vitest";
import { SceneSurfaceContact } from "./wholeSceneContact";
import { toolCapsuleMayMeetBounds } from "./wholeSceneToolBounds";

const point = (x: number, y: number, z: number) => ({ x, y, z });
const vector = (p: number[]) => point(p[0]!, p[1]!, p[2]!);
const bounds = { min: point(-2, -2, 0), max: point(2, 2, 0) };

describe("current instrument broad phase", () => {
  it("rejects a diagonal shaft whose enclosing box alone overlaps the organ", () => {
    const box = { min: point(-1, -1, -1), max: point(1, 1, 1) };
    expect(toolCapsuleMayMeetBounds(point(0, 0, 10), point(10, 0, 0), .3, box)).toBe(false);
    expect(toolCapsuleMayMeetBounds(point(0, 0, 10), point(0, 0, -10), .3, box)).toBe(true);
    expect(toolCapsuleMayMeetBounds(point(0, 0, 0), point(0, 0, 0), .3, box)).toBe(true);
    expect(toolCapsuleMayMeetBounds(point(0, 0, 1.3), point(1, 0, 1.3), .3, box)).toBe(true);
  });
  it("never rejects actual triangle contacts across deterministic mixed directions and radii", () => {
    const surface = new SceneSurfaceContact("thin-sheet", new Float32Array([-2, -2, 0, 2, -2, 0, 0, 2, 0]), new Uint32Array([0, 1, 2]));
    let seed = 29, contacts = 0, rejected = 0;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 500; i++) {
      const start = [0, 1, 2].map(() => random() * 12 - 6), end = [0, 1, 2].map(() => random() * 12 - 6), radius = .05 + random();
      const narrow = surface.closestCapsule(start, end, radius);
      const broad = toolCapsuleMayMeetBounds(vector(start), vector(end), radius, bounds);
      if (narrow) { contacts++; expect(broad).toBe(true); }
      if (!broad) rejected++;
    }
    expect(contacts).toBeGreaterThan(30); expect(rejected).toBeGreaterThan(100);
  });
  it("keeps unknown or nonfinite bounds for validation by the narrow phase", () => {
    expect(toolCapsuleMayMeetBounds(point(0, 0, 0), point(1, 1, 1), NaN, bounds)).toBe(true);
    expect(toolCapsuleMayMeetBounds(point(NaN, 0, 0), point(1, 1, 1), .5, bounds)).toBe(true);
    expect(toolCapsuleMayMeetBounds(point(100, 0, NaN), point(101, 1, 1), .5, bounds)).toBe(true);
  });
});
