import { expect, it } from "vitest";
import { geometryFor, synchronizeGeometry } from "./mesh-geometry";
const organ = {
  id: "liver",
  name: "Liver",
  kind: "organ",
  color: "#68332b",
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  indices: [0, 1, 2],
  uv: [0, 0, 1, 0, 0, 1],
};
const pigment = new Float32Array(9).fill(1);
it("replaces equal-sized imported topology and vertex attributes", () => {
  const geometry = geometryFor(organ, pigment);
  synchronizeGeometry(
    geometry,
    { ...organ, indices: [0, 2, 1], uv: [1, 1, 0, 1, 1, 0] },
    pigment,
  );
  expect(Array.from(geometry.index!.array)).toEqual([0, 2, 1]);
  expect(geometry.getAttribute("normal").getZ(0)).toBe(-1);
  expect(geometry.getAttribute("uv").getX(0)).toBe(1);
  geometry.dispose();
});
it("does not retain UVs from a different surface after import", () => {
  const geometry = geometryFor(organ, pigment);
  const { uv: _uv, ...withoutUV } = organ;
  synchronizeGeometry(geometry, withoutUV, pigment);
  expect(geometry.hasAttribute("uv")).toBe(false);
  geometry.dispose();
});
