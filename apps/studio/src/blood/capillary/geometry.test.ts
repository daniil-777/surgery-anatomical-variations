import { describe, expect, it } from "vitest";
import { filmGeometryData } from "./geometry";

describe("physical thin-film geometry", () => {
  it("preserves physical dimensions and flat normals, including the periodic seam", () => {
    const data = filmGeometryData(new Float64Array(16).fill(50e-6), .004, .001);
    expect(Array.from(data.positions.slice(0, 6))).toEqual([-2, Math.fround(.05), -.5, -2, Math.fround(.05), .5]);
    expect(data.positions.at(-6)).toBe(2);
    for (let i = 0; i < data.normals.length; i += 3) expect(Array.from(data.normals.slice(i, i + 3))).toEqual([-0, 1, 0]);
    expect(Array.from(data.colours.slice(0, 6))).toEqual(Array.from(data.colours.slice(-6)));
  });
  it("uses the true derivative and upward triangle winding", () => {
    const n = 32, length = .004, dx = length / n;
    const heights = Float64Array.from({ length: n }, (_, i) => 60e-6 + 10e-6 * Math.sin(2 * Math.PI * (i + .5) / n));
    const data = filmGeometryData(heights, length, .001);
    const expectedSlope = (heights[0]! - heights[n - 1]!) / dx;
    expect(data.normals[0]! / data.normals[1]!).toBeCloseTo(-expectedSlope, 7);
    expect(data.positions[1]).toBeCloseTo(.060, 7);
    for (let i = 0; i < data.indices.length; i += 3) {
      const [a, b, c] = Array.from(data.indices.slice(i, i + 3), v => 3 * v);
      const signedY = (data.positions[b! + 2]! - data.positions[a! + 2]!) * (data.positions[c!]! - data.positions[a!]!)
        - (data.positions[b!]! - data.positions[a!]!) * (data.positions[c! + 2]! - data.positions[a! + 2]!);
      expect(signedY).toBeGreaterThan(0);
    }
    expect(data.normals.slice(0, 6)).toEqual(data.normals.slice(-6));
  });
  it("rejects bad dimensions and nonfinite heights before constructing a surface", () => {
    expect(() => filmGeometryData(new Float64Array(8).fill(-1), .004, .001)).toThrow();
    expect(() => filmGeometryData(new Float64Array(8).fill(Infinity), .004, .001)).toThrow();
    expect(() => filmGeometryData(new Float64Array(8).fill(1e-5), 0, .001)).toThrow();
  });
});
