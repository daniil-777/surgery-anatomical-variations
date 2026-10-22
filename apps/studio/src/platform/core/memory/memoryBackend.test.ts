import { beforeEach, describe, expect, it } from "vitest";
import { defineBackendContract } from "../backendContract";
import { createMemoryBlobCache } from "../blobCache";
import { parsePlatformConfig } from "../config";
import { sha256Hex } from "../hash";
import { encodeSnapshot, uploadEncodedSnapshot } from "../snapshot";
import { PlatformError, type AuthEvent, type Plan, type PlatformErrorCode } from "../types";
import { MemoryBackend, type MemoryBackendOptions } from "./memoryBackend";
import { MemoryTransport } from "./memoryData";
import { MEMORY_STORAGE_KEY, sequentialIds, steppingClock, type MemoryStore, type StorageLike } from "./memoryStore";
import {
  DEFAULT_PLANS,
  ilikeContainsPattern,
  ilikeMatches,
  isValidLibraryFilename,
  isValidUsername,
  jsonbTextLength,
  MAX_IMPORTED_OBJECTS,
  MAX_LIBRARY_ITEMS,
  MAX_PENDING_ASSETS,
  MAX_VERSIONS_PER_PROJECT,
  validTags,
} from "./rules";

const TINY: Plan = { id: "tiny", title: "Tiny", storageQuotaBytes: 3000, maxFileBytes: 1000, versionRetentionDays: 1, maxProjects: 2 };
const PASSWORD = "correct horse battery";

// every test of the contract gets a fresh server; the backends one test creates share it
let contractServer: MemoryStore | undefined;
beforeEach(() => {
  contractServer = undefined;
});

defineBackendContract({
  name: "MemoryBackend",
  createBackend() {
    const options: MemoryBackendOptions = { plans: [...DEFAULT_PLANS, TINY], providers: { emailCode: true, google: true } };
    if (contractServer) options.server = contractServer;
    const backend = new MemoryBackend(options);
    contractServer ??= backend.server;
    return backend;
  },
  readEmailCode: async (backend, email) => (backend as MemoryBackend).latestCode(email),
  usernameSignIn: true,
  setPlan: async (backend, userId, planId) => (backend as MemoryBackend).setPlan(userId, planId),
  tinyPlan: TINY,
  collectAsset: async (backend, assetId, options = {}) => {
    const memory = backend as MemoryBackend;
    memory.collectAssets([assetId], options);
    return {
      finish: async () => {
        await memory.finishCollection();
      },
    };
  },
});

class MapStorage implements StorageLike {
  readonly items = new Map<string, string>();
  writes = 0;
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes += 1;
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 3; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function code(promise: Promise<unknown>): Promise<PlatformErrorCode> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PlatformError);
    return (error as PlatformError).code;
  }
  throw new Error("expected a failure");
}

async function snapshotRef(backend: MemoryBackend, state: unknown) {
  return uploadEncodedSnapshot(backend.assets, await encodeSnapshot({ schema: "s/1", labId: "organ", state: state as never }));
}

describe("MemoryBackend specifics", () => {
  it("is deterministic with injected ids and clock", async () => {
    async function scenario() {
      const backend = new MemoryBackend({ ids: sequentialIds(), now: steppingClock("2026-10-21T10:00:00.000Z") });
      const { session } = await backend.auth.signUp({ email: "same@example.test", password: PASSWORD });
      const project = await backend.projects.create({ labId: "organ", title: "Same", ...(await snapshotRef(backend, { a: 1 })) });
      return { session, project, versions: await backend.projects.versions(project.id) };
    }
    const first = await scenario();
    const second = await scenario();
    expect(second).toEqual(first);
    expect(first.project.id).toMatch(/^00000000-0000-4000-8000-0000000000[0-9a-f]{2}$/);
    expect(first.project.createdAt.startsWith("2026-10-21T10:00:")).toBe(true);
  });

  it("persists rows, bytes and the session across reloads", async () => {
    const storage = new MapStorage();
    const objects = createMemoryBlobCache({ maxBytes: Number.POSITIVE_INFINITY });
    const first = new MemoryBackend({ persist: { storage, objects } });
    await first.auth.signUp({ email: "keep@example.test", password: PASSWORD, username: "keeper" });
    const ref = await snapshotRef(first, { kept: true });
    const project = await first.projects.create({ labId: "organ", title: "Kept", ...ref });
    expect(storage.items.has(MEMORY_STORAGE_KEY)).toBe(true);
    expect(storage.items.has(`${MEMORY_STORAGE_KEY}.session`)).toBe(true);

    const reloaded = new MemoryBackend({ persist: { storage, objects } });
    expect((await reloaded.auth.ready())?.user.email).toBe("keep@example.test");
    expect((await reloaded.projects.get(project.id)).title).toBe("Kept");
    const bytes = await reloaded.assets.get(ref.snapshotAssetId);
    expect(bytes.size).toBe((await first.assets.get(ref.snapshotAssetId)).size);

    await reloaded.auth.signOut();
    const afterSignOut = new MemoryBackend({ persist: { storage, objects } });
    expect(await afterSignOut.auth.ready()).toBeNull();
    expect(await afterSignOut.auth.usernameAvailable("keeper")).toBe(false);

    await afterSignOut.reset();
    expect(storage.items.size).toBe(0);
    expect(await new MemoryBackend({ persist: { storage, objects } }).auth.usernameAvailable("keeper")).toBe(true);
  });

  it("does not touch storage unless asked to persist", async () => {
    const backend = new MemoryBackend();
    await backend.auth.signUp({ email: "ephemeral@example.test", password: PASSWORD });
    expect(backend.server.loadSession()).toBeNull();
    const config = parsePlatformConfig({ schema: "viscera.platform/v1", backend: "memory", persist: false, providers: { google: true } });
    if (!config.enabled || config.backend !== "memory") throw new Error("expected a memory config");
    const fromConfig = MemoryBackend.fromConfig(config);
    await fromConfig.auth.signInWithOAuth("google");
    expect(fromConfig.auth.current()?.user.providers).toEqual(["google"]);
  });

  it("rolls a failed operation back completely", async () => {
    const backend = new MemoryBackend();
    await backend.auth.signUp({ email: "atomic@example.test", password: PASSWORD });
    const good = await backend.assets.put(new Blob(["good"]));
    const failure = await code(
      backend.library.create({
        kind: "shape",
        title: "Half",
        files: [
          { filename: "a.bin", assetId: good.id, role: "mesh" },
          { filename: "b.bin", assetId: "00000000-0000-4000-8000-00000000dead", role: "mesh" },
        ],
      }),
    );
    expect(failure).toBe("not_found");
    expect(await backend.library.list()).toEqual([]);
    expect(backend.server.state.libraryItems).toEqual([]);
    expect(backend.server.state.libraryFiles).toEqual([]);
  });

  it("separates clients of one server and ends them all on a global sign-out", async () => {
    const laptop = new MemoryBackend();
    const phone = new MemoryBackend({ server: laptop.server });
    await laptop.auth.signUp({ email: "two@example.test", password: PASSWORD });
    expect(phone.auth.current()).toBeNull();
    await phone.auth.signInWithPassword("two@example.test", PASSWORD);
    const ref = await snapshotRef(laptop, { tab: 1 });
    const project = await laptop.projects.create({ labId: "organ", title: "Shared", ...ref });
    // both tabs start from the same draft revision; the second save loses
    const fromPhone = await phone.projects.get(project.id);
    await laptop.projects.saveDraft(project.id, { headVersionId: project.headVersionId, draftRev: 0 }, ref);
    expect(await code(phone.projects.saveDraft(project.id, { headVersionId: fromPhone.headVersionId, draftRev: fromPhone.draftRev }, ref))).toBe("draft_conflict");

    const events: AuthEvent[] = [];
    phone.auth.onChange((event) => events.push(event));
    await laptop.auth.signOut("global");
    expect(laptop.auth.current()).toBeNull();
    expect(phone.auth.current()).toBeNull();
    expect(await code(phone.projects.list())).toBe("not_authenticated");
    await phone.auth.signInWithPassword("two@example.test", PASSWORD);
    expect((await phone.projects.list()).map((item) => item.id)).toEqual([project.id]);
    await settle();
    expect(events).toEqual(["signed_in"]);
  });

  it("asks for confirmation when the server requires it, without revealing existing accounts", async () => {
    const backend = new MemoryBackend({ emailConfirmation: true });
    const result = await backend.auth.signUp({ email: "confirm@example.test", password: PASSWORD });
    expect(result).toEqual({ session: null, needsEmailConfirmation: true });
    expect(backend.outbox.map((mail) => mail.kind)).toEqual(["confirmation"]);
    expect(await code(backend.auth.signInWithPassword("confirm@example.test", PASSWORD))).toBe("email_not_confirmed");
    expect(await backend.auth.signUp({ email: "confirm@example.test", password: PASSWORD })).toEqual({ session: null, needsEmailConfirmation: true });
    await backend.auth.confirmEmail("confirm@example.test");
    expect((await backend.auth.signInWithPassword("confirm@example.test", PASSWORD)).user.emailConfirmed).toBe(true);
  });

  it("resets a forgotten password through the emailed link", async () => {
    const mailbox: string[] = [];
    const backend = new MemoryBackend({ mailbox: (mail) => mailbox.push(`${mail.kind}:${mail.to}`) });
    await backend.auth.signUp({ email: "forgot@example.test", password: PASSWORD });
    await backend.auth.signOut();
    await backend.auth.sendPasswordReset("nobody@example.test");
    await backend.auth.sendPasswordReset(" Forgot@Example.test ");
    expect(mailbox).toEqual(["recovery:forgot@example.test"]);
    expect(await code(backend.auth.sendPasswordReset("forgot@example.test"))).toBe("rate_limited");
    const events: AuthEvent[] = [];
    backend.auth.onChange((event) => events.push(event));
    const session = await backend.openRecoveryLink("forgot@example.test");
    expect(session.user.email).toBe("forgot@example.test");
    await settle();
    expect(events).toEqual(["password_recovery"]);
    expect(await code(backend.openRecoveryLink("forgot@example.test"))).toBe("invalid_credentials");
    expect(await code(backend.auth.updatePassword(PASSWORD))).toBe("invalid_input");
    await backend.auth.updatePassword("a brand new password");
    await backend.auth.signOut();
    expect((await backend.auth.signInWithPassword("forgot@example.test", "a brand new password")).user.email).toBe("forgot@example.test");
  });

  it("recovers an account with the 6-digit code from the reset mail", async () => {
    const backend = new MemoryBackend({ codes: () => "654321" });
    await backend.auth.signUp({ email: "code-reset@example.test", password: PASSWORD });
    await backend.auth.signOut();
    await backend.auth.sendPasswordReset("code-reset@example.test");
    expect(backend.latestCode("code-reset@example.test", "recovery")).toBe("654321");
    expect(await code(backend.auth.verifyRecoveryCode("code-reset@example.test", "111111"))).toBe("invalid_credentials");
    const events: AuthEvent[] = [];
    backend.auth.onChange((event) => events.push(event));
    expect((await backend.auth.verifyRecoveryCode(" Code-Reset@example.test ", " 654321 ")).user.email).toBe("code-reset@example.test");
    await settle();
    expect(events).toEqual(["password_recovery"]);
    await backend.auth.updatePassword("another long password");
    expect(await code(backend.auth.verifyRecoveryCode("code-reset@example.test", "654321"))).toBe("invalid_credentials");
  });

  it("offers codes and resets only while mail is delivered", async () => {
    const backend = new MemoryBackend({ emailDelivery: false, providers: { emailCode: true } });
    await backend.auth.signUp({ email: "nomail@example.test", password: PASSWORD });
    expect(await code(backend.auth.sendPasswordReset("nomail@example.test"))).toBe("provider_disabled");
    expect(await code(backend.auth.sendEmailCode("nomail@example.test"))).toBe("provider_disabled");
    expect(backend.outbox).toEqual([]);
    const config = parsePlatformConfig({ schema: "viscera.platform/v1", backend: "memory", persist: false, emailDelivery: false });
    if (!config.enabled || config.backend !== "memory") throw new Error("expected a memory config");
    const fromConfig = MemoryBackend.fromConfig(config);
    await fromConfig.auth.signUp({ email: "x@example.test", password: PASSWORD });
    expect(await code(fromConfig.auth.sendPasswordReset("x@example.test"))).toBe("provider_disabled");
  });

  it("asks for a fresh sign-in before a password change or account deletion", async () => {
    let now = Date.parse("2026-10-21T12:00:00.000Z");
    const backend = new MemoryBackend({ now: () => now });
    await backend.auth.signUp({ email: "fresh@example.test", password: PASSWORD });
    now += 9 * 60 * 1000;
    await backend.auth.updatePassword("still fresh password");
    now += 2 * 60 * 1000;
    const stale = await backend.auth.updatePassword("too late password").catch((error: unknown) => error as PlatformError);
    expect(stale).toMatchObject({ code: "not_authenticated", detail: "reauthentication_needed" });
    expect(await code(backend.account.deleteAccount("DELETE"))).toBe("not_authenticated");
    expect(backend.auth.current()).not.toBeNull();
    await backend.auth.signInWithPassword("fresh@example.test", "still fresh password");
    await backend.account.deleteAccount("DELETE");
    expect(backend.auth.current()).toBeNull();
  });

  it("seeds the plans of the foundation migration", async () => {
    const backend = new MemoryBackend();
    await backend.auth.signUp({ email: "plans@example.test", password: PASSWORD });
    expect(await backend.account.usage()).toMatchObject({ planId: "free", storageQuotaBytes: 262144000, maxFileBytes: 52428800, versionRetentionDays: 30, maxProjects: 100 });
    backend.setPlan("plans@example.test", "owner");
    expect(await backend.account.usage()).toMatchObject({ planId: "owner", storageQuotaBytes: 838860800, versionRetentionDays: 365, maxProjects: 1000 });
  });

  it("caps a project at 1 000 versions, counting the draft a restore keeps", async () => {
    const backend = new MemoryBackend();
    await backend.auth.signUp({ email: "versions@example.test", password: PASSWORD });
    const ref = await snapshotRef(backend, { v: 0 });
    const project = await backend.projects.create({ labId: "organ", title: "Long history", ...ref });
    const [head] = await backend.projects.versions(project.id);
    backend.server.mutate((state) => {
      for (let seq = 2; seq < MAX_VERSIONS_PER_PROJECT - 1; seq += 1) state.versions.push({ ...(head as NonNullable<typeof head>), id: `seeded-${seq}`, seq, ownerId: state.users[0]?.id as string });
    });
    // 998 versions: one more commit fits
    const { version: last, project: afterLast } = await backend.projects.commit(project.id, { headVersionId: project.headVersionId, draftRev: 0 }, "manual", ref);
    expect(last.seq).toBe(2);
    // 999: a restore with a draft needs room for two versions, and keeps nothing when there is room for one
    const drafted = await backend.projects.saveDraft(project.id, { headVersionId: last.id, draftRev: afterLast.draftRev }, await snapshotRef(backend, { v: 1 }));
    expect(await code(backend.projects.restore(project.id, project.headVersionId as string, { headVersionId: last.id, draftRev: drafted.draftRev }))).toBe("limit_reached");
    expect(await backend.projects.get(project.id)).toEqual(drafted);
    expect(backend.server.state.versions).toHaveLength(MAX_VERSIONS_PER_PROJECT - 1);
    const discarded = await backend.projects.discardDraft(project.id, drafted.draftRev);
    const { version: third, project: full } = await backend.projects.restore(project.id, project.headVersionId as string, { headVersionId: last.id, draftRev: discarded.draftRev });
    expect(third.seq).toBe(3);
    expect(await code(backend.projects.commit(project.id, { headVersionId: third.id, draftRev: full.draftRev }, "manual", ref))).toBe("limit_reached");
    expect(await code(backend.projects.restore(project.id, project.headVersionId as string, { headVersionId: third.id, draftRev: full.draftRev }))).toBe("limit_reached");
  });

  it("checks the draft revision on commit and restore before anything else changes", async () => {
    const laptop = new MemoryBackend();
    const phone = new MemoryBackend({ server: laptop.server });
    await laptop.auth.signUp({ email: "rev@example.test", password: PASSWORD });
    await phone.auth.signInWithPassword("rev@example.test", PASSWORD);
    const ref = await snapshotRef(laptop, { r: 0 });
    const project = await laptop.projects.create({ labId: "organ", title: "Two devices", ...ref });
    // the phone saw draft revision 0; the laptop autosaved since
    const seen = { headVersionId: project.headVersionId, draftRev: project.draftRev };
    const autosaved = await laptop.projects.saveDraft(project.id, seen, await snapshotRef(laptop, { r: 1 }));
    const commit = await phone.projects.commit(project.id, seen, "manual", ref).catch((error: unknown) => error as PlatformError);
    expect(commit).toMatchObject({ code: "draft_conflict", status: 409, detail: JSON.stringify({ draft_rev: 1 }) });
    const restore = await phone.projects.restore(project.id, project.headVersionId as string, seen).catch((error: unknown) => error as PlatformError);
    expect(restore).toMatchObject({ code: "draft_conflict", detail: JSON.stringify({ draft_rev: 1 }) });
    // nothing changed: the laptop's draft is still there
    expect(await laptop.projects.get(project.id)).toEqual(autosaved);
    expect(await laptop.projects.versions(project.id)).toHaveLength(1);
  });

  it("gives the versions a restore makes the time of its transaction", async () => {
    const backend = new MemoryBackend({ now: steppingClock("2026-10-22T08:00:00.000Z", 1000) });
    await backend.auth.signUp({ email: "same-time@example.test", password: PASSWORD });
    const project = await backend.projects.create({ labId: "organ", title: "Clock", ...(await snapshotRef(backend, { c: 0 })) });
    const drafted = await backend.projects.saveDraft(project.id, { headVersionId: project.headVersionId, draftRev: 0 }, await snapshotRef(backend, { c: 1 }));
    const { project: after, version } = await backend.projects.restore(project.id, project.headVersionId as string, { headVersionId: project.headVersionId, draftRev: drafted.draftRev });
    const [restored, kept] = await backend.projects.versions(project.id);
    expect(restored).toEqual(version);
    expect(kept?.createdAt).toBe(version.createdAt);
    expect(after.updatedAt).toBe(version.createdAt);
  });

  it("re-authentication stamps a fresh sign-in for sensitive changes", async () => {
    let now = Date.parse("2026-10-22T09:00:00.000Z");
    const backend = new MemoryBackend({ now: () => now });
    await backend.auth.signUp({ email: "again@example.test", password: PASSWORD });
    now += 30 * 60 * 1000;
    expect(await code(backend.auth.updatePassword("too late for this"))).toBe("not_authenticated");
    expect(await code(backend.auth.reauthenticate("wrong password!"))).toBe("invalid_credentials");
    expect(await code(backend.account.deleteAccount("DELETE"))).toBe("not_authenticated");
    await backend.auth.reauthenticate(PASSWORD);
    expect(backend.auth.current()?.user.lastSignInAt).toBe(new Date(now).toISOString());
    await backend.auth.updatePassword("fresh enough now");
    now += 11 * 60 * 1000;
    expect(await code(backend.account.deleteAccount("DELETE"))).toBe("not_authenticated");
    await backend.auth.reauthenticate("fresh enough now");
    await backend.account.deleteAccount("DELETE");
    expect(backend.auth.current()).toBeNull();

    // accounts without a password (provider or email code) cannot re-authenticate with one
    const oauth = new MemoryBackend({ providers: { google: true } });
    await oauth.auth.signInWithOAuth("google");
    expect(await code(oauth.auth.reauthenticate(PASSWORD))).toBe("invalid_credentials");
    expect(oauth.auth.current()).not.toBeNull();
  });

  it("allows at most 8 uploads in progress per account, counting reservations of the last hour", async () => {
    let now = Date.parse("2026-10-22T10:00:00.000Z");
    const backend = new MemoryBackend({ now: () => now });
    await backend.auth.signUp({ email: "pending@example.test", password: PASSWORD });
    const transport = new MemoryTransport(backend.server, backend.auth, async () => {});
    const sha = (index: number) => index.toString(16).padStart(64, "a");
    const reserve = (index: number) => transport.reserve({ sha256: sha(index), byteSize: 5, mimeType: "application/octet-stream" });
    const reservations = [];
    for (let index = 0; index < MAX_PENDING_ASSETS; index += 1) reservations.push(await reserve(index));
    expect(await reserve(100).catch((error: unknown) => error)).toMatchObject({ code: "limit_reached", status: 403, detail: "at most 8 uploads in progress per account" });
    // the same bytes again are the same reservation, not a new one
    expect((await reserve(0)).assetId).toBe(reservations[0]?.assetId);
    // finishing one makes room
    const first = reservations[0] as NonNullable<(typeof reservations)[number]>;
    await transport.uploadStandard(first.objectPath, new Blob(["12345"]), { mimeType: "application/octet-stream", sha256: sha(0) });
    await transport.confirm(first.assetId);
    expect((await reserve(100)).status).toBe("pending");
    expect((await backend.account.usage()).pendingBytes).toBe(5 * MAX_PENDING_ASSETS);
    expect(await reserve(101).catch((error: unknown) => error)).toMatchObject({ code: "limit_reached" });

    // an abandoned reservation stops counting after an hour, so a flaky connection cannot lock saving out
    now += 61 * 60 * 1000;
    for (let index = 200; index < 200 + MAX_PENDING_ASSETS; index += 1) await reserve(index);
    // renewing an old reservation takes a slot again
    expect(await reserve(1).catch((error: unknown) => error)).toMatchObject({ code: "limit_reached" });
  });

  it("rejects a reservation whose stored size is wrong, and reopens it for the next upload", async () => {
    const backend = new MemoryBackend();
    await backend.auth.signUp({ email: "rejected@example.test", password: PASSWORD });
    const transport = new MemoryTransport(backend.server, backend.auth, async () => {});
    const bytes = new Blob(["exactly"]);
    const sha256 = await sha256Hex(bytes);
    const reservation = await transport.reserve({ sha256, byteSize: bytes.size, mimeType: "text/plain" });
    await transport.uploadStandard(reservation.objectPath, new Blob(["partial"]).slice(0, 3), { mimeType: "text/plain", sha256 });
    expect(await transport.confirm(reservation.assetId).catch((error: unknown) => error)).toMatchObject({ code: "size_mismatch", status: 409, detail: "stored 3 bytes, reserved 7" });
    const row = () => backend.server.state.assets.find((asset) => asset.id === reservation.assetId);
    // the rejection is kept (not rolled back), hidden from clients, and its bytes still count
    expect(row()?.status).toBe("rejected");
    expect(await transport.describe([reservation.assetId])).toEqual([]);
    expect((await backend.account.usage()).pendingBytes).toBe(7);
    expect(await transport.confirm(reservation.assetId).catch((error: unknown) => error)).toMatchObject({
      code: "size_mismatch",
      detail: "rejected: reserve the file again and upload it once more",
    });
    // Storage takes uploads only for pending reservations
    expect(await transport.uploadStandard(reservation.objectPath, bytes, { mimeType: "text/plain", sha256 }).catch((error: unknown) => error)).toMatchObject({ status: 403 });
    // reserving again reopens it, under the type asked for now
    const reopened = await transport.reserve({ sha256, byteSize: bytes.size, mimeType: "application/octet-stream" });
    expect(reopened).toEqual({ assetId: reservation.assetId, objectPath: reservation.objectPath, status: "pending" });
    expect(row()?.mimeType).toBe("application/octet-stream");
    await transport.uploadStandard(reopened.objectPath, bytes, { mimeType: "application/octet-stream", sha256 });
    expect(await transport.confirm(reopened.assetId)).toMatchObject({ id: reservation.assetId, status: "ready", byteSize: 7 });

    // the asset port does all of that by itself
    const port = await backend.assets.put(new Blob(["also exact"]));
    expect(port.status).toBe("ready");
  });

  it("collects orphaned assets in two phases, answering asset_busy in between", async () => {
    const backend = new MemoryBackend({ busyRetryDelaysMs: [] });
    await backend.auth.signUp({ email: "collect@example.test", password: PASSWORD });
    const orphan = await backend.assets.put(new Blob(["orphan bytes"]));
    const kept = await backend.assets.put(new Blob(["kept bytes"]));
    await backend.library.create({ kind: "image", title: "Uses kept", files: [{ filename: "kept.bin", assetId: kept.id, role: "primary" }] });
    const before = await backend.account.usage();
    expect(backend.collectAssets([orphan.id, kept.id, "not-a-uuid"])).toEqual([orphan.id]);
    // an interrupted run is simply repeated
    expect(backend.collectAssets([orphan.id])).toEqual([orphan.id]);
    // its bytes count until the row is dropped
    expect(await backend.account.usage()).toMatchObject({ usedBytes: before.usedBytes, pendingBytes: 0 });
    const busy = await backend.assets.put(new Blob(["orphan bytes"])).catch((error: unknown) => error as PlatformError);
    expect(busy).toMatchObject({ code: "asset_busy", status: 409, detail: "being collected" });
    // a row being collected cannot be referenced either: the client stores the bytes again
    const late = await backend.library.create({ kind: "image", title: "Late", files: [{ filename: "o.bin", assetId: orphan.id, role: "primary" }] }).catch((error: unknown) => error);
    expect(late).toMatchObject({ code: "asset_busy", status: 409, detail: "o.bin" });
    expect(await backend.finishCollection()).toEqual([orphan.id]);
    expect(backend.server.state.assets.map((asset) => asset.id)).toEqual([kept.id]);
    expect(backend.server.state.objects.map((object) => object.path)).toEqual([kept.objectPath]);
    const again = await backend.assets.put(new Blob(["orphan bytes"]));
    expect(again.id).not.toBe(orphan.id);
    expect(await (await backend.assets.get(again.id)).text()).toBe("orphan bytes");
  });

  it("caps library items and imported objects per account, trash included", async () => {
    const backend = new MemoryBackend();
    const { session } = await backend.auth.signUp({ email: "caps@example.test", password: PASSWORD });
    const uid = session?.user.id as string;
    const file = await backend.assets.put(new Blob(["cap"]));
    const files = [{ filename: "cap.bin", assetId: file.id, role: "data" as const }];
    const item = await backend.library.create({ kind: "scene", title: "Template", files });
    await backend.library.update(item.id, { trashed: true });
    const template = backend.server.state.libraryItems[0] as NonNullable<(typeof backend.server.state.libraryItems)[number]>;
    backend.server.mutate((state) => {
      for (let index = 1; index < MAX_LIBRARY_ITEMS; index += 1) state.libraryItems.push({ ...template, id: `seeded-item-${index}`, ownerId: uid });
    });
    expect(await backend.library.create({ kind: "scene", title: "One too many", files }).catch((error: unknown) => error)).toMatchObject({
      code: "limit_reached",
      status: 403,
      detail: "at most 5000 library items per account",
    });

    const stats = { meshes: 1, vertices: 3, triangles: 1, materials: 0, textures: 0, animations: 0, skinned: false, bbox: null };
    const input = { title: "Mesh", format: "obj" as const, originalAssetId: file.id, sourceApp: "unknown" as const, sourceDetail: null, detectedBy: "none" as const, displayAssetId: null, thumbnailAssetId: null, stats };
    const object = await backend.imports.create(input);
    const importTemplate = backend.server.state.imports.find((row) => row.id === object.id) as NonNullable<(typeof backend.server.state.imports)[number]>;
    backend.server.mutate((state) => {
      for (let index = 1; index < MAX_IMPORTED_OBJECTS; index += 1) state.imports.push({ ...importTemplate, id: `seeded-import-${index}`, trashedAt: "2026-10-22T00:00:00.000Z" });
    });
    expect(await backend.imports.create(input).catch((error: unknown) => error)).toMatchObject({
      code: "limit_reached",
      detail: "at most 2000 imported objects per account",
    });
  });

  it("puts a project back from the trash only within the plan's project limit", async () => {
    const backend = new MemoryBackend({ plans: [...DEFAULT_PLANS, TINY] });
    const { session } = await backend.auth.signUp({ email: "untrash@example.test", password: PASSWORD });
    backend.setPlan(session?.user.id as string, "tiny");
    const ref = await snapshotRef(backend, { t: 1 });
    const first = await backend.projects.create({ labId: "organ", title: "One", ...ref });
    await backend.projects.create({ labId: "organ", title: "Two", ...ref });
    await backend.projects.update(first.id, { trashed: true });
    await backend.projects.create({ labId: "organ", title: "Three", ...ref });
    expect(await code(backend.projects.update(first.id, { trashed: false }))).toBe("limit_reached");
    expect((await backend.projects.get(first.id)).trashedAt).not.toBeNull();
  });

  it("drops MIME parameters before reserving, as the database does", async () => {
    const backend = new MemoryBackend();
    await backend.auth.signUp({ email: "mime@example.test", password: PASSWORD });
    const transport = new MemoryTransport(backend.server, backend.auth, async () => {});
    const reservation = await transport.reserve({ sha256: "b".repeat(64), byteSize: 3, mimeType: "image/png; charset=binary" });
    expect(backend.server.state.assets.find((asset) => asset.id === reservation.assetId)?.mimeType).toBe("image/png");
    expect(await code(transport.reserve({ sha256: "c".repeat(64), byteSize: 3, mimeType: "text/html; charset=utf-8" }))).toBe("invalid_input");
  });

  it("limits email codes to one a minute and lets them expire", async () => {
    let now = Date.parse("2026-10-21T12:00:00.000Z");
    const backend = new MemoryBackend({ now: () => now, providers: { emailCode: true }, codes: () => "123456" });
    expect(await code(new MemoryBackend().auth.sendEmailCode("x@example.test", { createUser: true }))).toBe("provider_disabled");
    await backend.auth.sendEmailCode("code@example.test", { createUser: true });
    expect(await code(backend.auth.sendEmailCode("code@example.test", { createUser: true }))).toBe("rate_limited");
    now += 61_000;
    await backend.auth.sendEmailCode("code@example.test", { createUser: true });
    now += 3_601_000;
    expect(await code(backend.auth.verifyEmailCode("code@example.test", "123456"))).toBe("invalid_credentials");
    await backend.auth.sendEmailCode("code@example.test", { createUser: true });
    expect((await backend.auth.verifyEmailCode("code@example.test", " 123456 ")).user.providers).toEqual(["email"]);
    expect(backend.latestCode("CODE@example.test")).toBe("123456");
  });

  it("simulates OAuth sign-in and identity linking", async () => {
    const backend = new MemoryBackend({ providers: { google: true, github: true } });
    expect(await code(backend.auth.signInWithOAuth("apple"))).toBe("provider_disabled");
    await backend.auth.signInWithOAuth("google");
    expect(backend.auth.current()?.user).toMatchObject({ email: "google.user@example.test", providers: ["google"], emailConfirmed: true });
    expect(await code(backend.auth.unlinkIdentity("google"))).toBe("invalid_input");
    await backend.auth.signOut();

    await backend.auth.signUp({ email: "linker@example.test", password: PASSWORD });
    await backend.auth.linkIdentity("github");
    expect(backend.auth.current()?.user.providers).toEqual(["email", "github"]);
    // the stand-in Google identity belongs to the first account
    expect(await code(backend.auth.linkIdentity("google"))).toBe("user_exists");
    expect(await code(backend.auth.linkIdentity("azure"))).toBe("provider_disabled");
    await backend.auth.unlinkIdentity("github");
    expect(backend.auth.current()?.user.providers).toEqual(["email"]);
    expect(await code(backend.auth.unlinkIdentity("github"))).toBe("not_found");
    expect(await code(new MemoryBackend({ oauth: "disabled", providers: { google: true } }).auth.signInWithOAuth("google"))).toBe("provider_disabled");
  });

  it("deletes an account with every row and byte, everywhere", async () => {
    const backend = new MemoryBackend();
    const other = new MemoryBackend({ server: backend.server });
    await backend.auth.signUp({ email: "gone@example.test", password: PASSWORD });
    await other.auth.signInWithPassword("gone@example.test", PASSWORD);
    const project = await backend.projects.create({ labId: "organ", title: "Doomed", ...(await snapshotRef(backend, { x: 1 })) });
    expect(project.id).toBeTruthy();
    expect(await code(backend.account.deleteAccount("delete" as "DELETE"))).toBe("invalid_input");
    const events: AuthEvent[] = [];
    backend.auth.onChange((event) => events.push(event));
    await backend.account.deleteAccount("DELETE");
    await settle();
    expect(events).toEqual(["signed_out"]);
    expect(backend.auth.current()).toBeNull();
    expect(other.auth.current()).toBeNull();
    const state = backend.server.state;
    expect([state.users, state.profiles, state.assets, state.objects, state.projects, state.versions].every((rows) => rows.length === 0)).toBe(true);
    expect(await code(backend.auth.signInWithPassword("gone@example.test", PASSWORD))).toBe("invalid_credentials");
  });

  it("checks library metadata size the way Postgres measures jsonb", async () => {
    const backend = new MemoryBackend();
    await backend.auth.signUp({ email: "meta@example.test", password: PASSWORD });
    const file = await backend.assets.put(new Blob(["m"]));
    const files = [{ filename: "m.bin", assetId: file.id, role: "data" as const }];
    expect(await code(backend.library.create({ kind: "scene", title: "Big", files, metadata: { blob: "x".repeat(65_530) } }))).toBe("invalid_input");
    expect((await backend.library.create({ kind: "scene", title: "Fits", files, metadata: { blob: "x".repeat(65_000) } })).title).toBe("Fits");
    expect(await code(backend.library.create({ kind: "scene", title: "NaN", files, metadata: { value: Number.NaN } }))).toBe("invalid_input");
  });

  it("reports latency-free calls asynchronously and supports artificial latency", async () => {
    const slow = new MemoryBackend({ latencyMs: 20 });
    const started = Date.now();
    await slow.auth.usernameAvailable("someone");
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});

describe("SQL rules restated", () => {
  it("usernames", () => {
    for (const name of ["abc", "daniil", "a.b-c_d", "x".repeat(30), "007"]) expect(isValidUsername(name), name).toBe(true);
    for (const name of ["ab", "x".repeat(31), "Abc", ".abc", "abc.", "a..b", "a._b", "admin", "trash", "a b", "ä12"]) {
      expect(isValidUsername(name), name).toBe(false);
    }
  });

  it("tags", () => {
    expect(validTags([])).toBe(true);
    expect(validTags(["liver", "Kidney"])).toBe(true);
    expect(validTags(["a", "A"])).toBe(false);
    expect(validTags([" padded"])).toBe(false);
    expect(validTags(["x".repeat(33)])).toBe(false);
    expect(validTags([""])).toBe(false);
    expect(validTags(["tab\tinside"])).toBe(false);
    expect(validTags(Array.from({ length: 21 }, (_, index) => `t${index}`))).toBe(false);
  });

  it("library filenames", () => {
    for (const name of ["liver.glb", "Liver Scan (1).png", "ü.json"]) expect(isValidLibraryFilename(name), name).toBe(true);
    for (const name of [".env", "a/b.glb", "a\\b", " lead.glb", "trail.glb ", "", "x".repeat(181), "bell\u0007.bin"]) {
      expect(isValidLibraryFilename(name), name).toBe(false);
    }
  });

  it("jsonb text length uses Postgres' separators", () => {
    expect(jsonbTextLength({ a: [1, "x"] })).toBe('{"a": [1, "x"]}'.length);
    expect(jsonbTextLength({})).toBe(2);
    expect(jsonbTextLength("é")).toBe(4);
  });

  it("search patterns behave like PostgREST ilike", () => {
    expect(ilikeContainsPattern("100%_\\")).toBe("%100\\%\\_\\\\%");
    expect(ilikeMatches("Liver 100% scan", ilikeContainsPattern("100%"))).toBe(true);
    expect(ilikeMatches("Liver 1000 scan", ilikeContainsPattern("100%"))).toBe(false);
    expect(ilikeMatches("LIVER", ilikeContainsPattern("liv"))).toBe(true);
    expect(ilikeMatches("a_b", ilikeContainsPattern("_"))).toBe(true);
    expect(ilikeMatches("ab", ilikeContainsPattern("_"))).toBe(false);
    // PostgREST reads * as a wildcard before Postgres sees the pattern
    expect(ilikeMatches("liver scan", ilikeContainsPattern("liver*scan"))).toBe(true);
    expect(ilikeMatches("line1\nline2", ilikeContainsPattern("1\nline"))).toBe(true);
  });
});
