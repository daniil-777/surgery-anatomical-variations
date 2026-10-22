// The service-role surface used by the Edge Functions: username sign-in helpers with their throttle, the provisioning
// RPC, and maintenance (version retention, 30-day trash purge, two-phase collection of orphan assets with a grace per
// state and a re-check under the owner's lock, orphan Storage objects). Maintenance acts on the whole database, so each
// maintenance test starts from a fresh database.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { anon, createTestDb, expectDenied, expectPlatformError, service, sha256, user, type Row, type TestDb } from "./support/db";
import {
  commitVersion,
  createImportedObject,
  createLibraryItem,
  createProject,
  getProject,
  one,
  pendingAsset,
  readyAsset,
  saveDraft,
  trash,
  type AssetRef,
} from "./support/fixtures";

// PGlite is fast, but a busy CI runner is not: database tests get explicit headroom.
vi.setConfig({ testTimeout: 30_000 });

// "$1" is the id of an existing account.
const SERVICE_CALLS = [
  "select public.resolve_login_email('someone')",
  "select public.login_failures(array['u:someone'])",
  "select public.note_login_attempt(array['u:someone'], false)",
  "select public.claim_login_attempt(array['u:someone'], 5)",
  "select * from public.admin_set_profile($1)",
  "select * from public.admin_upsert_plan('probe_plan', 'Probe', 1000, 100, 7, 2)",
  "select public.maintenance_run()",
  "select * from public.maintenance_orphan_assets()",
  "select * from public.maintenance_forget_assets(array[]::uuid[])",
  "select * from public.maintenance_finish_assets(array[]::uuid[])",
  "select * from public.maintenance_orphan_objects()",
];

interface MaintenanceResult {
  versions_pruned: number;
  projects_purged: number;
  library_items_purged: number;
  imports_purged: number;
  login_windows_dropped: number;
}

/** A timestamp `days` from the database's clock, as maintenance's p_now. */
async function daysFromNow(t: TestDb, days: number): Promise<string> {
  return one(await t.admin<{ at: string } & Row>("select (now() + make_interval(days => $1))::text as at", [days])).at;
}

async function runMaintenance(t: TestDb, days: number): Promise<MaintenanceResult> {
  const at = await daysFromNow(t, days);
  return one(await t.as<{ result: MaintenanceResult } & Row>(service, "select public.maintenance_run($1) as result", [at])).result;
}

/** A timestamp `minutes` from the database's clock. */
async function minutesFromNow(t: TestDb, minutes: number): Promise<string> {
  return one(await t.admin<{ at: string } & Row>("select (now() + make_interval(mins => $1))::text as at", [minutes])).at;
}

/** maintenance_orphan_assets at `minutes` from now, in the function's order. */
async function orphans(t: TestDb, minutes: number, extra = ""): Promise<string[]> {
  const at = await minutesFromNow(t, minutes);
  const rows = await t.as<{ asset_id: string } & Row>(
    service,
    `select asset_id from public.maintenance_orphan_assets(p_now => $1${extra})`,
    [at],
  );
  return rows.map((row) => row.asset_id);
}

/** Phase 1 at `minutes` from now: the ids it marked 'deleting' (and returned), sorted. */
async function forget(t: TestDb, ids: string[], minutes = 0): Promise<Array<{ asset_id: string; object_path: string }>> {
  const at = await minutesFromNow(t, minutes);
  const rows = await t.as<{ asset_id: string; object_path: string } & Row>(
    service,
    "select asset_id, object_path from public.maintenance_forget_assets($1::uuid[], p_now => $2)",
    [ids, at],
  );
  return rows.sort((a, b) => a.asset_id.localeCompare(b.asset_id));
}

/** Phase 2: the ids whose rows it dropped, sorted. */
async function finish(t: TestDb, ids: string[]): Promise<string[]> {
  const rows = await t.as<{ asset_id: string } & Row>(service, "select asset_id from public.maintenance_finish_assets($1::uuid[])", [ids]);
  return rows.map((row) => row.asset_id).sort();
}

/** What the maintenance function does with a batch: mark, remove the objects through the Storage API, finish. */
async function collect(t: TestDb, ids: string[], minutes = 0): Promise<string[]> {
  const marked = await forget(t, ids, minutes);
  await t.removeObjects(marked.map((row) => row.object_path));
  return finish(
    t,
    marked.map((row) => row.asset_id),
  );
}

const MINUTES = { hour: 60, sixHours: 6 * 60, day: 24 * 60 };

describe("service-only functions", () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  it.each(SERVICE_CALLS)("refuses anon, signed-in users and forged claims: %s", async (sql) => {
    const id = await t.createUser();
    const params = sql.includes("$1") ? [id] : [];
    await expectDenied(t.as(anon, sql, params));
    await expectDenied(t.as(user(id), sql, params));
    // the database role decides, never a claim inside the token
    await expectDenied(t.asClaims("authenticated", { sub: id, role: "service_role" }, sql, params));
    await expectDenied(t.asClaims("anon", { role: "service_role" }, sql, params));
    await t.as(service, sql, params);
  });

  it("keeps the private schema out of reach of the API roles", async () => {
    const id = await t.createUser();
    await expectDenied(t.as(user(id), "select * from private.login_attempts"));
    await expectDenied(t.as(user(id), "select private.raise_error('not_found', 404)"));
    await expectDenied(t.as(anon, "select private.require_uid()"));
  });

  it("resolves the email behind a username, ignoring case and surrounding spaces", async () => {
    await t.createUser({ email: "sign-in@example.test", metadata: { username: "sign-in-name" } });
    const resolve = async (name: string | null) =>
      one(await t.as<{ email: string | null } & Row>(service, "select public.resolve_login_email($1) as email", [name])).email;
    expect(await resolve("sign-in-name")).toBe("sign-in@example.test");
    expect(await resolve("  Sign-In-Name ")).toBe("sign-in@example.test");
    expect(await resolve("nobody-here")).toBeNull();
    expect(await resolve(null)).toBeNull();
  });

  describe("login throttle", () => {
    const failures = async (keys: Array<string | null>) =>
      one(await t.as<{ n: number } & Row>(service, "select public.login_failures($1) as n", [keys])).n;
    const note = (keys: Array<string | null>, success: boolean) =>
      t.as(service, "select public.note_login_attempt($1, $2)", [keys, success]);

    it("counts failures per key in the current window and reports the worst key", async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) await note(["u:throttled", "ip:203.0.113.7"], false);
      await note(["u:other-user"], false);
      expect(await failures(["u:throttled"])).toBe(3);
      expect(await failures(["ip:203.0.113.7"])).toBe(3);
      expect(await failures(["u:other-user", "ip:203.0.113.7"])).toBe(3);
      expect(await failures(["u:other-user"])).toBe(1);
      expect(await failures(["u:never-seen"])).toBe(0);
      expect(await failures([])).toBe(0);
      expect(one(await t.as<{ n: number } & Row>(service, "select public.login_failures(null) as n")).n).toBe(0);
    });

    it("clears a username's counter on success but keeps the shared address's", async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) await note(["u:recovers", "ip:198.51.100.9"], false);
      await note(["u:recovers", "ip:198.51.100.9"], true);
      expect(await failures(["u:recovers"])).toBe(0);
      expect(await failures(["ip:198.51.100.9"])).toBe(2);
    });

    it("skips blank, oversized and null keys", async () => {
      await note(["", "k".repeat(201), null, `u:${"k".repeat(198)}`], false);
      const keys = await t.admin<{ key: string } & Row>("select key from private.login_attempts where key not like 'u:%' or key like 'u:kkk%'");
      expect(keys.map((row) => row.key)).not.toContain("");
      expect(keys.map((row) => row.key)).toContain(`u:${"k".repeat(198)}`);
      expect(await t.admin("select 1 from private.login_attempts where char_length(key) > 200")).toEqual([]);
    });

    it("counts only the current 15-minute window; a success clears every window of that username", async () => {
      await t.admin(
        `insert into private.login_attempts (key, window_start, failures)
         values ('u:window', date_bin(interval '15 minutes', now(), timestamptz '2000-01-01') - interval '15 minutes', 9)`,
      );
      expect(await failures(["u:window"])).toBe(0);
      await note(["u:window"], false);
      expect(await failures(["u:window"])).toBe(1);
      await note(["u:window"], true);
      expect(await t.admin("select 1 from private.login_attempts where key = 'u:window'")).toEqual([]);
    });
  });
});

describe("claim_login_attempt", () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  interface Claim {
    allowed: boolean;
    attempts: number;
    retry_after_seconds: number;
  }
  const claim = async (keys: Array<string | null> | null, limit: number | null) =>
    one(await t.as<{ c: Claim } & Row>(service, "select public.claim_login_attempt($1, $2) as c", [keys, limit])).c;

  it("counts every attempt before the password check and locks a key past the limit until its window ends", async () => {
    const keys = ["u:claimant", "ip:192.0.2.10"];
    for (const attempts of [1, 2, 3]) {
      expect(await claim(keys, 3)).toEqual({ allowed: true, attempts, retry_after_seconds: 0 });
    }
    const locked = await claim(keys, 3);
    expect(locked.allowed).toBe(false);
    expect(locked.attempts).toBe(4);
    expect(locked.retry_after_seconds).toBeGreaterThanOrEqual(1);
    expect(locked.retry_after_seconds).toBeLessThanOrEqual(900);
    // the same counters login_failures reads
    expect(one(await t.as<{ n: number } & Row>(service, "select public.login_failures($1) as n", [["u:claimant"]])).n).toBe(4);
    // a successful sign-in clears the username, never the shared address
    await t.as(service, "select public.note_login_attempt($1, true)", [keys]);
    expect(await claim(["u:claimant"], 3)).toEqual({ allowed: true, attempts: 1, retry_after_seconds: 0 });
    expect((await claim(["ip:192.0.2.10"], 3)).allowed).toBe(false);
  });

  it("counts each key once per claim and skips blank, oversized and null keys", async () => {
    expect(await claim(["u:twice", "u:twice", "", null, "k".repeat(201)], 5)).toEqual({
      allowed: true,
      attempts: 1,
      retry_after_seconds: 0,
    });
    expect(await t.admin("select key, failures from private.login_attempts where key = 'u:twice'")).toEqual([{ key: "u:twice", failures: 1 }]);
    expect(await t.admin("select 1 from private.login_attempts where key = '' or char_length(key) > 200")).toEqual([]);
    expect(await claim([], 1)).toEqual({ allowed: true, attempts: 0, retry_after_seconds: 0 });
    expect(await claim(null, 1)).toEqual({ allowed: true, attempts: 0, retry_after_seconds: 0 });
  });

  it("needs a positive limit", async () => {
    await expectPlatformError(claim(["u:limitless"], 0), "invalid_input", 422, "limit");
    await expectPlatformError(claim(["u:limitless"], null), "invalid_input", 422, "limit");
    expect(await t.admin("select 1 from private.login_attempts where key = 'u:limitless'")).toEqual([]);
  });
});

describe("admin_set_profile", () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  const setProfile = (id: string | null, plan: string | null, username: string | null, displayName: string | null) =>
    t.as<Row>(service, "select * from public.admin_set_profile($1, $2, $3, $4)", [id, plan, username, displayName]);

  it("sets the owner's plan, username and display name for the provisioning script", async () => {
    const id = await t.createUser({ email: "owner@example.test" });
    const profile = one(await setProfile(id, "owner", "  Owner.Name ", " Owner Name  "));
    expect(profile).toMatchObject({ id, plan_id: "owner", username: "owner.name", display_name: "Owner Name" });
    const usage = one(await t.as<{ u: Record<string, unknown> } & Row>(user(id), "select public.my_usage() as u")).u;
    expect(usage).toMatchObject({ plan_id: "owner", storage_quota_bytes: 838860800, version_retention_days: 365 });
    // null or blank keeps every field; re-asserting the own username is fine
    expect(one(await setProfile(id, null, "", "   "))).toMatchObject({ plan_id: "owner", username: "owner.name", display_name: "Owner Name" });
    expect(one(await setProfile(id, "free", "owner.name", null))).toMatchObject({ plan_id: "free", username: "owner.name" });
  });

  it("refuses unknown plans and accounts, invalid or taken usernames and over-long names", async () => {
    const id = await t.createUser();
    await t.createUser({ metadata: { username: "already-taken" } });
    await expectPlatformError(setProfile(id, "platinum", null, null), "not_found", 404, "plan");
    await expectPlatformError(setProfile("00000000-0000-4000-8000-000000000000", "free", null, null), "not_found", 404, "profile");
    await expectPlatformError(setProfile(null, "free", null, null), "not_found", 404, "profile");
    await expectPlatformError(setProfile(id, null, "ab", null), "invalid_input", 422, "username");
    await expectPlatformError(setProfile(id, null, "admin", null), "invalid_input", 422, "username");
    await expectPlatformError(setProfile(id, null, "Already-Taken", null), "invalid_input", 422, "username taken");
    await expectPlatformError(setProfile(id, null, null, "x".repeat(81)), "invalid_input", 422, "display_name");
    expect(one(await t.admin("select plan_id, username, display_name from public.profiles where id = $1", [id]))).toEqual({
      plan_id: "free",
      username: null,
      display_name: null,
    });
  });
});

describe("admin_upsert_plan", () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  const upsert = (args: unknown[]) => t.as<Row>(service, "select * from public.admin_upsert_plan($1, $2, $3, $4, $5, $6)", args);

  it("creates a plan, changes it in place, and every account on it gets the new limits at once", async () => {
    expect(one(await upsert(["contract_tiny", "  Contract  ", 3000, 1000, 1, 2]))).toMatchObject({
      id: "contract_tiny",
      title: "Contract",
      storage_quota_bytes: 3000,
      max_file_bytes: 1000,
      version_retention_days: 1,
      max_projects: 2,
    });
    const id = await t.createUser();
    await t.as(service, "select * from public.admin_set_profile($1, 'contract_tiny')", [id]);
    await expectPlatformError(
      t.as(user(id), "select * from public.reserve_asset($1, 1001, 'text/plain')", ["a".repeat(64)]),
      "file_too_large",
      413,
    );
    expect(one(await upsert(["contract_tiny", "Contract", 3000, 2000, 1, 2]))).toMatchObject({ max_file_bytes: 2000 });
    expect(one(await t.as<{ status: string } & Row>(user(id), "select * from public.reserve_asset($1, 1001, 'text/plain')", ["a".repeat(64)])).status).toBe("pending");
    const usage = one(await t.as<{ u: Record<string, unknown> } & Row>(user(id), "select public.my_usage() as u")).u;
    expect(usage).toMatchObject({ plan_id: "contract_tiny", plan_title: "Contract", max_file_bytes: 2000 });
  });

  it.each([
    ["id", [null, "T", 1, 1, 1, 1]],
    ["id", ["Upper", "T", 1, 1, 1, 1]],
    ["id", ["x", "T", 1, 1, 1, 1]],
    ["title", ["plan_a", "   ", 1, 1, 1, 1]],
    ["title", ["plan_a", "x".repeat(61), 1, 1, 1, 1]],
    ["storage_quota_bytes", ["plan_a", "T", 0, 1, 1, 1]],
    ["max_file_bytes", ["plan_a", "T", 1, null, 1, 1]],
    ["version_retention_days", ["plan_a", "T", 1, 1, 0, 1]],
    ["version_retention_days", ["plan_a", "T", 1, 1, 3651, 1]],
    ["max_projects", ["plan_a", "T", 1, 1, 1, -1]],
  ] as const)("refuses an invalid %s", async (field, args) => {
    await expectPlatformError(upsert([...args]), "invalid_input", 422, field);
    expect(await t.admin("select 1 from public.plans where id = 'plan_a'")).toEqual([]);
  });
});

describe("maintenance", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
  }, 60_000);
  afterEach(async () => {
    await t.close();
  });

  describe("maintenance_run", () => {
    it("prunes unnamed, non-head versions older than the plan's window beyond the newest five", async () => {
      const free = await t.createUser();
      const pro = await t.createUser();
      await t.admin("update public.profiles set plan_id = 'pro' where id = $1", [pro]);
      const build = async (owner: string) => {
        const { project, head } = await createProject(t, owner);
        const versions = [head];
        for (let index = 0; index < 9; index += 1) versions.push((await commitVersion(t, owner, project.id)).version);
        return { project, versions };
      };
      const freeProject = await build(free);
      const proProject = await build(pro);
      const small = await createProject(t, free);
      const [v1, v2, v3, v4, v5, v6] = freeProject.versions;
      await t.as(user(free), "select * from public.label_version($1, 'Keep me')", [v2?.id]);
      const linked = await createLibraryItem(t, free, { sourceProjectId: freeProject.project.id, sourceVersionId: v3?.id ?? null });

      expect(await runMaintenance(t, 29)).toMatchObject({ versions_pruned: 0 });
      expect(await runMaintenance(t, 31)).toEqual({
        versions_pruned: 4,
        projects_purged: 0,
        library_items_purged: 0,
        imports_purged: 0,
        login_windows_dropped: 0,
      });
      const kept = await t.admin<{ seq: number } & Row>(
        "select seq from public.project_versions where project_id = $1 order by seq",
        [freeProject.project.id],
      );
      expect(kept.map((row) => row.seq)).toEqual([2, 6, 7, 8, 9, 10]);
      for (const gone of [v1, v4, v5]) {
        expect(await t.admin("select 1 from public.project_versions where id = $1", [gone?.id])).toEqual([]);
      }
      expect(one(await t.admin("select parent_version_id from public.project_versions where id = $1", [v6?.id]))).toEqual({
        parent_version_id: null,
      });
      expect(one(await t.admin("select source_version_id from public.library_items where id = $1", [linked.id]))).toEqual({
        source_version_id: null,
      });
      // the pro plan keeps 180 days; a project with five or fewer versions keeps them all
      expect(await t.admin("select 1 from public.project_versions where project_id = $1", [proProject.project.id])).toHaveLength(10);
      expect(await t.admin("select 1 from public.project_versions where project_id = $1", [small.project.id])).toHaveLength(1);
      expect((await getProject(t, freeProject.project.id)).head_seq).toBe(10);
      // after 180 days the pro project's five oldest (all unnamed) go too
      expect(await runMaintenance(t, 181)).toMatchObject({ versions_pruned: 5 });
    });

    it("purges what has been in the trash for 30 days, with everything inside it", async () => {
      const owner = await t.createUser();
      const kept = await createProject(t, owner);
      const doomed = await createProject(t, owner);
      await commitVersion(t, owner, doomed.project.id);
      await saveDraft(t, owner, doomed.project.id);
      const item = await createLibraryItem(t, owner, { sourceProjectId: doomed.project.id, sourceVersionId: doomed.head.id });
      const trashedItem = await createLibraryItem(t, owner, { title: "Trashed" });
      const imported = await createImportedObject(t, owner);
      const trashedImport = await createImportedObject(t, owner, { title: "Trashed" });
      await trash(t, owner, "projects", doomed.project.id);
      await trash(t, owner, "library_items", trashedItem.id);
      await trash(t, owner, "imported_objects", trashedImport.id);

      expect(await runMaintenance(t, 29)).toMatchObject({ projects_purged: 0, library_items_purged: 0, imports_purged: 0 });
      expect(await runMaintenance(t, 31)).toMatchObject({ projects_purged: 1, library_items_purged: 1, imports_purged: 1 });
      expect(await t.admin("select 1 from public.projects where id = $1", [doomed.project.id])).toEqual([]);
      expect(await t.admin("select 1 from public.project_versions where project_id = $1", [doomed.project.id])).toEqual([]);
      expect(await t.admin("select 1 from public.project_draft_assets where project_id = $1", [doomed.project.id])).toEqual([]);
      expect(await t.admin("select 1 from public.library_item_files where item_id = $1", [trashedItem.id])).toEqual([]);
      expect(await t.admin("select 1 from public.imported_objects where id = $1", [trashedImport.id])).toEqual([]);
      for (const [table, id] of [
        ["projects", kept.project.id],
        ["library_items", item.id],
        ["imported_objects", imported.id],
      ] as const) {
        expect(await t.admin(`select 1 from public.${table} where id = $1`, [id])).toHaveLength(1);
      }
      expect(one(await t.admin("select source_project_id, source_version_id from public.library_items where id = $1", [item.id]))).toEqual({
        source_project_id: null,
        source_version_id: null,
      });
    });

    it("drops login windows older than a day", async () => {
      await t.admin(
        `insert into private.login_attempts (key, window_start, failures)
         values ('u:old', now() - interval '2 days', 3), ('u:recent', now() - interval '2 hours', 3)`,
      );
      expect((await runMaintenance(t, 0)).login_windows_dropped).toBe(1);
      expect(await t.admin<{ key: string } & Row>("select key from private.login_attempts")).toEqual([{ key: "u:recent" }]);
    });
  });

  describe("orphan assets", () => {
    const statusOf = async (id: string) =>
      (await t.admin<{ status: string } & Row>("select status from public.assets where id = $1", [id]))[0]?.status ?? null;
    const objectExists = async (path: string) =>
      (await t.admin("select 1 from storage.objects where bucket_id = 'user-content' and name = $1", [path])).length === 1;
    const pathOf = (owner: string, asset: AssetRef) => `${owner}/${asset.sha.slice(0, 2)}/${asset.sha}`;

    it("lists unreferenced assets by state: ready after an hour, pending after six, rejected at once, deleting first", async () => {
      const owner = await t.createUser();
      const { snapshot } = await createProject(t, owner, { thumbnail: false });
      const loose = await readyAsset(t, owner, { size: 64 });
      const pending = await pendingAsset(t, owner);
      const rejected = await pendingAsset(t, owner);
      await t.putObject(owner, pathOf(owner, rejected), rejected.size + 1);
      await expectPlatformError(t.confirm(owner, rejected.id), "size_mismatch", 409);
      const stuck = await readyAsset(t, owner);
      await t.admin("update public.assets set status = 'deleting' where id = $1", [stuck.id]);

      expect(await orphans(t, 0)).toEqual([stuck.id, rejected.id]);
      expect(await orphans(t, MINUTES.hour - 1)).toEqual([stuck.id, rejected.id]);
      expect(await orphans(t, MINUTES.hour + 1)).toEqual([stuck.id, loose.id, pending.id, rejected.id].filter((id) => id !== pending.id));
      expect(await orphans(t, MINUTES.sixHours + 1)).toEqual([stuck.id, loose.id, pending.id, rejected.id]);
      expect(await orphans(t, MINUTES.day)).not.toContain(snapshot.id);
      const detail = one(
        await t.as<{ asset_id: string; object_path: string; byte_size: number; status: string } & Row>(
          service,
          "select * from public.maintenance_orphan_assets(p_now => now() + interval '2 hours') where asset_id = $1",
          [loose.id],
        ),
      );
      expect(detail).toEqual({ asset_id: loose.id, object_path: pathOf(owner, loose), byte_size: 64, status: "ready" });
      // the graces are parameters with those defaults
      expect(await orphans(t, 0, ", p_ready_grace => interval '0 seconds'")).toContain(loose.id);
      expect(await orphans(t, 0, ", p_pending_grace => interval '0 seconds'")).toContain(pending.id);
      expect(await orphans(t, 30, ", p_ready_grace => interval '20 minutes'")).toContain(loose.id);
      expect(await orphans(t, MINUTES.sixHours + 1, ", p_limit => 0")).toEqual([stuck.id]);
      expect(await orphans(t, MINUTES.sixHours + 1, ", p_limit => null")).toHaveLength(4);
    });

    it("restarts the grace when the file is reserved again or confirmed", async () => {
      const owner = await t.createUser();
      const content = `reused-${owner}`;
      const id = await t.upload(owner, content);
      await t.admin("update public.assets set last_used_at = now() - interval '3 days' where id = $1", [id]);
      expect(await orphans(t, 0)).toEqual([id]);
      await t.reserve(owner, content);
      expect(await orphans(t, 0)).toEqual([]);
      expect(await orphans(t, MINUTES.hour + 1)).toEqual([id]);
    });

    it("counts every column that references an asset", async () => {
      const owner = await t.createUser();
      // one row in every table that can point at an asset
      const part = await readyAsset(t, owner);
      const { project } = await createProject(t, owner, { attachments: [{ name: "part.bin", asset_id: part.id }] });
      await saveDraft(t, owner, project.id, {
        thumbnail: await readyAsset(t, owner, { mime: "image/webp" }),
        attachments: [{ name: "part.bin", asset_id: part.id }],
      });
      await createLibraryItem(t, owner, { thumbnail: await readyAsset(t, owner, { mime: "image/webp" }) });
      await createImportedObject(t, owner, {
        display: await readyAsset(t, owner, { mime: "model/gltf-binary" }),
        thumbnail: await readyAsset(t, owner, { mime: "image/webp" }),
      });
      await t.as(user(owner), "update public.profiles set avatar_asset_id = $1", [(await readyAsset(t, owner, { mime: "image/png" })).id]);

      const references = await t.admin<{ tbl: string; col: string } & Row>(
        `select c.conrelid::regclass::text as tbl, a.attname::text as col
           from pg_constraint c
           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
          where c.contype = 'f' and c.confrelid = 'public.assets'::regclass
          order by 1, 2`,
      );
      expect(references).toHaveLength(13);
      for (const { tbl, col } of references) {
        const table = tbl.replace(/^public\./, "");
        const probe: AssetRef = await readyAsset(t, owner, { mime: "image/png" });
        await t.admin("update public.assets set last_used_at = now() - interval '3 days' where id = $1", [probe.id]);
        expect(await orphans(t, 0), `${table}.${col}: baseline`).toContain(probe.id);

        const [target] = await t.admin<{ ctid: string; previous: string | null } & Row>(
          `select ctid::text as ctid, ${col}::text as previous from public.${table} where ${table === "profiles" ? "id" : "owner_id"} = $1 limit 1`,
          [owner],
        );
        if (!target) throw new Error(`no ${table} row to point at the probe`);
        await t.admin(`update public.${table} set ${col} = $1 where ctid = $2::tid`, [probe.id, target.ctid]);
        expect(await orphans(t, 0), `${table}.${col} must count as a reference`).not.toContain(probe.id);
        expect(await forget(t, [probe.id]), `${table}.${col} must survive forget`).toEqual([]);
        expect(await statusOf(probe.id)).toBe("ready");
        await t.admin(`update public.${table} set ${col} = $1 where ${col} = $2`, [target.previous, probe.id]);
      }
    });

    it("marks only candidates still collectable under the owner's lock, and leaves the objects to the Storage API", async () => {
      const owner = await t.createUser();
      const orphan = await readyAsset(t, owner);
      const used = await readyAsset(t, owner);
      const racing = await readyAsset(t, owner);
      const reserved = await readyAsset(t, owner);
      await createProject(t, owner, { snapshot: used, thumbnail: false });
      await t.admin("update public.assets set last_used_at = now() - interval '3 days' where id = any($1::uuid[])", [
        [orphan.id, used.id, racing.id, reserved.id],
      ]);
      const candidates = await orphans(t, 0);
      expect([...candidates].sort()).toEqual([orphan.id, racing.id, reserved.id].sort());
      // between listing and forgetting, the user uses one candidate and reserves the bytes of another again
      await createProject(t, owner, { snapshot: racing, thumbnail: false });
      expect(one(await t.as<{ status: string } & Row>(user(owner), "select * from public.reserve_asset($1, $2, 'application/gzip')", [reserved.sha, reserved.size])).status).toBe("ready");
      const fresh = await readyAsset(t, owner);

      expect(await forget(t, [...candidates, used.id, fresh.id, "00000000-0000-4000-8000-000000000000"])).toEqual([
        { asset_id: orphan.id, object_path: pathOf(owner, orphan) },
      ]);
      expect(await statusOf(orphan.id)).toBe("deleting");
      for (const kept of [used, racing, reserved, fresh]) expect(await statusOf(kept.id)).toBe("ready");
      // the bytes stay until the caller removes them through the Storage API; the row until finish
      expect(await objectExists(pathOf(owner, orphan))).toBe(true);
      expect(await forget(t, [])).toEqual([]);
      expect(await t.as(service, "select * from public.maintenance_forget_assets(null)")).toEqual([]);
    });

    it("drops only rows still marked deleting, once their objects are gone", async () => {
      const owner = await t.createUser();
      const doomed = await readyAsset(t, owner);
      const alive = await readyAsset(t, owner);
      await t.admin("update public.assets set last_used_at = now() - interval '3 days' where id = $1", [doomed.id]);
      expect(await forget(t, [doomed.id])).toHaveLength(1);
      await t.removeObjects([pathOf(owner, doomed)]);
      const dropped = await t.as<{ asset_id: string; object_path: string } & Row>(
        service,
        "select * from public.maintenance_finish_assets($1::uuid[])",
        [[doomed.id, alive.id, "00000000-0000-4000-8000-000000000000"]],
      );
      expect(dropped).toEqual([{ asset_id: doomed.id, object_path: pathOf(owner, doomed) }]);
      expect(await statusOf(doomed.id)).toBeNull();
      expect(await statusOf(alive.id)).toBe("ready");
      expect(await finish(t, [doomed.id])).toEqual([]);
      expect(await t.as(service, "select * from public.maintenance_finish_assets(null)")).toEqual([]);
    });

    it("never loses bytes reserved again during a collection: asset_busy until the row is gone, then a fresh upload", async () => {
      const owner = await t.createUser();
      const content = `collected-${owner}`;
      const old = { id: await t.upload(owner, content), size: content.length, sha: sha256(content) };
      await t.admin("update public.assets set last_used_at = now() - interval '2 hours' where id = $1", [old.id]);
      const [marked] = await forget(t, await orphans(t, 0));
      expect(marked?.asset_id).toBe(old.id);

      // the same bytes come back while the object is being removed: every way in answers asset_busy
      await expectPlatformError(t.reserve(owner, content), "asset_busy", 409, "being collected");
      await expectPlatformError(t.confirm(owner, old.id), "asset_busy", 409);
      await expectPlatformError(createProject(t, owner, { snapshot: old, thumbnail: false }), "asset_busy", 409, "snapshot_asset_id");
      expect(await objectExists(pathOf(owner, old))).toBe(true);

      await t.removeObjects([pathOf(owner, old)]);
      expect(await finish(t, [old.id])).toEqual([old.id]);
      // now a reservation starts afresh: a new row at the same address, uploaded and confirmed again
      const again = await t.reserve(owner, content);
      expect(again.asset_id).not.toBe(old.id);
      expect(again).toMatchObject({ object_path: pathOf(owner, old), status: "pending" });
      await t.putObject(owner, again.object_path, content.length);
      expect((await t.confirm(owner, again.asset_id)).status).toBe("ready");
      await createProject(t, owner, { snapshot: { ...old, id: again.asset_id }, thumbnail: false });

      // a late finish for the old id, or another full pass, never touches the new asset or its bytes
      expect(await finish(t, [old.id, again.asset_id])).toEqual([]);
      expect(await collect(t, await orphans(t, MINUTES.day))).toEqual([]);
      expect(await statusOf(again.asset_id)).toBe("ready");
      expect(await objectExists(pathOf(owner, old))).toBe(true);
    });

    it("repeats an interrupted collection: rows left deleting are listed first and finished by the next run", async () => {
      const owner = await t.createUser();
      const first = await readyAsset(t, owner);
      const second = await readyAsset(t, owner);
      await t.admin("update public.assets set last_used_at = now() - interval '2 hours' where id = any($1::uuid[])", [[first.id, second.id]]);
      // a run marks both and dies before removing anything
      expect(await forget(t, [first.id, second.id])).toHaveLength(2);
      // the next run finds them first, even before their grace would have passed, and finishes the job
      expect((await orphans(t, -MINUTES.day)).sort()).toEqual([first.id, second.id].sort());
      expect(await collect(t, await orphans(t, 0))).toEqual([first.id, second.id].sort());
      expect(await objectExists(pathOf(owner, first))).toBe(false);
      expect(await objectExists(pathOf(owner, second))).toBe(false);
    });

    it("keeps a rejected upload that was reserved again before the collection got to it", async () => {
      const owner = await t.createUser();
      const content = `rejected-${owner}`;
      const reservation = await t.reserve(owner, content);
      await t.putObject(owner, reservation.object_path, content.length + 1);
      await expectPlatformError(t.confirm(owner, reservation.asset_id), "size_mismatch", 409);
      const candidates = await orphans(t, 0);
      expect(candidates).toEqual([reservation.asset_id]);
      await t.reserve(owner, content);
      expect(await forget(t, candidates)).toEqual([]);
      expect(await statusOf(reservation.asset_id)).toBe("pending");
      // left alone, it is collected at once
      const other = await t.reserve(owner, `${content}-2`);
      await t.putObject(owner, other.object_path, 1);
      await expectPlatformError(t.confirm(owner, other.asset_id), "size_mismatch", 409);
      expect(await collect(t, await orphans(t, 0))).toEqual([other.asset_id]);
      expect(await objectExists(other.object_path)).toBe(false);
    });

    it("keeps counting the quota while a reservation is being collected, and frees it once the row is gone", async () => {
      const owner = await t.createUser();
      await t.setPlan(owner, { storageQuotaBytes: 100, maxFileBytes: 100 });
      const stuck = await t.as<{ asset_id: string } & Row>(user(owner), "select * from public.reserve_asset($1, 100, 'text/plain')", [
        "a".repeat(64),
      ]);
      const id = one(stuck).asset_id;
      const tooMuch = () => t.as(user(owner), "select * from public.reserve_asset($1, 1, 'text/plain')", ["c".repeat(64)]);
      await expectPlatformError(tooMuch(), "quota_exceeded", 413);
      expect(await orphans(t, MINUTES.sixHours - 1)).toEqual([]);
      expect(await forget(t, [id], MINUTES.sixHours + 1)).toHaveLength(1);
      await expectPlatformError(tooMuch(), "quota_exceeded", 413, "100 of 100 bytes used");
      expect(await finish(t, [id])).toEqual([id]);
      const again = await t.as<{ status: string } & Row>(user(owner), "select * from public.reserve_asset($1, 100, 'text/plain')", [
        "b".repeat(64),
      ]);
      expect(one(again).status).toBe("pending");
    });

    it("keeps a marked row that somehow gained a reference instead of failing the whole batch", async () => {
      const owner = await t.createUser();
      const { project } = await createProject(t, owner, { thumbnail: false });
      const [first, second] = [await readyAsset(t, owner), await readyAsset(t, owner)];
      await t.admin("update public.assets set last_used_at = now() - interval '2 hours' where id = any($1::uuid[])", [[first.id, second.id]]);
      expect(await forget(t, [first.id, second.id])).toHaveLength(2);
      // only possible by bypassing the RPCs (they refuse rows being collected), but finish must stay safe
      await t.admin("update public.projects set thumbnail_asset_id = $1 where id = $2", [first.id, project.id]);
      expect(await finish(t, [first.id, second.id])).toEqual([second.id]);
      expect(await statusOf(first.id)).toBe("deleting");
    });
  });

  describe("orphan objects", () => {
    it("lists stored objects no asset row describes, after the grace period, in user-content only", async () => {
      const owner = await t.createUser();
      const described = await readyAsset(t, owner);
      const forgotten = await readyAsset(t, owner);
      await t.admin("update public.assets set last_used_at = now() - interval '3 days' where id = $1", [forgotten.id]);
      // a collection whose Storage removal never happened: the row is gone, the object is left over
      const [marked] = await forget(t, [forgotten.id]);
      const forgottenPath = marked?.object_path;
      expect(await finish(t, [forgotten.id])).toEqual([forgotten.id]);
      await t.admin("insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true)");
      await t.admin("insert into storage.objects (bucket_id, name) values ('avatars', 'loose/face.png')");
      const list = async (days: number, extra = "") => {
        const at = await daysFromNow(t, days);
        const rows = await t.as<{ object_name: string } & Row>(
          service,
          `select object_name from public.maintenance_orphan_objects(p_now => $1${extra})`,
          [at],
        );
        return rows.map((row) => row.object_name);
      };
      expect(await list(0)).toEqual([]);
      expect(await list(2)).toEqual([forgottenPath]);
      expect(await list(2)).not.toContain(`${owner}/${described.sha.slice(0, 2)}/${described.sha}`);
      expect(await list(2, ", p_limit => 0")).toHaveLength(1);
    });

    it("picks up every object of a deleted account, whose rows all cascade away", async () => {
      const owner = await t.createUser();
      const bystander = await t.createUser();
      const part = await readyAsset(t, owner);
      const { project } = await createProject(t, owner, { attachments: [{ name: "part.bin", asset_id: part.id }] });
      await commitVersion(t, owner, project.id);
      await saveDraft(t, owner, project.id, { attachments: [{ name: "part.bin", asset_id: part.id }] });
      await createLibraryItem(t, owner, { sourceProjectId: project.id, thumbnail: await readyAsset(t, owner, { mime: "image/webp" }) });
      await createImportedObject(t, owner, { display: await readyAsset(t, owner, { mime: "model/gltf-binary" }) });
      const avatar = await readyAsset(t, owner, { mime: "image/png" });
      await t.as(user(owner), "update public.profiles set avatar_asset_id = $1", [avatar.id]);
      await pendingAsset(t, owner);
      const keep = await createProject(t, bystander);

      const objects = await t.admin<{ name: string } & Row>("select name from storage.objects where name like $1 order by name", [`${owner}/%`]);
      expect(objects.length).toBeGreaterThan(5);
      await t.admin("delete from auth.users where id = $1", [owner]);
      for (const table of [
        "profiles",
        "assets",
        "projects",
        "project_versions",
        "project_version_assets",
        "project_draft_assets",
        "library_items",
        "library_item_files",
        "imported_objects",
      ]) {
        const column = table === "profiles" ? "id" : "owner_id";
        expect(await t.admin(`select 1 from public.${table} where ${column} = $1`, [owner]), table).toEqual([]);
      }
      const at = await daysFromNow(t, 2);
      const listed = await t.as<{ object_name: string } & Row>(
        service,
        "select object_name from public.maintenance_orphan_objects(p_now => $1) order by 1",
        [at],
      );
      expect(listed.map((row) => row.object_name)).toEqual(objects.map((row) => row.name));
      expect((await getProject(t, keep.project.id)).owner_id).toBe(bystander);
    });
  });
});
