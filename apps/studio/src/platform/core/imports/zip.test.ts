import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { bytesOf, cubeGltfEmbedded, patchCentralDirectory, pngHeader, zipOf } from "./__fixtures__/builders";
import { isPlatformError } from "../types";
import { MiB } from "./limits";
import { checkZipEntries, extractZip, firstEntryName, listZip, zipFiles } from "./zip";

const budget = { analysisBytes: 16 * MiB };

function refusal(run: () => unknown): { code: string; detail: string | null; message: string } {
  try {
    run();
  } catch (error) {
    if (isPlatformError(error)) return { code: error.code, detail: error.detail, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("reading zips", () => {
  it("lists the central directory in archive order with sizes and methods", () => {
    const zip = zipOf({ "scene.gltf": cubeGltfEmbedded(), "textures/a.png": pngHeader(4, 4) }, 6);
    const entries = listZip(zip);
    expect(entries.map((entry) => entry.name)).toEqual(["scene.gltf", "textures/a.png"]);
    expect(entries[0]).toMatchObject({ method: 8, encrypted: false, directory: false, size: bytesOf(cubeGltfEmbedded()).length });
    expect(firstEntryName(zip)).toBe("scene.gltf");
  });

  it("extracts useful entries and leaves out clutter", () => {
    const zip = zipOf({
      "Heart/scene.gltf": cubeGltfEmbedded(),
      "Heart/textures/a.png": pngHeader(4, 4),
      "__MACOSX/Heart/._scene.gltf": "x",
      "Heart/.DS_Store": "x",
    });
    const { entries, skipped } = extractZip(zip, budget);
    expect(entries.map((entry) => entry.path)).toEqual(["Heart/scene.gltf", "Heart/textures/a.png"]);
    expect(skipped.sort()).toEqual(["Heart/.DS_Store", "__MACOSX/Heart/._scene.gltf"]);
    expect(Array.from(entries[1]!.bytes)).toEqual(Array.from(pngHeader(4, 4)));
  });

  it("keeps names that would climb out of the archive out of the bundle", () => {
    const zip = zipOf({ "../evil.png": pngHeader(1, 1), "ok.png": pngHeader(1, 1) });
    const { entries, skipped } = extractZip(zip, budget);
    expect(entries.map((entry) => entry.path)).toEqual(["ok.png"]);
    expect(skipped).toEqual(["../evil.png"]);
  });
});

describe("zip refusals", () => {
  it("refuses a zip bomb by its compression ratio", () => {
    const zip = zipOf({ "bomb.bin": new Uint8Array(4 * MiB) }, 6);
    expect(listZip(zip)[0]!.compressedSize).toBeLessThan(4 * MiB / 200);
    expect(refusal(() => extractZip(zip, budget))).toMatchObject({ code: "limit_reached", detail: "zip-ratio" });
  });

  it("refuses more declared bytes than the analysis budget", () => {
    const zip = zipOf({ "a.bin": new Uint8Array(3000).map((_, i) => (i * 7919) % 251), "b.bin": new Uint8Array(3000).map((_, i) => (i * 104729) % 241) });
    expect(refusal(() => extractZip(zip, { analysisBytes: 5000 }))).toMatchObject({ code: "file_too_large", detail: "zip-too-large" });
    expect(extractZip(zip, { analysisBytes: 6000 }).entries).toHaveLength(2);
  });

  it("refuses too many files", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) files[`f${i}.txt`] = "x";
    expect(refusal(() => extractZip(zipOf(files), { analysisBytes: MiB, maxFiles: 4 }))).toMatchObject({ code: "limit_reached", detail: "zip-too-many-files" });
  });

  it("refuses encrypted entries and unknown compression before unpacking", () => {
    const zip = zipOf({ "scene.gltf": cubeGltfEmbedded() }, 6);
    expect(refusal(() => extractZip(patchCentralDirectory(zip, "flags", 1), budget)).detail).toBe("zip-encrypted");
    expect(refusal(() => extractZip(patchCentralDirectory(zip, "method", 14), budget)).detail).toBe("zip-method");
  });

  it("refuses a damaged directory", () => {
    const zip = zipOf({ "scene.gltf": cubeGltfEmbedded() });
    expect(refusal(() => listZip(zip.subarray(0, zip.length - 10))).detail).toBe("zip-corrupt");
    expect(refusal(() => listZip(bytesOf("PK\u0003\u0004 nothing else here"))).detail).toBe("zip-corrupt");
  });

  it("checks only the entries a caller keeps", () => {
    const zip = zipOf({ "bomb.bin": new Uint8Array(4 * MiB), "scene.gltf": cubeGltfEmbedded() }, 6);
    expect(checkZipEntries(listZip(zip), budget, "x", (entry) => entry.name.endsWith(".gltf")).map((entry) => entry.name)).toEqual(["scene.gltf"]);
  });
});

describe("writing zips", () => {
  it("zips a selection with its folders, deterministically", () => {
    const files = [
      { path: "Heart/scene.gltf", bytes: bytesOf(cubeGltfEmbedded()) },
      { path: "Heart/textures/a.png", bytes: pngHeader(4, 4) },
    ];
    const zip = zipFiles(files);
    expect(Object.keys(unzipSync(zip))).toEqual(["Heart/scene.gltf", "Heart/textures/a.png"]);
    expect(listZip(zip).map((entry) => entry.method)).toEqual([8, 0]);
    expect(Array.from(zipFiles(files))).toEqual(Array.from(zip));
  });
});
