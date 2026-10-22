import { describe, expect, it } from "vitest";
import { MemoryBackend } from "../../core/memory";
import type { Plan } from "../../core/types";
import type { ProbeFn } from "./upload";
import { inferUpload } from "./uploadKind";
import { UploadStore, type UploadEvent } from "./uploadStore";

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(name: string, size = 1024): Blob & { name: string } {
  const bytes = new Uint8Array(size);
  bytes.set(PNG_HEAD);
  bytes[size - 1] = name.length;
  return Object.assign(new Blob([bytes], { type: "image/png" }), { name });
}

function plan(file: Blob & { name: string }) {
  const decision = inferUpload({ name: file.name, type: file.type, size: file.size }, new Uint8Array(PNG_HEAD));
  if (!decision.ok) throw new Error(decision.reason);
  return decision.plan;
}

const probe: ProbeFn = async () => ({ thumbnail: null, media: { width: 10, height: 10 } });

function settled(store: UploadStore): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (!store.busy) {
        unsubscribe();
        resolve();
      }
    };
    const unsubscribe = store.subscribe(check);
    check();
  });
}

async function setup(plans?: readonly Plan[]) {
  const backend = new MemoryBackend(plans ? { plans } : {});
  await backend.auth.signUp({ email: "queue@example.test", password: "correct horse battery" });
  const urls: string[] = [];
  const revoked: string[] = [];
  const store = new UploadStore({
    backend,
    probe,
    createUrl: () => {
      const url = `blob:test/${urls.length + 1}`;
      urls.push(url);
      return url;
    },
    revokeUrl: (url) => revoked.push(url),
  });
  const events: UploadEvent[] = [];
  store.onEvent((event) => events.push(event));
  return { backend, store, events, urls, revoked };
}

describe("upload queue", () => {
  it("uploads one file at a time and hands over each item", async () => {
    const { backend, store, events, urls, revoked } = await setup();
    const statuses: string[][] = [];
    store.subscribe(() => statuses.push(store.snapshot().map((entry) => entry.status)));
    const a = png("a.png");
    const b = png("b.png");
    store.enqueue(a, plan(a));
    store.enqueue(b, plan(b));
    // never two uploads at once
    expect(store.snapshot().filter((entry) => entry.status !== "queued")).toHaveLength(1);
    await settled(store);
    expect(store.snapshot()).toEqual([]);
    expect(events.map((event) => [event.type, event.entry.name])).toEqual([
      ["uploaded", "a.png"],
      ["uploaded", "b.png"],
    ]);
    for (const snapshot of statuses) expect(snapshot.filter((status) => status !== "queued" && status !== "failed").length).toBeLessThanOrEqual(1);
    expect((await backend.library.list()).map((item) => item.title).sort()).toEqual(["a", "b"]);
    // image previews are object URLs that are released when the entry leaves
    expect(urls).toHaveLength(2);
    expect(revoked.sort()).toEqual([...urls].sort());
  });

  it("cancels queued and running uploads", async () => {
    const { backend, store, events } = await setup();
    const a = png("running.png");
    const b = png("queued.png");
    const running = store.enqueue(a, plan(a));
    const queued = store.enqueue(b, plan(b));
    store.cancel(queued);
    store.cancel(running);
    await settled(store);
    expect(store.snapshot()).toEqual([]);
    expect(events.map((event) => event.type).sort()).toEqual(["cancelled", "cancelled"]);
    expect(await backend.library.list()).toEqual([]);
  });

  it("keeps failures listed until they are retried or dismissed", async () => {
    const tiny: Plan[] = [{ id: "free", title: "Free", storageQuotaBytes: 1500, maxFileBytes: 1200, versionRetentionDays: 30, maxProjects: 10 }];
    const { backend, store, events } = await setup(tiny);
    const big = png("big.png", 1300);
    const id = store.enqueue(big, plan(big));
    await settled(store);
    expect(store.snapshot()).toEqual([expect.objectContaining({ id, status: "failed", error: expect.objectContaining({ code: "file_too_large" }) })]);
    expect(events.at(-1)).toMatchObject({ type: "failed", error: { code: "file_too_large" } });
    // a retry runs again (and fails again on the same plan)
    store.retry(id);
    expect(store.snapshot()[0]?.status).not.toBe("failed");
    await settled(store);
    expect(store.snapshot()[0]?.status).toBe("failed");
    store.cancel(id);
    expect(store.snapshot()).toEqual([]);
    expect(await backend.library.list()).toEqual([]);
  });

  it("forgets everything on clear", async () => {
    const { store } = await setup();
    const a = png("a.png");
    store.enqueue(a, plan(a));
    store.clear();
    await settled(store);
    expect(store.snapshot()).toEqual([]);
  });
});
