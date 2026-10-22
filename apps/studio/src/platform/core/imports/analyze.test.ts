// analyzeFiles end to end in node. Two DOM pieces are stubbed (FileReader for GLTFExporter, ProgressEvent for three's
// FileLoader); there is no WebGL, so thumbnails are null with a note — the thumbnail itself, PNG/JPEG texture
// decoding and texture re-encoding are exercised in a real browser by px-imports-check.html.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { unzipSync } from "fflate";
import {
  cubeGlb,
  cubeGltf,
  fbxBinary,
  fileOf,
  NodeFileReader,
  NodeProgressEvent,
  objText,
  pngHeader,
  QUAD_TRIANGLES,
  stlBinary,
  zipOf,
} from "./__fixtures__/builders";
import { isPlatformError, PlatformError } from "../types";
import { analyzeFiles as analyzeDirect, type AnalyzeOptions, type ImportProgress } from "./analyze";
import { ImportChoiceError, ImportRejectedError } from "./errors";
import { analyzeFiles, importedObjectInput, importTags } from "./index";

beforeAll(() => {
  vi.stubGlobal("FileReader", NodeFileReader);
  if (typeof ProgressEvent === "undefined") vi.stubGlobal("ProgressEvent", NodeProgressEvent);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const NO_WEBGL = "No thumbnail was rendered (no WebGL in this environment).";
/** The free plan's per-file limit. */
const PLAN = { maxBytes: 50 * 1024 * 1024 };

function options(extra: Partial<AnalyzeOptions> = {}): AnalyzeOptions {
  return { ...PLAN, ...extra };
}

async function refusal(files: File[], extra?: Partial<AnalyzeOptions>): Promise<{ code: string; detail: string | null; message: string; error: unknown }> {
  try {
    await analyzeFiles(files, options(extra));
  } catch (error) {
    if (isPlatformError(error)) return { code: error.code, detail: error.detail, message: error.message, error };
    throw error;
  }
  throw new Error("expected a refusal");
}

async function glbMagic(blob: Blob | null): Promise<string> {
  return blob ? new TextDecoder().decode(new Uint8Array(await blob.slice(0, 4).arrayBuffer())) : "none";
}

describe("single files", () => {
  it("analyses an STL from Blender: detection, statistics, preview GLB, original kept as is", async () => {
    const file = fileOf(stlBinary(QUAD_TRIANGLES, "Exported from Blender-3.3.0"), "Liver Lobe.stl");
    const result = await analyzeFiles([file], options());
    expect(result).toMatchObject({
      format: "stl",
      mainFile: "Liver Lobe.stl",
      title: "Liver Lobe",
      sourceApp: "blender",
      sourceDetail: "Exported from Blender-3.3.0",
      detectedBy: "metadata",
      container: "file",
      originalName: "Liver Lobe.stl",
      originalMime: "model/stl",
      thumbnail: null,
      stats: { meshes: 1, vertices: 4, triangles: 2, materials: 1, textures: 0, animations: 0, skinned: false, upAxis: "Z" },
    });
    expect(result.evidence[0]).toBe('STL binary header "Exported from Blender-3.3.0"');
    expect(result.notes).toEqual([expect.stringMatching(/STL holds only triangles/), NO_WEBGL]);
    expect(result.stats.notes).toEqual(result.notes);
    expect(result.original.type).toBe("model/stl");
    expect(result.original.size).toBe(file.size);
    expect(await glbMagic(result.displayGlb)).toBe("glTF");
    expect(result.files).toEqual([{ path: "Liver Lobe.stl", bytes: file.size, role: "model" }]);
  });

  it("keeps a GLB as its own preview", async () => {
    const result = await analyzeFiles([fileOf(cubeGlb({ generator: "Unity 2022.3.10f1 glTFast 6.0.1" }), "Heart.glb")], options());
    expect(result).toMatchObject({ format: "glb", sourceApp: "unity", detectedBy: "metadata", displayGlb: null, originalMime: "model/gltf-binary", stats: { units: "m", upAxis: "Y" } });
  });

  it("detects an FBX source from its header and reads units and axes", async () => {
    const fbx = fbxBinary({ mesh: true, upAxis: 1, unitScaleFactor: 1, lastSaved: { vendor: "", name: "Unity FBX Exporter", version: "4.1.2" } });
    const result = await analyzeFiles([fileOf(fbx, "Organ.fbx")], options());
    expect(result).toMatchObject({ format: "fbx", sourceApp: "unity", sourceDetail: "Unity FBX Exporter 4.1.2", originalMime: "application/octet-stream", stats: { units: "cm", upAxis: "Y", triangles: 2 } });
    expect(await glbMagic(result.displayGlb)).toBe("glTF");
  });

  it("can skip the preview and the thumbnail", async () => {
    const result = await analyzeFiles([fileOf(objText(), "quad.obj")], options({ displayGlb: false, thumbnail: false }));
    expect(result.displayGlb).toBeNull();
    expect(result.notes).not.toContain(NO_WEBGL);
  });
});

describe("progress", () => {
  it("reports every stage in order with a fraction that only grows and ends at 1", async () => {
    const seen: ImportProgress[] = [];
    await analyzeFiles([fileOf(objText(), "quad.obj"), fileOf(pngHeader(4, 4), "unused.png")], options({ onProgress: (progress) => seen.push(progress) }));
    const stages = seen.map((progress) => progress.stage).filter((stage, index, all) => stage !== all[index - 1]);
    expect(stages).toEqual(["reading", "detecting", "loading", "measuring", "converting", "thumbnail", "packaging"]);
    const fractions = seen.map((progress) => progress.fraction);
    for (const [index, fraction] of fractions.entries()) {
      expect(fraction).toBeGreaterThanOrEqual(fractions[index - 1] ?? 0);
      expect(fraction).toBeLessThanOrEqual(1);
    }
    expect(seen.at(-1)).toEqual({ stage: "packaging", fraction: 1 });
    // Reading advances per file, by bytes.
    expect(seen.filter((progress) => progress.stage === "reading").length).toBe(3);
  });

  it("skips the conversion stage for GLB originals", async () => {
    const stages = new Set<string>();
    await analyzeFiles([fileOf(cubeGlb(), "a.glb")], options({ onProgress: (progress) => stages.add(progress.stage) }));
    expect(stages.has("converting")).toBe(false);
    expect(stages.has("thumbnail")).toBe(true);
  });

  it("stops between stages when cancelled from a progress callback", async () => {
    const controller = new AbortController();
    const stages: string[] = [];
    const result = await refusal([fileOf(objText(), "quad.obj")], {
      signal: controller.signal,
      onProgress: (progress) => {
        stages.push(progress.stage);
        if (progress.stage === "loading") controller.abort();
      },
    });
    expect(result).toMatchObject({ code: "aborted", detail: "aborted" });
    expect(stages).not.toContain("measuring");
  });
});

describe("bundles and selections", () => {
  it("unpacks a Sketchfab-style zip: title and source from the file, the zip kept as the original", async () => {
    const { json, bin } = cubeGltf({
      generator: "Sketchfab-12.66.0",
      bufferUri: "scene.bin",
      extras: { author: "Ada (https://sketchfab.com/ada)", license: "CC-BY-4.0", source: "https://sketchfab.com/3d-models/liver-123", title: "Human Liver" },
    });
    const zip = zipOf({ "scene.gltf": JSON.stringify(json), "scene.bin": bin, "license.txt": "CC-BY-4.0", "__MACOSX/._scene.gltf": "x" }, 6);
    const result = await analyzeFiles([fileOf(zip, "human-liver.zip")], options());
    expect(result).toMatchObject({ format: "gltf", mainFile: "scene.gltf", title: "Human Liver", sourceApp: "sketchfab", container: "zip", originalName: "human-liver.zip", originalMime: "application/zip" });
    expect(result.original.size).toBe(zip.length);
    expect(result.files).toEqual([
      { path: "scene.gltf", bytes: expect.any(Number), role: "model" },
      { path: "scene.bin", bytes: bin.length, role: "sidecar" },
      { path: "license.txt", bytes: 9, role: "extra" },
    ]);
  });

  it("titles a generic 'scene' after the zip", async () => {
    const zip = zipOf({ "scene.glb": cubeGlb() });
    expect((await analyzeFiles([fileOf(zip, "Kidney_v2.zip")], options())).title).toBe("Kidney_v2");
  });

  it("zips a multi-file selection (folder paths kept) to store it as one original", async () => {
    const { json, bin } = cubeGltf({ bufferUri: "scene.bin", generator: "Khronos glTF Blender I/O v4.2.70" });
    const files = [fileOf(JSON.stringify(json), "scene.gltf", "Heart/scene.gltf"), fileOf(bin, "scene.bin", "Heart/scene.bin"), fileOf("x", ".DS_Store", "Heart/.DS_Store")];
    const result = await analyzeFiles(files, options());
    expect(result).toMatchObject({ format: "gltf", mainFile: "Heart/scene.gltf", title: "Heart", sourceApp: "blender", container: "selection", originalName: "Heart.zip", originalMime: "application/zip" });
    const unzipped = unzipSync(new Uint8Array(await result.original.arrayBuffer()));
    expect(Object.keys(unzipped)).toEqual(["Heart/scene.gltf", "Heart/scene.bin"]);
    expect(Array.from(unzipped["Heart/scene.bin"]!)).toEqual(Array.from(bin));
    expect(result.files.map((file) => file.role)).toEqual(["model", "sidecar", "ignored"]);
  });

  it("asks which model to import when two of the same format are selected, then imports the chosen one", async () => {
    const files = [fileOf(cubeGlb(), "a.glb"), fileOf(cubeGlb({ size: 3 }), "b.glb")];
    const choice = await refusal(files);
    expect(choice.error).toBeInstanceOf(ImportChoiceError);
    expect(choice.error).toBeInstanceOf(ImportRejectedError);
    expect(choice.error).toMatchObject({ reason: "The selection holds 2 GLB models (a.glb, b.glb).", advice: expect.stringMatching(/Choose the one to import/), candidates: ["a.glb", "b.glb"] });
    const chosen = await analyzeFiles(files, options({ mainFile: "b.glb" }));
    expect(chosen.mainFile).toBe("b.glb");
    expect(chosen.stats.bbox).toEqual({ x: 3, y: 3, z: 3 });
  });

  it("prefers glTF over other formats in one bundle and says what was left out", async () => {
    const zip = zipOf({ "model.glb": cubeGlb(), "model.obj": objText(), "model.blend": "BLENDER-v402" });
    const result = await analyzeFiles([fileOf(zip, "pack.zip")], options());
    expect(result.mainFile).toBe("model.glb");
    expect(result.notes).toContain("Also in the selection, not imported: model.obj.");
    expect(result.notes).toContain("Kept with the original but not read: model.blend.");
  });

  it("uses companion files as a weaker hint (Unity .meta files)", async () => {
    const files = [fileOf(fbxBinary({ mesh: true, creator: "FBX SDK/FBX Plugins version 2020.2" }), "Liver.fbx"), fileOf("fileFormatVersion: 2\nguid: 1\n", "Liver.fbx.meta")];
    const result = await analyzeFiles(files, options({ displayGlb: false }));
    expect(result).toMatchObject({ sourceApp: "unity", detectedBy: "filename", sourceDetail: null, evidence: ["Unity .meta files are included"] });
  });
});

describe("refusals", () => {
  it("explains project files with a reason and the export to make instead", async () => {
    const blend = await refusal([fileOf("BLENDER-v402RENDH", "heart.blend")]);
    expect(blend).toMatchObject({ code: "invalid_input", detail: "unsupported:blend" });
    expect(blend.error).toBeInstanceOf(ImportRejectedError);
    expect(blend.error).toBeInstanceOf(PlatformError);
    expect(blend.error).toMatchObject({
      reason: "heart.blend: Blender project files (.blend) can't be opened in the browser.",
      advice: expect.stringMatching(/^In Blender, choose File › Export › glTF 2\.0 \(\.glb\)/),
    });
    const error = blend.error as ImportRejectedError;
    expect(error.message).toBe(`${error.reason} ${error.advice}`);
    expect(await refusal([fileOf(new Uint8Array([0x1f, 0x8b, 8, 0]), "Organs.unitypackage")])).toMatchObject({ detail: "unsupported:unitypackage", message: expect.stringMatching(/UnityGLTF or glTFast/) });
    const prefab = await refusal([fileOf("%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!1 &1\nGameObject:\n", "Liver.prefab")]);
    expect(prefab.error).toMatchObject({ detail: "unsupported:prefab", advice: expect.stringMatching(/GLB.*FBX/) });
  });

  it("refuses Draco and KTX2 glTF as not supported yet, with how to export without them", async () => {
    const draco = await refusal([fileOf(cubeGlb({ extensionsUsed: ["KHR_draco_mesh_compression"], extensionsRequired: ["KHR_draco_mesh_compression"] }), "heart.glb")]);
    expect(draco.error).toMatchObject({ detail: "unsupported:draco", reason: "heart.glb uses Draco mesh compression, which isn't supported yet.", advice: expect.stringMatching(/without Draco/) });
    const ktx2 = await refusal([fileOf(cubeGlb({ extensionsUsed: ["KHR_texture_basisu"], extensionsRequired: ["KHR_texture_basisu"] }), "heart.glb")]);
    expect(ktx2.error).toMatchObject({ detail: "unsupported:ktx2", reason: expect.stringMatching(/KTX2.*aren't supported yet/), advice: expect.stringMatching(/PNG, JPEG or WebP/) });
  });

  it("asks for the model when only textures are selected", async () => {
    expect(await refusal([fileOf(pngHeader(8, 8), "albedo.png")])).toMatchObject({ detail: "no-model", message: expect.stringMatching(/only textures/) });
  });

  it("refuses a zip next to files that are not a model, and keeps one next to a model", async () => {
    expect(await refusal([fileOf(zipOf({ "a.glb": cubeGlb() }), "a.zip"), fileOf(pngHeader(4, 4), "albedo.png")])).toMatchObject({ detail: "zip-and-files" });
    const kept = await analyzeFiles([fileOf(zipOf({ "textures/a.png": pngHeader(4, 4) }), "textures.zip"), fileOf(cubeGlb(), "b.glb")], options({ thumbnail: false }));
    expect(kept).toMatchObject({ mainFile: "b.glb", container: "selection" });
    expect(kept.notes).toContain("Kept with the original but not read: textures.zip.");
    expect(Object.keys(unzipSync(new Uint8Array(await kept.original.arrayBuffer())))).toEqual(["textures.zip", "b.glb"]);
  });

  it("checks the plan's per-file limit and the counts before reading any bytes", async () => {
    const file = fileOf(cubeGlb(), "big.glb");
    const read = vi.spyOn(file, "arrayBuffer");
    const tooLarge = await refusal([file], { maxBytes: 100 });
    expect(tooLarge).toMatchObject({ code: "file_too_large", detail: "selection-too-large" });
    expect(tooLarge.error).toMatchObject({ reason: expect.stringMatching(/your plan stores files up to 100 bytes/), advice: expect.stringMatching(/Leave out files/) });
    expect(read).not.toHaveBeenCalled();
    const many = Array.from({ length: 257 }, (_, i) => fileOf("x", `f${i}.txt`));
    expect(await refusal(many)).toMatchObject({ code: "limit_reached", detail: "too-many-files" });
    expect(await refusal([])).toMatchObject({ detail: "no-files" });
  });

  it("refuses scenes over the vertex limit with advice to decimate", async () => {
    const { json, bin } = cubeGltf();
    (json.accessors as Array<{ count: number }>)[0]!.count = 2_000_001;
    const { glbOf } = await import("./__fixtures__/builders");
    const result = await refusal([fileOf(glbOf(json, bin), "dense.glb")]);
    expect(result).toMatchObject({ code: "limit_reached", detail: "limit:vertices" });
    expect(result.error).toMatchObject({ reason: "dense.glb has 2,000,001 vertices; imports are limited to 2,000,000.", advice: expect.stringMatching(/Decimate/) });
  });

  it("stops when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await refusal([fileOf(cubeGlb(), "a.glb")], { signal: controller.signal })).toMatchObject({ code: "aborted" });
  });
});

describe("entry points", () => {
  it("the lazily loaded entry gives the same analysis as the module itself", async () => {
    const file = fileOf(cubeGlb({ generator: "Khronos glTF Blender I/O v4.2.70" }), "Heart.glb");
    const lazy = await analyzeFiles([file], options({ thumbnail: false }));
    const direct = await analyzeDirect([file], options({ thumbnail: false }));
    expect({ ...lazy, original: null }).toEqual({ ...direct, original: null });
  });
});

describe("importedObjectInput", () => {
  it("maps an analysis to the ImportPort.create row", async () => {
    const result = await analyzeFiles([fileOf(cubeGlb({ generator: "Khronos glTF Blender I/O v4.2.70" }), "Heart.glb")], options());
    const input = importedObjectInput(result, { originalAssetId: "orig", displayAssetId: null, thumbnailAssetId: "thumb" }, ["anatomy"]);
    expect(input).toEqual({
      title: "Heart",
      format: "glb",
      originalAssetId: "orig",
      sourceApp: "blender",
      sourceDetail: "Khronos glTF Blender I/O v4.2.70",
      detectedBy: "metadata",
      displayAssetId: null,
      thumbnailAssetId: "thumb",
      stats: result.stats,
      tags: ["anatomy"],
    });
    expect(new TextEncoder().encode(JSON.stringify(input.stats)).length).toBeLessThan(64 * 1024);
    expect("tags" in importedObjectInput(result, { originalAssetId: "orig", displayAssetId: null, thumbnailAssetId: null })).toBe(false);
  });

  it("keeps titles, details and tags within the database rules", async () => {
    const result = await analyzeFiles([fileOf(cubeGlb(), "Heart.glb")], options({ thumbnail: false }));
    const long = importedObjectInput({ ...result, title: `  ${"Liver ".repeat(40)}  `, sourceDetail: "x".repeat(400) }, { originalAssetId: "o", displayAssetId: null, thumbnailAssetId: null });
    expect(long.title.length).toBeLessThanOrEqual(120);
    expect(long.title).toBe(long.title.trim());
    expect(long.sourceDetail!.length).toBeLessThanOrEqual(200);
    expect(importedObjectInput({ ...result, title: " \u0000 " }, { originalAssetId: "o", displayAssetId: null, thumbnailAssetId: null }).title).toBe("Imported model");
    expect(importTags([" Liver ", "liver", "", "a".repeat(40), "Heart\u0007", ...Array.from({ length: 30 }, (_, i) => `t${i}`)])).toEqual([
      "Liver",
      `${"a".repeat(31)}…`,
      "Heart",
      ...Array.from({ length: 17 }, (_, i) => `t${i}`),
    ]);
  });
});
