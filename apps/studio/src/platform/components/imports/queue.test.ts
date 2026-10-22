import { describe, expect, it } from "vitest";
import { ImportRejectedError, type AnalyzeOptions, type ImportAnalysis } from "../../core/imports";
import { MemoryBackend } from "../../core/memory";
import { PlatformError, type ImportedObject, type Plan } from "../../core/types";
import { describeFailure, runImport } from "./engine";
import type { JobState } from "./model";
import { ImportQueue, type QueueEvent } from "./queue";

const PASSWORD = "correct horse battery";
const MB = 1024 * 1024;

async function signedIn(plans?: Plan[]): Promise<MemoryBackend> {
  const backend = new MemoryBackend(plans ? { plans } : {});
  await backend.auth.signUp({ email: `person${Math.random().toString(16).slice(2)}@example.com`, password: PASSWORD });
  return backend;
}

function analysisFor(name: string, overrides: Partial<ImportAnalysis> = {}): ImportAnalysis {
  return {
    format: "obj",
    mainFile: name,
    title: name.replace(/\.[^.]+$/, ""),
    sourceApp: "blender",
    sourceDetail: "Blender 4.4.1",
    detectedBy: "metadata",
    evidence: ['OBJ header comment "# Blender 4.4.1"'],
    stats: { meshes: 1, vertices: 8, triangles: 12, materials: 1, textures: 0, animations: 0, skinned: false, bbox: { x: 1, y: 1, z: 1 } },
    notes: [],
    displayGlb: new Blob([new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0])], { type: "model/gltf-binary" }),
    thumbnail: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], { type: "image/png" }),
    original: new Blob(["v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n", name], { type: "model/obj" }),
    originalName: name,
    originalMime: "model/obj",
    container: "file",
    files: [{ path: name, bytes: 30, role: "model" }],
    ...overrides,
  };
}

/** A stand-in for analyzeFiles that reports two stages and returns a prepared analysis. */
function fakeAnalyze(result: (files: File[]) => ImportAnalysis | Error) {
  const calls: Array<{ names: string[]; maxBytes: number }> = [];
  const analyze = async (files: File[], options: AnalyzeOptions): Promise<ImportAnalysis> => {
    calls.push({ names: files.map((file) => file.name), maxBytes: options.maxBytes });
    options.onProgress?.({ stage: "reading", fraction: 0.2 });
    await Promise.resolve();
    if (options.signal?.aborted) throw new PlatformError("aborted", "The import was cancelled.");
    options.onProgress?.({ stage: "thumbnail", fraction: 1 });
    const value = result(files);
    if (value instanceof Error) throw value;
    return value;
  };
  return { analyze, calls };
}

function until(queue: ImportQueue, predicate: (event: QueueEvent) => boolean): Promise<QueueEvent> {
  return new Promise((resolve) => {
    const stop = queue.onEvent((event) => {
      if (!predicate(event)) return;
      stop();
      resolve(event);
    });
  });
}

describe("runImport", () => {
  it("uploads the original, the preview GLB and the thumbnail, then creates the object", async () => {
    const backend = await signedIn();
    const { analyze, calls } = fakeAnalyze((files) => analysisFor(files[0]!.name));
    const states: JobState[] = [];
    const object = await runImport([new File(["v 0 0 0"], "chair.obj")], {
      backend,
      maxBytes: 50 * MB,
      signal: new AbortController().signal,
      onState: (state) => states.push(state),
      analyze,
    });

    expect(calls).toEqual([{ names: ["chair.obj"], maxBytes: 50 * MB }]);
    expect(object).toMatchObject({ title: "chair", format: "obj", sourceApp: "blender", sourceDetail: "Blender 4.4.1", detectedBy: "metadata" });
    expect(object.displayAssetId).not.toBeNull();
    expect(object.thumbnailAssetId).not.toBeNull();
    const assets = await backend.assets.describe([object.originalAssetId, object.displayAssetId!, object.thumbnailAssetId!]);
    expect(assets.map((asset) => asset.mimeType).sort()).toEqual(["image/png", "model/gltf-binary", "model/obj"]);
    expect((await backend.imports.list()).map((item) => item.id)).toEqual([object.id]);

    const statuses = states.map((state) => state.status);
    expect(statuses[0]).toBe("analyzing");
    expect(statuses).toContain("uploading");
    expect(statuses.at(-1)).toBe("saving");
    const last = states.filter((state) => state.status === "uploading").at(-1);
    expect(last).toMatchObject({ loaded: expect.any(Number) });
    if (last?.status === "uploading") expect(last.loaded).toBe(last.total);
  });

  it("keeps a GLB original as the viewer file (no preview upload)", async () => {
    const backend = await signedIn();
    const glb = new Blob([new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 9])], { type: "model/gltf-binary" });
    const { analyze } = fakeAnalyze(() => analysisFor("cube.glb", { format: "glb", displayGlb: null, thumbnail: null, original: glb, originalMime: "model/gltf-binary" }));
    const object = await runImport([new File([glb], "cube.glb")], { backend, maxBytes: 50 * MB, signal: new AbortController().signal, onState: () => {}, analyze });
    expect(object).toMatchObject({ format: "glb", displayAssetId: null, thumbnailAssetId: null });
  });

  it("stops before anything is created when cancelled", async () => {
    const backend = await signedIn();
    const controller = new AbortController();
    const { analyze } = fakeAnalyze((files) => analysisFor(files[0]!.name));
    const run = runImport([new File(["v 0 0 0"], "chair.obj")], {
      backend,
      maxBytes: 50 * MB,
      signal: controller.signal,
      onState: (state) => {
        if (state.status === "analyzing" && state.fraction > 0) controller.abort();
      },
      analyze,
    });
    await expect(run).rejects.toMatchObject({ code: "aborted" });
    expect(await backend.imports.list()).toEqual([]);
  });

  it("explains a project file from its first bytes without analysing it", async () => {
    const backend = await signedIn();
    const { analyze, calls } = fakeAnalyze(() => new Error("must not run"));
    const blend = new File([new TextEncoder().encode("BLENDER-v402RENDH"), new Uint8Array(64)], "organ.blend");
    const failure = await runImport([blend], { backend, maxBytes: 50 * MB, signal: new AbortController().signal, onState: () => {}, sniffFirst: true, analyze }).then(
      () => null,
      (error: unknown) => describeFailure(error),
    );
    expect(calls).toEqual([]);
    expect(failure?.retryable).toBe(false);
    expect(failure?.reason).toMatch(/organ\.blend/);
    expect(failure?.advice).toMatch(/File › Export › glTF 2\.0/);
  });

  it("refuses an upload over the account's quota with a friendly message", async () => {
    const tiny: Plan = { id: "free", title: "Free", storageQuotaBytes: 40, maxFileBytes: 1000, versionRetentionDays: 1, maxProjects: 2 };
    const backend = await signedIn([tiny]);
    const { analyze } = fakeAnalyze((files) => analysisFor(files[0]!.name));
    const failure = await runImport([new File(["v"], "chair.obj")], { backend, maxBytes: 1000, signal: new AbortController().signal, onState: () => {}, analyze }).then(
      () => null,
      (error: unknown) => describeFailure(error),
    );
    expect(failure).toEqual({ reason: "There isn’t enough storage left for this file. Delete items you no longer need or empty the Trash.", advice: null, retryable: false });
  });
});

describe("describeFailure", () => {
  it("shows the importer's own reason and advice", () => {
    expect(describeFailure(new ImportRejectedError("chair.blend: Blender project files can't be opened.", "unsupported:blend", { advice: "Export a GLB." }))).toEqual({
      reason: "chair.blend: Blender project files can't be opened.",
      advice: "Export a GLB.",
      retryable: false,
    });
  });

  it("offers another attempt for connection problems only", () => {
    expect(describeFailure(new PlatformError("network", "offline"))).toMatchObject({ retryable: true });
    expect(describeFailure(new TypeError("Failed to fetch"))).toMatchObject({ retryable: true });
    expect(describeFailure(new PlatformError("file_too_large", "big"))).toMatchObject({ retryable: false, reason: "This file is larger than your plan allows." });
  });
});

describe("ImportQueue", () => {
  it("waits for the plan's limit, runs jobs one at a time, and reports when it is idle", async () => {
    const backend = await signedIn();
    let active = 0;
    let most = 0;
    const analyze = async (files: File[], options: AnalyzeOptions): Promise<ImportAnalysis> => {
      active += 1;
      most = Math.max(most, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      options.onProgress?.({ stage: "loading", fraction: 0.5 });
      active -= 1;
      return analysisFor(files[0]!.name);
    };
    const imported: ImportedObject[] = [];
    const queue = new ImportQueue(backend, { analyze, onImported: (object) => imported.push(object) });
    queue.enqueue([
      { label: "a.obj", files: [new File(["v"], "a.obj")] },
      { label: "b.obj", files: [new File(["v"], "b.obj")] },
    ]);
    expect(queue.getSnapshot().map((job) => job.state.status)).toEqual(["waiting", "waiting"]);
    expect(queue.busy).toBe(true);

    const idle = until(queue, (event) => event.type === "idle");
    queue.setLimit(50 * MB);
    const summary = await idle;
    expect(most).toBe(1);
    expect(summary).toMatchObject({ type: "idle", failed: 0 });
    if (summary.type === "idle") expect(summary.imported.map((object) => object.title)).toEqual(["a", "b"]);
    expect(imported.map((object) => object.title)).toEqual(["a", "b"]);
    expect(queue.getSnapshot()).toEqual([]);
    expect(queue.busy).toBe(false);
  });

  it("keeps failed rows with their reason, retries them, and shows refusals made before reading", async () => {
    const backend = await signedIn();
    let attempts = 0;
    const analyze = async (files: File[]): Promise<ImportAnalysis> => {
      attempts += 1;
      if (attempts === 1) throw new PlatformError("network", "offline");
      return analysisFor(files[0]!.name);
    };
    const queue = new ImportQueue(backend, { analyze, onImported: () => {} });
    queue.setLimit(50 * MB);
    const failed = until(queue, (event) => event.type === "failed" && event.label === "a.obj");
    const [first, tooBig] = queue.enqueue([
      { label: "a.obj", files: [new File(["v"], "a.obj")] },
      { label: "huge.fbx", files: [], failure: { reason: "“huge.fbx” is 80 MB.", advice: "Reduce it.", retryable: false } },
    ]);
    await failed;
    const rows = queue.getSnapshot();
    expect(rows.map((job) => [job.label, job.state.status])).toEqual([
      ["a.obj", "failed"],
      ["huge.fbx", "failed"],
    ]);
    expect(rows[0]?.state).toMatchObject({ retryable: true, reason: "VISCERA can’t reach the server. Check your internet connection and try again." });

    const imported = until(queue, (event) => event.type === "imported");
    queue.retry(first!);
    await imported;
    expect(queue.getSnapshot().map((job) => job.label)).toEqual(["huge.fbx"]);
    queue.dismiss(tooBig!);
    expect(queue.getSnapshot()).toEqual([]);
  });

  it("drops a cancelled job at once and goes on with the next", async () => {
    const backend = await signedIn();
    const queue = new ImportQueue(backend, {
      analyze: async (files, options) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (options.signal?.aborted) throw new PlatformError("aborted", "The import was cancelled.");
        return analysisFor(files[0]!.name);
      },
      onImported: () => {},
    });
    queue.setLimit(50 * MB);
    const idle = until(queue, (event) => event.type === "idle");
    const [first] = queue.enqueue([
      { label: "a.obj", files: [new File(["v"], "a.obj")] },
      { label: "b.obj", files: [new File(["v"], "b.obj")] },
    ]);
    queue.cancel(first!);
    expect(queue.getSnapshot().map((job) => job.label)).toEqual(["b.obj"]);
    const summary = await idle;
    if (summary.type === "idle") expect(summary.imported.map((object) => object.title)).toEqual(["b"]);
    expect((await backend.imports.list()).map((object) => object.title)).toEqual(["b"]);
  });

  it("forgets everything on clear (sign-out)", async () => {
    const backend = await signedIn();
    const queue = new ImportQueue(backend, { analyze: async (files) => analysisFor(files[0]!.name), onImported: () => {} });
    queue.enqueue([{ label: "a.obj", files: [new File(["v"], "a.obj")] }]);
    queue.clear();
    expect(queue.getSnapshot()).toEqual([]);
    expect(queue.busy).toBe(false);
  });
});
