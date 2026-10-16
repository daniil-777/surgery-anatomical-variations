import { describe, expect, it } from "vitest";
import { Color } from "three";
import { pigmentModulation } from "./pigment";
import type { OrganMesh } from "./types";

const mesh: OrganMesh = {
  id: "liver",
  name: "Liver",
  kind: "liver",
  color: "#804020",
  positions: [0, 0, 0, 1, 1, 1],
  indices: [],
  colors: [0.4, 0.2, 0.1, 0.48, 0.24, 0.12],
};

describe("artifact-bound pigment", () => {
  it("reconstructs authored linear RGB with the original base tint", () => {
    const factors = pigmentModulation(mesh);
    const base = new Color(mesh.color).toArray();
    const expected = new Color()
      .setRGB(0.4, 0.2, 0.1)
      .convertSRGBToLinear()
      .toArray();
    for (let channel = 0; channel < 3; channel++) {
      expect(factors[channel]! * base[channel]!).toBeCloseTo(
        expected[channel]!,
        7,
      );
    }
  });

  it("does not swim or change when vertex positions are edited", () => {
    const before = pigmentModulation(mesh);
    const edited = { ...mesh, positions: [500, -300, 12, 25, 17, 4] };
    expect(pigmentModulation(edited)).toEqual(before);
    expect(mesh.colors).toEqual([0.4, 0.2, 0.1, 0.48, 0.24, 0.12]);
  });

  it("uses a neutral fallback only for missing pigment and rejects corrupt arrays", () => {
    const imported = { ...mesh };
    delete imported.colors;
    expect([...pigmentModulation(imported)]).toEqual([1, 1, 1, 1, 1, 1]);
    expect(() => pigmentModulation({ ...mesh, colors: [1, 1, 1] })).toThrow();
    expect(() =>
      pigmentModulation({ ...mesh, colors: [0, 0, 0, 0, NaN, 0] }),
    ).toThrow();
    expect(() =>
      pigmentModulation({ ...mesh, colors: [0, 0, 0, 0, 1.1, 0] }),
    ).toThrow();
  });
});
