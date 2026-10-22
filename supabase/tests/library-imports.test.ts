// The personal media library (create_library_item + client edits) and imported objects (create_imported_object +
// client edits): every file must be a ready asset of the caller, every field is validated with a 422 that names it,
// a failed call leaves nothing behind, and byte sizes count each distinct file once.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, expectPlatformError, expectSqlState, user, type Row, type TestDb } from "./support/db";
import {
  clientLiterals,
  createImportedObject,
  createLibraryItem,
  createProject,
  one,
  pendingAsset,
  readyAsset,
  type AssetRef,
  type ImportedObjectRow,
  type LibraryItemRow,
} from "./support/fixtures";

// PGlite is fast, but a busy CI runner is not: database tests get explicit headroom.
vi.setConfig({ testTimeout: 30_000 });

function recent(date: Date | null): boolean {
  return date !== null && Math.abs(Date.now() - date.getTime()) < 60_000;
}

describe("library", () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  const filesOf = (itemId: string) =>
    t.admin("select filename, asset_id, role, position from public.library_item_files where item_id = $1 order by filename", [itemId]);
  const itemCount = async (owner: string) =>
    one(await t.admin<{ n: number } & Row>("select count(*)::int as n from public.library_items where owner_id = $1", [owner])).n;

  it("creates an item from ready files, sized by its distinct files and thumbnail", async () => {
    const owner = await t.createUser();
    const { project, head } = await createProject(t, owner);
    const mesh = await readyAsset(t, owner, { size: 100, mime: "model/gltf-binary" });
    const albedo = await readyAsset(t, owner, { size: 50, mime: "image/png" });
    const thumb = await readyAsset(t, owner, { size: 30, mime: "image/webp" });
    const item = await createLibraryItem(t, owner, {
      kind: "shape",
      title: "  Liver, wide left lobe  ",
      tags: ["liver", "Variant A"],
      labId: "organ",
      sourceProjectId: project.id,
      sourceVersionId: head.id,
      metadata: { claims: { evidence: "Procedural shape", limitations: ["Not patient data"] } },
      thumbnail: thumb,
      files: [
        { filename: "liver.glb", asset_id: mesh.id, role: "mesh", position: 0 },
        { filename: "liver copy.glb", asset_id: mesh.id, role: "preview", position: 2 },
        { filename: "albedo.png", asset_id: albedo.id, role: "albedo", position: 1 },
        { filename: "cover.webp", asset_id: thumb.id },
      ],
    });
    expect(item).toMatchObject({
      owner_id: owner,
      kind: "shape",
      title: "Liver, wide left lobe",
      description: "",
      tags: ["liver", "Variant A"],
      lab_id: "organ",
      source_project_id: project.id,
      source_version_id: head.id,
      metadata: { claims: { evidence: "Procedural shape", limitations: ["Not patient data"] } },
      thumbnail_asset_id: thumb.id,
      favorite: false,
      byte_size: 180,
      trashed_at: null,
    });
    expect(await filesOf(item.id)).toEqual([
      { filename: "albedo.png", asset_id: albedo.id, role: "albedo", position: 1 },
      { filename: "cover.webp", asset_id: thumb.id, role: "other", position: 0 },
      { filename: "liver copy.glb", asset_id: mesh.id, role: "preview", position: 2 },
      { filename: "liver.glb", asset_id: mesh.id, role: "mesh", position: 0 },
    ]);
  });

  it("accepts every library kind and file role the client knows", async () => {
    const owner = await t.createUser();
    const asset = await readyAsset(t, owner);
    for (const kind of clientLiterals("LibraryKind")) {
      expect((await createLibraryItem(t, owner, { kind, files: [{ filename: "a.bin", asset_id: asset.id }] })).kind).toBe(kind);
    }
    const roles = clientLiterals("LibraryFileRole");
    expect(roles).toHaveLength(17);
    const item = await createLibraryItem(t, owner, {
      files: roles.map((role, position) => ({ filename: `${role}.bin`, asset_id: asset.id, role, position })),
    });
    expect((await filesOf(item.id)).map((file) => (file as { role: string }).role).sort()).toEqual([...roles].sort());
  });

  describe("validation", () => {
    let owner: string;
    let asset: AssetRef;
    let other: string;

    beforeAll(async () => {
      owner = await t.createUser();
      other = await t.createUser();
      asset = await readyAsset(t, owner);
    });

    // Overrides may be functions: the it.each tables are built before beforeAll has created the assets.
    const create = (overrides: Record<string, unknown>) => {
      const args: Record<string, unknown> = {
        p_kind: "shape",
        p_title: "Item",
        p_files: () => JSON.stringify([{ filename: "a.glb", asset_id: asset.id }]),
        p_description: "",
        p_tags: [],
        p_lab_id: null,
        p_source_project_id: null,
        p_source_version_id: null,
        p_metadata: "{}",
        p_thumbnail_asset_id: null,
        ...overrides,
      };
      const names = Object.keys(args);
      return t.as<LibraryItemRow>(
        user(owner),
        `select * from public.create_library_item(${names.map((name, index) => `${name} => $${index + 1}`).join(", ")})`,
        names.map((name) => {
          const value = args[name];
          return typeof value === "function" ? (value as () => unknown)() : value;
        }),
      );
    };
    const files = (value: unknown) => ({
      p_files: () => JSON.stringify(typeof value === "function" ? (value as () => unknown)() : value),
    });
    const file = (fields: Record<string, unknown>) => files(() => [{ filename: "a.glb", asset_id: asset.id, ...fields }]);

    it.each([
      ["kind", { p_kind: "Shape" }],
      ["kind", { p_kind: "video" }],
      ["kind", { p_kind: null }],
      ["title", { p_title: "" }],
      ["title", { p_title: "   " }],
      ["title", { p_title: "x".repeat(121) }],
      ["description", { p_description: "x".repeat(2001) }],
      ["tags", { p_tags: Array.from({ length: 21 }, (_, index) => `tag-${index}`) }],
      ["tags", { p_tags: ["Liver", "liver"] }],
      ["tags", { p_tags: ["x".repeat(33)] }],
      ["tags", { p_tags: [" padded"] }],
      ["tags", { p_tags: [""] }],
      ["tags", { p_tags: ["ok", null] }],
      ["tags", { p_tags: ["tab\there"] }],
      ["lab_id", { p_lab_id: "Organ" }],
      ["metadata", { p_metadata: "[]" }],
      ["metadata", { p_metadata: '"text"' }],
      ["metadata", { p_metadata: null }],
      ["metadata", { p_metadata: JSON.stringify({ blob: "x".repeat(65_536) }) }],
      ["files: 1 to 64 entries", { p_files: null }],
      ["files: 1 to 64 entries", { p_files: "{}" }],
      ["files: 1 to 64 entries", { p_files: "[]" }],
      ["file entry must be an object", files(["a.glb"])],
      ["filename", file({ filename: null })],
      ["filename", file({ filename: "" })],
      ["filename", file({ filename: ".hidden" })],
      ["filename", file({ filename: "..", asset_id: undefined })],
      ["filename", file({ filename: "dir/a.glb" })],
      ["filename", file({ filename: "dir\\a.glb" })],
      ["filename", file({ filename: " lead.glb" })],
      ["filename", file({ filename: "trail.glb " })],
      ["filename", file({ filename: "bell\u0007.glb" })],
      ["filename", file({ filename: "line\nbreak.glb" })],
      ["filename", file({ filename: `${"x".repeat(177)}.glb` })],
      ["asset_id of a.glb", file({ asset_id: "nope" })],
      ["asset_id of a.glb", file({ asset_id: null })],
      ["role of a.glb", file({ role: "bogus" })],
      ["role of a.glb", file({ role: "Mesh" })],
      ["position of a.glb", file({ position: -1 })],
      ["position of a.glb", file({ position: 1001 })],
      ["position of a.glb", file({ position: 1.5 })],
      ["position of a.glb", file({ position: "first" })],
      ["position of a.glb", file({ position: true })],
    ])("answers 422 for an invalid %s", async (detail, overrides) => {
      const before = await itemCount(owner);
      await expectPlatformError(create(overrides), "invalid_input", 422, detail);
      expect(await itemCount(owner)).toBe(before);
    });

    it("answers 422 for more than 64 files and for filenames that differ only in case", async () => {
      const many = Array.from({ length: 65 }, (_, index) => ({ filename: `part-${index}.bin`, asset_id: asset.id }));
      await expectPlatformError(create(files(many)), "invalid_input", 422, "files: 1 to 64 entries");
      await expectPlatformError(
        create(files([{ filename: "Mesh.GLB", asset_id: asset.id }, { filename: "mesh.glb", asset_id: asset.id }])),
        "invalid_input",
        422,
        "duplicate filename mesh.glb",
      );
      const max = Array.from({ length: 64 }, (_, index) => ({ filename: `part-${index}.bin`, asset_id: asset.id, position: 1000 }));
      const item = one(await create(files(max)));
      expect(await filesOf(item.id)).toHaveLength(64);
    });

    it("accepts the edges: 20 tags of 32 characters, a 180-character name with spaces and unicode, 60 KB of metadata", async () => {
      const tags = Array.from({ length: 20 }, (_, index) => `${String(index).padStart(2, "0")}${"t".repeat(30)}`);
      const filename = `Leber – ${"x".repeat(168)}.glb`;
      expect(filename).toHaveLength(180);
      const item = one(
        await create({
          p_tags: tags,
          p_files: JSON.stringify([{ filename, asset_id: asset.id, position: "7" }]),
          p_metadata: JSON.stringify({ blob: "x".repeat(60_000) }),
        }),
      );
      expect(item.tags).toEqual(tags);
      expect(await filesOf(item.id)).toEqual([{ filename, asset_id: asset.id, role: "other", position: 7 }]);
    });

    it("refuses unready (409) and foreign or unknown (404) files, and leaves nothing behind", async () => {
      const pending = await pendingAsset(t, owner);
      const foreign = await readyAsset(t, other);
      const before = await itemCount(owner);
      await expectPlatformError(create(file({ asset_id: pending.id })), "asset_not_ready", 409, "a.glb");
      await expectPlatformError(create(file({ asset_id: foreign.id })), "not_found", 404, "a.glb");
      await expectPlatformError(create(file({ asset_id: "00000000-0000-4000-8000-000000000000" })), "not_found", 404);
      // a bad file after good ones: the whole item is rolled back, files included
      await expectPlatformError(
        create(files([{ filename: "good.glb", asset_id: asset.id }, { filename: "bad.glb", asset_id: pending.id }])),
        "asset_not_ready",
        409,
      );
      await expectPlatformError(create({ p_thumbnail_asset_id: pending.id }), "asset_not_ready", 409, "thumbnail_asset_id");
      await expectPlatformError(create({ p_thumbnail_asset_id: foreign.id }), "not_found", 404, "thumbnail_asset_id");
      expect(await itemCount(owner)).toBe(before);
      expect(await t.admin("select 1 from public.library_item_files where owner_id = $1 and filename = 'good.glb'", [owner])).toEqual([]);
    });

    it("links only the caller's own project and a version of that project", async () => {
      const mine = await createProject(t, owner);
      const second = await createProject(t, owner);
      const theirs = await createProject(t, other);
      await expectPlatformError(create({ p_source_project_id: theirs.project.id }), "not_found", 404, "source_project_id");
      await expectPlatformError(create({ p_source_version_id: theirs.head.id }), "not_found", 404, "source_version_id");
      await expectPlatformError(
        create({ p_source_project_id: mine.project.id, p_source_version_id: second.head.id }),
        "not_found",
        404,
        "source_version_id",
      );
      const linked = one(await create({ p_source_project_id: mine.project.id, p_source_version_id: mine.head.id }));
      expect(linked).toMatchObject({ source_project_id: mine.project.id, source_version_id: mine.head.id });
      const versionOnly = one(await create({ p_source_version_id: second.head.id }));
      expect(versionOnly).toMatchObject({ source_project_id: null, source_version_id: second.head.id });
    });
  });

  it("keeps at most 5000 items per account, the trash included", async () => {
    const owner = await t.createUser();
    const other = await t.createUser();
    await t.admin(
      "insert into public.library_items (owner_id, kind, title) select $1, 'image', 'Bulk ' || s from generate_series(1, 4999) as s",
      [owner],
    );
    await t.admin("update public.library_items set trashed_at = now() where owner_id = $1 and title = 'Bulk 1'", [owner]);
    const last = await createLibraryItem(t, owner, { title: "Number 5000" });
    await expectPlatformError(createLibraryItem(t, owner), "limit_reached", 403, "at most 5000 library items per account");
    // another account is unaffected; deleting forever frees a slot
    await createLibraryItem(t, other);
    await t.as(user(owner), "update public.library_items set trashed_at = now() where id = $1", [last.id]);
    await t.as(user(owner), "delete from public.library_items where id = $1", [last.id]);
    await createLibraryItem(t, owner);
  });

  describe("client edits", () => {
    it("lets the owner retitle, describe, tag, favourite and trash an item, validated by the table", async () => {
      const owner = await t.createUser();
      const item = await createLibraryItem(t, owner);
      await t.admin("update public.library_items set updated_at = '2026-01-01T00:00:00Z' where id = $1", [item.id]);
      await t.as(user(owner), "update public.library_items set title = 'Kept', description = 'Notes', tags = $2, favorite = true where id = $1", [
        item.id,
        ["a", "b"],
      ]);
      const edited = one(await t.admin<LibraryItemRow>("select * from public.library_items where id = $1", [item.id]));
      expect(edited).toMatchObject({ title: "Kept", description: "Notes", tags: ["a", "b"], favorite: true });
      expect(recent(edited.updated_at)).toBe(true);
      for (const tags of [["A", "a"], ["x".repeat(33)], Array.from({ length: 21 }, (_, index) => `t${index}`)]) {
        await expectSqlState(t.as(user(owner), "update public.library_items set tags = $2 where id = $1", [item.id, tags]), "23514");
      }
      await expectSqlState(t.as(user(owner), "update public.library_items set title = ' x' where id = $1", [item.id]), "23514");
      await t.as(user(owner), "update public.library_items set trashed_at = '2000-01-01' where id = $1", [item.id]);
      const trashed = one(await t.admin<LibraryItemRow>("select * from public.library_items where id = $1", [item.id]));
      expect(recent(trashed.trashed_at)).toBe(true);
    });

    it("deletes forever only from the trash, files included", async () => {
      const owner = await t.createUser();
      const item = await createLibraryItem(t, owner);
      expect((await t.run(user(owner), "delete from public.library_items where id = $1", [item.id])).affectedRows).toBe(0);
      await t.as(user(owner), "update public.library_items set trashed_at = now() where id = $1", [item.id]);
      expect((await t.run(user(owner), "delete from public.library_items where id = $1", [item.id])).affectedRows).toBe(1);
      expect(await filesOf(item.id)).toEqual([]);
    });
  });
});

describe("imported objects", () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  const importCount = async (owner: string) =>
    one(await t.admin<{ n: number } & Row>("select count(*)::int as n from public.imported_objects where owner_id = $1", [owner])).n;

  it("registers an import with its original, preview and thumbnail, sized by distinct files", async () => {
    const owner = await t.createUser();
    const original = await readyAsset(t, owner, { size: 300, mime: "application/octet-stream" });
    const display = await readyAsset(t, owner, { size: 200, mime: "model/gltf-binary" });
    const thumbnail = await readyAsset(t, owner, { size: 50, mime: "image/webp" });
    const imported = await createImportedObject(t, owner, { title: "  Unity liver  ", original, display, thumbnail, sourceApp: "unity", tags: ["unity"] });
    expect(imported).toMatchObject({
      owner_id: owner,
      title: "Unity liver",
      source_app: "unity",
      source_detail: "Blender 4.2",
      detected_by: "metadata",
      format: "fbx",
      original_asset_id: original.id,
      display_asset_id: display.id,
      thumbnail_asset_id: thumbnail.id,
      stats: { meshes: 1, vertices: 8, triangles: 12 },
      tags: ["unity"],
      byte_size: 550,
      trashed_at: null,
    });
    const glb = await readyAsset(t, owner, { size: 120, mime: "model/gltf-binary" });
    const sameFile = await createImportedObject(t, owner, { format: "glb", original: glb, display: glb, thumbnail: null });
    expect(sameFile.byte_size).toBe(120);
  });

  it("accepts every source application, detection method and format the client knows", async () => {
    const owner = await t.createUser();
    const original = await readyAsset(t, owner);
    const create = (sourceApp: string, detectedBy: string, format: string) =>
      t.as<ImportedObjectRow>(
        user(owner),
        "select * from public.create_imported_object(p_title => 'x', p_format => $1, p_original_asset_id => $2, p_source_app => $3, p_detected_by => $4)",
        [format, original.id, sourceApp, detectedBy],
      );
    for (const sourceApp of clientLiterals("SourceApp")) {
      expect(one(await create(sourceApp, "user", "glb")).source_app).toBe(sourceApp);
    }
    for (const detectedBy of clientLiterals("DetectedBy")) {
      expect(one(await create("unknown", detectedBy, "glb")).detected_by).toBe(detectedBy);
    }
    for (const format of clientLiterals("ImportFormat")) {
      expect(one(await create("unknown", "none", format)).format).toBe(format);
    }
    const defaults = one(
      await t.as<ImportedObjectRow>(user(owner), "select * from public.create_imported_object('Bare', 'obj', $1)", [original.id]),
    );
    expect(defaults).toMatchObject({ source_app: "unknown", detected_by: "none", source_detail: null, stats: {}, tags: [] });
  });

  it("keeps at most 2000 imported objects per account, the trash included", async () => {
    const owner = await t.createUser();
    const original = await readyAsset(t, owner);
    await t.admin(
      `insert into public.imported_objects (owner_id, title, format, original_asset_id, trashed_at)
       select $1, 'Bulk ' || s, 'glb', $2, case when s = 1 then now() end from generate_series(1, 1999) as s`,
      [owner, original.id],
    );
    await createImportedObject(t, owner, { original });
    await expectPlatformError(
      createImportedObject(t, owner, { original }),
      "limit_reached",
      403,
      "at most 2000 imported objects per account",
    );
  });

  describe("validation", () => {
    let owner: string;
    let original: AssetRef;

    beforeAll(async () => {
      owner = await t.createUser();
      original = await readyAsset(t, owner);
    });

    const create = (overrides: Record<string, unknown>) => {
      const args: Record<string, unknown> = {
        p_title: "Import",
        p_format: "glb",
        p_original_asset_id: original.id,
        p_source_app: "blender",
        p_source_detail: null,
        p_detected_by: "filename",
        p_display_asset_id: null,
        p_thumbnail_asset_id: null,
        p_stats: "{}",
        p_tags: [],
        ...overrides,
      };
      const names = Object.keys(args);
      return t.as<ImportedObjectRow>(
        user(owner),
        `select * from public.create_imported_object(${names.map((name, index) => `${name} => $${index + 1}`).join(", ")})`,
        names.map((name) => args[name]),
      );
    };

    it.each([
      ["title", { p_title: "" }],
      ["title", { p_title: "x".repeat(121) }],
      ["format", { p_format: "GLB" }],
      ["format", { p_format: "blend" }],
      ["format", { p_format: null }],
      ["source_app", { p_source_app: "Unity" }],
      ["source_app", { p_source_app: "godot" }],
      ["source_app", { p_source_app: null }],
      ["detected_by", { p_detected_by: "auto" }],
      ["detected_by", { p_detected_by: null }],
      ["stats", { p_stats: "[]" }],
      ["stats", { p_stats: null }],
      ["stats", { p_stats: JSON.stringify({ notes: ["x".repeat(65_536)] }) }],
      ["tags", { p_tags: ["a", "A"] }],
      ["tags", { p_tags: Array.from({ length: 21 }, (_, index) => `t${index}`) }],
      ["original_asset_id", { p_original_asset_id: null }],
    ])("answers 422 for an invalid %s", async (detail, overrides) => {
      const before = await importCount(owner);
      await expectPlatformError(create(overrides), "invalid_input", 422, detail);
      expect(await importCount(owner)).toBe(before);
    });

    it("refuses unready (409) and foreign or unknown (404) files", async () => {
      const other = await t.createUser();
      const pending = await pendingAsset(t, owner);
      const foreign = await readyAsset(t, other);
      const before = await importCount(owner);
      await expectPlatformError(create({ p_original_asset_id: pending.id }), "asset_not_ready", 409, "original_asset_id");
      await expectPlatformError(create({ p_display_asset_id: pending.id }), "asset_not_ready", 409, "display_asset_id");
      await expectPlatformError(create({ p_original_asset_id: foreign.id }), "not_found", 404, "original_asset_id");
      await expectPlatformError(create({ p_display_asset_id: foreign.id }), "not_found", 404, "display_asset_id");
      await expectPlatformError(
        create({ p_thumbnail_asset_id: "00000000-0000-4000-8000-000000000000" }),
        "not_found",
        404,
        "thumbnail_asset_id",
      );
      expect(await importCount(owner)).toBe(before);
    });

    it("trims the source detail, drops a blank one and keeps at most 200 characters", async () => {
      expect(one(await create({ p_source_detail: "   " })).source_detail).toBeNull();
      expect(one(await create({ p_source_detail: "  Unity 6000.0.23f1  " })).source_detail).toBe("Unity 6000.0.23f1");
      expect(one(await create({ p_source_detail: "x".repeat(250) })).source_detail).toHaveLength(200);
    });
  });

  describe("client edits", () => {
    it("lets the owner retitle, tag, favourite, trash and correct the source application", async () => {
      const owner = await t.createUser();
      const imported = await createImportedObject(t, owner);
      await t.as(
        user(owner),
        "update public.imported_objects set title = 'Fixed', tags = $2, favorite = true, source_app = 'maya', detected_by = 'user' where id = $1",
        [imported.id, ["maya"]],
      );
      expect(one(await t.admin("select title, tags, favorite, source_app, detected_by from public.imported_objects where id = $1", [imported.id]))).toEqual({
        title: "Fixed",
        tags: ["maya"],
        favorite: true,
        source_app: "maya",
        detected_by: "user",
      });
      await expectSqlState(t.as(user(owner), "update public.imported_objects set source_app = 'godot' where id = $1", [imported.id]), "23514");
      await expectSqlState(t.as(user(owner), "update public.imported_objects set detected_by = 'guess' where id = $1", [imported.id]), "23514");
      await expectSqlState(t.as(user(owner), "update public.imported_objects set tags = $2 where id = $1", [imported.id, ["", "x"]]), "23514");
      await t.as(user(owner), "update public.imported_objects set trashed_at = '1990-01-01' where id = $1", [imported.id]);
      const trashed = one(await t.admin<ImportedObjectRow>("select * from public.imported_objects where id = $1", [imported.id]));
      expect(recent(trashed.trashed_at)).toBe(true);
      expect((await t.run(user(owner), "delete from public.imported_objects where id = $1", [imported.id])).affectedRows).toBe(1);
    });
  });
});
