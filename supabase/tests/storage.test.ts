// The user-content bucket policies on storage.objects (the shim's storage schema mirrors Supabase's): a signed-in user
// writes only into their own folder, only at a path they reserved and only while that reservation is pending (not once
// it is ready, rejected or being collected); SQL deletes are refused to everyone, as on Supabase, so objects leave only
// through the Storage API; other buckets and anon get nothing. These statements are what the Storage API runs on the
// user's behalf, so they are tested as the user.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { anon, createTestDb, expectDenied, expectPlatformError, service, sha256, user, type Actor, type Row, type TestDb } from "./support/db";
import { one, uniqueContent } from "./support/fixtures";

// PGlite is fast, but a busy CI runner is not: database tests get explicit headroom.
vi.setConfig({ testTimeout: 30_000 });

interface ObjectRow extends Row {
  name: string;
  metadata: { size?: number } | null;
}

describe("storage policies", () => {
  let t: TestDb;
  let a: string;
  let b: string;

  const insertObject = (owner: string | null, name: string, size = 10, bucket = "user-content") =>
    t.as(
      owner ? user(owner) : anon,
      "insert into storage.objects (bucket_id, name, owner, metadata) values ($1, $2, $3, $4)",
      [bucket, name, owner, JSON.stringify({ size })],
    );

  async function objectRow(name: string): Promise<ObjectRow | undefined> {
    const [row] = await t.admin<ObjectRow>("select name, metadata from storage.objects where name = $1", [name]);
    return row;
  }

  /** A SQL delete fails as a whole, whoever runs it and whatever it would match (Supabase's storage.protect_delete). */
  async function expectDeleteBlocked(actor: Actor, sql: string, params: unknown[] = []): Promise<void> {
    let caught: unknown;
    try {
      await t.run(actor, sql, params);
    } catch (error) {
      caught = error;
    }
    expect(caught, sql).toBeDefined();
    expect((caught as { code?: string }).code).toBe("42501");
    expect((caught as Error).message).toMatch(/Direct deletion from storage tables is not allowed/);
  }

  async function reserved(owner: string) {
    const content = uniqueContent("object");
    const reservation = await t.reserve(owner, content);
    return { ...reservation, size: new TextEncoder().encode(content).byteLength, sha: sha256(content) };
  }

  beforeAll(async () => {
    t = await createTestDb();
    a = await t.createUser();
    b = await t.createUser();
    await t.admin(
      "insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true), ('scratch', 'scratch', false)",
    );
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  it("accepts an upload into the owner's folder at their own pending reservation", async () => {
    const reservation = await reserved(a);
    expect(reservation.status).toBe("pending");
    expect(reservation.object_path).toBe(`${a}/${reservation.sha.slice(0, 2)}/${reservation.sha}`);
    await insertObject(a, reservation.object_path, reservation.size);
    expect((await objectRow(reservation.object_path))?.metadata?.size).toBe(reservation.size);
  });

  it("refuses any path that is not one of the caller's pending reservations", async () => {
    const mine = await reserved(a);
    const theirs = await reserved(b);
    const unreserved = sha256(uniqueContent("never reserved"));
    const attempts = [
      `${a}/${unreserved.slice(0, 2)}/${unreserved}`,
      theirs.object_path,
      `${b}/${mine.sha.slice(0, 2)}/${mine.sha}`,
      `${a}/../${b}/${theirs.sha.slice(0, 2)}/${theirs.sha}`,
      `${a}/${mine.sha.slice(0, 2)}/${mine.sha}/extra`,
      `${a}/${mine.sha.slice(0, 2)}/${mine.sha.toUpperCase()}`,
      `/${mine.object_path}`,
      `${mine.object_path}.html`,
      `${a}/${mine.sha}`,
    ];
    for (const name of attempts) {
      await expectDenied(insertObject(a, name));
    }
    // B cannot fill A's reservation either
    await expectDenied(insertObject(b, mine.object_path, mine.size));
    expect(await objectRow(mine.object_path)).toBeUndefined();
  });

  it("refuses to write once the reservation is ready: no second upload, no overwrite, no upsert", async () => {
    const reservation = await reserved(a);
    await insertObject(a, reservation.object_path, reservation.size);
    await t.confirm(a, reservation.asset_id);

    await expectDenied(insertObject(a, reservation.object_path, reservation.size));
    const overwrite = await t.run(
      user(a),
      "update storage.objects set metadata = $2 where bucket_id = 'user-content' and name = $1",
      [reservation.object_path, JSON.stringify({ size: 1 })],
    );
    expect(overwrite.affectedRows).toBe(0);
    await expectDenied(
      t.as(
        user(a),
        `insert into storage.objects (bucket_id, name, metadata) values ('user-content', $1, $2)
         on conflict (bucket_id, name) do update set metadata = excluded.metadata`,
        [reservation.object_path, JSON.stringify({ size: 1 })],
      ),
    );
    const moved = await t.run(user(a), "update storage.objects set name = name || '-moved' where name = $1", [
      reservation.object_path,
    ]);
    expect(moved.affectedRows).toBe(0);
    expect((await objectRow(reservation.object_path))?.metadata?.size).toBe(reservation.size);
  });

  it("lets a pending upload be replaced (upsert), so an interrupted upload can be retried", async () => {
    const reservation = await reserved(a);
    await insertObject(a, reservation.object_path, 3);
    const replaced = await t.run(
      user(a),
      `insert into storage.objects (bucket_id, name, metadata) values ('user-content', $1, $2)
       on conflict (bucket_id, name) do update set metadata = excluded.metadata`,
      [reservation.object_path, JSON.stringify({ size: reservation.size })],
    );
    expect(replaced.affectedRows).toBe(1);
    const asset = await t.confirm(a, reservation.asset_id);
    expect(asset.status).toBe("ready");
  });

  it("refuses writes to a rejected reservation until it is reserved again, and to one being collected", async () => {
    const reservation = await reserved(a);
    await insertObject(a, reservation.object_path, reservation.size + 5);
    await expectPlatformError(t.confirm(a, reservation.asset_id), "size_mismatch", 409);
    const upsert = (size: number) =>
      t.as(
        user(a),
        `insert into storage.objects (bucket_id, name, metadata) values ('user-content', $1, $2)
         on conflict (bucket_id, name) do update set metadata = excluded.metadata`,
        [reservation.object_path, JSON.stringify({ size })],
      );
    await expectDenied(upsert(reservation.size));
    expect((await objectRow(reservation.object_path))?.metadata?.size).toBe(reservation.size + 5);
    // reserving the same bytes again reopens the reservation for one more upload
    const again = one(
      await t.as<{ asset_id: string; status: string } & Row>(user(a), "select * from public.reserve_asset($1, $2, 'application/gzip')", [
        reservation.sha,
        reservation.size,
      ]),
    );
    expect(again).toMatchObject({ asset_id: reservation.asset_id, status: "pending" });
    await upsert(reservation.size);
    expect((await t.confirm(a, reservation.asset_id)).status).toBe("ready");

    const collected = await reserved(a);
    await t.admin("update public.assets set status = 'deleting' where id = $1", [collected.asset_id]);
    await expectDenied(insertObject(a, collected.object_path, collected.size));
    expect(await objectRow(collected.object_path)).toBeUndefined();
  });

  it("never moves an object out of the owner's reservations, folder or bucket", async () => {
    const first = await reserved(a);
    const theirs = await reserved(b);
    await insertObject(a, first.object_path, first.size);
    const unreserved = sha256(uniqueContent("unreserved"));
    for (const clause of [
      ["name = $2", theirs.object_path],
      ["name = $2", `${a}/${unreserved.slice(0, 2)}/${unreserved}`],
      ["bucket_id = $2", "scratch"],
    ] as const) {
      await expectDenied(t.as(user(a), `update storage.objects set ${clause[0]} where name = $1`, [first.object_path, clause[1]]));
    }
    expect(await objectRow(first.object_path)).toBeDefined();
  });

  it("refuses every SQL delete, even of the owner's own objects and from the service role; the Storage API removes them", async () => {
    const reservation = await reserved(a);
    await insertObject(a, reservation.object_path, reservation.size);
    for (const actor of [user(a), user(b), service]) {
      await expectDeleteBlocked(actor, "delete from storage.objects where name = $1", [reservation.object_path]);
    }
    await expectDeleteBlocked(user(a), "delete from storage.objects");
    await expectDeleteBlocked(user(a), "delete from storage.objects where false");
    // not even the database owner: only the Storage API's own statements may delete
    await expect(t.admin("delete from storage.buckets where id = 'scratch'")).rejects.toThrow(/Direct deletion from storage tables/);
    await expect(t.admin("delete from storage.objects where name = $1", [reservation.object_path])).rejects.toThrow(
      /Direct deletion from storage tables/,
    );
    expect(await objectRow(reservation.object_path)).toBeDefined();
    expect(await t.removeObjects([reservation.object_path])).toBe(1);
    expect(await objectRow(reservation.object_path)).toBeUndefined();
  });

  it("shows each user only their own folder of user-content", async () => {
    await t.admin("insert into storage.objects (bucket_id, name) values ('user-content', 'shared/readme.txt')");
    const forA = await t.as<ObjectRow>(user(a), "select name, metadata from storage.objects");
    expect(forA.length).toBeGreaterThan(0);
    for (const row of forA) expect(row.name.startsWith(`${a}/`)).toBe(true);
    const reservation = await reserved(b);
    await insertObject(b, reservation.object_path, reservation.size);
    const aLooksAtB = await t.as(user(a), "select * from storage.objects where name like $1", [`${b}/%`]);
    expect(aLooksAtB).toEqual([]);
    const forB = await t.as<ObjectRow>(user(b), "select name from storage.objects");
    expect(forB.map((row) => row.name)).toEqual([reservation.object_path]);
  });

  it("refuses every other bucket, public or private", async () => {
    const reservation = await reserved(a);
    await t.admin("insert into storage.objects (bucket_id, name) values ('avatars', $1)", [`${a}/face.png`]);
    for (const bucket of ["avatars", "scratch"]) {
      await expectDenied(insertObject(a, reservation.object_path, reservation.size, bucket));
      await expectDenied(insertObject(a, `${a}/face-2.png`, 10, bucket));
    }
    expect(await t.as(user(a), "select * from storage.objects where bucket_id <> 'user-content'")).toEqual([]);
    const updated = await t.run(user(a), "update storage.objects set metadata = '{}' where bucket_id = 'avatars'");
    expect(updated.affectedRows).toBe(0);
  });

  it("gives anon nothing", async () => {
    const reservation = await reserved(a);
    await expectDenied(insertObject(null, reservation.object_path, reservation.size));
    await expectDenied(insertObject(null, "public/anything.png", 10, "avatars"));
    expect(await t.as(anon, "select * from storage.objects")).toEqual([]);
    expect((await t.run(anon, "update storage.objects set metadata = '{}'")).affectedRows).toBe(0);
    await expectDeleteBlocked(anon, "delete from storage.objects");
  });
});
