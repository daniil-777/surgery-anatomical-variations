// Account isolation, table by table: anon is refused outright, the owner sees and edits only what the grants allow,
// and a second account can neither see, change, delete nor reference anything of the first, whatever it tries
// (direct SQL through the Data API roles, or the RPCs with the other account's ids).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { anon, createTestDb, expectDenied, expectPlatformError, user, type Row, type TestDb } from "./support/db";
import {
  commitVersion,
  createImportedObject,
  createLibraryItem,
  createProject,
  getProject,
  one,
  readyAsset,
  saveDraft,
  stateHash,
  trash,
  type AssetRef,
  type ImportedObjectRow,
  type LibraryItemRow,
  type ProjectRow,
  type VersionRow,
} from "./support/fixtures";

// PGlite is fast, but a busy CI runner is not: database tests get explicit headroom.
vi.setConfig({ testTimeout: 30_000 });

interface Account {
  id: string;
  project: ProjectRow;
  version: VersionRow;
  item: LibraryItemRow;
  imported: ImportedObjectRow;
  snapshot: AssetRef;
  attachment: AssetRef;
  trashed: Record<"projects" | "library_items" | "imported_objects", string>;
}

async function buildAccount(t: TestDb, name: string): Promise<Account> {
  const id = await t.createUser({ metadata: { username: name, display_name: name } });
  const attachment = await readyAsset(t, id, { mime: "application/octet-stream", label: "sculpt" });
  const attachments = [{ name: "sculpt.bin", asset_id: attachment.id }];
  const created = await createProject(t, id, { attachments });
  const { version } = await commitVersion(t, id, created.project.id, { attachments });
  await saveDraft(t, id, created.project.id, { attachments });
  const avatar = await readyAsset(t, id, { mime: "image/png", label: "avatar" });
  await t.as(user(id), "update public.profiles set avatar_asset_id = $1", [avatar.id]);
  const thumbnail = await readyAsset(t, id, { mime: "image/webp" });
  const item = await createLibraryItem(t, id, {
    thumbnail,
    sourceProjectId: created.project.id,
    sourceVersionId: version.id,
  });
  const display = await readyAsset(t, id, { mime: "model/gltf-binary" });
  const imported = await createImportedObject(t, id, { display, thumbnail });

  const oldProject = (await createProject(t, id, { title: "Old study" })).project;
  await trash(t, id, "projects", oldProject.id);
  const oldItem = await createLibraryItem(t, id, { title: "Old shape" });
  await trash(t, id, "library_items", oldItem.id);
  const oldImport = await createImportedObject(t, id, { title: "Old import" });
  await trash(t, id, "imported_objects", oldImport.id);

  return {
    id,
    project: await getProject(t, created.project.id),
    version,
    item,
    imported,
    snapshot: created.snapshot,
    attachment,
    trashed: { projects: oldProject.id, library_items: oldItem.id, imported_objects: oldImport.id },
  };
}

interface TableSpec {
  table: string;
  /** Column holding the owning account. */
  owner: string;
  /** A SET clause the owner may run, or null when the table has no client updates. */
  allowedUpdate: string | null;
  /** SET clauses that must be refused (columns without an update grant). */
  deniedUpdates: string[];
  deletable: boolean;
}

const TABLES: TableSpec[] = [
  {
    table: "profiles",
    owner: "id",
    allowedUpdate: "appearance = 'dark'",
    deniedUpdates: ["id = gen_random_uuid()", "plan_id = 'pro'", "created_at = now()", "updated_at = now()"],
    deletable: false,
  },
  {
    table: "assets",
    owner: "owner_id",
    allowedUpdate: null,
    deniedUpdates: [
      "status = 'ready'",
      "owner_id = owner_id",
      "byte_size = 1",
      "sha256 = sha256",
      "mime_type = 'text/plain'",
      "object_path = object_path",
      "last_used_at = now()",
    ],
    deletable: false,
  },
  {
    table: "projects",
    owner: "owner_id",
    allowedUpdate: "favorite = not favorite",
    deniedUpdates: [
      "owner_id = gen_random_uuid()",
      "lab_id = 'tissue'",
      "head_version_id = null",
      "head_seq = 99",
      "draft_asset_id = null",
      "draft_state_sha256 = null",
      "draft_rev = 0",
      "draft_saved_at = now()",
      "draft_thumbnail_asset_id = null",
      "thumbnail_asset_id = null",
      "created_at = now()",
      "updated_at = now()",
    ],
    deletable: true,
  },
  {
    table: "project_versions",
    owner: "owner_id",
    allowedUpdate: null,
    deniedUpdates: [
      "label = 'kept'",
      "seq = seq + 1",
      "kind = 'named'",
      "snapshot_asset_id = snapshot_asset_id",
      "state_sha256 = state_sha256",
      "owner_id = owner_id",
      "project_id = project_id",
      "byte_size = 0",
      "created_at = now()",
    ],
    deletable: false,
  },
  {
    table: "project_version_assets",
    owner: "owner_id",
    allowedUpdate: null,
    deniedUpdates: ["asset_id = asset_id", "name = 'other.bin'", "owner_id = owner_id", "version_id = version_id"],
    deletable: false,
  },
  {
    table: "project_draft_assets",
    owner: "owner_id",
    allowedUpdate: null,
    deniedUpdates: ["asset_id = asset_id", "name = 'other.bin'", "owner_id = owner_id", "project_id = project_id"],
    deletable: false,
  },
  {
    table: "library_items",
    owner: "owner_id",
    allowedUpdate: "favorite = not favorite",
    deniedUpdates: [
      "owner_id = gen_random_uuid()",
      "kind = 'image'",
      "lab_id = null",
      "metadata = '{}'",
      "thumbnail_asset_id = null",
      "source_project_id = null",
      "source_version_id = null",
      "byte_size = 0",
      "created_at = now()",
      "updated_at = now()",
    ],
    deletable: true,
  },
  {
    table: "library_item_files",
    owner: "owner_id",
    allowedUpdate: null,
    deniedUpdates: [
      "asset_id = asset_id",
      "filename = 'renamed.glb'",
      "role = 'other'",
      "position = 1",
      "owner_id = owner_id",
      "item_id = item_id",
    ],
    deletable: false,
  },
  {
    table: "imported_objects",
    owner: "owner_id",
    allowedUpdate: "favorite = not favorite",
    deniedUpdates: [
      "owner_id = gen_random_uuid()",
      "format = 'glb'",
      "original_asset_id = original_asset_id",
      "display_asset_id = null",
      "thumbnail_asset_id = null",
      "source_detail = 'Maya'",
      "stats = '{}'",
      "byte_size = 0",
      "created_at = now()",
      "updated_at = now()",
    ],
    deletable: true,
  },
];

describe("row level security", () => {
  let t: TestDb;
  let a: Account;
  let b: Account;

  async function ownedCount(table: string, ownerColumn: string, owner: string): Promise<number> {
    return one(
      await t.admin<{ n: number } & Row>(`select count(*)::int as n from public.${table} where ${ownerColumn} = $1`, [owner]),
    ).n;
  }

  beforeAll(async () => {
    t = await createTestDb();
    a = await buildAccount(t, "alice");
    b = await buildAccount(t, "bob");
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  describe("anon", () => {
    it.each([...TABLES.map((spec) => [spec.table, spec.owner]), ["plans", "id"]])(
      "cannot select, insert, update or delete %s",
      async (table, column) => {
        await expectDenied(t.as(anon, `select * from public.${table} limit 1`));
        await expectDenied(t.as(anon, `select count(*) from public.${table}`));
        await expectDenied(t.as(anon, `insert into public.${table} default values`));
        await expectDenied(t.as(anon, `update public.${table} set ${column} = ${column}`));
        await expectDenied(t.as(anon, `delete from public.${table}`));
      },
    );

    it("cannot call any app RPC", async () => {
      await expectDenied(t.as(anon, "select public.my_usage()"));
      await expectDenied(t.as(anon, "select * from public.reserve_asset($1, 1, 'text/plain')", ["a".repeat(64)]));
      await expectDenied(t.as(anon, "select * from public.create_project('organ', 'x', $1, $2)", [a.snapshot.id, stateHash("x")]));
      await expectDenied(t.as(anon, "select * from public.label_version($1, 'x')", [a.version.id]));
    });
  });

  describe.each(TABLES)("$table", (spec) => {
    it("shows the owner exactly their own rows and the other account none of them", async () => {
      const aRows = await ownedCount(spec.table, spec.owner, a.id);
      const bRows = await ownedCount(spec.table, spec.owner, b.id);
      expect(aRows).toBeGreaterThan(0);
      expect(bRows).toBeGreaterThan(0);
      const seenByA = one(await t.as<{ n: number } & Row>(user(a.id), `select count(*)::int as n from public.${spec.table}`));
      expect(seenByA.n).toBe(aRows);
      const foreign = await t.as(user(a.id), `select * from public.${spec.table} where ${spec.owner} = $1`, [b.id]);
      expect(foreign).toEqual([]);
      const foreignToB = await t.as(user(b.id), `select * from public.${spec.table} where ${spec.owner} = $1`, [a.id]);
      expect(foreignToB).toEqual([]);
    });

    it("refuses inserts, even of the owner's own row", async () => {
      await expectDenied(t.as(user(a.id), `insert into public.${spec.table} default values`));
      await expectDenied(
        t.as(user(a.id), `insert into public.${spec.table} select * from public.${spec.table} where ${spec.owner} = auth.uid() limit 1`),
      );
    });

    it("refuses updates of columns without a grant, including the owner column", async () => {
      for (const clause of spec.deniedUpdates) {
        await expectDenied(t.as(user(a.id), `update public.${spec.table} set ${clause} where ${spec.owner} = auth.uid()`));
      }
    });

    if (spec.allowedUpdate) {
      it("lets the owner update granted columns and the other account touch nothing", async () => {
        const own = await t.run(user(a.id), `update public.${spec.table} set ${spec.allowedUpdate} where ${spec.owner} = auth.uid()`);
        expect(own.affectedRows).toBe(await ownedCount(spec.table, spec.owner, a.id));
        const before = await t.admin(`select * from public.${spec.table} where ${spec.owner} = $1 order by 1`, [a.id]);
        const foreign = await t.run(
          user(b.id),
          `update public.${spec.table} set ${spec.allowedUpdate} where ${spec.owner} = $1 returning *`,
          [a.id],
        );
        expect(foreign.affectedRows).toBe(0);
        expect(foreign.rows).toEqual([]);
        expect(await t.admin(`select * from public.${spec.table} where ${spec.owner} = $1 order by 1`, [a.id])).toEqual(before);
      });
    } else {
      it("has no client updates at all", async () => {
        await expectDenied(t.as(user(a.id), `update public.${spec.table} set ${spec.owner} = ${spec.owner}`));
      });
    }

    if (!spec.deletable) {
      it("refuses deletes, even by the owner", async () => {
        await expectDenied(t.as(user(a.id), `delete from public.${spec.table} where ${spec.owner} = auth.uid()`));
        expect(await ownedCount(spec.table, spec.owner, a.id)).toBeGreaterThan(0);
      });
    }
  });

  describe("plans", () => {
    it("are readable reference data for every signed-in user and writable by nobody", async () => {
      const plans = await t.as<{ id: string } & Row>(user(b.id), "select id from public.plans order by id");
      expect(plans.map((plan) => plan.id)).toEqual(expect.arrayContaining(["free", "pro"]));
      await expectDenied(t.as(user(a.id), "update public.plans set storage_quota_bytes = 1e15 where id = 'free'"));
      await expectDenied(
        t.as(
          user(a.id),
          "insert into public.plans (id, title, storage_quota_bytes, max_file_bytes, version_retention_days, max_projects) values ('mine', 'Mine', 1, 1, 1, 1)",
        ),
      );
      await expectDenied(t.as(user(a.id), "delete from public.plans"));
    });
  });

  describe("cross-account references through the RPCs", () => {
    it("never lets B build on A's assets", async () => {
      const attachments = JSON.stringify([{ name: "sculpt.bin", asset_id: a.attachment.id }]);
      await expectPlatformError(
        t.as(user(b.id), "select * from public.create_project('organ', 'Stolen', $1, $2)", [a.snapshot.id, stateHash("s")]),
        "not_found",
        404,
      );
      const bSnapshot = await readyAsset(t, b.id);
      await expectPlatformError(
        t.as(user(b.id), "select * from public.create_project('organ', 'Stolen', $1, $2, $3)", [
          bSnapshot.id,
          stateHash("s"),
          a.attachment.id,
        ]),
        "not_found",
        404,
      );
      await expectPlatformError(
        t.as(user(b.id), "select * from public.create_project('organ', 'Stolen', $1, $2, p_attachments => $3)", [
          bSnapshot.id,
          stateHash("s"),
          attachments,
        ]),
        "not_found",
        404,
      );
      await expectPlatformError(
        t.as(user(b.id), "select public.commit_version($1, $2, $3, 'manual', $4, $5)", [
          b.project.id,
          b.project.head_version_id,
          b.project.draft_rev,
          a.snapshot.id,
          stateHash("s"),
        ]),
        "not_found",
        404,
      );
      await expectPlatformError(
        t.as(user(b.id), "select * from public.save_draft($1, $2, $3, $4, $5, null, $6)", [
          b.project.id,
          b.project.head_version_id,
          b.project.draft_rev,
          bSnapshot.id,
          stateHash("s"),
          attachments,
        ]),
        "not_found",
        404,
      );
      await expectPlatformError(
        t.as(user(b.id), "select * from public.create_library_item('shape', 'Stolen', $1)", [
          JSON.stringify([{ filename: "a.glb", asset_id: a.attachment.id }]),
        ]),
        "not_found",
        404,
      );
      await expectPlatformError(
        t.as(user(b.id), "select * from public.create_imported_object('Stolen', 'glb', $1)", [a.snapshot.id]),
        "not_found",
        404,
      );
      await expectPlatformError(
        t.as(user(b.id), "update public.profiles set avatar_asset_id = $1", [a.attachment.id]),
        "not_found",
        404,
      );
      await expectPlatformError(t.as(user(b.id), "select * from public.confirm_asset($1)", [a.snapshot.id]), "not_found", 404);
    });

    it("never lets B act on A's projects, versions or library sources", async () => {
      const bSnapshot = await readyAsset(t, b.id);
      const calls: Array<[string, unknown[]]> = [
        [
          "select * from public.save_draft($1, $2, $3, $4, $5)",
          [a.project.id, a.project.head_version_id, a.project.draft_rev, bSnapshot.id, stateHash("x")],
        ],
        ["select * from public.discard_draft($1, $2)", [a.project.id, a.project.draft_rev]],
        [
          "select public.commit_version($1, $2, $3, 'manual', $4, $5)",
          [a.project.id, a.project.head_version_id, a.project.draft_rev, bSnapshot.id, stateHash("x")],
        ],
        [
          "select public.restore_version($1, $2, $3, $4)",
          [a.project.id, a.version.id, a.project.head_version_id, a.project.draft_rev],
        ],
        [
          "select public.restore_version($1, $2, $3, $4)",
          [b.project.id, a.version.id, b.project.head_version_id, b.project.draft_rev],
        ],
        ["select * from public.label_version($1, 'Mine now')", [a.version.id]],
        ["select public.delete_version($1)", [a.version.id]],
        ["select * from public.duplicate_project($1, 'Copy')", [a.project.id]],
        ["select * from public.duplicate_project($1, 'Copy', $2)", [b.project.id, a.version.id]],
        [
          "select * from public.create_library_item('shape', 'Linked', $1, p_source_project_id => $2)",
          [JSON.stringify([{ filename: "a.glb", asset_id: bSnapshot.id }]), a.project.id],
        ],
        [
          "select * from public.create_library_item('shape', 'Linked', $1, p_source_version_id => $2)",
          [JSON.stringify([{ filename: "a.glb", asset_id: bSnapshot.id }]), a.version.id],
        ],
      ];
      for (const [sql, params] of calls) {
        await expectPlatformError(t.as(user(b.id), sql, params), "not_found", 404);
      }
      // nothing of A's moved
      const project = await getProject(t, a.project.id);
      expect(project.head_version_id).toBe(a.project.head_version_id);
      expect(project.draft_rev).toBe(a.project.draft_rev);
      expect(one(await t.admin("select label from public.project_versions where id = $1", [a.version.id]))).toEqual({ label: null });
    });

    it("keeps usage figures per account", async () => {
      const usageA = one(await t.as<{ u: Record<string, number> } & Row>(user(a.id), "select public.my_usage() as u")).u;
      const usageB = one(await t.as<{ u: Record<string, number> } & Row>(user(b.id), "select public.my_usage() as u")).u;
      const bytesA = one(
        await t.admin<{ n: number } & Row>("select sum(byte_size)::bigint as n from public.assets where owner_id = $1", [a.id]),
      ).n;
      expect(usageA.used_bytes).toBe(bytesA);
      expect(usageA.project_count).toBe(1);
      expect(usageA.trash_count).toBe(3);
      expect(usageB.project_count).toBe(1);
      expect(usageB.used_bytes).not.toBe(0);
    });
  });

  describe("deletes", () => {
    it.each(["projects", "library_items", "imported_objects"] as const)(
      "%s: only the owner, only from the trash",
      async (table) => {
        const live = table === "projects" ? a.project.id : table === "library_items" ? a.item.id : a.imported.id;
        const untrashed = await t.run(user(a.id), `delete from public.${table} where id = $1`, [live]);
        expect(untrashed.affectedRows).toBe(0);
        const byOther = await t.run(user(b.id), `delete from public.${table} where id = $1`, [a.trashed[table]]);
        expect(byOther.affectedRows).toBe(0);
        const untrashByOther = await t.run(user(b.id), `update public.${table} set trashed_at = null where id = $1`, [
          a.trashed[table],
        ]);
        expect(untrashByOther.affectedRows).toBe(0);
        expect(await t.admin(`select id from public.${table} where id = $1`, [a.trashed[table]])).toHaveLength(1);
        const own = await t.run(user(a.id), `delete from public.${table} where id = $1`, [a.trashed[table]]);
        expect(own.affectedRows).toBe(1);
        expect(await t.admin(`select id from public.${table} where id = $1`, [live])).toHaveLength(1);
      },
    );

    it("cascades a deleted project to its versions, attachments and draft, and unlinks library sources", async () => {
      await trash(t, a.id, "projects", a.project.id);
      const deleted = await t.run(user(a.id), "delete from public.projects where id = $1", [a.project.id]);
      expect(deleted.affectedRows).toBe(1);
      expect(await t.admin("select 1 from public.project_versions where project_id = $1", [a.project.id])).toEqual([]);
      expect(await t.admin("select 1 from public.project_draft_assets where project_id = $1", [a.project.id])).toEqual([]);
      expect(await t.admin("select 1 from public.project_version_assets where version_id = $1", [a.version.id])).toEqual([]);
      const item = one(
        await t.admin<LibraryItemRow>("select * from public.library_items where id = $1", [a.item.id]),
      );
      expect(item.source_project_id).toBeNull();
      expect(item.source_version_id).toBeNull();
      // B's project is untouched
      expect(await t.admin("select 1 from public.projects where id = $1", [b.project.id])).toHaveLength(1);
    });
  });
});
