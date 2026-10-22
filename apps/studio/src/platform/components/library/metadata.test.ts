import { describe, expect, it } from "vitest";
import type { LibraryFile } from "../../core/types";
import { choosePreview, fileType, isResearchOnly, isUpload, metadataRowCount, metadataSummary, readClaims, readMediaFacts, textureMaps } from "./metadata";

const ASSET = "00000000-0000-4000-8000-000000000001";
const file = (filename: string, role: LibraryFile["role"], mimeType?: string, position = 0): LibraryFile => ({
  filename,
  role,
  assetId: ASSET,
  position,
  ...(mimeType ? { mimeType } : {}),
});

describe("claims", () => {
  it("reads claims exactly as stored", () => {
    const claims = readClaims({
      claims: { evidence: "  Vertex colours baked in this browser.  ", limitations: ["Not a clinical model.", "", 4], rights: "CC BY 4.0" },
    });
    expect(claims).toEqual({ evidence: "  Vertex colours baked in this browser.  ", limitations: ["Not a clinical model."], rights: "CC BY 4.0" });
  });

  it("ignores missing or empty claims", () => {
    expect(readClaims({})).toBeNull();
    expect(readClaims(null)).toBeNull();
    expect(readClaims({ claims: "procedural" })).toBeNull();
    expect(readClaims({ claims: { evidence: " ", limitations: [] } })).toBeNull();
    expect(readClaims({ claims: { limitations: ["Only one."] } })).toEqual({ evidence: null, limitations: ["Only one."], rights: null });
  });

  it("recognises research-only rights like the lab host does", () => {
    expect(isResearchOnly("Research-only until the licence is resolved.")).toBe(true);
    expect(isResearchOnly("research use only")).toBe(true);
    expect(isResearchOnly("CC BY 4.0")).toBe(false);
    expect(isResearchOnly(null)).toBe(false);
  });
});

describe("media facts", () => {
  it("reads uploads, recorder metrics and import stats", () => {
    expect(readMediaFacts({ media: { width: 1920, height: 1080, durationMs: 4200 } })).toEqual({ width: 1920, height: 1080, durationMs: 4200 });
    expect(readMediaFacts({ recording: { width: 3840, height: 2160, durationMs: 12_000, requestedFps: 30, bytes: 5 } })).toEqual({
      width: 3840,
      height: 2160,
      durationMs: 12_000,
      requestedFps: 30,
    });
    expect(readMediaFacts({ stats: { vertices: 1200, triangles: 2000.4, meshes: 3, generator: "Khronos glTF Blender I/O v4.2.70" } })).toEqual({
      vertices: 1200,
      triangles: 2000,
      meshes: 3,
      generator: "Khronos glTF Blender I/O v4.2.70",
    });
    expect(readMediaFacts({ media: { durationSeconds: 1.5 } })).toEqual({ durationMs: 1500 });
  });

  it("prefers the first source and skips nonsense", () => {
    expect(readMediaFacts({ media: { width: 640 }, recording: { width: 3840, height: 2160 } })).toEqual({ width: 640, height: 2160 });
    expect(readMediaFacts({ media: { width: -1, height: "tall", durationMs: Number.POSITIVE_INFINITY } })).toEqual({});
    expect(readMediaFacts(undefined)).toEqual({});
  });

  it("knows uploads", () => {
    expect(isUpload({ source: { kind: "upload", filename: "a.png" } })).toBe(true);
    expect(isUpload({ source: "upload" })).toBe(false);
    expect(isUpload({})).toBe(false);
  });
});

describe("metadata summary", () => {
  it("lists keys verbatim, one level deep, without claims and media", () => {
    const rows = metadataSummary({
      claims: { evidence: "x", limitations: [] },
      media: { width: 1 },
      organ: "liver",
      seed: "18446744073709551615",
      variant: 12,
      wet: true,
      recording: { durationMs: 1234.5, stopReason: "user" },
      tags: ["a", "b"],
      list: [{ a: 1 }, { b: 2 }],
      empty: {},
      nothing: null,
    });
    expect(rows).toEqual([
      { key: "organ", value: "liver" },
      { key: "seed", value: "18446744073709551615" },
      { key: "variant", value: "12" },
      { key: "wet", value: "Yes" },
      { key: "recording.durationMs", value: "1,234.5" },
      { key: "recording.stopReason", value: "user" },
      { key: "tags", value: "a, b" },
      { key: "list", value: "2 entries" },
      { key: "nothing", value: "—" },
    ]);
  });

  it("stops at the row limit and counts the rest", () => {
    const metadata = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`k${index}`, index]));
    expect(metadataSummary(metadata, 5)).toHaveLength(5);
    expect(metadataRowCount(metadata)).toBe(30);
    expect(metadataSummary({ long: "x".repeat(300) })[0]?.value).toHaveLength(120);
  });
});

describe("preview choice", () => {
  it("shows a shape's mesh, a recording's video and an image's picture", () => {
    const shape = choosePreview({ kind: "shape", thumbnailAssetId: ASSET, files: [file("albedo.png", "albedo", "image/png"), file("liver.glb", "mesh", "model/gltf-binary")] });
    expect(shape.type).toBe("model");
    const recording = choosePreview({ kind: "recording", thumbnailAssetId: null, files: [file("data.json", "data", "application/json"), file("run.webm", "video", "video/webm")] });
    expect(recording).toMatchObject({ type: "video", file: { filename: "run.webm" } });
    const image = choosePreview({ kind: "image", thumbnailAssetId: null, files: [file("still.jpg", "primary")] });
    expect(image).toMatchObject({ type: "image", file: { filename: "still.jpg" } });
  });

  it("prefers the main file and never previews the thumbnail file", () => {
    const material = choosePreview({
      kind: "material",
      thumbnailAssetId: ASSET,
      files: [file("thumb.webp", "thumbnail", "image/webp"), file("normal.png", "normal", "image/png"), file("albedo.png", "albedo", "image/png")],
    });
    expect(material).toMatchObject({ type: "image", file: { filename: "albedo.png" } });
  });

  it("falls back to the thumbnail, then to nothing", () => {
    expect(choosePreview({ kind: "scene", thumbnailAssetId: ASSET, files: [file("scene.json", "spec", "application/json")] })).toEqual({ type: "thumbnail" });
    expect(choosePreview({ kind: "scene", thumbnailAssetId: null })).toEqual({ type: "none" });
    // only binary glTF opens in the viewer
    expect(choosePreview({ kind: "model", thumbnailAssetId: null, files: [file("cube.obj", "primary", "model/obj")] })).toEqual({ type: "none" });
  });

  it("types files and lists texture maps in order", () => {
    expect(fileType({ filename: "a.glb" })).toBe("model");
    expect(fileType({ filename: "a.bin", mimeType: "image/png" })).toBe("image");
    expect(fileType({ filename: "a.webm" })).toBe("video");
    expect(fileType({ filename: "a.json" })).toBe("data");
    expect(fileType({ filename: "a.zip" })).toBe("archive");
    expect(fileType({ filename: "a.txt" })).toBe("text");
    expect(fileType({ filename: "a.xyz" })).toBe("other");
    const maps = textureMaps([
      file("rough.png", "roughness", "image/png"),
      file("mesh.glb", "mesh", "model/gltf-binary"),
      file("albedo.png", "albedo", "image/png"),
      file("normal.ktx2", "normal", "image/ktx2"),
    ]);
    expect(maps.map((entry) => entry.filename)).toEqual(["albedo.png", "rough.png"]);
  });
});
