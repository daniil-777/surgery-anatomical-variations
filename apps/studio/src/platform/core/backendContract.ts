// The behaviour every PlatformBackend must show, as a reusable Vitest suite: registered for the MemoryBackend in
// memory/memoryBackend.test.ts and, given a real stack (`supabase start`), for the SupabaseBackend in
// supabase/supabaseBackend.contract.test.ts. Only ports are used here, never a backend's internals, so a passing
// suite means the memory twin and the real database agree on the scenarios below. Test-only module (imports vitest).

import { describe, expect, it } from "vitest";
import { conflictDetail } from "./errors";
import { encodeSnapshot, uploadEncodedSnapshot } from "./snapshot";
import { PlatformError, type AllowedMimeType, type AuthEvent, type PlatformBackend, type PlatformErrorCode, type SnapshotRef } from "./types";

export interface ContractHarness {
  /** Shown in the suite title. */
  name: string;
  /** A backend without a session. Called once or more per test; backends of one test share the same server. */
  createBackend(): PlatformBackend | Promise<PlatformBackend>;
  /** A fresh address per call (a real server keeps accounts between runs). Default: <label>.<random>@example.test */
  uniqueEmail?(label: string): string;
  /** The newest 6-digit code mailed to `email` (memory: the outbox; local Supabase: Mailpit), when mail is readable. */
  readEmailCode?(backend: PlatformBackend, email: string): Promise<string | null>;
  /** Username sign-in needs the auth-username Edge Function. */
  usernameSignIn?: boolean;
  /** For quota and limit tests: put an account on `tinyPlan` (memory: setPlan; real: service-role SQL). */
  setPlan?(backend: PlatformBackend, userId: string, planId: string): Promise<void>;
  tinyPlan?: { id: string; storageQuotaBytes: number; maxFileBytes: number; maxProjects: number };
  /**
   * Starts collecting an unreferenced asset the way the maintenance job collects orphans (DESIGN.md §15.3; memory:
   * MemoryBackend.collectAssets). With `finishAfterBusyAnswers` the collection ends on its own after that many
   * asset_busy answers; finish() ends it now. Without this hook the asset_busy scenario is skipped.
   */
  collectAsset?(backend: PlatformBackend, assetId: string, options?: { finishAfterBusyAnswers?: number }): Promise<{ finish(): Promise<void> }>;
  /** Per-test timeout in ms (default 20 s). */
  timeoutMs?: number;
}

const PASSWORD = "correct horse battery";

function randomToken(length = 10): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  for (let index = 0; index < length; index += 1) token += alphabet[Math.floor(Math.random() * alphabet.length)];
  return token;
}

/** Waits for deferred auth events (both backends deliver them with setTimeout). */
async function settle(): Promise<void> {
  for (let index = 0; index < 3; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function failure(promise: Promise<unknown>): Promise<PlatformError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PlatformError);
    return error as PlatformError;
  }
  throw new Error("expected the call to fail");
}

async function expectCode(promise: Promise<unknown>, code: PlatformErrorCode): Promise<PlatformError> {
  const error = await failure(promise);
  expect(error.code, `${error.code} (${error.detail ?? ""})`).toBe(code);
  return error;
}

export function defineBackendContract(harness: ContractHarness): void {
  const timeout = harness.timeoutMs ?? 20_000;
  const email = (label: string) => harness.uniqueEmail?.(label) ?? `${label}.${randomToken()}@example.test`;
  const username = () => `u${randomToken(12)}`;

  async function account(label: string, extra: { username?: string; displayName?: string } = {}) {
    const backend = await harness.createBackend();
    await backend.auth.ready();
    const address = email(label);
    const result = await backend.auth.signUp({ email: address, password: PASSWORD, ...extra });
    expect(result.needsEmailConfirmation).toBe(false);
    expect(result.session?.user.email).toBe(address);
    return { backend, email: address, userId: result.session?.user.id as string };
  }

  async function snapshot(backend: PlatformBackend, state: unknown, attachments: Record<string, Blob> = {}): Promise<SnapshotRef> {
    const encoded = await encodeSnapshot({ schema: "viscera.contract-session/2", labId: "organ", state: state as never, attachments });
    return uploadEncodedSnapshot(backend.assets, encoded, { labSchemaVersion: 2, appBuild: "contract" });
  }

  describe(`backend contract: ${harness.name}`, () => {
    describe("auth", () => {
      it(
        "signs up, signs out and signs in again, with events",
        async () => {
          const backend = await harness.createBackend();
          expect(await backend.auth.ready()).toBeNull();
          expect(backend.auth.current()).toBeNull();
          const events: AuthEvent[] = [];
          const stop = backend.auth.onChange((event) => events.push(event));
          const address = email("signup");
          const name = username();
          const { session } = await backend.auth.signUp({ email: address, password: PASSWORD, username: name, displayName: "  Ada Lovelace " });
          expect(session?.user).toMatchObject({ email: address, emailConfirmed: true });
          expect(session?.user.providers).toContain("email");
          expect(backend.auth.current()?.user.id).toBe(session?.user.id);
          await settle();
          expect(events).toContain("signed_in");

          const profile = await backend.account.profile();
          expect(profile).toMatchObject({ id: session?.user.id, username: name, displayName: "Ada Lovelace", planId: "free", appearance: "system" });

          await backend.auth.signOut();
          expect(backend.auth.current()).toBeNull();
          await settle();
          expect(events).toContain("signed_out");
          await expectCode(backend.auth.signInWithPassword(address, "not the password"), "invalid_credentials");
          await expectCode(backend.auth.signInWithPassword(`nobody.${randomToken()}@example.test`, PASSWORD), "invalid_credentials");
          const again = await backend.auth.signInWithPassword(address.toUpperCase(), PASSWORD);
          expect(again.user.id).toBe(session?.user.id);
          stop();
        },
        timeout,
      );

      it(
        "signs in with a username when the platform offers it",
        async () => {
          if (!harness.usernameSignIn) return;
          const name = username();
          const { backend, userId } = await account("username", { username: name });
          await backend.auth.signOut();
          const session = await backend.auth.signInWithUsername(` ${name.toUpperCase()} `, PASSWORD);
          expect(session.user.id).toBe(userId);
          await backend.auth.signOut();
          await expectCode(backend.auth.signInWithUsername(name, "wrong password!"), "invalid_credentials");
          await expectCode(backend.auth.signInWithUsername(username(), PASSWORD), "invalid_credentials");
          await expectCode(backend.auth.signInWithUsername("x", PASSWORD), "invalid_credentials");
        },
        timeout,
      );

      it(
        "checks usernames, passwords and duplicate accounts",
        async () => {
          const name = username();
          const { backend, email: address } = await account("rules", { username: name });
          expect(await backend.auth.usernameAvailable(name)).toBe(false);
          expect(await backend.auth.usernameAvailable(name.toUpperCase())).toBe(false);
          expect(await backend.auth.usernameAvailable(username())).toBe(true);
          expect(await backend.auth.usernameAvailable("ab")).toBe(false);
          expect(await backend.auth.usernameAvailable("admin")).toBe(false);
          expect(await backend.auth.usernameAvailable("a..b")).toBe(false);

          const other = await harness.createBackend();
          await other.auth.ready();
          await expectCode(other.auth.signUp({ email: email("weak"), password: "short" }), "weak_password");
          await expectCode(other.auth.signUp({ email: email("badname"), password: PASSWORD, username: "No Spaces!" }), "invalid_input");
          await expectCode(other.auth.signUp({ email: address, password: PASSWORD }), "user_exists");
          // a taken username never fails the sign-up: the profile is created without it
          const taken = await other.auth.signUp({ email: email("taken"), password: PASSWORD, username: name });
          expect(taken.session).not.toBeNull();
          expect((await other.account.profile()).username).toBeNull();
          await expectCode(other.account.updateProfile({ username: name }), "user_exists");
          await expectCode(other.account.updateProfile({ username: "Bad Name" }), "invalid_input");
        },
        timeout,
      );

      it(
        "updates the profile and the password",
        async () => {
          const { backend, email: address } = await account("profile");
          const before = await backend.account.profile();
          const name = username();
          const updated = await backend.account.updateProfile({ displayName: " Daniil ", appearance: "dark", username: name.toUpperCase() });
          expect(updated).toMatchObject({ displayName: "Daniil", appearance: "dark", username: name });
          expect(updated.updatedAt >= before.updatedAt).toBe(true);
          expect((await backend.account.updateProfile({ displayName: "" })).displayName).toBeNull();
          expect((await backend.account.updateProfile({})).username).toBe(name);

          await expectCode(backend.auth.updatePassword("short"), "weak_password");
          await backend.auth.updatePassword("a new long password");
          await backend.auth.signOut();
          await expectCode(backend.auth.signInWithPassword(address, PASSWORD), "invalid_credentials");
          expect((await backend.auth.signInWithPassword(address, "a new long password")).user.email).toBe(address);
        },
        timeout,
      );

      it(
        "signs in with an emailed 6-digit code when mail can be read",
        async () => {
          if (!harness.readEmailCode) return;
          const backend = await harness.createBackend();
          await backend.auth.ready();
          const address = email("code");
          await expectCode(backend.auth.sendEmailCode(address), "invalid_credentials");
          await backend.auth.sendEmailCode(address, { createUser: true });
          const code = await harness.readEmailCode(backend, address);
          expect(code).toMatch(/^\d{6}$/);
          const wrong = code === "000000" ? "111111" : "000000";
          await expectCode(backend.auth.verifyEmailCode(address, wrong), "invalid_credentials");
          const session = await backend.auth.verifyEmailCode(address, code as string);
          expect(session.user).toMatchObject({ email: address, emailConfirmed: true });
          // a code works once
          await backend.auth.signOut();
          await expectCode(backend.auth.verifyEmailCode(address, code as string), "invalid_credentials");
        },
        timeout,
      );

      it(
        "recovers an account with the code from the reset mail when mail can be read",
        async () => {
          if (!harness.readEmailCode) return;
          const { backend, email: address, userId } = await account("recovery");
          await backend.auth.signOut();
          await backend.auth.sendPasswordReset(`nobody.${randomToken()}@example.test`);
          await backend.auth.sendPasswordReset(address);
          const code = await harness.readEmailCode(backend, address);
          expect(code).toMatch(/^\d{6}$/);
          await expectCode(backend.auth.verifyRecoveryCode(address, code === "000000" ? "111111" : "000000"), "invalid_credentials");
          expect(backend.auth.current()).toBeNull();
          const events: AuthEvent[] = [];
          backend.auth.onChange((event) => events.push(event));
          const session = await backend.auth.verifyRecoveryCode(address, code as string);
          expect(session.user.id).toBe(userId);
          await settle();
          expect(events).toContain("password_recovery");
          // the recovery sign-in counts as fresh: the new password can be set right away
          await backend.auth.updatePassword("recovered long password");
          await backend.auth.signOut();
          expect((await backend.auth.signInWithPassword(address, "recovered long password")).user.email).toBe(address);
          // a code works once
          await backend.auth.signOut();
          await expectCode(backend.auth.verifyRecoveryCode(address, code as string), "invalid_credentials");
        },
        timeout,
      );

      it(
        "re-authenticates with the password before sensitive changes, keeping the session when it is wrong",
        async () => {
          const { backend, email: address, userId } = await account("reauth");
          const events: AuthEvent[] = [];
          backend.auth.onChange((event) => events.push(event));
          await expectCode(backend.auth.reauthenticate("not the password"), "invalid_credentials");
          expect(backend.auth.current()?.user.id).toBe(userId);
          expect((await backend.account.profile()).id).toBe(userId);
          await backend.auth.reauthenticate(PASSWORD);
          expect(backend.auth.current()?.user).toMatchObject({ id: userId, email: address });
          await settle();
          // the same person signing in again is not news for the shell
          expect(events).not.toContain("signed_out");
          expect(events).not.toContain("signed_in");
          await backend.auth.updatePassword("a newer long password");
          await backend.auth.signOut();
          await expectCode(backend.auth.reauthenticate("a newer long password"), "not_authenticated");
          expect((await backend.auth.signInWithPassword(address, "a newer long password")).user.id).toBe(userId);
        },
        timeout,
      );

      it(
        "refuses every data call while signed out",
        async () => {
          const backend = await harness.createBackend();
          await backend.auth.ready();
          const id = "00000000-0000-4000-8000-000000000001";
          await expectCode(backend.projects.list(), "not_authenticated");
          await expectCode(backend.projects.get(id), "not_authenticated");
          await expectCode(backend.library.list(), "not_authenticated");
          await expectCode(backend.imports.list(), "not_authenticated");
          await expectCode(backend.account.profile(), "not_authenticated");
          await expectCode(backend.account.usage(), "not_authenticated");
          await expectCode(backend.projects.restore(id, id, { headVersionId: id, draftRev: 0 }), "not_authenticated");
          await expectCode(backend.assets.put(new Blob(["x"])), "not_authenticated");
          await expectCode(backend.assets.describe([id]), "not_authenticated");
          await expectCode(backend.auth.updatePassword("long enough password"), "not_authenticated");
          await expectCode(backend.auth.reauthenticate(PASSWORD), "not_authenticated");
        },
        timeout,
      );
    });

    describe("assets", () => {
      it(
        "stores verified, deduplicated bytes per account",
        async () => {
          const { backend } = await account("assets");
          const bytes = new Uint8Array(4096).map((_, index) => (index * 13) % 256);
          const asset = await backend.assets.put(new Blob([bytes], { type: "model/gltf-binary" }));
          expect(asset).toMatchObject({ status: "ready", byteSize: 4096, mimeType: "model/gltf-binary" });
          expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
          expect(asset.objectPath).toBe(`${backend.auth.current()?.user.id}/${asset.sha256.slice(0, 2)}/${asset.sha256}`);
          const again = await backend.assets.put(new Blob([bytes]));
          expect(again.id).toBe(asset.id);
          expect(await backend.assets.describe([asset.id, asset.id])).toEqual([asset]);
          const copy = new Uint8Array(await (await backend.assets.get(asset.id)).arrayBuffer());
          expect(copy).toEqual(bytes);
          expect(typeof (await backend.assets.url(asset.id))).toBe("string");
          await expectCode(backend.assets.put(new Blob([])), "invalid_input");

          const stranger = await account("assets-other");
          expect(await stranger.backend.assets.describe([asset.id])).toEqual([]);
          await expectCode(stranger.backend.assets.get(asset.id), "not_found");
          // the same bytes are stored again for the other account (no cross-account dedup)
          const theirs = await stranger.backend.assets.put(new Blob([bytes]));
          expect(theirs.id).not.toBe(asset.id);
        },
        timeout,
      );

      it(
        "stores recordings under their type without codec parameters",
        async () => {
          const { backend } = await account("mime");
          const video = await backend.assets.put(new Blob([new Uint8Array([26, 69, 223, 163, 1])], { type: "video/webm;codecs=vp9,opus" }));
          expect(video.mimeType).toBe("video/webm");
          const explicit = await backend.assets.put(new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])]), {
            mimeType: "video/mp4; codecs=\"avc1.42E01E\"" as AllowedMimeType,
          });
          expect(explicit.mimeType).toBe("video/mp4");
          expect((await backend.assets.get(video.id)).type).toBe("video/webm");
        },
        timeout,
      );

      it(
        "starts a put over while the same bytes are being collected, and gives up if that does not end",
        async () => {
          if (!harness.collectAsset) return;
          const { backend } = await account("busy");
          const bytes = new Uint8Array(256).map((_, index) => (index * 7) % 256);
          // an upload nothing refers to: the maintenance job collects it as an orphan
          const orphan = await backend.assets.put(new Blob([bytes]));
          const stuck = await harness.collectAsset(backend, orphan.id);
          const busy = await expectCode(backend.assets.put(new Blob([bytes])), "asset_busy");
          expect(busy.status).toBe(409);
          await stuck.finish();
          const stored = await backend.assets.put(new Blob([bytes]));
          expect(stored).toMatchObject({ status: "ready", byteSize: 256, sha256: orphan.sha256 });
          expect(stored.id).not.toBe(orphan.id);
          expect(await backend.assets.describe([orphan.id])).toEqual([]);
          expect(new Uint8Array(await (await backend.assets.get(stored.id)).arrayBuffer())).toEqual(bytes);

          // the collection ends while put() waits: the next attempt reserves afresh and succeeds
          await harness.collectAsset(backend, stored.id, { finishAfterBusyAnswers: 1 });
          const again = await backend.assets.put(new Blob([bytes]));
          expect(again).toMatchObject({ status: "ready", sha256: orphan.sha256 });
          expect(again.id).not.toBe(stored.id);

          // referenced bytes are never collected
          const ref = await snapshot(backend, { busy: true });
          await backend.projects.create({ labId: "organ", title: "Keeps its files", ...ref });
          await (await harness.collectAsset(backend, ref.snapshotAssetId)).finish();
          expect((await backend.assets.describe([ref.snapshotAssetId])).map((asset) => asset.id)).toEqual([ref.snapshotAssetId]);
        },
        timeout,
      );

      it(
        "enforces the plan's file limit and quota",
        async () => {
          if (!harness.setPlan || !harness.tinyPlan) return;
          const plan = harness.tinyPlan;
          const { backend, userId } = await account("quota");
          await harness.setPlan(backend, userId, plan.id);
          await expectCode(backend.assets.put(new Blob([new Uint8Array(plan.maxFileBytes + 1)])), "file_too_large");
          let stored = 0;
          let index = 0;
          while (stored + plan.maxFileBytes <= plan.storageQuotaBytes) {
            await backend.assets.put(new Blob([new Uint8Array(plan.maxFileBytes).fill(++index % 255)]));
            stored += plan.maxFileBytes;
          }
          await expectCode(backend.assets.put(new Blob([new Uint8Array(plan.maxFileBytes).fill(254)])), "quota_exceeded");
          expect((await backend.account.usage()).usedBytes).toBe(stored);
        },
        timeout,
      );
    });

    describe("projects", () => {
      it(
        "creates, drafts, commits, conflicts, restores, labels, duplicates, trashes and deletes",
        async () => {
          const { backend } = await account("projects");
          const v1 = await snapshot(backend, { step: 1 }, { "mesh.bin": new Blob([new Uint8Array([1, 2, 3])]) });
          const project = await backend.projects.create({ labId: "organ", title: "  Liver variant  ", description: "first", ...v1 });
          expect(project).toMatchObject({ labId: "organ", title: "Liver variant", description: "first", headSeq: 1, draftRev: 0, draftAssetId: null, trashedAt: null });
          const [initial] = await backend.projects.versions(project.id);
          expect(initial).toMatchObject({ seq: 1, kind: "initial", label: null, stateSha256: v1.stateSha256, labSchemaVersion: 2, appBuild: "contract" });
          expect(project.headVersionId).toBe(initial?.id);
          expect(await backend.projects.versionAttachments(initial?.id as string)).toEqual(v1.attachments);
          expect(initial?.byteSize).toBeGreaterThan(3);

          expect((await backend.projects.list()).map((item) => item.id)).toContain(project.id);
          expect((await backend.projects.list({ labId: "tissue" })).map((item) => item.id)).not.toContain(project.id);
          expect((await backend.projects.list({ search: "liver" })).map((item) => item.id)).toEqual([project.id]);
          expect(await backend.projects.list({ search: "100%" })).toEqual([]);

          // autosave into the draft, optimistic on head and draft revision
          const d1 = await snapshot(backend, { step: 2 });
          const drafted = await backend.projects.saveDraft(project.id, { headVersionId: project.headVersionId, draftRev: 0 }, d1);
          expect(drafted).toMatchObject({ draftRev: 1, draftAssetId: d1.snapshotAssetId, draftStateSha256: d1.stateSha256 });
          expect(drafted.draftSavedAt).not.toBeNull();
          expect(await backend.projects.draftAttachments(project.id)).toEqual([]);
          const stale = await expectCode(backend.projects.saveDraft(project.id, { headVersionId: project.headVersionId, draftRev: 0 }, d1), "draft_conflict");
          expect(stale.status).toBe(409);
          expect(conflictDetail(stale)?.draftRev).toBe(1);

          // commit a manual version: the draft is cleared, and the answer carries the project as it is now
          const v2ref = await snapshot(backend, { step: 3 }, { "mesh.bin": new Blob([new Uint8Array([9])]) });
          const committed = await backend.projects.commit(project.id, { headVersionId: project.headVersionId, draftRev: drafted.draftRev }, "manual", v2ref);
          const v2 = committed.version;
          expect(v2).toMatchObject({ seq: 2, kind: "manual", parentVersionId: initial?.id, label: null, stateSha256: v2ref.stateSha256 });
          expect(committed.project).toMatchObject({ headVersionId: v2.id, headSeq: 2, draftRev: 2, draftAssetId: null, draftSavedAt: null });
          expect(await backend.projects.get(project.id)).toEqual(committed.project);
          const afterCommit = { headVersionId: v2.id, draftRev: committed.project.draftRev };
          const conflict = await expectCode(backend.projects.commit(project.id, { headVersionId: initial?.id ?? null, draftRev: 2 }, "manual", v2ref), "version_conflict");
          expect(conflictDetail(conflict)).toMatchObject({ headVersionId: v2.id, headSeq: 2 });
          // another tab autosaved meanwhile: committing what this tab saw would drop that draft
          const staleCommit = await expectCode(backend.projects.commit(project.id, { headVersionId: v2.id, draftRev: 1 }, "manual", v2ref), "draft_conflict");
          expect(staleCommit.status).toBe(409);
          expect(conflictDetail(staleCommit)?.draftRev).toBe(2);
          await expectCode(backend.projects.commit(project.id, afterCommit, "named", v2ref), "invalid_input");
          await expectCode(backend.projects.commit(project.id, afterCommit, "manual", { ...v2ref, stateSha256: "nope" }), "invalid_input");
          expect(await backend.projects.get(project.id)).toEqual(committed.project);

          // restore never rewrites history
          const restore = await backend.projects.restore(project.id, initial?.id as string, afterCommit);
          const restored = restore.version;
          expect(restored).toMatchObject({ seq: 3, kind: "restore", restoredFromVersionId: initial?.id, snapshotAssetId: v1.snapshotAssetId, parentVersionId: v2.id });
          expect(restore.project).toMatchObject({ headVersionId: restored.id, headSeq: 3, draftRev: 3, draftAssetId: null });
          expect(await backend.projects.versionAttachments(restored.id)).toEqual(v1.attachments);
          await expectCode(backend.projects.restore(project.id, initial?.id as string, afterCommit), "version_conflict");
          const staleRestore = await expectCode(backend.projects.restore(project.id, initial?.id as string, { headVersionId: restored.id, draftRev: 2 }), "draft_conflict");
          expect(conflictDetail(staleRestore)?.draftRev).toBe(3);
          await expectCode(backend.projects.restore(project.id, "00000000-0000-4000-8000-0000000000ff", { headVersionId: restored.id, draftRev: 3 }), "not_found");

          // names keep versions; the head and named versions cannot be deleted
          const named = await backend.projects.label(restored.id, "  Milestone  ");
          expect(named.label).toBe("Milestone");
          await expectCode(backend.projects.deleteVersion(restored.id), "invalid_input");
          await backend.projects.label(v2.id, "Keep");
          await expectCode(backend.projects.deleteVersion(v2.id), "invalid_input");
          expect((await backend.projects.label(v2.id, null)).label).toBeNull();
          await backend.projects.deleteVersion(v2.id);
          expect((await backend.projects.versions(project.id)).map((version) => version.seq)).toEqual([3, 1]);
          const finalCommit = await backend.projects.commit(project.id, { headVersionId: restored.id, draftRev: 3 }, "named", await snapshot(backend, { step: 4 }), " Final ");
          const v4 = finalCommit.version;
          expect(v4).toMatchObject({ seq: 4, kind: "named", label: "Final" });

          // every commit and restore cleared the draft (create 0 → draft 1 → commit 2 → restore 3 → commit 4)
          const beforeDraft = await backend.projects.get(project.id);
          expect(beforeDraft).toMatchObject({ draftRev: 4, headVersionId: v4.id, headSeq: 4 });
          expect(beforeDraft).toEqual(finalCommit.project);
          // discard a draft
          const draft2 = await backend.projects.saveDraft(project.id, { headVersionId: v4.id, draftRev: 4 }, await snapshot(backend, { step: 5 }));
          await expectCode(backend.projects.discardDraft(project.id, 0), "draft_conflict");
          const discarded = await backend.projects.discardDraft(project.id, draft2.draftRev);
          expect(discarded).toMatchObject({ draftAssetId: null, draftStateSha256: null, draftRev: draft2.draftRev + 1, headVersionId: v4.id });

          // save as copy from any version
          const copy = await backend.projects.duplicate(project.id, " Liver copy ", initial?.id as string);
          expect(copy).toMatchObject({ title: "Liver copy", labId: "organ", description: "first", headSeq: 1 });
          const [copyHead] = await backend.projects.versions(copy.id);
          expect(copyHead).toMatchObject({ seq: 1, kind: "duplicate", restoredFromVersionId: initial?.id, snapshotAssetId: v1.snapshotAssetId });

          // edits that are not content keep updatedAt
          const renamed = await backend.projects.update(project.id, { title: " Liver A ", favorite: true, opened: true });
          expect(renamed).toMatchObject({ title: "Liver A", favorite: true, updatedAt: discarded.updatedAt });
          expect(renamed.openedAt).not.toBeNull();
          await expectCode(backend.projects.update(project.id, { title: "   " }), "invalid_input");
          expect((await backend.projects.list({ favorite: true })).map((item) => item.id)).toEqual([project.id]);
          expect((await backend.projects.list({ orderBy: "title" })).map((item) => item.title)).toEqual(["Liver A", "Liver copy"]);

          // trash: read-only history, then delete forever
          await expectCode(backend.projects.deleteForever(copy.id), "invalid_input");
          const trashed = await backend.projects.update(project.id, { trashed: true });
          expect(trashed.trashedAt).not.toBeNull();
          expect((await backend.projects.list()).map((item) => item.id)).toEqual([copy.id]);
          expect((await backend.projects.list({ trashed: true })).map((item) => item.id)).toEqual([project.id]);
          await expectCode(backend.projects.saveDraft(project.id, { headVersionId: v4.id, draftRev: discarded.draftRev }, d1), "project_trashed");
          await expectCode(backend.projects.commit(project.id, { headVersionId: v4.id, draftRev: discarded.draftRev }, "manual", d1), "project_trashed");
          await expectCode(backend.projects.restore(project.id, initial?.id as string, { headVersionId: v4.id, draftRev: discarded.draftRev }), "project_trashed");
          await expectCode(backend.projects.label(v4.id, "x"), "project_trashed");
          const untrashed = await backend.projects.update(project.id, { trashed: false });
          expect(untrashed.trashedAt).toBeNull();
          await backend.projects.update(project.id, { trashed: true });
          await backend.projects.deleteForever(project.id);
          await expectCode(backend.projects.get(project.id), "not_found");
          expect(await backend.projects.versions(project.id)).toEqual([]);
          // the copy keeps its own history
          expect((await backend.projects.versions(copy.id)).map((version) => version.seq)).toEqual([1]);
          await expectCode(backend.projects.get("not-a-uuid"), "not_found");
        },
        timeout,
      );

      it(
        "keeps an unsaved draft as a version when restoring",
        async () => {
          const { backend } = await account("restore-draft");
          const v1 = await snapshot(backend, { step: 1 }, { "mesh.bin": new Blob([new Uint8Array([1, 2, 3])]) });
          const project = await backend.projects.create({ labId: "organ", title: "Kidney", ...v1 });
          const [initial] = await backend.projects.versions(project.id);
          const thumbnail = await backend.assets.put(new Blob([new Uint8Array([137, 80, 78, 71, 2])], { type: "image/png" }));
          // the lab moved on to schema 3 since version 1: the kept draft records what it was saved with
          const draftRef = {
            ...(await snapshot(backend, { step: 2 }, { "mesh.bin": new Blob([new Uint8Array([4, 5])]), "scan.bin": new Blob(["s"]) })),
            thumbnailAssetId: thumbnail.id,
            labSchemaVersion: 3,
            appBuild: "contract-draft",
          };
          const drafted = await backend.projects.saveDraft(project.id, { headVersionId: project.headVersionId, draftRev: 0 }, draftRef);

          const { project: after, version: restored } = await backend.projects.restore(project.id, initial?.id as string, {
            headVersionId: project.headVersionId,
            draftRev: drafted.draftRev,
          });
          const versions = await backend.projects.versions(project.id);
          expect(versions.map((version) => [version.seq, version.kind])).toEqual([
            [3, "restore"],
            [2, "autosave"],
            [1, "initial"],
          ]);
          const kept = versions[1];
          // the draft became a version of its own, with its state, files and picture
          expect(kept).toMatchObject({
            kind: "autosave",
            label: null,
            parentVersionId: initial?.id,
            snapshotAssetId: draftRef.snapshotAssetId,
            stateSha256: draftRef.stateSha256,
            thumbnailAssetId: thumbnail.id,
            restoredFromVersionId: null,
            labSchemaVersion: 3,
            appBuild: "contract-draft",
          });
          expect(await backend.projects.versionAttachments(kept?.id as string)).toEqual(draftRef.attachments);
          expect(kept?.byteSize).toBeGreaterThan(0);
          // then the restore, on top of it
          expect(restored).toMatchObject({ seq: 3, kind: "restore", parentVersionId: kept?.id, restoredFromVersionId: initial?.id, snapshotAssetId: v1.snapshotAssetId });
          expect(versions[0]).toEqual(restored);
          expect(after).toMatchObject({ headVersionId: restored.id, headSeq: 3, draftAssetId: null, draftStateSha256: null, draftThumbnailAssetId: null, draftSavedAt: null, draftRev: drafted.draftRev + 1 });
          expect(await backend.projects.get(project.id)).toEqual(after);
          expect(await backend.projects.draftAttachments(project.id)).toEqual([]);

          // going back to the kept draft is an ordinary restore
          const back = await backend.projects.restore(project.id, kept?.id as string, { headVersionId: restored.id, draftRev: after.draftRev });
          expect(back.version).toMatchObject({ seq: 4, kind: "restore", restoredFromVersionId: kept?.id, stateSha256: draftRef.stateSha256 });
          expect(await backend.projects.versionAttachments(back.version.id)).toEqual(draftRef.attachments);
        },
        timeout,
      );

      it(
        "validates input and keeps accounts apart",
        async () => {
          const { backend } = await account("project-rules");
          const ref = await snapshot(backend, { ok: true });
          await expectCode(backend.projects.create({ labId: "Organ Lab", title: "x", ...ref }), "invalid_input");
          await expectCode(backend.projects.create({ labId: "organ", title: "   ", ...ref }), "invalid_input");
          await expectCode(backend.projects.create({ labId: "organ", title: "x".repeat(121), ...ref }), "invalid_input");
          await expectCode(backend.projects.create({ labId: "organ", title: "x", ...ref, labSchemaVersion: 0 }), "invalid_input");
          const duplicateNames = { ...ref, attachments: [...ref.attachments, { name: "a.bin", assetId: ref.snapshotAssetId }, { name: "a.bin", assetId: ref.snapshotAssetId }] };
          await expectCode(backend.projects.create({ labId: "organ", title: "x", ...duplicateNames }), "invalid_input");
          await expectCode(backend.projects.create({ labId: "organ", title: "x", ...ref, attachments: [{ name: "../evil", assetId: ref.snapshotAssetId }] }), "invalid_input");
          const project = await backend.projects.create({ labId: "organ", title: "Mine", ...ref });

          const stranger = await account("project-stranger");
          await expectCode(stranger.backend.projects.get(project.id), "not_found");
          expect(await stranger.backend.projects.list()).toEqual([]);
          expect(await stranger.backend.projects.versions(project.id)).toEqual([]);
          await expectCode(stranger.backend.projects.update(project.id, { title: "Stolen" }), "not_found");
          await expectCode(stranger.backend.projects.saveDraft(project.id, { headVersionId: project.headVersionId, draftRev: 0 }, ref), "not_found");
          await expectCode(stranger.backend.projects.duplicate(project.id, "Copy"), "not_found");
          // someone else's snapshot asset cannot be referenced
          await expectCode(stranger.backend.projects.create({ labId: "organ", title: "x", ...ref }), "not_found");
          expect((await backend.projects.get(project.id)).title).toBe("Mine");
        },
        timeout,
      );

      it(
        "limits the number of projects on a plan",
        async () => {
          if (!harness.setPlan || !harness.tinyPlan) return;
          const { backend, userId } = await account("project-limit");
          await harness.setPlan(backend, userId, harness.tinyPlan.id);
          const ref = await snapshot(backend, { n: 0 });
          const created = [];
          for (let index = 0; index < harness.tinyPlan.maxProjects; index += 1) {
            created.push(await backend.projects.create({ labId: "organ", title: `P${index}`, ...ref }));
          }
          await expectCode(backend.projects.create({ labId: "organ", title: "One too many", ...ref }), "limit_reached");
          await expectCode(backend.projects.duplicate(created[0]?.id as string, "Copy"), "limit_reached");
          // trashed projects do not count
          await backend.projects.update(created[0]?.id as string, { trashed: true });
          expect((await backend.projects.create({ labId: "organ", title: "Fits again", ...ref })).title).toBe("Fits again");
        },
        timeout,
      );
    });

    describe("library", () => {
      it(
        "keeps items with files, tags, favourites, search and trash",
        async () => {
          const { backend } = await account("library");
          const mesh = await backend.assets.put(new Blob([new Uint8Array(64).fill(3)], { type: "model/gltf-binary" }));
          const spec = await backend.assets.put(new Blob(['{"seed":"1"}'], { type: "application/json" }));
          const thumbnail = await backend.assets.put(new Blob([new Uint8Array([137, 80, 78, 71, 1])], { type: "image/png" }));
          const item = await backend.library.create({
            kind: "shape",
            title: " Liver 42 ",
            description: "vertex-colour bake",
            tags: [" liver ", "Liver", "variation", ""],
            labId: "organ",
            metadata: { claims: { evidence: "procedural", limitations: ["not validated"] } },
            thumbnailAssetId: thumbnail.id,
            files: [
              { filename: "liver.glb", assetId: mesh.id, role: "mesh", position: 0 },
              { filename: "spec.json", assetId: spec.id, role: "spec", position: 1 },
            ],
          });
          expect(item).toMatchObject({ kind: "shape", title: "Liver 42", tags: ["liver", "variation"], labId: "organ", favorite: false, trashedAt: null });
          expect(item.byteSize).toBe(mesh.byteSize + spec.byteSize + thumbnail.byteSize);
          expect(item.metadata).toEqual({ claims: { evidence: "procedural", limitations: ["not validated"] } });
          const fetched = await backend.library.get(item.id);
          expect(fetched.files).toEqual([
            { filename: "liver.glb", assetId: mesh.id, role: "mesh", position: 0, byteSize: 64, mimeType: "model/gltf-binary" },
            { filename: "spec.json", assetId: spec.id, role: "spec", position: 1, byteSize: spec.byteSize, mimeType: "application/json" },
          ]);

          expect((await backend.library.list({ kind: "shape" })).map((entry) => entry.id)).toEqual([item.id]);
          expect(await backend.library.list({ kind: "recording" })).toEqual([]);
          expect((await backend.library.list({ tag: "variation" })).map((entry) => entry.id)).toEqual([item.id]);
          expect((await backend.library.list({ search: "LIVER" })).map((entry) => entry.id)).toEqual([item.id]);
          expect(await backend.library.list({ search: "_" })).toEqual([]);

          const updated = await backend.library.update(item.id, { title: "Liver 43", tags: ["final"], favorite: true });
          expect(updated).toMatchObject({ title: "Liver 43", tags: ["final"], favorite: true });
          expect(updated.updatedAt >= item.updatedAt).toBe(true);
          expect(updated.files?.length).toBe(2);
          await expectCode(backend.library.update(item.id, { tags: Array.from({ length: 21 }, (_, index) => `t${index}`) }), "invalid_input");

          await expectCode(
            backend.library.create({ kind: "shape", title: "Dup", files: [{ filename: "a.glb", assetId: mesh.id, role: "mesh" }, { filename: "A.GLB", assetId: spec.id, role: "spec" }] }),
            "invalid_input",
          );
          await expectCode(backend.library.create({ kind: "shape", title: "No files", files: [] }), "invalid_input");
          await expectCode(backend.library.create({ kind: "shape", title: "Hidden", files: [{ filename: ".env", assetId: mesh.id, role: "mesh" }] }), "invalid_input");
          await expectCode(backend.library.create({ kind: "shape", title: "Bad role", files: [{ filename: "a.glb", assetId: mesh.id, role: "skin" as never }] }), "invalid_input");
          await expectCode(backend.library.create({ kind: "shape", title: "Far", files: [{ filename: "a.glb", assetId: mesh.id, role: "mesh", position: 1001 }] }), "invalid_input");

          await expectCode(backend.library.deleteForever(item.id), "invalid_input");
          await backend.library.update(item.id, { trashed: true });
          expect(await backend.library.list()).toEqual([]);
          expect((await backend.library.list({ trashed: true })).map((entry) => entry.id)).toEqual([item.id]);
          await backend.library.deleteForever(item.id);
          await expectCode(backend.library.get(item.id), "not_found");

          const stranger = await account("library-stranger");
          await expectCode(stranger.backend.library.create({ kind: "shape", title: "Theirs", files: [{ filename: "a.glb", assetId: mesh.id, role: "mesh" }] }), "not_found");
        },
        timeout,
      );

      it(
        "links items to the project and version they came from",
        async () => {
          const { backend } = await account("library-source");
          const ref = await snapshot(backend, { s: 1 });
          const project = await backend.projects.create({ labId: "organ", title: "Source", ...ref });
          const file = await backend.assets.put(new Blob(["video"], { type: "video/webm" }));
          const item = await backend.library.create({
            kind: "recording",
            title: "Experiment",
            files: [{ filename: "run.webm", assetId: file.id, role: "video" }],
            sourceProjectId: project.id,
            sourceVersionId: project.headVersionId,
          });
          expect(item).toMatchObject({ sourceProjectId: project.id, sourceVersionId: project.headVersionId });
          await expectCode(
            backend.library.create({ kind: "recording", title: "Bad", files: [{ filename: "run.webm", assetId: file.id, role: "video" }], sourceProjectId: "00000000-0000-4000-8000-0000000000aa" }),
            "not_found",
          );
          await backend.projects.update(project.id, { trashed: true });
          await backend.projects.deleteForever(project.id);
          expect(await backend.library.get(item.id)).toMatchObject({ sourceProjectId: null, sourceVersionId: null });
        },
        timeout,
      );
    });

    describe("imports", () => {
      it(
        "keeps imported objects with their analysis",
        async () => {
          const { backend } = await account("imports");
          const original = await backend.assets.put(new Blob([new Uint8Array(128).fill(5)]));
          const display = await backend.assets.put(new Blob([new Uint8Array(96).fill(6)], { type: "model/gltf-binary" }));
          const stats = { meshes: 2, vertices: 120, triangles: 80, materials: 1, textures: 0, animations: 0, skinned: false, bbox: { x: 1, y: 2, z: 3 }, upAxis: "Z" as const, notes: ["textures referenced but not bundled"] };
          const object = await backend.imports.create({
            title: " Heart.fbx ",
            format: "fbx",
            originalAssetId: original.id,
            sourceApp: "blender",
            sourceDetail: "  Blender 4.2  ",
            detectedBy: "metadata",
            displayAssetId: display.id,
            thumbnailAssetId: null,
            stats,
            tags: ["heart"],
          });
          expect(object).toMatchObject({ title: "Heart.fbx", sourceApp: "blender", sourceDetail: "Blender 4.2", detectedBy: "metadata", format: "fbx", stats, tags: ["heart"] });
          expect(object.byteSize).toBe(128 + 96);
          expect(await backend.imports.get(object.id)).toEqual(object);
          expect((await backend.imports.list({ sourceApp: "blender" })).map((entry) => entry.id)).toEqual([object.id]);
          expect(await backend.imports.list({ sourceApp: "unity" })).toEqual([]);
          expect((await backend.imports.list({ search: "heart" })).map((entry) => entry.id)).toEqual([object.id]);

          const corrected = await backend.imports.update(object.id, { sourceApp: "unity", favorite: true, title: "Heart" });
          expect(corrected).toMatchObject({ sourceApp: "unity", detectedBy: "user", favorite: true, title: "Heart" });
          await expectCode(
            backend.imports.create({ title: "x", format: "max" as never, originalAssetId: original.id, sourceApp: "other", sourceDetail: null, detectedBy: "none", displayAssetId: null, thumbnailAssetId: null, stats }),
            "invalid_input",
          );

          await expectCode(backend.imports.deleteForever(object.id), "invalid_input");
          await backend.imports.update(object.id, { trashed: true });
          expect(await backend.imports.list()).toEqual([]);
          await backend.imports.deleteForever(object.id);
          await expectCode(backend.imports.get(object.id), "not_found");
        },
        timeout,
      );
    });

    describe("usage", () => {
      it(
        "reports the plan and what the account stores",
        async () => {
          const { backend } = await account("usage");
          const empty = await backend.account.usage();
          expect(empty).toMatchObject({ planId: "free", usedBytes: 0, pendingBytes: 0, projectCount: 0, versionCount: 0, libraryCount: 0, importCount: 0, trashCount: 0 });
          expect(empty.storageQuotaBytes).toBeGreaterThan(0);
          const ref = await snapshot(backend, { u: 1 });
          const project = await backend.projects.create({ labId: "organ", title: "Counted", ...ref });
          await backend.projects.commit(project.id, { headVersionId: project.headVersionId, draftRev: project.draftRev }, "manual", await snapshot(backend, { u: 2 }));
          const file = await backend.assets.put(new Blob(["image"], { type: "image/png" }));
          const item = await backend.library.create({ kind: "image", title: "Still", files: [{ filename: "still.png", assetId: file.id, role: "primary" }] });
          const original = await backend.assets.put(new Blob(["mesh"], { type: "model/obj" }));
          await backend.imports.create({
            title: "obj",
            format: "obj",
            originalAssetId: original.id,
            sourceApp: "unknown",
            sourceDetail: null,
            detectedBy: "none",
            displayAssetId: null,
            thumbnailAssetId: null,
            stats: { meshes: 1, vertices: 3, triangles: 1, materials: 0, textures: 0, animations: 0, skinned: false, bbox: null },
          });
          await backend.library.update(item.id, { trashed: true });
          const usage = await backend.account.usage();
          expect(usage).toMatchObject({ projectCount: 1, versionCount: 2, libraryCount: 0, importCount: 1, trashCount: 1, pendingBytes: 0 });
          const described = await backend.assets.describe([ref.snapshotAssetId, file.id, original.id]);
          expect(usage.usedBytes).toBeGreaterThanOrEqual(described.reduce((sum, asset) => sum + asset.byteSize, 0));
        },
        timeout,
      );
    });
  });
}
