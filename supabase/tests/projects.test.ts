// Lab projects with Adobe-style history: create (version 1), autosaved drafts, committed versions (autosave / manual /
// named), non-destructive restore (an existing draft is kept as a version first), naming, deleting old versions and
// save-as-copy. Every write is optimistic (expected head and draft revision) and every rule is enforced by the
// database, so the tests attack the RPCs directly: stale heads and drafts, foreign or unready files, malformed input,
// the trash and the plan's project limit.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, expectPlatformError, expectSqlState, user, type Row, type TestDb } from "./support/db";
import {
  commitVersion,
  createLibraryItem,
  createProject,
  draftAttachments,
  getProject,
  getVersion,
  one,
  pendingAsset,
  readyAsset,
  restoreVersion,
  saveDraft,
  stateHash,
  trash,
  versionAttachments,
  type CommitResult,
  type ProjectRow,
  type VersionRow,
} from "./support/fixtures";

// PGlite is fast, but a busy CI runner is not: database tests get explicit headroom.
vi.setConfig({ testTimeout: 30_000 });

/** The JSON detail of a 409 conflict, after checking its code. */
async function conflictDetail(promise: Promise<unknown>, code: string): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    const caught = error as { message?: string; code?: string; detail?: string };
    expect(caught.message).toBe(code);
    expect(caught.code).toBe("PT409");
    return JSON.parse(caught.detail ?? "null") as Record<string, unknown>;
  }
  throw new Error(`expected the platform error ${code}`);
}

function recent(date: Date | null): boolean {
  return date !== null && Math.abs(Date.now() - date.getTime()) < 60_000;
}

describe("projects", () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  const versionsOf = (projectId: string) =>
    t.admin<VersionRow>("select * from public.project_versions where project_id = $1 order by seq", [projectId]);
  const projectCount = async (owner: string) =>
    one(await t.admin<{ n: number } & Row>("select count(*)::int as n from public.projects where owner_id = $1", [owner])).n;
  /** The project and version rows as JSON, exactly what commit_version and restore_version must answer. */
  const storedAnswer = async (projectId: string, versionId: string): Promise<CommitResult> =>
    one(
      await t.admin<{ answer: CommitResult } & Row>(
        `select jsonb_build_object('project', (select to_jsonb(p) from public.projects p where p.id = $1),
                                   'version', (select to_jsonb(v) from public.project_versions v where v.id = $2)) as answer`,
        [projectId, versionId],
      ),
    ).answer;

  describe("create_project", () => {
    it("creates the project with version 1 (initial) as its head", async () => {
      const owner = await t.createUser();
      const snapshot = await readyAsset(t, owner, { size: 200 });
      const sculpt = await readyAsset(t, owner, { size: 100, mime: "application/octet-stream" });
      const { project, head, thumbnail } = await createProject(t, owner, {
        title: "  Liver study  ",
        description: "Left lobe variant",
        snapshot,
        attachments: [
          { name: "sculpt.bin", asset_id: sculpt.id },
          { name: "sculpt-copy.bin", asset_id: sculpt.id },
          { name: "state.json.gz", asset_id: snapshot.id },
        ],
      });
      expect(project).toMatchObject({
        owner_id: owner,
        lab_id: "organ",
        title: "Liver study",
        description: "Left lobe variant",
        head_version_id: head.id,
        head_seq: 1,
        draft_asset_id: null,
        draft_state_sha256: null,
        draft_rev: 0,
        thumbnail_asset_id: thumbnail?.id,
        favorite: false,
        opened_at: null,
        trashed_at: null,
      });
      expect(head).toMatchObject({
        project_id: project.id,
        owner_id: owner,
        seq: 1,
        kind: "initial",
        parent_version_id: null,
        label: null,
        snapshot_asset_id: snapshot.id,
        state_sha256: stateHash(snapshot.id),
        thumbnail_asset_id: thumbnail?.id,
        restored_from_version_id: null,
        lab_schema_version: 1,
        app_build: "test",
        // snapshot + distinct attachments (the duplicate and the snapshot itself count once; thumbnails never)
        byte_size: 300,
      });
      expect(await versionAttachments(t, head.id)).toEqual([
        { name: "sculpt-copy.bin", asset_id: sculpt.id },
        { name: "sculpt.bin", asset_id: sculpt.id },
        { name: "state.json.gz", asset_id: snapshot.id },
      ]);
    });

    describe("validation", () => {
      let owner: string;
      let snapshot: string;
      let asset: string;

      beforeAll(async () => {
        owner = await t.createUser();
        snapshot = (await readyAsset(t, owner)).id;
        asset = (await readyAsset(t, owner)).id;
      });

      const create = (overrides: Record<string, unknown>) => {
        const args: Record<string, unknown> = {
          p_lab_id: "organ",
          p_title: "Study",
          p_snapshot_asset_id: snapshot,
          p_state_sha256: stateHash("valid"),
          p_thumbnail_asset_id: null,
          p_lab_schema_version: 1,
          p_app_build: null,
          p_attachments: "[]",
          p_description: "",
          ...overrides,
        };
        const names = Object.keys(args);
        return t.as(
          user(owner),
          `select * from public.create_project(${names.map((name, index) => `${name} => $${index + 1}`).join(", ")})`,
          names.map((name) => args[name]),
        );
      };
      const attachments = (value: unknown) => ({ p_attachments: JSON.stringify(value) });

      it.each([
        ["lab_id", { p_lab_id: "Organ" }],
        ["lab_id", { p_lab_id: "o" }],
        ["lab_id", { p_lab_id: "organ_lab" }],
        ["lab_id", { p_lab_id: "1organ" }],
        ["lab_id", { p_lab_id: `o${"a".repeat(32)}` }],
        ["lab_id", { p_lab_id: null }],
        ["title", { p_title: "" }],
        ["title", { p_title: "    " }],
        ["title", { p_title: "x".repeat(121) }],
        ["title", { p_title: null }],
        ["description", { p_description: "x".repeat(2001) }],
        ["state_sha256", { p_state_sha256: "A".repeat(64) }],
        ["state_sha256", { p_state_sha256: "abc" }],
        ["state_sha256", { p_state_sha256: null }],
        ["snapshot_asset_id", { p_snapshot_asset_id: null }],
        ["lab_schema_version", { p_lab_schema_version: 0 }],
        ["lab_schema_version", { p_lab_schema_version: 1_000_001 }],
        ["lab_schema_version", { p_lab_schema_version: null }],
        ["app_build", { p_app_build: "" }],
        ["app_build", { p_app_build: "x".repeat(65) }],
        ["attachments must be an array", attachments({ name: "a" })],
        ["attachments must be an array", attachments("a")],
        ["attachment must be an object", attachments([1])],
        ["attachment name", attachments([{ name: ".hidden", asset_id: "00000000-0000-4000-8000-000000000000" }])],
        ["attachment name", attachments([{ name: "a/b", asset_id: "00000000-0000-4000-8000-000000000000" }])],
        ["attachment name", attachments([{ name: "a b", asset_id: "00000000-0000-4000-8000-000000000000" }])],
        ["attachment name", attachments([{ name: "", asset_id: "00000000-0000-4000-8000-000000000000" }])],
        ["attachment name", attachments([{ name: "x".repeat(65), asset_id: "00000000-0000-4000-8000-000000000000" }])],
        ["attachment name", attachments([{ asset_id: "00000000-0000-4000-8000-000000000000" }])],
        ["attachment asset_id", attachments([{ name: "a.bin", asset_id: "not-a-uuid" }])],
        ["attachment asset_id", attachments([{ name: "a.bin", asset_id: null }])],
      ])("answers 422 for an invalid %s", async (detail, overrides) => {
        const before = await projectCount(owner);
        await expectPlatformError(create(overrides), "invalid_input", 422, detail);
        expect(await projectCount(owner)).toBe(before);
      });

      it("answers 422 for duplicate attachment names and more than 64 attachments", async () => {
        await expectPlatformError(
          create(attachments([{ name: "a.bin", asset_id: asset }, { name: "a.bin", asset_id: snapshot }])),
          "invalid_input",
          422,
          "duplicate attachment name a.bin",
        );
        const many = Array.from({ length: 65 }, (_, index) => ({ name: `part-${index}.bin`, asset_id: asset }));
        await expectPlatformError(create(attachments(many)), "invalid_input", 422, "at most 64 attachments");
        const max = Array.from({ length: 64 }, (_, index) => ({ name: `part-${index}.bin`, asset_id: asset }));
        const [created] = await create(attachments(max));
        const head = (created as ProjectRow | undefined)?.head_version_id ?? "";
        expect(await versionAttachments(t, head)).toHaveLength(64);
      });

      it("treats attachment names as case-sensitive keys", async () => {
        const [created] = await create(attachments([{ name: "Mesh.bin", asset_id: asset }, { name: "mesh.bin", asset_id: asset }]));
        expect(await versionAttachments(t, (created as ProjectRow | undefined)?.head_version_id ?? "")).toHaveLength(2);
      });

      it("refuses unready (409) and foreign or unknown (404) files, and creates nothing", async () => {
        const other = await t.createUser();
        const foreign = await readyAsset(t, other);
        const pending = await pendingAsset(t, owner);
        const before = await projectCount(owner);
        await expectPlatformError(create({ p_snapshot_asset_id: pending.id }), "asset_not_ready", 409, "snapshot_asset_id");
        await expectPlatformError(create({ p_thumbnail_asset_id: pending.id }), "asset_not_ready", 409, "thumbnail_asset_id");
        await expectPlatformError(
          create(attachments([{ name: "late.bin", asset_id: pending.id }])),
          "asset_not_ready",
          409,
          "attachment late.bin",
        );
        await expectPlatformError(create({ p_snapshot_asset_id: foreign.id }), "not_found", 404, "snapshot_asset_id");
        await expectPlatformError(
          create({ p_snapshot_asset_id: "00000000-0000-4000-8000-000000000000" }),
          "not_found",
          404,
        );
        await expectPlatformError(create(attachments([{ name: "theirs.bin", asset_id: foreign.id }])), "not_found", 404);
        expect(await projectCount(owner)).toBe(before);
      });
    });

    it("allows at most the plan's number of live projects; trashed ones do not count", async () => {
      const owner = await t.createUser();
      await t.setPlan(owner, { maxProjects: 2 });
      const first = await createProject(t, owner);
      await createProject(t, owner);
      await expectPlatformError(createProject(t, owner), "limit_reached", 403, "at most 2 projects on this plan");
      await expectPlatformError(
        t.as(user(owner), "select * from public.duplicate_project($1, 'Copy')", [first.project.id]),
        "limit_reached",
        403,
      );
      await trash(t, owner, "projects", first.project.id);
      await createProject(t, owner);
      expect(await projectCount(owner)).toBe(3);
    });

    it("re-checks the limit when a project comes back from the trash, row by row in bulk restores", async () => {
      const owner = await t.createUser();
      await t.setPlan(owner, { maxProjects: 2 });
      const a = await createProject(t, owner, { title: "A" });
      const b = await createProject(t, owner, { title: "B" });
      await trash(t, owner, "projects", a.project.id);
      await trash(t, owner, "projects", b.project.id);
      await createProject(t, owner, { title: "C" });
      const d = await createProject(t, owner, { title: "D" });
      const restore = (id: string) => t.as(user(owner), "update public.projects set trashed_at = null where id = $1", [id]);
      await expectPlatformError(restore(a.project.id), "limit_reached", 403, "at most 2 projects on this plan");
      await trash(t, owner, "projects", d.project.id);
      // one slot is free: a bulk restore of three must fail as a whole
      await expectPlatformError(
        t.as(user(owner), "update public.projects set trashed_at = null where trashed_at is not null"),
        "limit_reached",
        403,
      );
      expect((await getProject(t, a.project.id)).trashed_at).not.toBeNull();
      await restore(a.project.id);
      const live = await t.admin<{ title: string } & Row>(
        "select title from public.projects where owner_id = $1 and trashed_at is null order by title",
        [owner],
      );
      expect(live.map((row) => row.title)).toEqual(["A", "C"]);
      // moving between trash and trash, or retitling a trashed project, is not a restore
      await t.as(user(owner), "update public.projects set trashed_at = now(), title = 'B again' where id = $1", [b.project.id]);
    });
  });

  describe("save_draft", () => {
    it("stores the working copy, bumps draft_rev and moves updated_at", async () => {
      const owner = await t.createUser();
      const { project } = await createProject(t, owner);
      const thumb = await readyAsset(t, owner, { mime: "image/webp" });
      const sculpt = await readyAsset(t, owner, { mime: "application/octet-stream" });
      const { project: saved, snapshot } = await saveDraft(t, owner, project.id, {
        thumbnail: thumb,
        attachments: [{ name: "sculpt.bin", asset_id: sculpt.id }],
      });
      expect(saved).toMatchObject({
        head_version_id: project.head_version_id,
        head_seq: 1,
        draft_asset_id: snapshot.id,
        draft_state_sha256: stateHash(snapshot.id),
        draft_thumbnail_asset_id: thumb.id,
        draft_rev: 1,
        thumbnail_asset_id: thumb.id,
      });
      expect(recent(saved.draft_saved_at)).toBe(true);
      expect(saved.updated_at.getTime()).toBeGreaterThanOrEqual(project.updated_at.getTime());
      expect(await draftAttachments(t, project.id)).toEqual([{ name: "sculpt.bin", asset_id: sculpt.id }]);
      expect(await versionsOf(project.id)).toHaveLength(1);
    });

    it("replaces the attachment list on every save", async () => {
      const owner = await t.createUser();
      const { project } = await createProject(t, owner);
      const [a, b, c] = [await readyAsset(t, owner), await readyAsset(t, owner), await readyAsset(t, owner)];
      await saveDraft(t, owner, project.id, { attachments: [{ name: "a.bin", asset_id: a.id }, { name: "b.bin", asset_id: b.id }] });
      await saveDraft(t, owner, project.id, { attachments: [{ name: "c.bin", asset_id: c.id }] });
      expect(await draftAttachments(t, project.id)).toEqual([{ name: "c.bin", asset_id: c.id }]);
      const { project: last } = await saveDraft(t, owner, project.id, { attachments: [] });
      expect(await draftAttachments(t, project.id)).toEqual([]);
      expect(last.draft_rev).toBe(3);
    });

    it("keeps the lab schema version and app build the lab reported with the draft, and validates them", async () => {
      const owner = await t.createUser();
      const { project } = await createProject(t, owner);
      const { project: saved } = await saveDraft(t, owner, project.id, { labSchemaVersion: 4, appBuild: "2026.10.22" });
      expect(saved).toMatchObject({ draft_lab_schema_version: 4, draft_app_build: "2026.10.22" });
      const { project: unknown } = await saveDraft(t, owner, project.id);
      expect(unknown).toMatchObject({ draft_lab_schema_version: null, draft_app_build: null });
      for (const [field, options] of [
        ["lab_schema_version", { labSchemaVersion: 0 }],
        ["lab_schema_version", { labSchemaVersion: 1_000_001 }],
        ["app_build", { appBuild: "" }],
        ["app_build", { appBuild: "x".repeat(65) }],
      ] as const) {
        await expectPlatformError(saveDraft(t, owner, project.id, options), "invalid_input", 422, field);
      }
      // gone with the draft: commit and discard clear them
      await saveDraft(t, owner, project.id, { labSchemaVersion: 2, appBuild: "b" });
      const { project: committed } = await commitVersion(t, owner, project.id);
      expect(committed).toMatchObject({ draft_lab_schema_version: null, draft_app_build: null });
      await saveDraft(t, owner, project.id, { labSchemaVersion: 2, appBuild: "b" });
      const current = await getProject(t, project.id);
      const discarded = one(await t.as<ProjectRow>(user(owner), "select * from public.discard_draft($1, $2)", [project.id, current.draft_rev]));
      expect(discarded).toMatchObject({ draft_lab_schema_version: null, draft_app_build: null });
    });

    it("keeps the project thumbnail when a save carries none", async () => {
      const owner = await t.createUser();
      const { project, thumbnail } = await createProject(t, owner);
      const { project: saved } = await saveDraft(t, owner, project.id, { thumbnail: null });
      expect(saved.thumbnail_asset_id).toBe(thumbnail?.id);
      expect(saved.draft_thumbnail_asset_id).toBeNull();
    });

    it("answers draft_conflict for a stale revision, and version_conflict first once the head moved", async () => {
      const owner = await t.createUser();
      const { project } = await createProject(t, owner);
      await saveDraft(t, owner, project.id);
      expect(await conflictDetail(saveDraft(t, owner, project.id, { expectedDraftRev: 0 }), "draft_conflict")).toEqual({
        draft_rev: 1,
      });
      const snapshot = await readyAsset(t, owner);
      await expectPlatformError(
        t.as(user(owner), "select * from public.save_draft($1, $2, null, $3, $4)", [
          project.id,
          project.head_version_id,
          snapshot.id,
          stateHash("x"),
        ]),
        "draft_conflict",
        409,
      );
      const { version } = await commitVersion(t, owner, project.id);
      const detail = await conflictDetail(
        saveDraft(t, owner, project.id, { expectedHead: project.head_version_id, expectedDraftRev: 0 }),
        "version_conflict",
      );
      expect(detail).toEqual({ head_version_id: version.id, head_seq: 2 });
      const after = await getProject(t, project.id);
      expect(after.draft_asset_id).toBeNull();
    });

    it("refuses unusable files and malformed state hashes", async () => {
      const owner = await t.createUser();
      const other = await t.createUser();
      const { project } = await createProject(t, owner);
      const pending = await pendingAsset(t, owner);
      const foreign = await readyAsset(t, other);
      await expectPlatformError(saveDraft(t, owner, project.id, { snapshot: pending }), "asset_not_ready", 409);
      await expectPlatformError(saveDraft(t, owner, project.id, { snapshot: foreign }), "not_found", 404);
      await expectPlatformError(saveDraft(t, owner, project.id, { thumbnail: pending }), "asset_not_ready", 409);
      await expectPlatformError(
        t.as(user(owner), "select * from public.save_draft($1, $2, 0, null, $3)", [project.id, project.head_version_id, stateHash("x")]),
        "invalid_input",
        422,
        "snapshot_asset_id",
      );
      await expectPlatformError(
        t.as(user(owner), "select * from public.save_draft($1, $2, 0, $3, 'not-a-hash')", [
          project.id,
          project.head_version_id,
          (await readyAsset(t, owner)).id,
        ]),
        "invalid_input",
        422,
        "state_sha256",
      );
      expect((await getProject(t, project.id)).draft_rev).toBe(0);
    });
  });

  describe("discard_draft", () => {
    it("drops the working copy and its attachments and returns to the head's thumbnail", async () => {
      const owner = await t.createUser();
      const { project, thumbnail } = await createProject(t, owner);
      const draftThumb = await readyAsset(t, owner, { mime: "image/webp" });
      const part = await readyAsset(t, owner);
      await saveDraft(t, owner, project.id, { thumbnail: draftThumb, attachments: [{ name: "part.bin", asset_id: part.id }] });
      const discarded = one(
        await t.as<ProjectRow>(user(owner), "select * from public.discard_draft($1, 1)", [project.id]),
      );
      expect(discarded).toMatchObject({
        draft_asset_id: null,
        draft_state_sha256: null,
        draft_thumbnail_asset_id: null,
        draft_saved_at: null,
        draft_rev: 2,
        thumbnail_asset_id: thumbnail?.id,
        head_version_id: project.head_version_id,
      });
      expect(await draftAttachments(t, project.id)).toEqual([]);
    });

    it("needs the current draft revision", async () => {
      const owner = await t.createUser();
      const { project } = await createProject(t, owner);
      await saveDraft(t, owner, project.id);
      expect(
        await conflictDetail(t.as(user(owner), "select * from public.discard_draft($1, 0)", [project.id]), "draft_conflict"),
      ).toEqual({ draft_rev: 1 });
      expect((await getProject(t, project.id)).draft_asset_id).not.toBeNull();
    });
  });

  describe("commit_version", () => {
    it("appends autosave, manual and named versions, each the child of the previous head", async () => {
      const owner = await t.createUser();
      const { project, head } = await createProject(t, owner);
      const autosave = (await commitVersion(t, owner, project.id, { kind: "autosave" })).version;
      const manual = (await commitVersion(t, owner, project.id, { kind: "manual" })).version;
      const named = (await commitVersion(t, owner, project.id, { kind: "named", label: "  Wider left lobe  " })).version;
      expect([autosave, manual, named].map((version) => [version.seq, version.kind, version.parent_version_id])).toEqual([
        [2, "autosave", head.id],
        [3, "manual", autosave.id],
        [4, "named", manual.id],
      ]);
      expect(named.label).toBe("Wider left lobe");
      const after = await getProject(t, project.id);
      expect(after).toMatchObject({ head_version_id: named.id, head_seq: 4 });
      expect(after.updated_at.getTime()).toBeGreaterThanOrEqual(project.updated_at.getTime());
    });

    it.each(["initial", "restore", "duplicate", "import", "Manual", "", null])("rejects the kind %j", async (kind) => {
      const owner = await t.createUser();
      const { project } = await createProject(t, owner);
      const snapshot = await readyAsset(t, owner);
      await expectPlatformError(
        t.as(user(owner), "select public.commit_version($1, $2, $3, $4, $5, $6)", [
          project.id,
          project.head_version_id,
          project.draft_rev,
          kind,
          snapshot.id,
          stateHash("x"),
        ]),
        "invalid_input",
        422,
        "kind",
      );
      expect(await versionsOf(project.id)).toHaveLength(1);
    });

    it("needs a label for a named version and caps labels at 120 characters", async () => {
      const owner = await t.createUser();
      const { project } = await createProject(t, owner);
      for (const label of [null, "", "   "]) {
        await expectPlatformError(
          commitVersion(t, owner, project.id, { kind: "named", label }),
          "invalid_input",
          422,
          "a named version needs a label",
        );
      }
      await expectPlatformError(
        commitVersion(t, owner, project.id, { kind: "named", label: "x".repeat(121) }),
        "invalid_input",
        422,
        "label",
      );
      const longest = (await commitVersion(t, owner, project.id, { kind: "named", label: "x".repeat(120) })).version;
      expect(longest.label).toHaveLength(120);
    });

    it("answers version_conflict on a stale head and never forks the history", async () => {
      const owner = await t.createUser();
      const { project } = await createProject(t, owner);
      const second = (await commitVersion(t, owner, project.id)).version;
      const detail = await conflictDetail(
        commitVersion(t, owner, project.id, { expectedHead: project.head_version_id }),
        "version_conflict",
      );
      expect(detail).toEqual({ head_version_id: second.id, head_seq: 2 });
      await expectPlatformError(commitVersion(t, owner, project.id, { expectedHead: null }), "version_conflict", 409);
      expect((await versionsOf(project.id)).map((version) => version.seq)).toEqual([1, 2]);
    });

    it("answers {project, version} exactly as stored, with draft_rev one past the expected revision", async () => {
      const owner = await t.createUser();
      const { project } = await createProject(t, owner);
      const first = await commitVersion(t, owner, project.id, { kind: "named", label: "First" });
      expect(first.result).toEqual(await storedAnswer(project.id, first.version.id));
      expect(first.result.project).toMatchObject({ head_version_id: first.version.id, head_seq: 2, draft_rev: 1 });
      await saveDraft(t, owner, project.id);
      await saveDraft(t, owner, project.id);
      // 0 → commit 1 → save 2 → save 3 → commit 4: the returned project is the caller's next expectation
      const second = await commitVersion(t, owner, project.id, { expectedDraftRev: 3 });
      expect(second.result.project).toMatchObject({ head_version_id: second.version.id, head_seq: 3, draft_rev: 4, draft_asset_id: null });
      expect(second.result).toEqual(await storedAnswer(project.id, second.version.id));
      const third = await commitVersion(t, owner, project.id, {
        expectedHead: second.result.project.head_version_id,
        expectedDraftRev: second.result.project.draft_rev,
      });
      expect(third.result.project).toMatchObject({ head_seq: 4, draft_rev: 5 });
    });

    it("answers draft_conflict when another tab or device saved a draft since, and never clears it unseen", async () => {
      const owner = await t.createUser();
      const { project } = await createProject(t, owner);
      // tab A opened the project at draft_rev 0; tab B autosaves twice and closes
      const seenByA = await getProject(t, project.id);
      await saveDraft(t, owner, project.id);
      const { project: fromB } = await saveDraft(t, owner, project.id);
      // tab A presses ⌘S with what it saw
      const detail = await conflictDetail(
        commitVersion(t, owner, project.id, { expectedHead: seenByA.head_version_id, expectedDraftRev: seenByA.draft_rev }),
        "draft_conflict",
      );
      expect(detail).toEqual({ draft_rev: 2 });
      await expectPlatformError(commitVersion(t, owner, project.id, { expectedDraftRev: null }), "draft_conflict", 409);
      expect(await getProject(t, project.id)).toMatchObject({
        draft_asset_id: fromB.draft_asset_id,
        draft_rev: 2,
        head_version_id: project.head_version_id,
      });
      expect(await versionsOf(project.id)).toHaveLength(1);
      // a stale head is reported first
      const { version } = await commitVersion(t, owner, project.id);
      expect(
        await conflictDetail(
          commitVersion(t, owner, project.id, { expectedHead: project.head_version_id, expectedDraftRev: 0 }),
          "version_conflict",
        ),
      ).toEqual({ head_version_id: version.id, head_seq: 2 });
    });

    it("keeps seq monotonic when old versions are deleted", async () => {
      const owner = await t.createUser();
      const { project } = await createProject(t, owner);
      const second = (await commitVersion(t, owner, project.id)).version;
      await commitVersion(t, owner, project.id);
      await t.as(user(owner), "select public.delete_version($1)", [second.id]);
      const fourth = (await commitVersion(t, owner, project.id)).version;
      expect(fourth.seq).toBe(4);
      expect((await versionsOf(project.id)).map((version) => version.seq)).toEqual([1, 3, 4]);
    });

    it("clears the draft and its attachments", async () => {
      const owner = await t.createUser();
      const { project } = await createProject(t, owner);
      const part = await readyAsset(t, owner);
      await saveDraft(t, owner, project.id, { attachments: [{ name: "part.bin", asset_id: part.id }] });
      await commitVersion(t, owner, project.id, { attachments: [{ name: "part.bin", asset_id: part.id }] });
      const after = await getProject(t, project.id);
      expect(after).toMatchObject({ draft_asset_id: null, draft_state_sha256: null, draft_thumbnail_asset_id: null, draft_rev: 2 });
      expect(await draftAttachments(t, project.id)).toEqual([]);
    });

    it("moves the project thumbnail only when the version carries one", async () => {
      const owner = await t.createUser();
      const { project, thumbnail } = await createProject(t, owner);
      await commitVersion(t, owner, project.id, { thumbnail: null });
      expect((await getProject(t, project.id)).thumbnail_asset_id).toBe(thumbnail?.id);
      const next = await readyAsset(t, owner, { mime: "image/webp" });
      const { version } = await commitVersion(t, owner, project.id, { thumbnail: next });
      expect(version.thumbnail_asset_id).toBe(next.id);
      expect((await getProject(t, project.id)).thumbnail_asset_id).toBe(next.id);
    });

    it("sizes a version as its snapshot plus its distinct attachments", async () => {
      const owner = await t.createUser();
      const { project } = await createProject(t, owner);
      const snapshot = await readyAsset(t, owner, { size: 50 });
      const first = await readyAsset(t, owner, { size: 30 });
      const second = await readyAsset(t, owner, { size: 20 });
      const thumb = await readyAsset(t, owner, { size: 1000, mime: "image/webp" });
      const { version } = await commitVersion(t, owner, project.id, {
        snapshot,
        thumbnail: thumb,
        attachments: [
          { name: "a.bin", asset_id: first.id },
          { name: "b.bin", asset_id: first.id },
          { name: "c.bin", asset_id: second.id },
          { name: "d.bin", asset_id: snapshot.id },
        ],
      });
      expect(version.byte_size).toBe(100);
    });

    it("validates the lab schema version and app build", async () => {
      const owner = await t.createUser();
      const { project } = await createProject(t, owner);
      const snapshot = await readyAsset(t, owner);
      const commit = (schema: unknown, build: unknown) =>
        t.as<{ result: CommitResult } & Row>(
          user(owner),
          `select public.commit_version(p_project_id => $1, p_expected_head_version_id => $2, p_expected_draft_rev => 0,
             p_kind => 'manual', p_snapshot_asset_id => $3, p_state_sha256 => $4, p_lab_schema_version => $5,
             p_app_build => $6) as result`,
          [project.id, project.head_version_id, snapshot.id, stateHash("x"), schema, build],
        );
      await expectPlatformError(commit(0, null), "invalid_input", 422, "lab_schema_version");
      await expectPlatformError(commit(null, null), "invalid_input", 422, "lab_schema_version");
      await expectPlatformError(commit(1, ""), "invalid_input", 422, "app_build");
      await expectPlatformError(commit(1, "x".repeat(65)), "invalid_input", 422, "app_build");
      await expectPlatformError(
        t.as(user(owner), "select public.commit_version($1, $2, 0, 'manual', null, $3)", [
          project.id,
          project.head_version_id,
          stateHash("x"),
        ]),
        "invalid_input",
        422,
        "snapshot_asset_id",
      );
      const { result } = one(await commit(7, "2026.10.21"));
      expect(result.version).toMatchObject({ lab_schema_version: 7, app_build: "2026.10.21" });
    });
  });

  describe("version cap", () => {
    it("keeps at most 1000 versions per project; deleting one makes room again", async () => {
      const owner = await t.createUser();
      const { project, head } = await createProject(t, owner);
      // versions 2..999 directly (the RPCs would take minutes); version 1000 goes through commit_version
      await t.admin(
        `insert into public.project_versions (project_id, owner_id, seq, parent_version_id, kind, snapshot_asset_id,
                                              state_sha256, lab_schema_version)
         select $1, $2, s, null, 'autosave', $3, $4, 1 from generate_series(2, 999) as s`,
        [project.id, owner, head.snapshot_asset_id, head.state_sha256],
      );
      await t.admin(
        `update public.projects
            set head_version_id = (select id from public.project_versions where project_id = $1 and seq = 999),
                head_seq = 999
          where id = $1`,
        [project.id],
      );
      expect((await commitVersion(t, owner, project.id)).version.seq).toBe(999 + 1);
      await expectPlatformError(commitVersion(t, owner, project.id), "limit_reached", 403, "at most 1000 versions per project");
      await expectPlatformError(restoreVersion(t, owner, project.id, head.id), "limit_reached", 403);
      const second = one(await t.admin<{ id: string } & Row>("select id from public.project_versions where project_id = $1 and seq = 2", [project.id]));
      await t.as(user(owner), "select public.delete_version($1)", [second.id]);
      // one free slot: a restore over a draft needs two (the draft is kept as a version first), so it is refused whole
      await saveDraft(t, owner, project.id);
      const before = await getProject(t, project.id);
      await expectPlatformError(restoreVersion(t, owner, project.id, head.id), "limit_reached", 403, "at most 1000 versions per project");
      expect(await getProject(t, project.id)).toMatchObject({ draft_asset_id: before.draft_asset_id, draft_rev: before.draft_rev });
      await t.as(user(owner), "select public.delete_version($1)", [head.id]);
      const restored = await restoreVersion(t, owner, project.id, (await versionsOf(project.id))[0]?.id ?? "");
      expect(restored.version.seq).toBe(1002);
    });
  });

  describe("restore_version", () => {
    it("commits a new head that reuses the chosen version's files, without rewriting history", async () => {
      const owner = await t.createUser();
      const original = await readyAsset(t, owner);
      const { project, head: first, thumbnail } = await createProject(t, owner, {
        attachments: [{ name: "sculpt.bin", asset_id: original.id }],
      });
      const later = await readyAsset(t, owner);
      const laterThumb = await readyAsset(t, owner, { mime: "image/webp" });
      const second = (
        await commitVersion(t, owner, project.id, { thumbnail: laterThumb, attachments: [{ name: "other.bin", asset_id: later.id }] })
      ).version;

      const { version: restored, result } = await restoreVersion(t, owner, project.id, first.id, {
        expectedHead: second.id,
        expectedDraftRev: 1,
      });
      expect(restored).toMatchObject({
        seq: 3,
        kind: "restore",
        label: null,
        parent_version_id: second.id,
        restored_from_version_id: first.id,
        snapshot_asset_id: first.snapshot_asset_id,
        state_sha256: first.state_sha256,
        thumbnail_asset_id: thumbnail?.id,
        lab_schema_version: first.lab_schema_version,
        app_build: first.app_build,
        byte_size: first.byte_size,
      });
      expect(await versionAttachments(t, restored.id)).toEqual([{ name: "sculpt.bin", asset_id: original.id }]);
      expect(result).toEqual(await storedAnswer(project.id, restored.id));
      expect(await getProject(t, project.id)).toMatchObject({
        head_version_id: restored.id,
        head_seq: 3,
        thumbnail_asset_id: thumbnail?.id,
        draft_asset_id: null,
        // 0 → commit 1 → restore 2: a restore without a draft still moves draft_rev on by one
        draft_rev: 2,
      });
      expect((await versionsOf(project.id)).map((version) => version.id)).toEqual([first.id, second.id, restored.id]);
      expect(await versionAttachments(t, second.id)).toEqual([{ name: "other.bin", asset_id: later.id }]);
    });

    it("keeps an existing draft as an autosave version, with its files, before the restore version", async () => {
      const owner = await t.createUser();
      const { project, head: first } = await createProject(t, owner);
      const second = (await commitVersion(t, owner, project.id, { labSchemaVersion: 3, appBuild: "head-build" })).version;
      const draftPart = await readyAsset(t, owner, { size: 40 });
      const draftThumb = await readyAsset(t, owner, { mime: "image/webp" });
      const draftSnapshot = await readyAsset(t, owner, { size: 60, label: "draft" });
      const { project: drafted } = await saveDraft(t, owner, project.id, {
        snapshot: draftSnapshot,
        thumbnail: draftThumb,
        attachments: [
          { name: "part.bin", asset_id: draftPart.id },
          { name: "copy.bin", asset_id: draftPart.id },
        ],
        labSchemaVersion: 4,
        appBuild: "draft-build",
      });
      expect(drafted.draft_rev).toBe(2);

      const { version: restored, project: after, result } = await restoreVersion(t, owner, project.id, first.id, {
        expectedHead: second.id,
        expectedDraftRev: 2,
      });
      const versions = await versionsOf(project.id);
      expect(versions.map((version) => [version.seq, version.kind])).toEqual([
        [1, "initial"],
        [2, "manual"],
        [3, "autosave"],
        [4, "restore"],
      ]);
      const kept = versions[2] as VersionRow;
      expect(kept).toMatchObject({
        parent_version_id: second.id,
        label: null,
        snapshot_asset_id: draftSnapshot.id,
        state_sha256: stateHash(draftSnapshot.id),
        thumbnail_asset_id: draftThumb.id,
        restored_from_version_id: null,
        lab_schema_version: 4,
        app_build: "draft-build",
        // snapshot + distinct attachments
        byte_size: 100,
      });
      expect(await versionAttachments(t, kept.id)).toEqual([
        { name: "copy.bin", asset_id: draftPart.id },
        { name: "part.bin", asset_id: draftPart.id },
      ]);
      expect(restored).toMatchObject({ seq: 4, parent_version_id: kept.id, restored_from_version_id: first.id });
      // one step: the draft is cleared once, so draft_rev moves on by exactly one
      expect(after).toMatchObject({
        head_version_id: restored.id,
        head_seq: 4,
        draft_asset_id: null,
        draft_state_sha256: null,
        draft_thumbnail_asset_id: null,
        draft_lab_schema_version: null,
        draft_app_build: null,
        draft_rev: 3,
      });
      expect(await draftAttachments(t, project.id)).toEqual([]);
      expect(result).toEqual(await storedAnswer(project.id, restored.id));
      // and the kept work is one restore away
      const back = await restoreVersion(t, owner, project.id, kept.id);
      expect(back.version).toMatchObject({ seq: 5, snapshot_asset_id: draftSnapshot.id, restored_from_version_id: kept.id });
      expect(await versionAttachments(t, back.version.id)).toEqual(await versionAttachments(t, kept.id));
    });

    it("takes the schema version and app build the lab did not report with the draft from the head", async () => {
      const owner = await t.createUser();
      const { project, head } = await createProject(t, owner);
      await commitVersion(t, owner, project.id, { labSchemaVersion: 6, appBuild: "head-build" });
      await saveDraft(t, owner, project.id);
      await restoreVersion(t, owner, project.id, head.id);
      const kept = (await versionsOf(project.id)).find((version) => version.kind === "autosave");
      expect(kept).toMatchObject({ seq: 3, lab_schema_version: 6, app_build: "head-build", thumbnail_asset_id: null });
    });

    it("answers draft_conflict for a draft revision it has not seen, and changes nothing", async () => {
      const owner = await t.createUser();
      const { project, head } = await createProject(t, owner);
      await commitVersion(t, owner, project.id);
      const seen = await getProject(t, project.id);
      const { project: drafted } = await saveDraft(t, owner, project.id);
      expect(await conflictDetail(restoreVersion(t, owner, project.id, head.id, { expectedDraftRev: seen.draft_rev }), "draft_conflict")).toEqual({
        draft_rev: drafted.draft_rev,
      });
      await expectPlatformError(restoreVersion(t, owner, project.id, head.id, { expectedDraftRev: null }), "draft_conflict", 409);
      expect(await getProject(t, project.id)).toMatchObject({
        head_version_id: seen.head_version_id,
        head_seq: 2,
        draft_asset_id: drafted.draft_asset_id,
        draft_rev: drafted.draft_rev,
      });
      expect(await versionsOf(project.id)).toHaveLength(2);
    });

    it("answers version_conflict on a stale head, before looking at the draft", async () => {
      const owner = await t.createUser();
      const { project, head } = await createProject(t, owner);
      await commitVersion(t, owner, project.id);
      await expectPlatformError(
        restoreVersion(t, owner, project.id, head.id, { expectedHead: head.id, expectedDraftRev: 99 }),
        "version_conflict",
        409,
      );
    });

    it("restores only versions of the same project", async () => {
      const owner = await t.createUser();
      const first = await createProject(t, owner);
      const second = await createProject(t, owner);
      await expectPlatformError(restoreVersion(t, owner, first.project.id, second.head.id), "not_found", 404, "version");
      await expectPlatformError(
        t.as(user(owner), "select public.restore_version($1, null, $2, 0)", [first.project.id, first.head.id]),
        "not_found",
        404,
        "version",
      );
    });
  });

  describe("label_version", () => {
    it("names a version (kept forever), trimmed, and un-names it with null or blanks", async () => {
      const owner = await t.createUser();
      const { head } = await createProject(t, owner);
      const label = (value: unknown) =>
        t.as<VersionRow>(user(owner), "select * from public.label_version($1, $2)", [head.id, value]);
      expect(one(await label("  Before the cut  ")).label).toBe("Before the cut");
      expect(one(await label("   ")).label).toBeNull();
      expect(one(await label("Again")).label).toBe("Again");
      expect(one(await label(null)).label).toBeNull();
      await expectPlatformError(label("x".repeat(121)), "invalid_input", 422, "label");
      await expectPlatformError(
        t.as(user(owner), "select * from public.label_version(gen_random_uuid(), 'x')"),
        "not_found",
        404,
        "version",
      );
    });
  });

  describe("delete_version", () => {
    it("deletes an unnamed older version with its attachments and unlinks what pointed at it", async () => {
      const owner = await t.createUser();
      const part = await readyAsset(t, owner);
      const { project } = await createProject(t, owner);
      const second = (await commitVersion(t, owner, project.id, { attachments: [{ name: "part.bin", asset_id: part.id }] })).version;
      const third = (await commitVersion(t, owner, project.id)).version;
      const { version: restored } = await restoreVersion(t, owner, project.id, second.id);
      const item = await createLibraryItem(t, owner, { sourceProjectId: project.id, sourceVersionId: second.id });

      await t.as(user(owner), "select public.delete_version($1)", [second.id]);
      expect(await t.admin("select 1 from public.project_versions where id = $1", [second.id])).toEqual([]);
      expect(await versionAttachments(t, second.id)).toEqual([]);
      expect((await getVersion(t, third.id)).parent_version_id).toBeNull();
      expect((await getVersion(t, restored.id)).restored_from_version_id).toBeNull();
      // the restored head keeps its own copy of the attachment list
      expect(await versionAttachments(t, restored.id)).toEqual([{ name: "part.bin", asset_id: part.id }]);
      const linked = one(await t.admin<Row>("select source_project_id, source_version_id from public.library_items where id = $1", [item.id]));
      expect(linked).toEqual({ source_project_id: project.id, source_version_id: null });
      expect((await getProject(t, project.id)).head_version_id).toBe(restored.id);
    });

    it("refuses the head and named versions (un-name first)", async () => {
      const owner = await t.createUser();
      const { project, head } = await createProject(t, owner);
      await expectPlatformError(
        t.as(user(owner), "select public.delete_version($1)", [head.id]),
        "invalid_input",
        422,
        "the current version cannot be deleted",
      );
      await commitVersion(t, owner, project.id);
      await t.as(user(owner), "select * from public.label_version($1, 'Keep')", [head.id]);
      await expectPlatformError(
        t.as(user(owner), "select public.delete_version($1)", [head.id]),
        "invalid_input",
        422,
        "remove the name before deleting a named version",
      );
      await t.as(user(owner), "select * from public.label_version($1, null)", [head.id]);
      await t.as(user(owner), "select public.delete_version($1)", [head.id]);
      expect((await versionsOf(project.id)).map((version) => version.seq)).toEqual([2]);
      await expectPlatformError(t.as(user(owner), "select public.delete_version($1)", [head.id]), "not_found", 404);
    });
  });

  describe("duplicate_project", () => {
    it("saves the head as a copy whose version 1 shares the same files", async () => {
      const owner = await t.createUser();
      const part = await readyAsset(t, owner);
      const { project, head } = await createProject(t, owner, {
        description: "Source",
        attachments: [{ name: "part.bin", asset_id: part.id }],
      });
      await saveDraft(t, owner, project.id);
      const copy = one(
        await t.as<ProjectRow>(user(owner), "select * from public.duplicate_project($1, '  Liver study copy ')", [project.id]),
      );
      expect(copy).toMatchObject({
        lab_id: project.lab_id,
        title: "Liver study copy",
        description: "Source",
        head_seq: 1,
        draft_asset_id: null,
        draft_rev: 0,
        thumbnail_asset_id: head.thumbnail_asset_id,
        favorite: false,
        trashed_at: null,
      });
      expect(copy.id).not.toBe(project.id);
      const first = await getVersion(t, copy.head_version_id ?? "");
      expect(first).toMatchObject({
        project_id: copy.id,
        seq: 1,
        kind: "duplicate",
        parent_version_id: null,
        restored_from_version_id: head.id,
        snapshot_asset_id: head.snapshot_asset_id,
        state_sha256: head.state_sha256,
        byte_size: head.byte_size,
      });
      expect(await versionAttachments(t, first.id)).toEqual([{ name: "part.bin", asset_id: part.id }]);
      expect((await getProject(t, project.id)).draft_asset_id).not.toBeNull();
    });

    it("copies a chosen older version", async () => {
      const owner = await t.createUser();
      const { project, head } = await createProject(t, owner);
      await commitVersion(t, owner, project.id);
      const copy = one(
        await t.as<ProjectRow>(user(owner), "select * from public.duplicate_project($1, 'From v1', $2)", [project.id, head.id]),
      );
      const first = await getVersion(t, copy.head_version_id ?? "");
      expect(first).toMatchObject({ snapshot_asset_id: head.snapshot_asset_id, restored_from_version_id: head.id });
    });

    it("answers not_found when the account has no profile to take the plan from", async () => {
      const owner = await t.createUser();
      const { project } = await createProject(t, owner);
      await t.admin("delete from public.profiles where id = $1", [owner]);
      await expectPlatformError(
        t.as(user(owner), "select * from public.duplicate_project($1, 'Copy')", [project.id]),
        "not_found",
        404,
        "profile",
      );
    });

    it("refuses versions of another project and invalid titles", async () => {
      const owner = await t.createUser();
      const one_ = await createProject(t, owner);
      const two = await createProject(t, owner);
      await expectPlatformError(
        t.as(user(owner), "select * from public.duplicate_project($1, 'Mixed', $2)", [one_.project.id, two.head.id]),
        "not_found",
        404,
        "version",
      );
      for (const title of ["", "   ", "x".repeat(121), null]) {
        await expectPlatformError(
          t.as(user(owner), "select * from public.duplicate_project($1, $2)", [one_.project.id, title]),
          "invalid_input",
          422,
          "title",
        );
      }
      await expectPlatformError(
        t.as(user(owner), "select * from public.duplicate_project(gen_random_uuid(), 'x')"),
        "not_found",
        404,
        "project",
      );
    });
  });

  describe("the trash", () => {
    it("makes a trashed project's working copy and history read-only", async () => {
      const owner = await t.createUser();
      const { project, head } = await createProject(t, owner);
      const second = (await commitVersion(t, owner, project.id)).version;
      await saveDraft(t, owner, project.id);
      await trash(t, owner, "projects", project.id);
      const current = await getProject(t, project.id);
      const snapshot = await readyAsset(t, owner);
      const attempts: Array<[string, unknown[]]> = [
        [
          "select * from public.save_draft($1, $2, $3, $4, $5)",
          [project.id, current.head_version_id, current.draft_rev, snapshot.id, stateHash("x")],
        ],
        ["select * from public.discard_draft($1, $2)", [project.id, current.draft_rev]],
        [
          "select public.commit_version($1, $2, $3, 'manual', $4, $5)",
          [project.id, current.head_version_id, current.draft_rev, snapshot.id, stateHash("x")],
        ],
        ["select public.restore_version($1, $2, $3, $4)", [project.id, head.id, current.head_version_id, current.draft_rev]],
        ["select * from public.label_version($1, 'Named in the trash')", [head.id]],
        ["select public.delete_version($1)", [head.id]],
      ];
      for (const [sql, params] of attempts) {
        await expectPlatformError(
          t.as(user(owner), sql, params),
          "project_trashed",
          409,
          "restore the project from the trash first",
        );
      }
      const unchanged = await getProject(t, project.id);
      expect(unchanged).toMatchObject({ head_version_id: second.id, head_seq: 2, draft_rev: current.draft_rev });
      expect((await getVersion(t, head.id)).label).toBeNull();

      await t.as(user(owner), "update public.projects set trashed_at = null where id = $1", [project.id]);
      await t.as(user(owner), "select * from public.label_version($1, 'Back from the trash')", [head.id]);
      expect((await getVersion(t, head.id)).label).toBe("Back from the trash");
    });

    it("stamps trashed_at and opened_at with the server clock, so nothing is back-dated into an early purge", async () => {
      const owner = await t.createUser();
      const { project } = await createProject(t, owner);
      await t.as(user(owner), "update public.projects set trashed_at = '2000-01-01', opened_at = '1999-12-31' where id = $1", [
        project.id,
      ]);
      const stamped = await getProject(t, project.id);
      expect(recent(stamped.trashed_at)).toBe(true);
      expect(recent(stamped.opened_at)).toBe(true);
      await t.as(user(owner), "update public.projects set trashed_at = '2001-01-01' where id = $1", [project.id]);
      expect(recent((await getProject(t, project.id)).trashed_at)).toBe(true);
      await t.as(user(owner), "update public.projects set trashed_at = null, opened_at = null where id = $1", [project.id]);
      expect(await getProject(t, project.id)).toMatchObject({ trashed_at: null, opened_at: null });
    });

    it("deletes forever only from the trash", async () => {
      const owner = await t.createUser();
      const { project } = await createProject(t, owner);
      expect((await t.run(user(owner), "delete from public.projects where id = $1", [project.id])).affectedRows).toBe(0);
      await trash(t, owner, "projects", project.id);
      expect((await t.run(user(owner), "delete from public.projects where id = $1", [project.id])).affectedRows).toBe(1);
      expect(await versionsOf(project.id)).toEqual([]);
    });
  });

  describe("client edits", () => {
    it("enforces the title and description rules on renames", async () => {
      const owner = await t.createUser();
      const { project } = await createProject(t, owner);
      for (const title of ["", " Leading space", "Trailing space ", "x".repeat(121)]) {
        await expectSqlState(t.as(user(owner), "update public.projects set title = $2 where id = $1", [project.id, title]), "23514");
      }
      await expectSqlState(
        t.as(user(owner), "update public.projects set description = $2 where id = $1", [project.id, "x".repeat(2001)]),
        "23514",
      );
      await t.as(user(owner), "update public.projects set title = $2, description = $3 where id = $1", [project.id, "x".repeat(120), "d"]);
    });

    it("keeps updated_at for content changes: renames and favourites do not move it", async () => {
      const owner = await t.createUser();
      const { project } = await createProject(t, owner);
      await t.admin("update public.projects set updated_at = '2026-01-01T00:00:00Z' where id = $1", [project.id]);
      await t.as(user(owner), "update public.projects set title = 'Renamed', favorite = true, description = 'x' where id = $1", [
        project.id,
      ]);
      expect((await getProject(t, project.id)).updated_at.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    });
  });
});
