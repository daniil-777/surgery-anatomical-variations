import { describe, expect, it } from "vitest";
import { parseProject, validateScene } from "./project";
const organ = {
  id: "liver",
  name: "Liver",
  kind: "organ",
  color: "#68332b",
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  indices: [0, 1, 2],
};
const scene = { organs: [organ] };
describe("atomic Studio project validation", () => {
  it("loads raw scenes with empty editor state", () => {
    const result = parseProject(scene);
    expect(result.scene).toBe(scene);
    expect(result.hidden.size).toBe(0);
    expect(result.locked.size).toBe(0);
  });
  it("rejects duplicate IDs and empty surfaces before renderer adoption", () => {
    expect(() => validateScene({ organs: [organ, organ] })).toThrow(/unique/);
    expect(() =>
      validateScene({ organs: [{ ...organ, positions: [], indices: [] }] }),
    ).toThrow(/mesh validation/);
  });
  it("rejects corrupted vertex attributes and out-of-range appearance", () => {
    expect(() =>
      validateScene({ organs: [{ ...organ, colors: [1, 0, 0] }] }),
    ).toThrow(/vertex count/);
    expect(() =>
      parseProject({
        scene,
        appearance: {
          liver: {
            color: "#ffffff",
            roughness: 4,
            clearcoat: 0,
            opacity: 1,
            wireframe: false,
          },
        },
      }),
    ).toThrow(/appearance/);
    expect(() => parseProject({ scene, hidden: ["missing-organ"] })).toThrow(
      /hidden/,
    );
  });
  it("rejects unsupported versions and invalid seeds", () => {
    expect(() =>
      parseProject({ format: "viscera-studio-project", version: "99", scene }),
    ).toThrow(/version/);
    expect(() => validateScene({ ...scene, spec: { seed: Infinity } })).toThrow(
      /seed/,
    );
  });
});
