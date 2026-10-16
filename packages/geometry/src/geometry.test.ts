import { describe, it, expect } from "vitest";
import {
  brushMesh,
  meshMetrics,
  scaleMesh,
  validateSurfaceEdit,
} from "./index";
const tet = {
  positions: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10],
  indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
};
describe("surface editing preview", () => {
  it("measures physical volume and cubic scale without changing topology", () => {
    expect(meshMetrics(tet).volumeMl).toBeCloseTo(1 / 6, 12);
    const positions = scaleMesh(tet, "all", 2);
    expect(meshMetrics({ ...tet, positions }).volumeMl).toBeCloseTo(8 / 6, 12);
    expect(validateSurfaceEdit(tet, positions).valid).toBe(true);
  });
  it("rejects nonfinite coordinates and collapsed triangles", () => {
    const bad = tet.positions.slice();
    bad[0] = NaN;
    expect(validateSurfaceEdit(tet, bad).valid).toBe(false);
    expect(validateSurfaceEdit(tet, new Array(12).fill(0)).valid).toBe(false);
  });
  it("keeps distant points unchanged under a local brush and has bounded support", () => {
    const p = brushMesh(tet, {
      tool: "grab",
      point: [0, 0, 0],
      delta: [0.1, 0, 0],
      normal: [0, 0, 1],
      radius: 3,
      strength: 0.5,
    });
    expect(p[0]).toBeCloseTo(0.05);
    expect(p.slice(3)).toEqual(tet.positions.slice(3));
    expect(tet.positions[0]).toBe(0);
    expect(validateSurfaceEdit(tet, p).valid).toBe(true);
  });
  it("preserves a uniform positive axis scale and rejects reflection", () => {
    expect(validateSurfaceEdit(tet, scaleMesh(tet, 0, 0.8)).valid).toBe(true);
    expect(validateSurfaceEdit(tet, scaleMesh(tet, 0, -1)).valid).toBe(false);
  });
});
