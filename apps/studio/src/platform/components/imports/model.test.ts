import { describe, expect, it } from "vitest";
import type { ImportedObject, SourceApp } from "../../core/types";
import {
  addTags,
  advanceJob,
  cleanPath,
  detectionSummary,
  fileKind,
  filterFromRoute,
  formatBounds,
  formatLimit,
  jobFraction,
  jobStatusText,
  matchesFilter,
  matchesSearch,
  originalFileName,
  planImports,
  removeTag,
  routeSourceForFilter,
  safeFileName,
  sectionsBySource,
  sizeRefusal,
  sourceCounts,
  sourceGroup,
  unitsLabel,
  viewerAssetId,
  visibleImports,
  type DroppedFileInfo,
  type SourceFilter,
} from "./model";

function object(id: string, sourceApp: SourceApp, extra: Partial<ImportedObject> = {}): ImportedObject {
  return {
    id,
    title: `Model ${id}`,
    sourceApp,
    sourceDetail: null,
    detectedBy: "metadata",
    format: "glb",
    originalAssetId: `original-${id}`,
    displayAssetId: null,
    thumbnailAssetId: null,
    stats: { meshes: 1, vertices: 8, triangles: 12, materials: 0, textures: 0, animations: 0, skinned: false, bbox: null },
    tags: [],
    favorite: false,
    byteSize: 100,
    createdAt: "2026-10-21T10:00:00.000Z",
    updatedAt: "2026-10-21T10:00:00.000Z",
    trashedAt: null,
    ...extra,
  };
}

const files = (...paths: Array<string | [string, number]>): DroppedFileInfo[] =>
  paths.map((entry) => (typeof entry === "string" ? { path: entry, size: 10 } : { path: entry[0], size: entry[1] }));

/** The plan as file names, which reads better in assertions than indexes. */
function named(input: DroppedFileInfo[]) {
  const plan = planImports(input);
  const name = (index: number) => input[index]?.path ?? "?";
  return {
    groups: plan.groups.map((group) => ({ kind: group.kind, label: group.label, files: group.files.map(name) })),
    ignored: plan.ignored.map(name),
  };
}

describe("source scope", () => {
  const objects = [object("1", "unity"), object("2", "blender"), object("3", "blender"), object("4", "maya"), object("5", "unknown"), object("6", "other")];

  it("groups Unity and Blender on their own and every other application as Other", () => {
    expect(sourceGroup("unity")).toBe("unity");
    expect(sourceGroup("blender")).toBe("blender");
    for (const app of ["maya", "3ds-max", "sketchfab", "other", "unknown"] as const) expect(sourceGroup(app)).toBe("other");
  });

  it("counts every scope", () => {
    expect(sourceCounts(objects)).toEqual({ all: 6, unity: 1, blender: 2, other: 3 });
    expect(sourceCounts([])).toEqual({ all: 0, unity: 0, blender: 0, other: 0 });
  });

  it("maps the route's ?source= to a segment and back", () => {
    expect(filterFromRoute(undefined)).toBe("all");
    expect(filterFromRoute("unity")).toBe("unity");
    expect(filterFromRoute("blender")).toBe("blender");
    expect(filterFromRoute("other")).toBe("other");
    expect(filterFromRoute("maya")).toBe("other");
    expect(filterFromRoute("unknown")).toBe("other");
    const filters: SourceFilter[] = ["all", "unity", "blender", "other"];
    for (const filter of filters) expect(filterFromRoute(routeSourceForFilter(filter))).toBe(filter);
    expect(routeSourceForFilter("all")).toBeUndefined();
  });

  it("filters by scope and keeps the order", () => {
    expect(objects.filter((item) => matchesFilter(item, "other")).map((item) => item.id)).toEqual(["4", "5", "6"]);
    expect(objects.filter((item) => matchesFilter(item, "all"))).toHaveLength(6);
    expect(sectionsBySource(objects).map((section) => [section.group, section.items.map((item) => item.id)])).toEqual([
      ["unity", ["1"]],
      ["blender", ["2", "3"]],
      ["other", ["4", "5", "6"]],
    ]);
    expect(sectionsBySource([object("9", "blender")]).map((section) => section.group)).toEqual(["blender"]);
  });

  it("searches titles, tags, applications, exporter words and formats, every word must match", () => {
    const chair = object("c", "blender", { title: "Office Chair", tags: ["Furniture"], sourceDetail: "Khronos glTF Blender I/O v4.2.70", format: "obj" });
    expect(matchesSearch(chair, "")).toBe(true);
    expect(matchesSearch(chair, "  chair ")).toBe(true);
    expect(matchesSearch(chair, "furniture office")).toBe(true);
    expect(matchesSearch(chair, "khronos")).toBe(true);
    expect(matchesSearch(chair, "OBJ")).toBe(true);
    expect(matchesSearch(chair, "blender")).toBe(true);
    expect(matchesSearch(chair, "chair unity")).toBe(false);
    expect(visibleImports([chair, ...objects], "blender", "chair").map((item) => item.id)).toEqual(["c"]);
  });
});

describe("planImports", () => {
  it("classifies files by name", () => {
    expect(fileKind("Chair.GLB")).toBe("model");
    expect(fileKind("scene.gltf")).toBe("model");
    expect(fileKind("pack.zip")).toBe("archive");
    expect(fileKind("scene.bin")).toBe("sidecar");
    expect(fileKind("textures/Wood_BaseColor.PNG")).toBe("sidecar");
    expect(fileKind("chair.mtl")).toBe("sidecar");
    expect(fileKind("chair.blend")).toBe("project");
    expect(fileKind("Assets.unitypackage")).toBe("project");
    expect(fileKind("model.dae")).toBe("unsupported");
    expect(fileKind("README.md")).toBe("extra");
    expect(fileKind("chair.fbx.meta")).toBe("extra");
    expect(fileKind("__MACOSX/._chair.obj")).toBe("junk");
    expect(fileKind("folder/.DS_Store")).toBe("junk");
    expect(cleanPath("\\Folder\\./sub//a.png")).toBe("Folder/sub/a.png");
  });

  it("keeps a glTF with its buffer and textures together", () => {
    expect(named(files("scene.gltf", "scene.bin", "textures/BaseColor.png", "textures/Normal.png"))).toEqual({
      groups: [{ kind: "model", label: "scene.gltf", files: ["scene.gltf", "scene.bin", "textures/BaseColor.png", "textures/Normal.png"] }],
      ignored: [],
    });
  });

  it("keeps an OBJ with its MTL and textures, whatever order they were dropped in", () => {
    expect(named(files("wood.jpg", "chair.mtl", "chair.obj"))).toEqual({
      groups: [{ kind: "model", label: "chair.obj", files: ["chair.obj", "wood.jpg", "chair.mtl"] }],
      ignored: [],
    });
  });

  it("makes one import per model and shares textures only between models that can use them", () => {
    expect(named(files("a.obj", "a.mtl", "b.obj", "b.mtl", "shared.png", "c.glb", "d.stl"))).toEqual({
      groups: [
        { kind: "model", label: "a.obj", files: ["a.obj", "a.mtl", "shared.png"] },
        { kind: "model", label: "b.obj", files: ["b.obj", "b.mtl", "shared.png"] },
        { kind: "model", label: "c.glb", files: ["c.glb"] },
        { kind: "model", label: "d.stl", files: ["d.stl"] },
      ],
      ignored: [],
    });
  });

  it("gives files in a dropped folder to the model of that folder", () => {
    expect(
      named(files("Chair/chair.gltf", "Chair/chair.bin", "Chair/tex/wood.png", "Table/table.gltf", "Table/table.bin", "Table/tex/oak.png")),
    ).toEqual({
      groups: [
        { kind: "model", label: "chair.gltf", files: ["Chair/chair.gltf", "Chair/chair.bin", "Chair/tex/wood.png"] },
        { kind: "model", label: "table.gltf", files: ["Table/table.gltf", "Table/table.bin", "Table/tex/oak.png"] },
      ],
      ignored: [],
    });
  });

  it("falls back to the only model that can use a companion file", () => {
    expect(named(files("Export/model/scene.gltf", "Export/textures/a.png", "Export/scene.bin"))).toEqual({
      groups: [{ kind: "model", label: "scene.gltf", files: ["Export/model/scene.gltf", "Export/textures/a.png", "Export/scene.bin"] }],
      ignored: [],
    });
  });

  it("never adds companions to complete files, so a GLB original stays the GLB", () => {
    expect(named(files("chair.glb", "chair.glb.meta", "README.txt", "wood.png"))).toEqual({
      groups: [{ kind: "model", label: "chair.glb", files: ["chair.glb"] }],
      ignored: ["chair.glb.meta", "README.txt", "wood.png"],
    });
  });

  it("adds documents only by name (Unity .meta files help detection)", () => {
    expect(named(files("Assets/chair.fbx", "Assets/chair.fbx.meta", "Assets/notes.txt"))).toEqual({
      groups: [{ kind: "model", label: "chair.fbx", files: ["Assets/chair.fbx", "Assets/chair.fbx.meta"] }],
      ignored: ["Assets/notes.txt"],
    });
  });

  it("makes project files and unsupported formats their own import, which the importer refuses with advice", () => {
    expect(named(files("chair.blend", "chair.glb", "scene.dae"))).toEqual({
      groups: [
        { kind: "refused", label: "chair.blend", files: ["chair.blend"] },
        { kind: "model", label: "chair.glb", files: ["chair.glb"] },
        { kind: "refused", label: "scene.dae", files: ["scene.dae"] },
      ],
      ignored: [],
    });
  });

  it("keeps a zip whole and does not mix loose files into it", () => {
    expect(named(files("pack.zip", "extra.png"))).toEqual({
      groups: [{ kind: "archive", label: "pack.zip", files: ["pack.zip"] }],
      ignored: ["extra.png"],
    });
  });

  it("turns companions without any model into one import, so the importer can say what is missing", () => {
    expect(named(files("a.png", "b.mtl", "notes.md"))).toEqual({
      groups: [{ kind: "loose", label: "a.png", files: ["a.png", "b.mtl"] }],
      ignored: ["notes.md"],
    });
    expect(named(files("chair.blend", "chair.png"))).toEqual({
      groups: [{ kind: "refused", label: "chair.blend", files: ["chair.blend"] }],
      ignored: ["chair.png"],
    });
  });

  it("drops duplicates and system clutter", () => {
    expect(named(files("a.glb", "a.glb", ".DS_Store", "__MACOSX/._a.glb"))).toEqual({
      groups: [{ kind: "model", label: "a.glb", files: ["a.glb"] }],
      ignored: ["a.glb", ".DS_Store", "__MACOSX/._a.glb"],
    });
    expect(planImports([])).toEqual({ groups: [], ignored: [] });
  });
});

describe("sizeRefusal", () => {
  const limit = 50 * 1024 * 1024;

  it("refuses a file over the plan's limit before it is read", () => {
    const input = files(["huge.fbx", 80 * 1024 * 1024]);
    const plan = planImports(input);
    expect(sizeRefusal(input, plan.groups[0]!, limit)).toBe("“huge.fbx” is 80 MB. Your plan stores files up to 50 MB each.");
  });

  it("refuses a set of files that is over the limit together (it is kept as one zip)", () => {
    const input = files(["scene.gltf", 1024], ["scene.bin", 30 * 1024 * 1024], ["albedo.png", 25 * 1024 * 1024]);
    const plan = planImports(input);
    expect(sizeRefusal(input, plan.groups[0]!, limit)).toMatch(/^These 3 files are 55 MB together/);
  });

  it("lets files under the limit through, and leaves refused files to the importer", () => {
    const input = files(["ok.glb", 49 * 1024 * 1024], ["big.blend", 900 * 1024 * 1024]);
    const plan = planImports(input);
    expect(sizeRefusal(input, plan.groups[0]!, limit)).toBeNull();
    expect(sizeRefusal(input, plan.groups[1]!, limit)).toBeNull();
  });

  it("formats limits in the binary units the plans use", () => {
    expect(formatLimit(52428800)).toBe("50 MB");
    expect(formatLimit(1073741824)).toBe("1 GB");
    expect(formatLimit(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatLimit(800 * 1024)).toBe("800 KB");
    expect(formatLimit(12)).toBe("12 bytes");
  });
});

describe("wording", () => {
  it("explains where the source application came from", () => {
    expect(detectionSummary({ sourceApp: "blender", sourceDetail: "Khronos glTF Blender I/O v4.2.70", detectedBy: "metadata" })).toBe(
      "Read from the file: “Khronos glTF Blender I/O v4.2.70”.",
    );
    expect(detectionSummary({ sourceApp: "unity", sourceDetail: null, detectedBy: "filename" })).toMatch(/^Guessed from the file and folder names/);
    expect(detectionSummary({ sourceApp: "maya", sourceDetail: "Khronos glTF Blender I/O", detectedBy: "user" })).toBe(
      "Set by you. The file says “Khronos glTF Blender I/O”.",
    );
    expect(detectionSummary({ sourceApp: "unknown", sourceDetail: null, detectedBy: "none" })).toBe("The file names no application.");
  });

  it("formats bounds and units", () => {
    expect(formatBounds({ bbox: { x: 1.2, y: 0.8, z: 2 }, units: "m" })).toBe("1.2 × 0.8 × 2 m");
    expect(formatBounds({ bbox: { x: 1234.5678, y: 10, z: 0 } })).toBe("1,235 × 10 × 0");
    expect(formatBounds({ bbox: null })).toBeNull();
    expect(unitsLabel("cm")).toBe("Centimeters");
    expect(unitsLabel(undefined)).toBe("Not declared");
    expect(unitsLabel("furlong")).toBe("furlong");
  });

  it("names downloads safely", () => {
    expect(safeFileName('Chair: v2 / "final"')).toBe("Chair- v2 - -final");
    expect(safeFileName("  ..  ")).toBe("Imported model");
    expect(originalFileName({ title: "Chair", format: "obj" }, "application/zip")).toBe("Chair.zip");
    expect(originalFileName({ title: "Chair", format: "fbx" }, "application/octet-stream")).toBe("Chair.fbx");
    expect(originalFileName({ title: "Chair", format: "glb" }, null)).toBe("Chair.glb");
  });

  it("shows the preview GLB, or the original when it is a GLB itself", () => {
    expect(viewerAssetId({ displayAssetId: "d", originalAssetId: "o", format: "obj" })).toBe("d");
    expect(viewerAssetId({ displayAssetId: null, originalAssetId: "o", format: "glb" })).toBe("o");
    expect(viewerAssetId({ displayAssetId: null, originalAssetId: "o", format: "stl" })).toBeNull();
  });

  it("adds and removes tags within the database rules", () => {
    expect(addTags(["Chair"], "furniture, chair,  wood  ,,")).toEqual({ tags: ["Chair", "furniture", "wood"], rejected: [] });
    const long = "x".repeat(33);
    expect(addTags([], long).rejected).toEqual([long]);
    const full = Array.from({ length: 20 }, (_, index) => `t${index}`);
    expect(addTags(full, "one more")).toEqual({ tags: full, rejected: ["one more"] });
    expect(removeTag(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("job progress", () => {
  it("moves through analysis, upload and saving on one bar", () => {
    expect(jobFraction({ status: "waiting" })).toBeNull();
    expect(jobFraction({ status: "analyzing", stage: "reading", fraction: 0 })).toBe(0);
    expect(jobFraction({ status: "analyzing", stage: "thumbnail", fraction: 1 })).toBeCloseTo(0.6);
    expect(jobFraction({ status: "uploading", loaded: 50, total: 100 })).toBeCloseTo(0.785);
    expect(jobFraction({ status: "uploading", loaded: 0, total: 0 })).toBeCloseTo(0.6);
    expect(jobFraction({ status: "saving" })).toBeCloseTo(0.97);
    expect(jobFraction({ status: "failed", reason: "x", advice: null, retryable: false })).toBe(1);
  });

  it("describes each stage", () => {
    expect(jobStatusText({ status: "analyzing", stage: "converting", fraction: 0.5 })).toBe("Making a GLB Preview…");
    expect(jobStatusText({ status: "uploading", loaded: 1_250_000, total: 12_000_000 })).toBe("Uploading 1.3 of 12.0 MB…");
    expect(jobStatusText({ status: "failed", reason: "Nope.", advice: null, retryable: false })).toBe("Nope.");
  });

  it("never moves the analysis bar backwards", () => {
    const previous = { status: "analyzing", stage: "loading", fraction: 0.5 } as const;
    expect(advanceJob(previous, { status: "analyzing", stage: "measuring", fraction: 0.2 })).toEqual({ status: "analyzing", stage: "measuring", fraction: 0.5 });
    expect(advanceJob(previous, { status: "uploading", loaded: 0, total: 10 })).toEqual({ status: "uploading", loaded: 0, total: 10 });
  });
});
