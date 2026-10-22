// Profiles: created by the sign-up trigger from the account's metadata (a bad, reserved or taken username never fails
// the sign-up), edited by the owner within the table's rules, an avatar only from the owner's own ready files, and the
// public username_available check used by the sign-up form.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { anon, createTestDb, expectDenied, expectPlatformError, expectSqlState, user, type Row, type TestDb } from "./support/db";
import { one, pendingAsset, readyAsset } from "./support/fixtures";

// PGlite is fast, but a busy CI runner is not: database tests get explicit headroom.
vi.setConfig({ testTimeout: 30_000 });

interface ProfileRow extends Row {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_asset_id: string | null;
  plan_id: string;
  appearance: string;
  created_at: Date;
  updated_at: Date;
}

describe("profiles", () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  const profile = async (id: string) =>
    one(await t.admin<ProfileRow>("select * from public.profiles where id = $1", [id]), "profile");
  const signUp = async (metadata: Record<string, unknown>) => profile(await t.createUser({ metadata }));

  describe("sign-up trigger", () => {
    it("takes a trimmed, lower-cased username and a trimmed display name; the plan is free", async () => {
      const created = await signUp({ username: "  Dana.Example  ", display_name: "  Dana Example " });
      expect(created).toMatchObject({
        username: "dana.example",
        display_name: "Dana Example",
        avatar_asset_id: null,
        plan_id: "free",
        appearance: "system",
      });
    });

    it.each([
      ["too short", "ab"],
      ["too long", "a".repeat(31)],
      ["a space", "has space"],
      ["non-ASCII letters", "émile"],
      ["a leading separator", "-lead"],
      ["a trailing separator", "trail_"],
      ["repeated separators", "two..dots"],
      ["mixed adjacent separators", "a_-b"],
      ["punctuation", "semi;colon"],
      ["blank", "   "],
      ["a reserved name", "admin"],
      ["a reserved name in capitals", "ADMIN"],
      ["a reserved route name", "trash"],
      ["a reserved hyphenated name", "no-reply"],
      ["the product name", "Viscera"],
    ])("drops a username with %s and still creates the account", async (_reason, username) => {
      const created = await signUp({ username, display_name: "Someone" });
      expect(created.username).toBeNull();
      expect(created.display_name).toBe("Someone");
    });

    it("accepts the edges of the username rules", async () => {
      expect((await signUp({ username: "abc" })).username).toBe("abc");
      expect((await signUp({ username: `a${"b".repeat(28)}c` })).username).toHaveLength(30);
      expect((await signUp({ username: "a.b_c-d9" })).username).toBe("a.b_c-d9");
    });

    it("drops a username that is already taken (in any case) without failing the sign-up", async () => {
      const first = await signUp({ username: "taken-name" });
      const second = await signUp({ username: "Taken-Name", display_name: "Second" });
      expect(first.username).toBe("taken-name");
      expect(second).toMatchObject({ username: null, display_name: "Second" });
    });

    it.each([
      [{ display_name: "Chosen", full_name: "Provider Full", name: "Provider" }, "Chosen"],
      [{ full_name: "Provider Full", name: "Provider" }, "Provider Full"],
      [{ name: "Provider" }, "Provider"],
      [{ display_name: "", full_name: "Provider Full" }, "Provider Full"],
      [{ display_name: "   ", name: "Provider" }, "Provider"],
      [{ display_name: " ", full_name: " ", name: " " }, null],
      [{}, null],
    ])("takes the display name from %j", async (metadata, expected) => {
      expect((await signUp(metadata)).display_name).toBe(expected);
    });

    it("keeps at most 80 characters of a display name, trimmed again after the cut", async () => {
      const created = await signUp({ display_name: `${"a".repeat(79)} ${"b".repeat(30)}` });
      expect(created.display_name).toBe("a".repeat(79));
      expect((await signUp({ full_name: "x".repeat(200) })).display_name).toHaveLength(80);
    });

    it("never fails on odd metadata types, JSON null or no metadata at all", async () => {
      const created = await signUp({ username: ["array"], display_name: { nested: true }, name: 42 });
      expect(created.username).toBeNull();
      expect(created.display_name).toBe('{"nested": true}');
      for (const metadata of ["null", "[1, 2]", '"text"', null]) {
        const id = randomUUID();
        await t.admin("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)", [
          id,
          `${id}@example.test`,
          metadata,
        ]);
        expect(await profile(id)).toMatchObject({ username: null, display_name: null, plan_id: "free" });
      }
    });

    it("follows the account: deleting the auth user deletes the profile and frees the username", async () => {
      const id = await t.createUser({ metadata: { username: "short-lived" } });
      expect(one(await t.as(anon, "select public.username_available('short-lived') as ok"))).toEqual({ ok: false });
      await t.admin("delete from auth.users where id = $1", [id]);
      expect(await t.admin("select 1 from public.profiles where id = $1", [id])).toEqual([]);
      expect(one(await t.as(anon, "select public.username_available('short-lived') as ok"))).toEqual({ ok: true });
    });
  });

  describe("client edits", () => {
    it("lets the owner change username, display name and appearance within the table's rules", async () => {
      const id = await t.createUser({ metadata: { username: "editor-one" } });
      await t.createUser({ metadata: { username: "editor-two" } });
      await t.admin("update public.profiles set updated_at = '2026-01-01T00:00:00Z' where id = $1", [id]);
      await t.as(user(id), "update public.profiles set username = 'editor.renamed', display_name = 'Editor', appearance = 'light'");
      const edited = await profile(id);
      expect(edited).toMatchObject({ username: "editor.renamed", display_name: "Editor", appearance: "light" });
      expect(edited.updated_at.getTime()).toBeGreaterThan(Date.parse("2026-01-02T00:00:00Z"));

      for (const username of ["Editor", "ad", "admin", "a..b", " padded"]) {
        await expectSqlState(t.as(user(id), "update public.profiles set username = $1", [username]), "23514");
      }
      await expectSqlState(t.as(user(id), "update public.profiles set username = 'editor-two'"), "23505");
      for (const displayName of ["", " Leading", "Trailing ", "x".repeat(81)]) {
        await expectSqlState(t.as(user(id), "update public.profiles set display_name = $1", [displayName]), "23514");
      }
      await expectSqlState(t.as(user(id), "update public.profiles set appearance = 'sepia'"), "23514");
      await expectDenied(t.as(user(id), "update public.profiles set plan_id = 'pro'"));
      await t.as(user(id), "update public.profiles set username = null, display_name = null");
      expect(await profile(id)).toMatchObject({ username: null, display_name: null, plan_id: "free" });
    });

    it("takes an avatar only from the owner's own ready files", async () => {
      const id = await t.createUser();
      const other = await t.createUser();
      const avatar = await readyAsset(t, id, { mime: "image/png" });
      const pending = await pendingAsset(t, id, "image/png");
      const foreign = await readyAsset(t, other, { mime: "image/png" });
      const setAvatar = (assetId: string | null) =>
        t.as(user(id), "update public.profiles set avatar_asset_id = $1", [assetId]);
      await expectPlatformError(setAvatar(pending.id), "asset_not_ready", 409, "avatar_asset_id");
      await expectPlatformError(setAvatar(foreign.id), "not_found", 404, "avatar_asset_id");
      await expectPlatformError(setAvatar("00000000-0000-4000-8000-000000000000"), "not_found", 404);
      await setAvatar(avatar.id);
      expect((await profile(id)).avatar_asset_id).toBe(avatar.id);
      await setAvatar(avatar.id);
      await t.as(user(id), "update public.profiles set display_name = 'Still fine'");
      await setAvatar(null);
      expect((await profile(id)).avatar_asset_id).toBeNull();
    });
  });

  describe("username_available", () => {
    it("answers anon and signed-in callers: valid and free only", async () => {
      const id = await t.createUser({ metadata: { username: "occupied" } });
      const check = async (actor: Parameters<TestDb["as"]>[0], name: string | null) =>
        one(await t.as<{ ok: boolean } & Row>(actor, "select public.username_available($1) as ok", [name])).ok;
      for (const actor of [anon, user(id)]) {
        expect(await check(actor, "free-name")).toBe(true);
        expect(await check(actor, "occupied")).toBe(false);
        expect(await check(actor, "Occupied")).toBe(false);
        expect(await check(actor, "Free-Name")).toBe(false);
        expect(await check(actor, "admin")).toBe(false);
        expect(await check(actor, "x")).toBe(false);
        expect(await check(actor, "")).toBe(false);
        expect(await check(actor, null)).toBe(false);
      }
      await t.as(user(id), "update public.profiles set username = null");
      expect(await check(anon, "occupied")).toBe(true);
    });
  });
});
