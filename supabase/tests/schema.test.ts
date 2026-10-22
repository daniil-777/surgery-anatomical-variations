// The privilege model as a whole, checked from the catalog: which roles can touch which tables, columns and functions,
// that every table has row level security with policies for signed-in users only, that every function pins its
// search_path, and that the database's error codes are the ones the client understands. Run under both default-
// privilege models (legacy auto-grants and the newer "nothing implicit"), so the migrations never depend on either.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  anon,
  createTestDb,
  expectDenied,
  expectPlatformError,
  migrationFiles,
  readMigration,
  service,
  user,
  type Row,
  type TestDb,
} from "./support/db";
import { clientLiterals, createProject, one, readyAsset } from "./support/fixtures";

// PGlite is fast, but a busy CI runner is not: database tests get explicit headroom.
vi.setConfig({ testTimeout: 30_000 });

const TABLES = [
  "plans",
  "profiles",
  "assets",
  "projects",
  "project_versions",
  "project_version_assets",
  "project_draft_assets",
  "library_items",
  "library_item_files",
  "imported_objects",
];

const AUTHENTICATED_FUNCTIONS = [
  "public.commit_version(uuid, uuid, bigint, text, uuid, text, text, uuid, integer, text, jsonb)",
  "public.confirm_asset(uuid)",
  "public.create_imported_object(text, text, uuid, text, text, text, uuid, uuid, jsonb, text[])",
  "public.create_library_item(text, text, jsonb, text, text[], text, uuid, uuid, jsonb, uuid)",
  "public.create_project(text, text, uuid, text, uuid, integer, text, jsonb, text)",
  "public.delete_version(uuid)",
  "public.discard_draft(uuid, bigint)",
  "public.duplicate_project(uuid, text, uuid)",
  "public.label_version(uuid, text)",
  "public.my_usage()",
  "public.reserve_asset(text, bigint, text)",
  "public.restore_version(uuid, uuid, uuid, bigint)",
  "public.save_draft(uuid, uuid, bigint, uuid, text, uuid, jsonb, integer, text)",
  "public.username_available(text)",
];

const SERVICE_FUNCTIONS = [
  "public.admin_set_profile(uuid, text, text, text)",
  "public.admin_upsert_plan(text, text, bigint, bigint, integer, integer)",
  "public.claim_login_attempt(text[], integer)",
  "public.login_failures(text[])",
  "public.maintenance_finish_assets(uuid[])",
  "public.maintenance_forget_assets(uuid[], interval, interval, timestamp with time zone)",
  "public.maintenance_orphan_assets(integer, interval, interval, timestamp with time zone)",
  "public.maintenance_orphan_objects(integer, interval, timestamp with time zone)",
  "public.maintenance_run(timestamp with time zone)",
  "public.note_login_attempt(text[], boolean)",
  "public.resolve_login_email(text)",
];

// Pure validators that CHECK constraints call: whoever writes the row needs EXECUTE on them.
const CHECK_VALIDATORS = [
  "private.is_allowed_mime(text)",
  "private.is_valid_username(text)",
  "private.valid_tags(text[])",
];

const UPDATABLE_COLUMNS = [
  "imported_objects.detected_by",
  "imported_objects.favorite",
  "imported_objects.source_app",
  "imported_objects.tags",
  "imported_objects.title",
  "imported_objects.trashed_at",
  "library_items.description",
  "library_items.favorite",
  "library_items.tags",
  "library_items.title",
  "library_items.trashed_at",
  "profiles.appearance",
  "profiles.avatar_asset_id",
  "profiles.display_name",
  "profiles.username",
  "projects.description",
  "projects.favorite",
  "projects.opened_at",
  "projects.title",
  "projects.trashed_at",
];

const POLICY_COMMANDS: Record<string, string[]> = {
  "public.assets": ["SELECT"],
  "public.imported_objects": ["DELETE", "SELECT", "UPDATE"],
  "public.library_item_files": ["SELECT"],
  "public.library_items": ["DELETE", "SELECT", "UPDATE"],
  "public.plans": ["SELECT"],
  "public.profiles": ["SELECT", "UPDATE"],
  "public.project_draft_assets": ["SELECT"],
  "public.project_version_assets": ["SELECT"],
  "public.project_versions": ["SELECT"],
  "public.projects": ["DELETE", "SELECT", "UPDATE"],
  "storage.objects": ["INSERT", "SELECT", "UPDATE"],
};

// Every code the database raises (raise_error) or answers (error_response) and the HTTP status PostgREST answers with
// (SQLSTATE PT<status>, or response.status).
const ERROR_STATUS: Record<string, number> = {
  asset_busy: 409,
  asset_not_ready: 409,
  draft_conflict: 409,
  file_too_large: 413,
  invalid_input: 422,
  limit_reached: 403,
  not_authenticated: 401,
  not_found: 404,
  project_trashed: 409,
  quota_exceeded: 413,
  size_mismatch: 409,
  upload_missing: 409,
  version_conflict: 409,
};

interface FunctionRow extends Row {
  signature: string;
  schema: string;
  anon: boolean;
  authenticated: boolean;
  service_role: boolean;
  definer: boolean;
  config: string[] | null;
}

async function functions(t: TestDb): Promise<FunctionRow[]> {
  return t.admin<FunctionRow>(`
    select format('%s.%s(%s)', n.nspname, p.proname, oidvectortypes(p.proargtypes)) as signature,
           n.nspname as schema,
           has_function_privilege('anon', p.oid, 'execute') as anon,
           has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
           has_function_privilege('service_role', p.oid, 'execute') as service_role,
           p.prosecdef as definer,
           p.proconfig as config
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private')
     order by 1`);
}

describe.each([
  { mode: "legacy default privileges (auto-exposed)", autoExpose: true },
  { mode: "no implicit privileges", autoExpose: false },
])("privilege model with $mode", ({ autoExpose }) => {
  let t: TestDb;

  beforeAll(async () => {
    t = await createTestDb({ autoExpose });
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  it("gives anon nothing but username_available", async () => {
    const rows = await functions(t);
    expect(rows.filter((row) => row.anon).map((row) => row.signature)).toEqual(["public.username_available(text)"]);
    const tables = await t.admin<{ privileges: number } & Row>(
      `select count(*)::int as privileges
         from unnest($1::text[]) as tbl,
              unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) as priv
        where has_table_privilege('anon', 'public.' || tbl, priv)`,
      [TABLES],
    );
    expect(one(tables).privileges).toBe(0);
    const columns = await t.admin(
      `select 1 from information_schema.columns c
        where c.table_schema = 'public'
          and (has_column_privilege('anon', format('public.%I', c.table_name), c.column_name, 'select')
               or has_column_privilege('anon', format('public.%I', c.table_name), c.column_name, 'update')
               or has_column_privilege('anon', format('public.%I', c.table_name), c.column_name, 'insert'))`,
    );
    expect(columns).toEqual([]);
  });

  it("lets signed-in users execute exactly the app RPCs and the CHECK validators", async () => {
    const rows = await functions(t);
    expect(rows.filter((row) => row.schema === "public" && row.authenticated).map((row) => row.signature)).toEqual(
      AUTHENTICATED_FUNCTIONS,
    );
    expect(rows.filter((row) => row.schema === "private" && row.authenticated).map((row) => row.signature)).toEqual(
      CHECK_VALIDATORS,
    );
  });

  it("grants the service role every service function explicitly", async () => {
    const rows = await functions(t);
    const service = rows.filter((row) => row.service_role).map((row) => row.signature);
    expect(service).toEqual(expect.arrayContaining([...SERVICE_FUNCTIONS, ...CHECK_VALIDATORS]));
    for (const signature of SERVICE_FUNCTIONS) {
      const row = rows.find((candidate) => candidate.signature === signature);
      expect(row?.authenticated, signature).toBe(false);
      expect(row?.anon, signature).toBe(false);
    }
  });

  it("gives signed-in users read access, column-level updates and deletes on three tables only", async () => {
    const privileges = await t.admin<{ tbl: string; priv: string } & Row>(
      `select tbl, priv
         from unnest($1::text[]) as tbl,
              unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) as priv
        where has_table_privilege('authenticated', 'public.' || tbl, priv)
        order by 1, 2`,
      [TABLES],
    );
    const expected = [
      ...TABLES.map((tbl) => ({ tbl, priv: "select" })),
      { tbl: "imported_objects", priv: "delete" },
      { tbl: "library_items", priv: "delete" },
      { tbl: "projects", priv: "delete" },
    ].sort((a, b) => (a.tbl === b.tbl ? a.priv.localeCompare(b.priv) : a.tbl.localeCompare(b.tbl)));
    expect(privileges).toEqual(expected);

    const updatable = await t.admin<{ col: string } & Row>(
      `select c.table_name || '.' || c.column_name as col
         from information_schema.columns c
        where c.table_schema = 'public'
          and has_column_privilege('authenticated', format('public.%I', c.table_name), c.column_name, 'update')
        order by 1`,
    );
    expect(updatable.map((row) => row.col)).toEqual(UPDATABLE_COLUMNS);
    const insertable = await t.admin(
      `select 1 from information_schema.columns c
        where c.table_schema = 'public'
          and has_column_privilege('authenticated', format('public.%I', c.table_name), c.column_name, 'insert')`,
    );
    expect(insertable).toEqual([]);
  });

  it("lets the service role read asset paths, as the account-delete function does through the Data API", async () => {
    const owner = await t.createUser();
    await readyAsset(t, owner);
    await readyAsset(t, owner);
    const paths = await t.as<{ object_path: string } & Row>(
      service,
      "select object_path from public.assets where owner_id = $1 and object_path > '' order by object_path limit 100",
      [owner],
    );
    expect(paths).toHaveLength(2);
    for (const row of paths) expect(row.object_path.startsWith(`${owner}/`)).toBe(true);
  });

  it("starts every function a later migration adds closed to the API roles", async () => {
    await t.db.exec(`
      create function public.later_rpc() returns integer language sql as 'select 1';
      create function private.later_helper() returns integer language sql as 'select 1';`);
    const later = await t.admin<{ fn: string; anon: boolean; authenticated: boolean } & Row>(
      `select p.oid::regprocedure::text as fn,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authenticated
         from pg_proc p where p.proname in ('later_rpc', 'later_helper') order by 1`,
    );
    expect(later.map(({ anon, authenticated }) => ({ anon, authenticated }))).toEqual([
      { anon: false, authenticated: false },
      { anon: false, authenticated: false },
    ]);
    await t.db.exec("drop function public.later_rpc(); drop function private.later_helper();");
  });

  it("keeps the private schema closed to the API roles", async () => {
    const [usage] = await t.admin<{ anon: boolean; authenticated: boolean } & Row>(
      `select has_schema_privilege('anon', 'private', 'usage') as anon,
              has_schema_privilege('authenticated', 'private', 'usage') as authenticated`,
    );
    expect(usage).toEqual({ anon: false, authenticated: false });
    const attempts = await t.admin(
      `select 1 where has_table_privilege('authenticated', 'private.login_attempts', 'select')
                   or has_table_privilege('anon', 'private.login_attempts', 'select')`,
    );
    expect(attempts).toEqual([]);
  });

  it("works end to end through the explicit grants alone", async () => {
    const owner = await t.createUser({ metadata: { username: `smoke${autoExpose ? "a" : "b"}` } });
    const { project } = await createProject(t, owner);
    await t.as(user(owner), "update public.profiles set display_name = 'Smoke Test', appearance = 'dark'");
    await t.as(user(owner), "update public.projects set title = 'Renamed', favorite = true where id = $1", [project.id]);
    const usage = one(await t.as<{ usage: Record<string, unknown> } & Row>(user(owner), "select public.my_usage() as usage"));
    expect(usage.usage.project_count).toBe(1);
    expect(one(await t.as(anon, "select public.username_available('free-name') as ok"))).toEqual({ ok: true });
    const run = one(await t.as<{ result: Record<string, number> } & Row>(service, "select public.maintenance_run() as result"));
    expect(run.result.versions_pruned).toBe(0);
    await expectDenied(t.as(user(owner), "select public.maintenance_run()"));
  });
});

describe("structure", () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  it("enables row level security on every public table", async () => {
    const rows = await t.admin<{ relname: string; rls: boolean; kind: string } & Row>(
      `select c.relname, c.relrowsecurity as rls, c.relkind::text as kind
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
        order by 1`,
    );
    expect(rows.map((row) => row.relname).sort()).toEqual([...TABLES].sort());
    for (const row of rows) {
      expect(row.kind, row.relname).toBe("r");
      expect(row.rls, row.relname).toBe(true);
    }
  });

  it("writes policies for signed-in users only, with no delete policy on storage", async () => {
    const rows = await t.admin<{ tbl: string; cmd: string; roles: string[] } & Row>(
      `select schemaname || '.' || tablename as tbl, cmd, roles::text[] as roles
         from pg_policies where schemaname in ('public', 'storage') order by 1, 2`,
    );
    const commands: Record<string, string[]> = {};
    for (const row of rows) {
      expect(row.roles, `${row.tbl} ${row.cmd}`).toEqual(["authenticated"]);
      expect(row.cmd, row.tbl).not.toBe("ALL");
      (commands[row.tbl] ??= []).push(row.cmd);
    }
    expect(commands).toEqual(POLICY_COMMANDS);
  });

  it("pins search_path on every function and runs every public function as its definer", async () => {
    const rows = await functions(t);
    expect(rows.length).toBeGreaterThan(20);
    for (const row of rows) {
      expect(row.config ?? [], row.signature).toContain('search_path=""');
      if (row.schema === "public") expect(row.definer, row.signature).toBe(true);
    }
    const privateDefiners = rows.filter((row) => row.schema === "private" && row.definer).map((row) => row.signature);
    expect(privateDefiners).toEqual([
      "private.check_profile_avatar()",
      "private.check_project_untrash()",
      "private.handle_new_user()",
    ]);
  });

  it("keeps the user-content bucket private, limited to 50 MB and free of active content types", async () => {
    const bucket = one(
      await t.admin<{ public: boolean; file_size_limit: number; allowed_mime_types: string[] } & Row>(
        "select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'user-content'",
      ),
    );
    expect(bucket.public).toBe(false);
    expect(bucket.file_size_limit).toBe(52428800);
    for (const mime of bucket.allowed_mime_types) {
      expect(mime).not.toMatch(/html|svg|xml|javascript|ecmascript/);
    }
    // the bucket and the asset table accept exactly the same types
    const mismatches = await t.admin(
      "select m from unnest($1::text[]) as m where not private.is_allowed_mime(m)",
      [bucket.allowed_mime_types],
    );
    expect(mismatches).toEqual([]);
    const assetOnly = await t.admin<{ m: string } & Row>(
      `select m from unnest(array['text/html', 'image/svg+xml', 'application/xml', 'text/javascript',
                                  'application/javascript', 'application/xhtml+xml']) as m
        where private.is_allowed_mime(m)`,
    );
    expect(assetOnly).toEqual([]);
  });

  it("accepts in every enumerated column exactly the values the client's types declare", async () => {
    // Asset rows also pass through states the upload protocol never hands to a client (reserve answers pending or
    // ready, confirm answers ready): stored with another size, and being collected. They may appear in the client's
    // AssetStatus too; the database must not accept anything beyond the two sets together.
    const serverOnly: Record<string, string[]> = { AssetStatus: ["rejected", "deleting"] };
    const columns: Array<[string, string, string]> = [
      ["Appearance", "profiles", "appearance"],
      ["AssetStatus", "assets", "status"],
      ["VersionKind", "project_versions", "kind"],
      ["LibraryKind", "library_items", "kind"],
      ["LibraryFileRole", "library_item_files", "role"],
      ["SourceApp", "imported_objects", "source_app"],
      ["DetectedBy", "imported_objects", "detected_by"],
      ["ImportFormat", "imported_objects", "format"],
    ];
    for (const [typeName, table, column] of columns) {
      const definitions = await t.admin<{ def: string } & Row>(
        `select pg_get_constraintdef(c.oid) as def
           from pg_constraint c
           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
          where c.contype = 'c' and c.conrelid = $1::regclass and a.attname = $2 and cardinality(c.conkey) = 1`,
        [`public.${table}`, column],
      );
      const def = one(definitions, `check constraint on ${table}.${column}`).def;
      const values = [...def.matchAll(/'([^']+)'::text/g)].map((match) => match[1] ?? "");
      const expected = [...new Set([...clientLiterals(typeName), ...(serverOnly[typeName] ?? [])])].sort();
      expect(values.sort(), `${table}.${column} vs ${typeName}`).toEqual(expected);
    }
    const bucket = one(
      await t.admin<{ types: string[] } & Row>("select allowed_mime_types as types from storage.buckets where id = 'user-content'"),
    );
    expect([...bucket.types].sort()).toEqual(clientLiterals("ALLOWED_MIME_TYPES").sort());
  });

  it("seeds the free, owner and pro plans with the documented limits", async () => {
    const plans = await t.admin(
      `select id, storage_quota_bytes, max_file_bytes, version_retention_days, max_projects
         from public.plans where id in ('free', 'owner', 'pro') order by id`,
    );
    // DESIGN.md §15.16: free 250 MB, owner 800 MB with a 365-day history (both 50 MB per file)
    expect(plans).toEqual([
      { id: "free", storage_quota_bytes: 262144000, max_file_bytes: 52428800, version_retention_days: 30, max_projects: 100 },
      { id: "owner", storage_quota_bytes: 838860800, max_file_bytes: 52428800, version_retention_days: 365, max_projects: 1000 },
      { id: "pro", storage_quota_bytes: 21474836480, max_file_bytes: 1073741824, version_retention_days: 180, max_projects: 10000 },
    ]);
  });

  it("re-applies cleanly: plan rows and the bucket are upserts", async () => {
    // `supabase db push` never re-runs a migration, but the seed-like statements must not depend on that
    await t.admin("update public.plans set title = 'Changed' where id = 'free'");
    await t.admin(
      `insert into public.plans (id, title, storage_quota_bytes, max_file_bytes, version_retention_days, max_projects)
       values ('free', 'Free', 262144000, 52428800, 30, 100)
       on conflict (id) do update set title = excluded.title`,
    );
    expect(one(await t.admin("select title from public.plans where id = 'free'"))).toEqual({ title: "Free" });
  });
});

describe("error contract", () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  it("raises only codes the client knows, each always with the same HTTP status", () => {
    const clientCodes = new Set(clientLiterals("PlatformErrorCode"));
    expect(clientCodes.size).toBeGreaterThan(10);

    const raised = new Map<string, Set<number>>();
    for (const name of migrationFiles()) {
      for (const match of readMigration(name).matchAll(/(?:raise_error|error_response)\('([a-z_]+)',\s*(\d{3})/g)) {
        const code = match[1] ?? "";
        const statuses = raised.get(code) ?? new Set<number>();
        statuses.add(Number(match[2]));
        raised.set(code, statuses);
      }
    }
    expect([...raised.keys()].sort()).toEqual(Object.keys(ERROR_STATUS).sort());
    for (const [code, statuses] of raised) {
      expect(clientCodes.has(code), `${code} is a PlatformErrorCode`).toBe(true);
      expect([...statuses], code).toEqual([ERROR_STATUS[code]]);
    }
  });

  it("answers a token without a subject with PT401 not_authenticated", async () => {
    await expectPlatformError(
      t.asClaims("authenticated", { role: "authenticated" }, "select public.my_usage()"),
      "not_authenticated",
      401,
    );
    await expectPlatformError(
      t.asClaims("authenticated", { role: "authenticated", sub: "" }, "select * from public.reserve_asset($1, 1, 'text/plain')", [
        "a".repeat(64),
      ]),
      "not_authenticated",
      401,
    );
  });

  it("answers a token for a deleted account with PT404 rather than acting on nobody's behalf", async () => {
    const ghost = await t.createUser();
    await t.admin("delete from auth.users where id = $1", [ghost]);
    await expectPlatformError(t.as(user(ghost), "select public.my_usage()"), "not_found", 404);
    await expectPlatformError(
      t.as(user(ghost), "select * from public.reserve_asset($1, 10, 'text/plain')", ["b".repeat(64)]),
      "not_found",
      404,
    );
  });

  it("maps each platform error to its PostgREST status", async () => {
    const owner = await t.createUser();
    const other = await t.createUser();
    const { project } = await createProject(t, owner);
    const asset = await readyAsset(t, owner);
    await t.setPlan(owner, { maxProjects: 1, maxFileBytes: 100, storageQuotaBytes: 100_000 });
    await expectPlatformError(
      t.as(user(owner), "select * from public.save_draft($1, null, 0, $2, $3)", [project.id, asset.id, "c".repeat(64)]),
      "version_conflict",
      409,
    );
    await expectPlatformError(
      t.as(user(owner), "select * from public.reserve_asset($1, 101, 'text/plain')", ["d".repeat(64)]),
      "file_too_large",
      413,
    );
    await expectPlatformError(t.as(user(other), "select * from public.confirm_asset($1)", [asset.id]), "not_found", 404);
    await expectPlatformError(
      t.as(user(owner), "select * from public.reserve_asset('nope', 1, 'text/plain')"),
      "invalid_input",
      422,
    );
    await expectPlatformError(
      t.as(user(owner), "select * from public.duplicate_project($1, 'Copy')", [project.id]),
      "limit_reached",
      403,
    );
  });
});
