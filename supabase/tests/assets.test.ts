// The content-addressed upload protocol: reserve_asset (validation, per-account dedup, per-file limit, quota, uploads in
// progress) → Storage upload → confirm_asset (the stored object must exist with the reserved size), and the states a
// row passes through on its way to collection (rejected, deleting). Quotas and limits come from the caller's plan, so
// the tests move accounts onto tiny plans.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { anon, createTestDb, expectDenied, expectPlatformError, sha256, user, type Row, type TestDb } from "./support/db";
import {
  commitVersion,
  createImportedObject,
  createLibraryItem,
  createProject,
  one,
  pendingAsset,
  readyAsset,
  trash,
  uniqueContent,
  type AssetRef,
} from "./support/fixtures";

// PGlite is fast, but a busy CI runner is not: database tests get explicit headroom.
vi.setConfig({ testTimeout: 30_000 });

interface AssetRow extends Row {
  id: string;
  owner_id: string;
  sha256: string;
  byte_size: number;
  mime_type: string;
  object_path: string;
  status: string;
  created_at: Date;
  last_used_at: Date;
  ready_at: Date | null;
}

describe("assets", () => {
  let t: TestDb;

  const reserveRaw = (owner: string, sha: unknown, size: unknown, mime: unknown) =>
    t.as<{ asset_id: string; object_path: string; status: string } & Row>(
      user(owner),
      "select * from public.reserve_asset($1, $2, $3)",
      [sha, size, mime],
    );
  const confirm = (owner: string, assetId: string | null) => t.confirm(owner, assetId);
  const assetRow = async (id: string) => one(await t.admin<AssetRow>("select * from public.assets where id = $1", [id]));
  const pathOf = (owner: string, asset: AssetRef) => `${owner}/${asset.sha.slice(0, 2)}/${asset.sha}`;
  const usageOf = async (owner: string) =>
    one(await t.as<{ u: Record<string, number> } & Row>(user(owner), "select public.my_usage() as u")).u;

  beforeAll(async () => {
    t = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  describe("reserve_asset", () => {
    it("reserves a pending row at <owner>/<sha[0:2]>/<sha> and returns the same row until it is uploaded", async () => {
      const owner = await t.createUser();
      const content = uniqueContent("reserve");
      const first = await t.reserve(owner, content, "image/png");
      const sha = sha256(content);
      expect(first).toEqual({ asset_id: expect.any(String), object_path: `${owner}/${sha.slice(0, 2)}/${sha}`, status: "pending" });
      const again = await t.reserve(owner, content, "image/png");
      expect(again).toEqual(first);
      const row = await assetRow(first.asset_id);
      expect(row).toMatchObject({ owner_id: owner, sha256: sha, mime_type: "image/png", status: "pending", ready_at: null });
    });

    it("deduplicates per account: a ready file needs no second upload, another account gets its own row", async () => {
      const owner = await t.createUser();
      const other = await t.createUser();
      const content = uniqueContent("dedup");
      const id = await t.upload(owner, content);
      const again = await t.reserve(owner, content);
      expect(again).toMatchObject({ asset_id: id, status: "ready" });
      // the stored type is the first reservation's; a later reservation under another type reuses the bytes
      const otherType = await t.reserve(owner, content, "application/octet-stream");
      expect(otherType).toMatchObject({ asset_id: id, status: "ready" });
      const foreign = await t.reserve(other, content);
      expect(foreign.asset_id).not.toBe(id);
      expect(foreign.status).toBe("pending");
      expect(foreign.object_path.startsWith(`${other}/`)).toBe(true);
    });

    it("refuses a different size for a sha256 it already holds", async () => {
      const owner = await t.createUser();
      const content = uniqueContent("size");
      await t.upload(owner, content);
      await expectPlatformError(
        reserveRaw(owner, sha256(content), content.length + 1, "application/gzip"),
        "invalid_input",
        422,
        /byte_size differs/,
      );
      const pendingContent = uniqueContent("pending-size");
      await t.reserve(owner, pendingContent);
      await expectPlatformError(reserveRaw(owner, sha256(pendingContent), 1, "application/gzip"), "invalid_input", 422);
    });

    it("touches last_used_at on every reservation, so orphan collection waits", async () => {
      const owner = await t.createUser();
      const content = uniqueContent("touch");
      const id = await t.upload(owner, content);
      await t.admin("update public.assets set last_used_at = now() - interval '30 days' where id = $1", [id]);
      await t.reserve(owner, content);
      const row = await assetRow(id);
      expect(Date.now() - row.last_used_at.getTime()).toBeLessThan(60_000);
    });

    it.each([
      ["sha256", ["A".repeat(64), 10, "image/png"]],
      ["sha256", ["a".repeat(63), 10, "image/png"]],
      ["sha256", ["g".repeat(64), 10, "image/png"]],
      ["sha256", [` ${"a".repeat(63)}`, 10, "image/png"]],
      ["sha256", [null, 10, "image/png"]],
      ["byte_size", ["a".repeat(64), 0, "image/png"]],
      ["byte_size", ["a".repeat(64), -5, "image/png"]],
      ["byte_size", ["a".repeat(64), null, "image/png"]],
      ["mime_type", ["a".repeat(64), 10, "text/html"]],
      ["mime_type", ["a".repeat(64), 10, "image/svg+xml"]],
      ["mime_type", ["a".repeat(64), 10, "application/xml"]],
      ["mime_type", ["a".repeat(64), 10, "text/javascript"]],
      ["mime_type", ["a".repeat(64), 10, "IMAGE/PNG"]],
      ["mime_type", ["a".repeat(64), 10, "text/html; charset=utf-8"]],
      ["mime_type", ["a".repeat(64), 10, "; image/png"]],
      ["mime_type", ["a".repeat(64), 10, ""]],
      ["mime_type", ["a".repeat(64), 10, null]],
    ] as const)("rejects an invalid %s (%j)", async (field, [sha, size, mime]) => {
      const owner = await t.createUser();
      await expectPlatformError(reserveRaw(owner, sha, size, mime), "invalid_input", 422, field);
      expect(await t.admin("select 1 from public.assets where owner_id = $1", [owner])).toEqual([]);
    });

    it("drops MIME parameters and surrounding spaces before checking and storing the type", async () => {
      const owner = await t.createUser();
      const content = uniqueContent("parameters");
      const reservation = await t.reserve(owner, content, " image/png; charset=binary ");
      expect((await assetRow(reservation.asset_id)).mime_type).toBe("image/png");
      const video = await t.reserve(owner, uniqueContent("codecs"), 'video/mp4; codecs="avc1.42E01E"');
      expect((await assetRow(video.asset_id)).mime_type).toBe("video/mp4");
    });

    it("enforces the plan's per-file limit before the quota", async () => {
      const owner = await t.createUser();
      await t.setPlan(owner, { maxFileBytes: 50, storageQuotaBytes: 40 });
      await expectPlatformError(reserveRaw(owner, "b".repeat(64), 51, "text/plain"), "file_too_large", 413, /51 bytes; the limit is 50/);
      const exact = await t.setPlan(owner, { maxFileBytes: 50, storageQuotaBytes: 1000 });
      expect(exact).toMatch(/^test_plan_/);
      expect(one(await reserveRaw(owner, "c".repeat(64), 50, "text/plain")).status).toBe("pending");
    });

    it("counts pending reservations and ready files against the quota, up to exactly the limit", async () => {
      const owner = await t.createUser();
      await t.setPlan(owner, { storageQuotaBytes: 100, maxFileBytes: 100 });
      const ready = await readyAsset(t, owner, { size: 40 });
      await reserveRaw(owner, "d".repeat(64), 30, "text/plain");
      await expectPlatformError(reserveRaw(owner, "e".repeat(64), 31, "text/plain"), "quota_exceeded", 413, /^70 of 100 bytes used$/);
      expect(one(await reserveRaw(owner, "e".repeat(64), 30, "text/plain")).status).toBe("pending");
      await expectPlatformError(reserveRaw(owner, "f".repeat(64), 1, "text/plain"), "quota_exceeded", 413);
      // a full account can still re-reserve what it already has (dedup costs nothing)
      expect(one(await reserveRaw(owner, ready.sha, ready.size, "application/gzip")).status).toBe("ready");
      const usage = one(await t.as<{ u: Record<string, number> } & Row>(user(owner), "select public.my_usage() as u")).u;
      expect(usage).toMatchObject({ used_bytes: 40, pending_bytes: 60, storage_quota_bytes: 100, max_file_bytes: 100 });
    });

    it("is closed to anon", async () => {
      await expectDenied(t.as(anon, "select * from public.reserve_asset($1, 1, 'text/plain')", ["a".repeat(64)]));
      await expectDenied(t.as(anon, "select * from public.confirm_asset(gen_random_uuid())"));
    });
  });

  describe("my_usage", () => {
    it("reports the caller's plan, bytes and counts, and nobody else's", async () => {
      const owner = await t.createUser();
      const other = await t.createUser();
      await t.setPlan(owner, { storageQuotaBytes: 10_000, maxFileBytes: 5_000, versionRetentionDays: 7, maxProjects: 3 });
      const { project } = await createProject(t, owner);
      await commitVersion(t, owner, project.id);
      const trashed = await createProject(t, owner);
      await trash(t, owner, "projects", trashed.project.id);
      await createLibraryItem(t, owner);
      const oldItem = await createLibraryItem(t, owner);
      await trash(t, owner, "library_items", oldItem.id);
      await createImportedObject(t, owner);
      await pendingAsset(t, owner);
      await createProject(t, other);
      const bytes = async (status: string) =>
        one(
          await t.admin<{ n: number } & Row>(
            "select coalesce(sum(byte_size), 0)::bigint as n from public.assets where owner_id = $1 and status = $2",
            [owner, status],
          ),
        ).n;
      const usage = one(await t.as<{ u: Record<string, unknown> } & Row>(user(owner), "select public.my_usage() as u")).u;
      expect(usage).toEqual({
        plan_id: expect.stringMatching(/^test_plan_/),
        plan_title: expect.stringMatching(/^Test plan /),
        storage_quota_bytes: 10_000,
        max_file_bytes: 5_000,
        version_retention_days: 7,
        max_projects: 3,
        used_bytes: await bytes("ready"),
        pending_bytes: await bytes("pending"),
        project_count: 1,
        version_count: 3,
        library_count: 1,
        import_count: 1,
        trash_count: 2,
      });
      expect(usage.pending_bytes).not.toBe(0);
    });
  });

  describe("confirm_asset", () => {
    it("marks the asset ready once the object exists with the reserved size, and answers the row", async () => {
      const owner = await t.createUser();
      const content = uniqueContent("confirm");
      const reservation = await t.reserve(owner, content);
      await t.putObject(owner, reservation.object_path, content.length);
      const answer = await confirm(owner, reservation.asset_id);
      expect(answer).toMatchObject({ id: reservation.asset_id, status: "ready" });
      expect(answer.ready_at).not.toBeNull();
      // the answer is the row itself, as JSON
      const stored = one(await t.admin<{ row: Record<string, unknown> } & Row>("select to_jsonb(a) as row from public.assets a where id = $1", [
        reservation.asset_id,
      ]));
      expect(answer).toEqual(stored.row);
    });

    it("is idempotent for a ready asset", async () => {
      const owner = await t.createUser();
      const id = await t.upload(owner, uniqueContent("idempotent"));
      const before = await assetRow(id);
      const again = await confirm(owner, id);
      expect(again.status).toBe("ready");
      expect(new Date(again.ready_at ?? 0).getTime()).toBe(before.ready_at?.getTime());
    });

    it("starts the collection grace at confirmation, not at a reservation that may be hours old", async () => {
      const owner = await t.createUser();
      const content = uniqueContent("slow");
      const reservation = await t.reserve(owner, content);
      await t.admin("update public.assets set last_used_at = now() - interval '5 hours' where id = $1", [reservation.asset_id]);
      await t.putObject(owner, reservation.object_path, content.length);
      await confirm(owner, reservation.asset_id);
      expect(Date.now() - (await assetRow(reservation.asset_id)).last_used_at.getTime()).toBeLessThan(60_000);
    });

    it("answers upload_missing while nothing was stored (or it went to another bucket)", async () => {
      const owner = await t.createUser();
      const content = uniqueContent("missing");
      const reservation = await t.reserve(owner, content);
      await expectPlatformError(confirm(owner, reservation.asset_id), "upload_missing", 409, reservation.object_path);
      await t.admin("insert into storage.buckets (id, name) values ('elsewhere', 'elsewhere') on conflict do nothing");
      await t.admin("insert into storage.objects (bucket_id, name, metadata) values ('elsewhere', $1, $2)", [
        reservation.object_path,
        JSON.stringify({ size: content.length }),
      ]);
      await expectPlatformError(confirm(owner, reservation.asset_id), "upload_missing", 409);
      expect((await assetRow(reservation.asset_id)).status).toBe("pending");
    });

    it.each([
      ["a truncated upload", -1],
      ["a padded upload", 1],
      ["an upload without a recorded size", null],
    ] as const)("rejects %s: the mark survives the 409 size_mismatch", async (_label, delta) => {
      const owner = await t.createUser();
      const content = uniqueContent("mismatch");
      const reservation = await t.reserve(owner, content);
      const stored = delta === null ? null : content.length + delta;
      await t.as(user(owner), "insert into storage.objects (bucket_id, name, metadata) values ('user-content', $1, $2)", [
        reservation.object_path,
        stored === null ? null : JSON.stringify({ size: stored }),
      ]);
      // what PostgREST sees: a committed transaction, response.status 409 and its own error body
      const answer = one(
        await t.as<{ body: unknown; status: string } & Row>(
          user(owner),
          `with answer as materialized (select public.confirm_asset($1) as body)
           select body, current_setting('response.status', true) as status from answer`,
          [reservation.asset_id],
        ),
      );
      expect(answer).toEqual({
        status: "409",
        body: {
          code: "PT409",
          message: "size_mismatch",
          details: `stored ${stored ?? 0} bytes, reserved ${content.length}`,
          hint: null,
        },
      });
      expect((await assetRow(reservation.asset_id)).status).toBe("rejected");
      // confirming again changes nothing (nothing can be stored meanwhile): reserving it again is the way back
      await expectPlatformError(confirm(owner, reservation.asset_id), "size_mismatch", 409, `stored ${stored ?? 0} bytes, reserved ${content.length}`);
      expect((await assetRow(reservation.asset_id)).status).toBe("rejected");
    });

    it("takes the bytes again after a rejected upload is reserved once more", async () => {
      const owner = await t.createUser();
      const content = uniqueContent("retry");
      const reservation = await t.reserve(owner, content, "application/gzip");
      await t.putObject(owner, reservation.object_path, content.length + 3);
      await expectPlatformError(confirm(owner, reservation.asset_id), "size_mismatch", 409, `stored ${content.length + 3} bytes, reserved ${content.length}`);
      const again = await t.reserve(owner, content, "application/json; charset=utf-8");
      expect(again).toEqual({ asset_id: reservation.asset_id, object_path: reservation.object_path, status: "pending" });
      expect(await assetRow(reservation.asset_id)).toMatchObject({ status: "pending", mime_type: "application/json", ready_at: null });
      // the upload is replaced while the reservation is pending again
      await t.as(user(owner), "update storage.objects set metadata = $2 where name = $1", [
        reservation.object_path,
        JSON.stringify({ size: content.length }),
      ]);
      expect((await confirm(owner, reservation.asset_id)).status).toBe("ready");
    });

    it("answers not_found for another account's asset or an unknown id", async () => {
      const owner = await t.createUser();
      const other = await t.createUser();
      const content = uniqueContent("foreign");
      const reservation = await t.reserve(owner, content);
      await t.putObject(owner, reservation.object_path, content.length);
      await expectPlatformError(confirm(other, reservation.asset_id), "not_found", 404, "asset");
      await expectPlatformError(confirm(other, "00000000-0000-4000-8000-000000000000"), "not_found", 404);
      await expectPlatformError(confirm(owner, null), "not_found", 404);
      expect((await assetRow(reservation.asset_id)).status).toBe("pending");
    });
  });

  describe("collection states", () => {
    it("answers asset_busy while the bytes are being collected: reserving, confirming and referencing them", async () => {
      const owner = await t.createUser();
      const content = uniqueContent("busy");
      const stored = await readyAsset(t, owner);
      const id = await t.upload(owner, content);
      const pending = await pendingAsset(t, owner);
      await t.admin("update public.assets set status = 'deleting' where id = any($1::uuid[])", [[id, pending.id]]);
      await expectPlatformError(t.reserve(owner, content), "asset_busy", 409, "being collected");
      await expectPlatformError(confirm(owner, id), "asset_busy", 409, "being collected");
      await expectPlatformError(confirm(owner, pending.id), "asset_busy", 409, "being collected");
      const busy: AssetRef = { id, size: content.length, sha: sha256(content) };
      await expectPlatformError(createProject(t, owner, { snapshot: busy, thumbnail: false }), "asset_busy", 409, "snapshot_asset_id");
      const { project } = await createProject(t, owner, { snapshot: stored, thumbnail: false });
      await expectPlatformError(commitVersion(t, owner, project.id, { snapshot: busy }), "asset_busy", 409, "snapshot_asset_id");
      await expectPlatformError(
        commitVersion(t, owner, project.id, { attachments: [{ name: "part.bin", asset_id: id }] }),
        "asset_busy",
        409,
        "attachment part.bin",
      );
      await expectPlatformError(createLibraryItem(t, owner, { files: [{ filename: "a.glb", asset_id: id }] }), "asset_busy", 409, "a.glb");
      await expectPlatformError(createImportedObject(t, owner, { original: busy }), "asset_busy", 409, "original_asset_id");
      await expectPlatformError(t.as(user(owner), "update public.profiles set avatar_asset_id = $1", [id]), "asset_busy", 409, "avatar_asset_id");
      expect((await assetRow(id)).status).toBe("deleting");
      expect((await assetRow(pending.id)).status).toBe("deleting");
    });

    it("counts every row against the quota until it is collected, whatever its state", async () => {
      const owner = await t.createUser();
      await t.setPlan(owner, { storageQuotaBytes: 100, maxFileBytes: 100 });
      await readyAsset(t, owner, { size: 20 });
      const collected = await readyAsset(t, owner, { size: 20 });
      await t.admin("update public.assets set status = 'deleting' where id = $1", [collected.id]);
      await reserveRaw(owner, "1".repeat(64), 20, "text/plain");
      const rejected = one(await reserveRaw(owner, "2".repeat(64), 20, "text/plain"));
      await t.putObject(owner, rejected.object_path, 19, "text/plain");
      await expectPlatformError(confirm(owner, rejected.asset_id), "size_mismatch", 409);
      await expectPlatformError(reserveRaw(owner, "3".repeat(64), 21, "text/plain"), "quota_exceeded", 413, "80 of 100 bytes used");
      // used + pending is exactly what the quota counts
      expect(await usageOf(owner)).toMatchObject({ used_bytes: 40, pending_bytes: 40, storage_quota_bytes: 100 });
      expect(one(await reserveRaw(owner, "3".repeat(64), 20, "text/plain")).status).toBe("pending");
      // reserving the rejected bytes again adds nothing: they were counted all along
      expect(one(await reserveRaw(owner, "2".repeat(64), 20, "text/plain")).status).toBe("pending");
      expect(await usageOf(owner)).toMatchObject({ used_bytes: 40, pending_bytes: 60 });
    });

    it("allows at most 8 uploads in progress per account", async () => {
      const owner = await t.createUser();
      const other = await t.createUser();
      const stored = await readyAsset(t, owner);
      const inProgress: AssetRef[] = [];
      for (let index = 0; index < 8; index += 1) inProgress.push(await pendingAsset(t, owner));
      const [first, second, third, fourth] = inProgress as [AssetRef, AssetRef, AssetRef, AssetRef];
      await expectPlatformError(pendingAsset(t, owner), "limit_reached", 403, "at most 8 unfinished uploads per account");
      // no new slot needed: a stored file (dedup), a reservation already in progress, another account
      expect(one(await reserveRaw(owner, stored.sha, stored.size, "application/gzip")).status).toBe("ready");
      expect(one(await reserveRaw(owner, first.sha, first.size, "application/gzip")).status).toBe("pending");
      await pendingAsset(t, other);
      // a confirmed upload frees its slot
      await t.putObject(owner, pathOf(owner, first), first.size);
      await confirm(owner, first.id);
      await pendingAsset(t, owner);
      await expectPlatformError(pendingAsset(t, owner), "limit_reached", 403);
      // so does a rejected one, and reserving it again takes a slot again
      await t.putObject(owner, pathOf(owner, second), second.size + 1);
      await expectPlatformError(confirm(owner, second.id), "size_mismatch", 409);
      await pendingAsset(t, owner);
      await expectPlatformError(reserveRaw(owner, second.sha, second.size, "application/gzip"), "limit_reached", 403);
      // a reservation left alone for an hour stops counting (collection takes it after six), and renewing it takes a slot
      await t.admin("update public.assets set last_used_at = now() - interval '61 minutes' where id = $1", [third.id]);
      await pendingAsset(t, owner);
      await expectPlatformError(reserveRaw(owner, third.sha, third.size, "application/gzip"), "limit_reached", 403);
      await t.admin("update public.assets set last_used_at = now() - interval '61 minutes' where id = $1", [fourth.id]);
      expect(one(await reserveRaw(owner, third.sha, third.size, "application/gzip")).status).toBe("pending");
      const counts = await t.admin<{ status: string; n: number } & Row>(
        "select status, count(*)::int as n from public.assets where owner_id = $1 group by status order by status",
        [owner],
      );
      expect(counts).toEqual([
        // eight in progress, and the fourth, which stopped counting
        { status: "pending", n: 9 },
        { status: "ready", n: 2 },
        { status: "rejected", n: 1 },
      ]);
      const active = await t.admin<{ n: number } & Row>(
        "select count(*)::int as n from public.assets where owner_id = $1 and status = 'pending' and last_used_at > now() - interval '1 hour'",
        [owner],
      );
      expect(one(active).n).toBe(8);
    });
  });
});
