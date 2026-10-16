import type { Appearance, SceneData } from "@viscera/render";

export const MAX_PROJECT_BYTES = 32 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const color = (value: unknown): value is string =>
  typeof value === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
const finiteArray = (value: unknown, length?: number): value is number[] =>
  Array.isArray(value) &&
  (length === undefined || value.length === length) &&
  value.every((n) => typeof n === "number" && Number.isFinite(n));

/** Validate before touching React state; these structural checks do not certify anatomy. */
export function validateScene(value: unknown): asserts value is SceneData {
  if (!record(value) || !Array.isArray(value.organs) || !value.organs.length)
    throw new Error("The scene contains no organ meshes");
  if (value.vessels !== undefined && !Array.isArray(value.vessels))
    throw new Error("Scene vessels must be an array");
  const ids = new Set<string>();
  for (const mesh of [...value.organs, ...(value.vessels ?? [])]) {
    if (
      !record(mesh) ||
      typeof mesh.id !== "string" ||
      !/^[a-z][a-z0-9_-]*$/i.test(mesh.id) ||
      ["__proto__", "constructor", "prototype"].includes(mesh.id) ||
      ids.has(mesh.id) ||
      typeof mesh.name !== "string" ||
      !mesh.name.trim() ||
      typeof mesh.kind !== "string" ||
      !color(mesh.color)
    )
      throw new Error(
        "Scene objects require unique IDs, names, kinds and hex colors",
      );
    ids.add(mesh.id);
    if (
      !finiteArray(mesh.positions) ||
      mesh.positions.length < 9 ||
      mesh.positions.length % 3 ||
      !finiteArray(mesh.indices) ||
      mesh.indices.length < 3 ||
      mesh.indices.length % 3 ||
      !mesh.indices.every(
        (i) =>
          Number.isInteger(i) &&
          i >= 0 &&
          i < (mesh.positions as number[]).length / 3,
      )
    )
      throw new Error("Scene mesh validation failed");
    for (const key of ["normals", "colors", "uv"] as const) {
      if (
        mesh[key] !== undefined &&
        !finiteArray(
          mesh[key],
          mesh.positions.length * (key === "uv" ? 2 / 3 : 1),
        )
      )
        throw new Error(
          `Scene ${key} must match the vertex count and contain finite values`,
        );
    }
    if (
      mesh.colors &&
      !(mesh.colors as number[]).every((v) => v >= 0 && v <= 1)
    )
      throw new Error("Scene pigment values must be between zero and one");
    for (const key of ["metadata", "landmarks"] as const)
      if (mesh[key] !== undefined && !record(mesh[key]))
        throw new Error(`Invalid mesh ${key}`);
  }
  for (const key of ["spec", "parameters", "metadata"] as const)
    if (value[key] !== undefined && !record(value[key]))
      throw new Error(`Invalid scene ${key}`);
  for (const seed of [
    (value.spec as Record<string, unknown> | undefined)?.seed,
    (value.parameters as Record<string, unknown> | undefined)?.seed,
  ])
    if (
      seed !== undefined &&
      (typeof seed !== "number" ||
        !Number.isInteger(seed) ||
        seed < 0 ||
        seed > 4294967295)
    )
      throw new Error("Scene seed must be an unsigned 32-bit integer");
}

export interface ImportedProject {
  scene: SceneData;
  appearance: Record<string, Appearance>;
  hidden: Set<string>;
  locked: Set<string>;
}
export function parseProject(value: unknown): ImportedProject {
  if (!record(value)) throw new Error("Invalid project file");
  if (
    value.format !== undefined &&
    (value.format !== "viscera-studio-project" || value.version !== "0.1.0")
  )
    throw new Error("Unsupported Studio project format or version");
  const scene = value.scene ?? value;
  validateScene(scene);
  const ids = new Set(
    [...scene.organs, ...(scene.vessels ?? [])].map((o) => o.id),
  );
  const appearance: Record<string, Appearance> = {};
  if (value.appearance !== undefined) {
    if (!record(value.appearance))
      throw new Error("Invalid project appearance");
    for (const [id, material] of Object.entries(value.appearance)) {
      if (
        !ids.has(id) ||
        !record(material) ||
        !color(material.color) ||
        typeof material.wireframe !== "boolean" ||
        ![material.roughness, material.clearcoat, material.opacity].every(
          (v) =>
            typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1,
        )
      )
        throw new Error("Invalid project appearance");
      appearance[id] = material as unknown as Appearance;
    }
  }
  const stateIds = (key: "hidden" | "locked") => {
    const entries = value[key] ?? [];
    const allowed =
      key === "locked" ? new Set(scene.organs.map((o) => o.id)) : ids;
    if (
      !Array.isArray(entries) ||
      !entries.every((id) => typeof id === "string" && allowed.has(id))
    )
      throw new Error(`Invalid project ${key} objects`);
    return new Set<string>(entries as string[]);
  };
  return {
    scene,
    appearance,
    hidden: stateIds("hidden"),
    locked: stateIds("locked"),
  };
}
