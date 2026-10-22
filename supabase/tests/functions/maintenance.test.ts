// maintenance handler (supabase/functions/maintenance/handler.ts) against a fake database and Storage that follow the
// SQL in …_platform_auth_usage_maintenance.sql: maintenance_orphan_assets lists collectable unreferenced assets, rows
// already 'deleting' first (p_limit clamped to 1…1000); maintenance_forget_assets marks the ones still collectable
// 'deleting' under lock and returns {asset_id, object_path}; maintenance_finish_assets drops rows still 'deleting';
// maintenance_orphan_objects lists stored objects without an asset row (a 'deleting' row still describes its object).
// A fake clock advances with every call, so the time budget is exercised deterministically.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LogFields } from "../../functions/_shared/log.ts";
import type {
  RpcClient,
  ServiceResult,
  StorageBucket,
  StorageClient,
  StorageEntry,
} from "../../functions/_shared/ports.ts";
import {
  createMaintenanceHandler,
  type MaintenanceDeps,
  type MaintenanceSummary,
  MIN_SECRET_LENGTH,
} from "../../functions/maintenance/handler.ts";

const SECRET = "4f6c1b0e9a7d3c2b18e5f4a6d9c0b7a3";
const NOW = Date.UTC(2026, 9, 21, 3, 0, 0);
const OWNER = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const RUN_RESULT = {
  versions_pruned: 2,
  projects_purged: 1,
  library_items_purged: 0,
  imports_purged: 0,
  login_windows_dropped: 3,
};

function objectPath(seed: string): string {
  const sha = createHash("sha256").update(seed).digest("hex");
  return `${OWNER}/${sha.slice(0, 2)}/${sha}`;
}

interface AssetRow {
  id: string;
  path: string;
  status: "ready" | "deleting";
  referenced: boolean;
  /** Listed as an orphan but never marked (the SQL re-check keeps refusing it). */
  stubborn: boolean;
}

type RpcFailure = "error" | "throw" | "odd" | undefined;
type RemoveBehaviour = "ok" | "error" | "throw";

/** The database's maintenance functions and the user-content bucket, sharing one clock. */
class FakeProject implements RpcClient, StorageClient {
  readonly assets = new Map<string, AssetRow>();
  readonly objects = new Set<string>();
  readonly calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  readonly removeCalls: string[][] = [];
  readonly clock = { now: NOW };
  msPerCall = 0;
  msPerRemove = 0;
  /** Assets the user starts using again between the listing and the forgetting. */
  readonly usedAgainBeforeForget = new Set<string>();
  failRpc: (fn: string) => RpcFailure = () => undefined;
  removeBehaviour: (batch: string[], call: number) => RemoveBehaviour = () => "ok";
  private nextId = 0;

  /** `count` asset rows (oldest first); `stored` decides whether the object was ever uploaded. */
  addAssets(count: number, options: { referenced?: boolean; stored?: boolean; stubborn?: boolean } = {}): AssetRow[] {
    const rows: AssetRow[] = [];
    for (let index = 0; index < count; index += 1) {
      this.nextId += 1;
      const id = `00000000-0000-4000-8000-${String(this.nextId).padStart(12, "0")}`;
      const row: AssetRow = {
        id,
        path: objectPath(id),
        status: "ready",
        referenced: options.referenced ?? false,
        stubborn: options.stubborn ?? false,
      };
      this.assets.set(id, row);
      if (options.stored ?? true) this.objects.add(row.path);
      rows.push(row);
    }
    return rows;
  }

  /** Stored objects without any asset row (a deleted account's files). */
  addLooseObjects(count: number): string[] {
    const paths = Array.from({ length: count }, (_, index) => objectPath(`loose-${this.objects.size}-${index}`));
    for (const path of paths) this.objects.add(path);
    return paths;
  }

  calledFunctions(): string[] {
    return this.calls.map((call) => call.fn);
  }

  async rpc(fn: string, args: Record<string, unknown> = {}): Promise<ServiceResult<unknown>> {
    this.calls.push({ fn, args });
    this.clock.now += this.msPerCall;
    const failure = this.failRpc(fn);
    if (failure === "throw") throw new TypeError("fetch failed");
    if (failure === "error") return { data: null, error: { message: "canceling statement due to statement timeout" } };
    if (failure === "odd") return { data: { unexpected: true }, error: null };
    const limit = Math.max(1, Math.min(typeof args.p_limit === "number" ? args.p_limit : 500, 1000));
    switch (fn) {
      case "maintenance_run":
        return { data: RUN_RESULT, error: null };
      case "maintenance_orphan_assets": {
        const unreferenced = [...this.assets.values()].filter((asset) => !asset.referenced);
        const rows = [
          ...unreferenced.filter((asset) => asset.status === "deleting"),
          ...unreferenced.filter((asset) => asset.status !== "deleting"),
        ]
          .slice(0, limit)
          .map((asset) => ({ asset_id: asset.id, object_path: asset.path, byte_size: 64, status: asset.status }));
        return { data: rows, error: null };
      }
      case "maintenance_forget_assets": {
        const marked: Array<{ asset_id: string; object_path: string }> = [];
        for (const id of ids(args)) {
          const asset = this.assets.get(id);
          if (asset === undefined) continue;
          if (this.usedAgainBeforeForget.has(id)) asset.referenced = true;
          if (asset.referenced || asset.stubborn) continue;
          asset.status = "deleting";
          marked.push({ asset_id: asset.id, object_path: asset.path });
        }
        return { data: marked, error: null };
      }
      case "maintenance_finish_assets": {
        const dropped: Array<{ asset_id: string; object_path: string }> = [];
        for (const id of ids(args)) {
          const asset = this.assets.get(id);
          if (asset === undefined || asset.status !== "deleting" || asset.referenced) continue;
          this.assets.delete(id);
          dropped.push({ asset_id: asset.id, object_path: asset.path });
        }
        return { data: dropped, error: null };
      }
      case "maintenance_orphan_objects": {
        const described = new Set([...this.assets.values()].map((asset) => asset.path));
        const names = [...this.objects]
          .filter((name) => !described.has(name))
          .sort()
          .slice(0, limit)
          .map((name) => ({ object_name: name }));
        return { data: names, error: null };
      }
      default:
        return { data: null, error: { message: `unexpected function ${fn}` } };
    }
  }

  readonly storage = {
    from: (bucket: string): StorageBucket => {
      if (bucket !== "user-content") throw new Error(`unexpected bucket ${bucket}`);
      return {
        list: async (): Promise<ServiceResult<StorageEntry[]>> => ({ data: [], error: null }),
        remove: async (paths: string[]): Promise<ServiceResult<Array<{ name: string }>>> => {
          const call = this.removeCalls.push([...paths]);
          this.clock.now += this.msPerRemove;
          const behaviour = this.removeBehaviour(paths, call);
          if (behaviour === "throw") throw new TypeError("fetch failed");
          if (behaviour === "error") return { data: null, error: { message: "remove failed", status: 500 } };
          return { data: paths.filter((path) => this.objects.delete(path)).map((name) => ({ name })), error: null };
        },
      };
    },
  };
}

function ids(args: Record<string, unknown>): string[] {
  return Array.isArray(args.p_asset_ids) ? args.p_asset_ids.map(String) : [];
}

interface LogEntry {
  level: "info" | "error";
  event: string;
  fields: LogFields | undefined;
}

function handlerFor(project: FakeProject | null, deps: Partial<MaintenanceDeps> = {}) {
  const logs: LogEntry[] = [];
  const handler = createMaintenanceHandler({
    secret: SECRET,
    client: project,
    now: () => project?.clock.now ?? NOW,
    logger: {
      info: (event, fields) => logs.push({ level: "info", event, fields }),
      error: (event, fields) => logs.push({ level: "error", event, fields }),
    },
    ...deps,
  });
  return { handler, logs };
}

function call(options: { method?: string; secret?: string | null } = {}): Request {
  const headers = new Headers();
  const secret = options.secret === undefined ? SECRET : options.secret;
  if (secret !== null) headers.set("x-maintenance-secret", secret);
  return new Request("https://ref.supabase.co/functions/v1/maintenance", { method: options.method ?? "POST", headers });
}

async function summaryOf(response: Response): Promise<MaintenanceSummary & { error?: string; step?: string }> {
  return (await response.json()) as MaintenanceSummary & { error?: string; step?: string };
}

describe("maintenance: access", () => {
  it("answers only POST", async () => {
    const project = new FakeProject();
    const { handler } = handlerFor(project);
    for (const method of ["GET", "PUT", "DELETE", "OPTIONS"]) {
      const response = await handler(call({ method }));
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(project.calls).toEqual([]);
  });

  it(`refuses to run without a secret of at least ${MIN_SECRET_LENGTH} characters`, async () => {
    for (const [secret, reason] of [
      [null, "secret_missing"],
      ["too-short", "secret_too_short"],
    ] as const) {
      const project = new FakeProject();
      const { handler, logs } = handlerFor(project, { secret });
      const response = await handler(call({ secret: secret ?? SECRET }));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "not_configured" });
      expect(logs).toContainEqual({ level: "error", event: "not_configured", fields: { reason } });
      expect(project.calls).toEqual([]);
    }
  });

  it("requires the shared secret in x-maintenance-secret", async () => {
    const project = new FakeProject();
    const { handler } = handlerFor(project);
    for (const secret of [null, "", SECRET.toUpperCase(), SECRET.slice(0, -1), `${SECRET}0`, "x".repeat(SECRET.length)]) {
      const response = await handler(call({ secret }));
      expect(response.status, String(secret)).toBe(401);
      expect(await response.json()).toEqual({ error: "not_authenticated" });
    }
    expect(project.calls).toEqual([]);
  });

  it("checks the secret before reporting a missing service client", async () => {
    const { handler } = handlerFor(null);
    expect((await handler(call({ secret: "wrong-secret-of-some-length" }))).status).toBe(401);
    const response = await handler(call());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "not_configured" });
  });
});

describe("maintenance: a run", () => {
  it("runs the SQL housekeeping, then collects orphans in rounds until nothing is left", async () => {
    const project = new FakeProject();
    project.msPerCall = 5;
    const orphans = project.addAssets(1200);
    const neverUploaded = project.addAssets(5, { stored: false });
    const kept = project.addAssets(50, { referenced: true });
    const loose = project.addLooseObjects(300);
    const { handler, logs } = handlerFor(project);

    const response = await handler(call());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const summary = await summaryOf(response);
    expect(summary).toEqual({
      run: RUN_RESULT,
      assetsMarked: orphans.length + neverUploaded.length,
      assetsForgotten: orphans.length + neverUploaded.length,
      objectsRemoved: orphans.length,
      orphanObjectsRemoved: loose.length,
      rounds: 3,
      durationMs: project.calls.length * 5,
      stoppedBy: "drained",
      failedRemovals: 0,
    });

    expect(project.calledFunctions()).toEqual([
      "maintenance_run",
      "maintenance_orphan_assets",
      "maintenance_forget_assets",
      "maintenance_finish_assets",
      "maintenance_orphan_objects",
      "maintenance_orphan_assets",
      "maintenance_forget_assets",
      "maintenance_finish_assets",
      "maintenance_orphan_assets",
      "maintenance_forget_assets",
      "maintenance_finish_assets",
    ]);
    for (const { fn, args } of project.calls) {
      if (fn.startsWith("maintenance_orphan_")) expect(args).toEqual({ p_limit: 500 });
    }
    const sizes = (fn: string) => project.calls.filter((entry) => entry.fn === fn).map((entry) => ids(entry.args).length);
    expect(sizes("maintenance_forget_assets")).toEqual([500, 500, 205]);
    // every marked row is finished, after its objects were removed
    expect(sizes("maintenance_finish_assets")).toEqual([500, 500, 205]);
    expect(project.removeCalls.every((batch) => batch.length <= 1000)).toBe(true);
    // only the files of assets in use are left
    expect([...project.objects].sort()).toEqual(kept.map((asset) => asset.path).sort());
    expect([...project.assets.keys()].sort()).toEqual(kept.map((asset) => asset.id).sort());
    expect(logs).toContainEqual({
      level: "info",
      event: "maintenance_completed",
      fields: {
        assetsMarked: 1205,
        assetsForgotten: 1205,
        objectsRemoved: 1200,
        orphanObjectsRemoved: 300,
        rounds: 3,
        durationMs: summary.durationMs,
        stoppedBy: "drained",
        failedRemovals: 0,
      },
    });
  });

  it("marks, then removes the objects, then finishes: no row is dropped while its object may still exist", async () => {
    const project = new FakeProject();
    const orphans = project.addAssets(3);
    const order: string[] = [];
    const rpc = project.rpc.bind(project);
    project.rpc = async (fn, args) => {
      order.push(fn === "maintenance_finish_assets" ? `finish:${project.objects.size}` : fn);
      return rpc(fn, args);
    };
    let markedDuringRemoval = true;
    project.removeBehaviour = (batch) => {
      order.push(`remove:${batch.length}`);
      // the rows are marked, not gone, while their objects are being removed
      markedDuringRemoval &&= batch.every((path) =>
        [...project.assets.values()].some((asset) => asset.path === path && asset.status === "deleting"),
      );
      return "ok";
    };
    const response = await handlerFor(project).handler(call());
    expect(response.status).toBe(200);
    expect(markedDuringRemoval).toBe(true);
    expect(order).toEqual([
      "maintenance_run",
      "maintenance_orphan_assets",
      "maintenance_forget_assets",
      "remove:3",
      "finish:0",
      "maintenance_orphan_objects",
    ]);
    expect(project.calls.find((entry) => entry.fn === "maintenance_finish_assets")?.args).toEqual({
      p_asset_ids: orphans.map((asset) => asset.id),
    });
  });

  it("does one round and touches nothing when there is nothing to collect", async () => {
    const project = new FakeProject();
    const kept = project.addAssets(3, { referenced: true });
    const response = await handlerFor(project).handler(call());
    expect(await summaryOf(response)).toMatchObject({ assetsMarked: 0, assetsForgotten: 0, objectsRemoved: 0, orphanObjectsRemoved: 0, rounds: 1 });
    expect(project.calledFunctions()).toEqual(["maintenance_run", "maintenance_orphan_assets", "maintenance_orphan_objects"]);
    expect(project.removeCalls).toEqual([]);
    expect(project.objects.size).toBe(kept.length);
  });

  it("keeps assets that were used again between listing and marking (the SQL re-checks under lock)", async () => {
    const project = new FakeProject();
    const orphans = project.addAssets(10);
    const revived = orphans.slice(0, 3);
    for (const asset of revived) project.usedAgainBeforeForget.add(asset.id);
    const response = await handlerFor(project).handler(call());
    expect(await summaryOf(response)).toMatchObject({ assetsMarked: 7, assetsForgotten: 7, objectsRemoved: 7, stoppedBy: "drained" });
    expect([...project.objects].sort()).toEqual(revived.map((asset) => asset.path).sort());
  });

  it("tries each candidate once per run, so candidates the database keeps refusing cannot keep it busy", async () => {
    const project = new FakeProject();
    project.addAssets(600, { stubborn: true });
    const response = await handlerFor(project).handler(call());
    const summary = await summaryOf(response);
    expect(summary).toMatchObject({ assetsMarked: 0, rounds: 2, stoppedBy: "drained" });
    expect(project.calledFunctions().filter((fn) => fn === "maintenance_forget_assets")).toHaveLength(1);
    expect(project.calledFunctions()).not.toContain("maintenance_finish_assets");
  });

  it("stops at the round limit and says so", async () => {
    const project = new FakeProject();
    project.addAssets(2000);
    const response = await handlerFor(project, { maxRounds: 2 }).handler(call());
    expect(response.status).toBe(200);
    expect(await summaryOf(response)).toMatchObject({ assetsMarked: 1000, assetsForgotten: 1000, rounds: 2, stoppedBy: "round_limit" });
    expect(project.assets.size).toBe(1000);
  });

  it("passes its batch limit to the orphan queries", async () => {
    const project = new FakeProject();
    project.addAssets(25);
    project.addLooseObjects(25);
    const response = await handlerFor(project, { batchLimit: 10 }).handler(call());
    expect(await summaryOf(response)).toMatchObject({ assetsForgotten: 25, orphanObjectsRemoved: 25, rounds: 3, stoppedBy: "drained" });
    const limits = project.calls.filter((entry) => entry.fn.startsWith("maintenance_orphan_")).map((entry) => entry.args.p_limit);
    expect(new Set(limits)).toEqual(new Set([10]));
  });
});

describe("maintenance: time budget", () => {
  it("starts no request after the budget, except removing the objects of rows it has just marked and finishing them", async () => {
    const project = new FakeProject();
    project.msPerCall = 300;
    project.msPerRemove = 300;
    project.addAssets(800);
    project.addLooseObjects(20);
    const response = await handlerFor(project, { budgetMs: 1000 }).handler(call());
    expect(response.status).toBe(200);
    // run 0→300, list →600, mark →900 (still inside the budget), removal →1200 and finish →1500 complete the marking
    expect(project.calledFunctions()).toEqual([
      "maintenance_run",
      "maintenance_orphan_assets",
      "maintenance_forget_assets",
      "maintenance_finish_assets",
    ]);
    expect(project.removeCalls.map((batch) => batch.length)).toEqual([500]);
    expect(await summaryOf(response)).toMatchObject({
      assetsMarked: 500,
      assetsForgotten: 500,
      objectsRemoved: 500,
      orphanObjectsRemoved: 0,
      rounds: 1,
      durationMs: 1500,
      stoppedBy: "time_budget",
    });
    expect([...project.assets.values()].some((asset) => asset.status === "deleting")).toBe(false);
  });

  it("does not mark anything once the budget is spent", async () => {
    const project = new FakeProject();
    project.msPerCall = 300;
    project.addAssets(10);
    const response = await handlerFor(project, { budgetMs: 500 }).handler(call());
    expect(project.calledFunctions()).toEqual(["maintenance_run", "maintenance_orphan_assets"]);
    expect(project.removeCalls).toEqual([]);
    expect(project.assets.size).toBe(10);
    expect(await summaryOf(response)).toMatchObject({ assetsMarked: 0, rounds: 1, stoppedBy: "time_budget" });
  });

  it("does not start a round after the budget", async () => {
    const project = new FakeProject();
    project.msPerCall = 1000;
    project.addAssets(10);
    const response = await handlerFor(project, { budgetMs: 1000 }).handler(call());
    expect(project.calledFunctions()).toEqual(["maintenance_run"]);
    expect(await summaryOf(response)).toMatchObject({ rounds: 0, stoppedBy: "time_budget", run: RUN_RESULT });
  });
});

describe("maintenance: failures", () => {
  it("retries a failed removal once at once, then finishes the rows whose objects went", async () => {
    const project = new FakeProject();
    const orphans = project.addAssets(4);
    project.removeBehaviour = (_batch, removal) => (removal === 1 ? "error" : "ok");
    const response = await handlerFor(project).handler(call());
    expect(response.status).toBe(200);
    expect(await summaryOf(response)).toMatchObject({ assetsMarked: 4, assetsForgotten: 4, objectsRemoved: 4, failedRemovals: 0 });
    const paths = orphans.map((asset) => asset.path);
    expect(project.removeCalls).toEqual([paths, paths]);
    expect(project.objects.size).toBe(0);
    expect(project.assets.size).toBe(0);
  });

  it("leaves rows whose objects could not be removed 'deleting', answers 502, and the next run finishes them first", async () => {
    for (const behaviour of ["error", "throw"] as const) {
      const project = new FakeProject();
      const orphans = project.addAssets(4);
      project.addLooseObjects(2);
      project.removeBehaviour = () => behaviour;
      const { handler, logs } = handlerFor(project);
      const response = await handler(call());
      expect(response.status, behaviour).toBe(502);
      expect(await summaryOf(response)).toMatchObject({
        error: "upstream",
        step: "storage.remove",
        assetsMarked: 4,
        assetsForgotten: 0,
        objectsRemoved: 0,
        orphanObjectsRemoved: 0,
        failedRemovals: 6,
        stoppedBy: "drained",
      });
      expect(logs.some((entry) => entry.level === "error" && entry.event === "maintenance_incomplete")).toBe(true);
      // never finished: the rows still block their bytes, and their objects still exist
      expect(project.calledFunctions()).not.toContain("maintenance_finish_assets");
      for (const asset of orphans) expect(project.assets.get(asset.id)?.status).toBe("deleting");
      expect(project.objects.size).toBe(6);

      project.removeBehaviour = () => "ok";
      project.calls.length = 0;
      const next = await handlerFor(project).handler(call());
      expect(next.status).toBe(200);
      expect(await summaryOf(next)).toMatchObject({ assetsMarked: 4, assetsForgotten: 4, objectsRemoved: 4, orphanObjectsRemoved: 2 });
      expect(project.assets.size).toBe(0);
      expect(project.objects.size).toBe(0);
    }
  });

  it("answers 502 when finishing fails; the rows stay 'deleting' and the next run completes them", async () => {
    const project = new FakeProject();
    project.addAssets(3);
    project.failRpc = (fn) => (fn === "maintenance_finish_assets" ? "error" : undefined);
    const response = await handlerFor(project).handler(call());
    expect(response.status).toBe(502);
    expect(await summaryOf(response)).toMatchObject({
      step: "maintenance_finish_assets",
      assetsMarked: 3,
      assetsForgotten: 0,
      objectsRemoved: 3,
    });
    expect([...project.assets.values()].map((asset) => asset.status)).toEqual(["deleting", "deleting", "deleting"]);
    project.failRpc = () => undefined;
    const next = await handlerFor(project).handler(call());
    expect(await summaryOf(next)).toMatchObject({ assetsMarked: 3, assetsForgotten: 3, objectsRemoved: 0, failedRemovals: 0 });
    expect(project.assets.size).toBe(0);
  });

  it("ends the asset phase of a run when only rows it already tried are left, without looping", async () => {
    const project = new FakeProject();
    project.addAssets(4);
    project.removeBehaviour = () => "error";
    const response = await handlerFor(project, { batchLimit: 4 }).handler(call());
    expect(await summaryOf(response)).toMatchObject({ assetsMarked: 4, rounds: 2, failedRemovals: 4, stoppedBy: "drained" });
    expect(project.calledFunctions().filter((fn) => fn === "maintenance_forget_assets")).toHaveLength(1);
  });

  it("answers 502 naming the failed step, with whatever was done before it", async () => {
    const cases: Array<[string, RpcFailure]> = [
      ["maintenance_run", "error"],
      ["maintenance_run", "throw"],
      ["maintenance_orphan_assets", "odd"],
      ["maintenance_forget_assets", "error"],
      ["maintenance_forget_assets", "odd"],
      ["maintenance_finish_assets", "throw"],
      ["maintenance_finish_assets", "odd"],
      ["maintenance_orphan_objects", "error"],
      ["maintenance_orphan_objects", "odd"],
    ];
    for (const [failing, failure] of cases) {
      const project = new FakeProject();
      project.addAssets(3);
      project.addLooseObjects(2);
      project.failRpc = (fn) => (fn === failing ? failure : undefined);
      const { handler, logs } = handlerFor(project);
      const response = await handler(call());
      expect(response.status, `${failing} ${failure}`).toBe(502);
      const body = await summaryOf(response);
      expect(body.error).toBe("upstream");
      expect(body.step).toBe(failing);
      expect(logs.some((entry) => entry.event === "maintenance_failed" && entry.fields?.step === failing)).toBe(true);
      if (failing === "maintenance_orphan_objects") {
        // the assets were collected before the failing step, and the answer says so
        expect(body).toMatchObject({ run: RUN_RESULT, assetsMarked: 3, assetsForgotten: 3, objectsRemoved: 3, rounds: 1 });
      }
      if (failing === "maintenance_run") expect(body).toMatchObject({ run: null, rounds: 0, assetsMarked: 0 });
    }
  });

  it("answers 502 for rows without the expected columns", async () => {
    const answers: Array<[string, unknown]> = [
      ["maintenance_orphan_assets", [{ asset_id: "" }]],
      ["maintenance_forget_assets", [{ asset_id: "00000000-0000-4000-8000-000000000001" }]],
      ["maintenance_forget_assets", [{ object_path: "x/y/z" }]],
      ["maintenance_finish_assets", [{ asset_id: 42 }]],
    ];
    for (const [fn, data] of answers) {
      const project = new FakeProject();
      project.addAssets(2);
      const original = project.rpc.bind(project);
      project.rpc = async (name, args) => (name === fn ? { data, error: null } : original(name, args));
      const response = await handlerFor(project).handler(call());
      expect(response.status, fn).toBe(502);
      expect((await summaryOf(response)).step).toBe(fn);
    }
  });

  it("answers 500 for an unexpected error", async () => {
    const project = new FakeProject();
    const broken: RpcClient & StorageClient = {
      rpc: (fn, args) => project.rpc(fn, args),
      storage: {
        from: () => {
          throw new RangeError("unexpected");
        },
      },
    };
    const { handler, logs } = handlerFor(project, { client: broken });
    const response = await handler(call());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
    expect(logs).toContainEqual({ level: "error", event: "internal_error", fields: { name: "RangeError" } });
  });

  it("never logs the secret or any object path", async () => {
    const project = new FakeProject();
    const orphans = project.addAssets(3);
    project.removeBehaviour = () => "error";
    const { handler, logs } = handlerFor(project);
    await handler(call());
    await handler(call({ secret: "a-wrong-secret-of-some-length" }));
    project.failRpc = (fn) => (fn === "maintenance_orphan_objects" ? "error" : undefined);
    await handler(call());
    expect(logs.length).toBeGreaterThan(1);
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(OWNER);
    for (const asset of orphans) expect(serialized).not.toContain(asset.id);
  });
});
