import { describe, expect, it } from "vitest";
import type { LabSessionDocument } from "../bridge/labSession";
import { EMPTY_SHA256, sha256Hex } from "./hash";
import { MemoryBackend, sequentialIds, steppingClock } from "./memory";
import {
  createSnapshotStore,
  decodeSnapshot,
  decodeSnapshotWithContext,
  encodeSnapshot,
  labSchemaVersionOf,
  readSnapshotManifest,
  SNAPSHOT_FORMAT,
  snapshotStateSha256,
  storableMimeType,
  uploadEncodedSnapshot,
  type SnapshotAttachmentEntry,
} from "./snapshot";
import { PlatformError } from "./types";

function documentWith(overrides: Partial<LabSessionDocument> = {}): LabSessionDocument {
  return {
    schema: "viscera.atlas-session/3",
    labId: "organ",
    state: { seed: "18446744073709551615", camera: { zoom: 1.5, target: [0, 1, 2] }, sculpt: null },
    attachments: {
      "sculpt.f32": new Blob([new Float32Array([1, 2, 3])], { type: "application/octet-stream" }),
      "photo.png": new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }),
    },
    versions: { generator: "atlas-v4", material: "m2" },
    ...overrides,
  };
}

async function gunzipJson(blob: Blob): Promise<string> {
  return new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

function rejection(promise: Promise<unknown>): Promise<PlatformError> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(PlatformError);
      return error as PlatformError;
    },
  );
}

describe("encodeSnapshot", () => {
  it("gzips canonical JSON with a manifest of the attachments", async () => {
    const document = documentWith();
    const encoded = await encodeSnapshot(document);
    expect(encoded.snapshot.type).toBe("application/gzip");
    const text = await gunzipJson(encoded.snapshot);
    const sculptSha = await sha256Hex(new Float32Array([1, 2, 3]));
    const photoSha = await sha256Hex(new Uint8Array([137, 80, 78, 71]));
    expect(text).toBe(
      `{"attachments":{"photo.png":{"bytes":4,"mime":"image/png","sha256":"${photoSha}"},"sculpt.f32":{"bytes":12,"mime":"application/octet-stream","sha256":"${sculptSha}"}},` +
        `"format":"${SNAPSHOT_FORMAT}","labId":"organ","schema":"viscera.atlas-session/3",` +
        `"state":{"camera":{"target":[0,1,2],"zoom":1.5},"sculpt":null,"seed":"18446744073709551615"},"version":1,` +
        `"versions":{"generator":"atlas-v4","material":"m2"}}`,
    );
    expect(encoded.attachments.map((attachment) => [attachment.name, attachment.bytes, attachment.mimeType])).toEqual([
      ["photo.png", 4, "image/png"],
      ["sculpt.f32", 12, "application/octet-stream"],
    ]);
  });

  it("hashes the canonical document without the format header", async () => {
    const document = documentWith();
    const encoded = await encodeSnapshot(document);
    const sculptSha = await sha256Hex(new Float32Array([1, 2, 3]));
    const photoSha = await sha256Hex(new Uint8Array([137, 80, 78, 71]));
    // DESIGN.md §15.5: attachments enter the hash by their bytes' SHA-256 only
    const canonical =
      `{"attachments":{"photo.png":"${photoSha}","sculpt.f32":"${sculptSha}"},` +
      `"labId":"organ","schema":"viscera.atlas-session/3",` +
      `"state":{"camera":{"target":[0,1,2],"zoom":1.5},"sculpt":null,"seed":"18446744073709551615"},` +
      `"versions":{"generator":"atlas-v4","material":"m2"}}`;
    expect(encoded.stateSha256).toBe(await sha256Hex(canonical));
    expect(await snapshotStateSha256(document)).toBe(encoded.stateSha256);
  });

  it("gives the same stateSha256 for equal documents in any key order, and a new one for any change", async () => {
    const base = await encodeSnapshot(documentWith());
    const reordered = await encodeSnapshot(
      documentWith({ state: { sculpt: null, camera: { target: [0, 1, 2], zoom: 1.5 }, seed: "18446744073709551615" }, versions: { material: "m2", generator: "atlas-v4" } }),
    );
    expect(reordered.stateSha256).toBe(base.stateSha256);
    const stateChange = await encodeSnapshot(documentWith({ state: { seed: "1" } }));
    expect(stateChange.stateSha256).not.toBe(base.stateSha256);
    const attachmentChange = await encodeSnapshot(
      documentWith({ attachments: { "sculpt.f32": new Blob([new Float32Array([1, 2, 4])]), "photo.png": new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }) } }),
    );
    expect(attachmentChange.stateSha256).not.toBe(base.stateSha256);
    const versionChange = await encodeSnapshot(documentWith({ versions: { generator: "atlas-v5", material: "m2" } }));
    expect(versionChange.stateSha256).not.toBe(base.stateSha256);
  });

  it("produces the same stateSha256 as Chromium, WebKit and Firefox (golden value)", async () => {
    // the same document was hashed in all three browsers (Playwright check, 2026-10-21): any change to the canonical
    // form or the hashed fields changes this value and every stored project's no-op detection
    const encoded = await encodeSnapshot({
      schema: "viscera.atlas-session/3",
      labId: "organ",
      state: { seed: "18446744073709551615", camera: { zoom: 1.5, target: [0, 1, 2] }, sculpt: null, label: "Leber · Gefäß 😀" },
      attachments: { "sculpt.f32": new Blob([new Float32Array([1, 2, 3])]), "photo.png": new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }) },
      versions: { generator: "atlas-v4" },
    });
    expect(encoded.stateSha256).toBe("4a3ab0194c2f2cb87cc7253a77a48a0d83ff9580d67eb10c7f7fc11e3424c156");
  });

  it("ignores an attachment's type in the hash but not its bytes", async () => {
    const typed = await encodeSnapshot(documentWith({ attachments: { "a.bin": new Blob(["x"], { type: "text/plain" }) } }));
    const untyped = await encodeSnapshot(documentWith({ attachments: { "a.bin": new Blob(["x"]) } }));
    expect(typed.stateSha256).toBe(untyped.stateSha256);
  });

  it("lists local-only attachments with their hash but never uploads them", async () => {
    const local = new Blob([new Uint8Array(4096).fill(7)], { type: "model/obj" });
    const document = documentWith({ attachments: { "scan.obj": local, "photo.png": new Blob([new Uint8Array([1])], { type: "image/png" }) } });
    const encoded = await encodeSnapshot(document, { localOnly: ["scan.obj", "not-there.bin"], maxFileBytes: 1024 });
    expect(encoded.local).toEqual(["scan.obj"]);
    expect(encoded.attachments.map((attachment) => attachment.name)).toEqual(["photo.png"]);
    const manifest = await readSnapshotManifest(encoded.snapshot);
    expect(manifest.attachments["scan.obj"]).toEqual({ sha256: await sha256Hex(local), bytes: 4096, mime: "model/obj", local: true });
    // the local file counts towards the state like any other attachment
    expect(encoded.stateSha256).toBe(await snapshotStateSha256(document));
    expect(encoded.stateSha256).not.toBe((await encodeSnapshot(documentWith({ attachments: { "photo.png": new Blob([new Uint8Array([1])], { type: "image/png" }) } }))).stateSha256);

    const stored = new Map(encoded.attachments.map((attachment) => [attachment.name, attachment.blob]));
    const without = await decodeSnapshot(encoded.snapshot, async (name) => stored.get(name) as Blob);
    expect(Object.keys(without.attachments ?? {})).toEqual(["photo.png"]);
    const asked: string[] = [];
    const withLocal = await decodeSnapshot(encoded.snapshot, async (name) => stored.get(name) as Blob, {
      getLocalAttachment: async (name) => {
        asked.push(name);
        return local;
      },
    });
    expect(asked).toEqual(["scan.obj"]);
    expect(withLocal.attachments?.["scan.obj"]?.size).toBe(4096);
    const wrongFile = await rejection(decodeSnapshot(encoded.snapshot, async (name) => stored.get(name) as Blob, { getLocalAttachment: async () => new Blob(["other"]) }));
    expect(wrongFile.detail).toContain("wrong size");
  });

  it("keeps the attachments a document names in localOnly on the device, and reports the ones a restore lacks", async () => {
    const scan = new Blob([new Uint8Array(2048).fill(9)], { type: "model/obj" });
    const photo = new Blob([new Uint8Array([1, 2])], { type: "image/png" });
    const document = documentWith({ attachments: { "scan.obj": scan, "photo.png": photo }, localOnly: ["scan.obj"] });
    const encoded = await encodeSnapshot(document, { maxFileBytes: 1024 });
    expect(encoded.local).toEqual(["scan.obj"]);
    expect(encoded.attachments.map((attachment) => attachment.name)).toEqual(["photo.png"]);
    // where the list comes from does not change the state hash
    expect(encoded.stateSha256).toBe((await encodeSnapshot({ ...document, localOnly: [] }, { localOnly: ["scan.obj"] })).stateSha256);
    expect(encoded.stateSha256).toBe(await snapshotStateSha256(document));
    await expect(encodeSnapshot({ ...document, localOnly: "scan.obj" as unknown as string[] })).rejects.toMatchObject({ code: "invalid_input", detail: "localOnly" });

    const stored = new Map(encoded.attachments.map((attachment) => [attachment.name, attachment.blob]));
    const missing = await decodeSnapshotWithContext(encoded.snapshot, async (name) => stored.get(name) as Blob);
    expect(missing.context).toEqual({ missingLocal: [{ name: "scan.obj", sha256: await sha256Hex(scan) }] });
    expect(Object.keys(missing.document.attachments ?? {})).toEqual(["photo.png"]);
    expect(missing.document.localOnly).toEqual(["scan.obj"]);
    // the restored document still says which attachments stay local, so saving it again keeps them off the server
    const present = await decodeSnapshotWithContext(encoded.snapshot, async (name) => stored.get(name) as Blob, { getLocalAttachment: async () => scan });
    expect(present.context.missingLocal).toEqual([]);
    const again = await encodeSnapshot(present.document, { maxFileBytes: 1024 });
    expect(again.local).toEqual(["scan.obj"]);
    expect(again.stateSha256).toBe(encoded.stateSha256);
    expect((await decodeSnapshot(encoded.snapshot, async (name) => stored.get(name) as Blob)).localOnly).toEqual(["scan.obj"]);

    // a document without local attachments gets no localOnly list back
    const plain = await encodeSnapshot(documentWith());
    const plainStored = new Map(plain.attachments.map((attachment) => [attachment.name, attachment.blob]));
    const decoded = await decodeSnapshotWithContext(plain.snapshot, async (name) => plainStored.get(name) as Blob);
    expect(decoded.document.localOnly).toBeUndefined();
    expect(decoded.context).toEqual({ missingLocal: [] });
  });

  it("treats missing versions like empty ones", async () => {
    const { versions: _versions, ...withoutVersions } = documentWith();
    const a = await encodeSnapshot(withoutVersions);
    const b = await encodeSnapshot({ ...withoutVersions, versions: {} });
    expect(a.stateSha256).toBe(b.stateSha256);
  });

  it("keeps zero-byte attachments in the manifest only", async () => {
    const encoded = await encodeSnapshot(documentWith({ attachments: { "empty.bin": new Blob([], { type: "text/plain" }) } }));
    expect(encoded.attachments).toEqual([]);
    const manifest = await readSnapshotManifest(encoded.snapshot);
    expect(manifest.attachments["empty.bin"]).toEqual({ sha256: EMPTY_SHA256, bytes: 0, mime: "text/plain" });
  });

  it("stores types the bucket refuses as octet-stream but remembers the original", async () => {
    const svg = new Blob(["<svg/>"], { type: "image/svg+xml" });
    const encoded = await encodeSnapshot(documentWith({ attachments: { "icon.svg": svg } }));
    expect(encoded.attachments[0]?.mimeType).toBe("application/octet-stream");
    expect((await readSnapshotManifest(encoded.snapshot)).attachments["icon.svg"]?.mime).toBe("image/svg+xml");
    expect(storableMimeType("text/plain;charset=utf-8")).toBe("text/plain");
    expect(storableMimeType("")).toBe("application/octet-stream");
  });

  it("rejects bad lab ids, schemas, names, too many or too large attachments and non-JSON state", async () => {
    expect((await rejection(encodeSnapshot(documentWith({ labId: "Organ" })))).detail).toBe("labId");
    expect((await rejection(encodeSnapshot(documentWith({ schema: "" })))).detail).toBe("schema");
    expect((await rejection(encodeSnapshot(documentWith({ attachments: { "../x": new Blob(["a"]) } })))).code).toBe("invalid_input");
    expect((await rejection(encodeSnapshot(documentWith({ attachments: { ".hidden": new Blob(["a"]) } })))).code).toBe("invalid_input");
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`a${index}`, new Blob(["x"])]));
    expect((await rejection(encodeSnapshot(documentWith({ attachments: many })))).detail).toBe("attachments");
    const large = await rejection(encodeSnapshot(documentWith({ attachments: { "big.bin": new Blob([new Uint8Array(2048)]) } }), { maxFileBytes: 1024 }));
    expect(large.code).toBe("file_too_large");
    expect(large.message).toContain('"big.bin"');
    const nan = await rejection(encodeSnapshot(documentWith({ state: { values: [1, Number.NaN] } })));
    expect(nan.message).toBe("session.state.values[1] is NaN, which JSON cannot represent");
    expect((await rejection(encodeSnapshot(documentWith({ versions: { generator: 4 } as unknown as Record<string, string> })))).code).toBe("invalid_input");
    expect((await rejection(encodeSnapshot(documentWith({ attachments: { "a.bin": "text" as unknown as Blob } })))).code).toBe("invalid_input");
  });

  it("refuses a snapshot larger than the per-file limit", async () => {
    const noisy = Array.from({ length: 4000 }, (_, index) => `${index}-${(index * 7919) % 104729}`);
    expect((await rejection(encodeSnapshot(documentWith({ state: { noisy }, attachments: {} }), { maxFileBytes: 1000 }))).code).toBe("file_too_large");
  });
});

describe("decodeSnapshot", () => {
  it("round-trips the document with byte-exact, typed attachments", async () => {
    const document = documentWith();
    const encoded = await encodeSnapshot(document);
    const byName = new Map(encoded.attachments.map((attachment) => [attachment.name, attachment.blob]));
    const asked: string[] = [];
    const decoded = await decodeSnapshot(encoded.snapshot, async (name, entry: SnapshotAttachmentEntry) => {
      asked.push(name);
      expect(entry.bytes).toBe(byName.get(name)?.size);
      return new Blob([await (byName.get(name) as Blob).arrayBuffer()]);
    });
    expect(asked.sort()).toEqual(["photo.png", "sculpt.f32"]);
    expect(decoded.schema).toBe(document.schema);
    expect(decoded.labId).toBe("organ");
    expect(decoded.state).toEqual(document.state);
    expect(decoded.versions).toEqual(document.versions);
    expect(decoded.attachments?.["photo.png"]?.type).toBe("image/png");
    expect(new Float32Array(await (decoded.attachments?.["sculpt.f32"] as Blob).arrayBuffer())).toEqual(new Float32Array([1, 2, 3]));
    expect((await encodeSnapshot(decoded)).stateSha256).toBe(encoded.stateSha256);
  });

  it("restores zero-byte attachments without asking for them and omits empty parts", async () => {
    const encoded = await encodeSnapshot({ schema: "s/1", labId: "organ", state: [1], attachments: { "e.txt": new Blob([], { type: "text/plain" }) } });
    const decoded = await decodeSnapshot(encoded.snapshot, async () => {
      throw new Error("not asked");
    });
    expect(decoded.attachments?.["e.txt"]?.size).toBe(0);
    expect(decoded.attachments?.["e.txt"]?.type).toBe("text/plain");
    expect("versions" in decoded).toBe(false);
    const plain = await decodeSnapshot((await encodeSnapshot({ schema: "s/1", labId: "organ", state: null })).snapshot, async () => new Blob());
    expect(plain).toEqual({ schema: "s/1", labId: "organ", state: null });
  });

  it("refuses attachments of the wrong size or checksum", async () => {
    const encoded = await encodeSnapshot(documentWith());
    const wrongSize = await rejection(decodeSnapshot(encoded.snapshot, async () => new Blob(["x"])));
    expect(wrongSize.detail).toContain("wrong size");
    const wrongBytes = await rejection(
      decodeSnapshot(encoded.snapshot, async (_name, entry) => new Blob([new Uint8Array(entry.bytes).fill(9)])),
    );
    expect(wrongBytes.detail).toContain("checksum");
  });

  it("reads uncompressed JSON and refuses other formats and newer versions", async () => {
    const encoded = await encodeSnapshot({ schema: "s/1", labId: "organ", state: { a: 1 } });
    const plainText = new Blob([await gunzipJson(encoded.snapshot)]);
    expect((await decodeSnapshot(plainText, async () => new Blob())).state).toEqual({ a: 1 });
    expect((await rejection(decodeSnapshot(new Blob(["not json"]), async () => new Blob()))).code).toBe("invalid_input");
    expect((await rejection(decodeSnapshot(new Blob(['{"format":"other"}']), async () => new Blob()))).code).toBe("invalid_input");
    const newer = await rejection(
      decodeSnapshot(new Blob([JSON.stringify({ format: SNAPSHOT_FORMAT, version: 2, schema: "s", labId: "organ", state: 1 })]), async () => new Blob()),
    );
    expect(newer.message).toContain("newer release");
  });
});

describe("snapshot upload and the snapshot store", () => {
  async function signedInBackend(): Promise<MemoryBackend> {
    const backend = new MemoryBackend({ ids: sequentialIds(), now: steppingClock() });
    await backend.auth.signUp({ email: "lab@example.test", password: "correct horse" });
    return backend;
  }

  it("uploads snapshot, attachments and thumbnail and reports aggregate progress", async () => {
    const backend = await signedInBackend();
    const encoded = await encodeSnapshot(documentWith());
    const progress: number[] = [];
    const thumbnail = new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" });
    const ref = await uploadEncodedSnapshot(backend.assets, encoded, {
      thumbnail,
      labSchemaVersion: 3,
      appBuild: "abc123",
      onProgress: (value) => progress.push(value.loaded),
    });
    expect(ref.stateSha256).toBe(encoded.stateSha256);
    expect(ref.labSchemaVersion).toBe(3);
    expect(ref.appBuild).toBe("abc123");
    expect(ref.attachments.map((attachment) => attachment.name)).toEqual(["photo.png", "sculpt.f32"]);
    const described = await backend.assets.describe([ref.snapshotAssetId, ref.thumbnailAssetId as string]);
    expect(described.map((asset) => asset.mimeType)).toEqual(["application/gzip", "image/webp"]);
    const total = encoded.snapshot.size + 4 + 12 + 3;
    expect(progress.at(-1)).toBe(total);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
  });

  it("saves and loads documents through the versioning engine's port", async () => {
    const backend = await signedInBackend();
    const store = createSnapshotStore(backend.assets, { appBuild: "build-7" });
    const document = documentWith();
    const ref = await store.save(document, { thumbnail: null, signal: new AbortController().signal });
    expect(ref.labSchemaVersion).toBe(3);
    expect(ref.appBuild).toBe("build-7");
    expect(ref.thumbnailAssetId).toBeNull();
    const project = await backend.projects.create({ labId: "organ", title: "Liver", ...ref });
    const [head] = await backend.projects.versions(project.id);
    const loaded = await store.load(
      { snapshotAssetId: head?.snapshotAssetId as string, attachments: await backend.projects.versionAttachments(head?.id as string) },
      { signal: new AbortController().signal },
    );
    expect(loaded.state).toEqual(document.state);
    expect(new Float32Array(await (loaded.attachments?.["sculpt.f32"] as Blob).arrayBuffer())).toEqual(new Float32Array([1, 2, 3]));
    const missing = await rejection(store.load({ snapshotAssetId: ref.snapshotAssetId, attachments: [] }, { signal: new AbortController().signal }));
    expect(missing.detail).toContain("not stored with this version");

    // a lab's local-only attachment is never uploaded; loading elsewhere reports it for restore()'s context
    const local = await store.save(documentWith({ localOnly: ["sculpt.f32"] }), { thumbnail: null, signal: new AbortController().signal });
    expect(local.attachments.map((attachment) => attachment.name)).toEqual(["photo.png"]);
    const reopened = await store.loadWithContext({ snapshotAssetId: local.snapshotAssetId, attachments: local.attachments }, { signal: new AbortController().signal });
    expect(reopened.context.missingLocal).toEqual([{ name: "sculpt.f32", sha256: await sha256Hex(new Float32Array([1, 2, 3])) }]);
    expect(reopened.document.localOnly).toEqual(["sculpt.f32"]);
    expect(reopened.document.state).toEqual(document.state);
  });

  it("derives the stored schema revision from the schema id", () => {
    expect(labSchemaVersionOf("viscera.atlas-session/3")).toBe(3);
    expect(labSchemaVersionOf("viscera.tissue-session")).toBe(1);
    expect(labSchemaVersionOf("x/0")).toBe(1);
    expect(labSchemaVersionOf("x/9999999")).toBe(1_000_000);
  });
});
