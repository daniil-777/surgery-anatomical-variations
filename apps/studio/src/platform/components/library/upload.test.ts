import { describe, expect, it } from "vitest";
import { MemoryBackend } from "../../core/memory";
import type { Plan } from "../../core/types";
import { uploadMetadata, uploadToLibrary, type ProbeFn, type UploadPhase } from "./upload";
import { inferUpload } from "./uploadKind";

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngFile(name: string, size = 2048): Blob & { name: string; size: number } {
  const bytes = new Uint8Array(size);
  bytes.set(PNG_HEAD);
  for (let index = PNG_HEAD.length; index < size; index += 1) bytes[index] = (index * 7) % 251;
  return Object.assign(new Blob([bytes], { type: "image/png" }), { name });
}

function planFor(file: Blob & { name: string }, head: number[] = PNG_HEAD) {
  const decision = inferUpload({ name: file.name, type: file.type, size: file.size }, new Uint8Array(head));
  if (!decision.ok) throw new Error(decision.reason);
  return decision.plan;
}

const probe: ProbeFn = async () => ({
  thumbnail: new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4])], { type: "image/webp" }),
  media: { width: 640, height: 480.4, durationMs: Number.NaN, generator: "  Khronos glTF Blender I/O  " },
});

async function signedIn(plans?: readonly Plan[]): Promise<MemoryBackend> {
  const backend = new MemoryBackend(plans ? { plans } : {});
  await backend.auth.signUp({ email: "uploader@example.test", password: "correct horse battery" });
  return backend;
}

describe("uploading into the library", () => {
  it("stores the file, its thumbnail and an honest metadata record", async () => {
    const backend = await signedIn();
    const file = pngFile("Liver still v2.png");
    const phases: UploadPhase[] = [];
    const fractions: number[] = [];
    const previews: Blob[] = [];
    const item = await uploadToLibrary(file, planFor(file), {
      backend,
      probe,
      signal: new AbortController().signal,
      onProgress: (fraction, phase) => {
        fractions.push(fraction);
        phases.push(phase);
      },
      onPreview: (blob) => previews.push(blob),
    });
    expect(item).toMatchObject({ kind: "image", title: "Liver still v2", favorite: false, trashedAt: null });
    expect(item.thumbnailAssetId).not.toBeNull();
    expect(item.files).toEqual([expect.objectContaining({ filename: "Liver still v2.png", role: "primary", mimeType: "image/png", byteSize: 2048 })]);
    expect(item.metadata).toEqual({
      source: { kind: "upload", filename: "Liver still v2.png", format: "PNG", mimeType: "image/png" },
      media: { width: 640, height: 480, generator: "Khronos glTF Blender I/O" },
    });
    expect(previews).toHaveLength(1);
    expect(fractions[0]).toBe(0);
    expect(fractions[fractions.length - 1]).toBe(1);
    for (let index = 1; index < fractions.length; index += 1) expect(fractions[index]!).toBeGreaterThanOrEqual(fractions[index - 1]!);
    expect(new Set(phases)).toEqual(new Set(["preparing", "uploading", "finishing"]));
    // the item is listed and its bytes come back unchanged
    const listed = await backend.library.list();
    expect(listed.map((entry) => entry.id)).toEqual([item.id]);
    const bytes = await backend.assets.get(item.files![0]!.assetId);
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(new Uint8Array(await file.arrayBuffer()));
  });

  it("goes on without a preview when the probe fails", async () => {
    const backend = await signedIn();
    const file = pngFile("broken preview.png");
    const item = await uploadToLibrary(file, planFor(file), {
      backend,
      probe: () => Promise.reject(new Error("decoder crashed")),
      signal: new AbortController().signal,
    });
    expect(item.thumbnailAssetId).toBeNull();
    expect(item.metadata).toEqual({ source: { kind: "upload", filename: "broken preview.png", format: "PNG", mimeType: "image/png" } });
  });

  it("stops when cancelled and creates nothing", async () => {
    const backend = await signedIn();
    const file = pngFile("cancel me.png");
    const controller = new AbortController();
    const upload = uploadToLibrary(file, planFor(file), {
      backend,
      probe: async (...args) => {
        controller.abort();
        return probe(...args);
      },
      signal: controller.signal,
    });
    await expect(upload).rejects.toMatchObject({ code: "aborted" });
    expect(await backend.library.list()).toEqual([]);
  });

  it("reports the plan's quota and file limits as platform errors", async () => {
    const tiny: Plan[] = [{ id: "free", title: "Free", storageQuotaBytes: 4096, maxFileBytes: 3000, versionRetentionDays: 30, maxProjects: 10 }];
    const backend = await signedIn(tiny);
    const big = pngFile("big.png", 3500);
    await expect(uploadToLibrary(big, planFor(big), { backend, probe, signal: new AbortController().signal })).rejects.toMatchObject({ code: "file_too_large" });
    const first = pngFile("first.png", 2500);
    await uploadToLibrary(first, planFor(first), { backend, probe, signal: new AbortController().signal });
    const second = pngFile("second.png", 2000);
    await expect(uploadToLibrary(second, planFor(second), { backend, probe, signal: new AbortController().signal })).rejects.toMatchObject({
      code: "quota_exceeded",
    });
  });

  it("writes only measured numbers into metadata", () => {
    const plan = { kind: "model", mimeType: "model/gltf-binary", role: "mesh", format: "GLB" } as const;
    expect(uploadMetadata({ name: "a.glb", size: 10 }, plan, { thumbnail: null, media: { vertices: 12.2, triangles: 0, meshes: -1, width: 0 } })).toEqual({
      source: { kind: "upload", filename: "a.glb", format: "GLB", mimeType: "model/gltf-binary" },
      media: { vertices: 12, triangles: 0 },
    });
  });
});
