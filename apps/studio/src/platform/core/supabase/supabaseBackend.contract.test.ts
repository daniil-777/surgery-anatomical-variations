// The backend contract against a real Supabase stack (CI: `supabase start`, then run vitest with the variables below).
// Skipped unless VISCERA_SUPABASE_URL and VISCERA_SUPABASE_KEY are set, so the default unit run needs no network.
//   VISCERA_SUPABASE_URL          e.g. http://127.0.0.1:54321
//   VISCERA_SUPABASE_KEY          the publishable (or anon) key printed by `supabase status`
//   VISCERA_SUPABASE_SECRET_KEY   optional: enables the quota and project-limit scenarios (plan changes via the API)
//   VISCERA_MAILPIT_URL           optional: e.g. http://127.0.0.1:54324, enables the email-code scenario
//   VISCERA_CONTRACT_USERNAME=1   optional: the auth-username function is served (`supabase functions serve`)
//   VISCERA_CONTRACT_EMAIL_DOMAIN optional: domain for throwaway accounts (default example.com)
import { describe, it } from "vitest";
import { defineBackendContract, type ContractHarness } from "../backendContract";
import { parsePlatformConfig } from "../config";
import type { PlatformBackend } from "../types";
import { SupabaseBackend } from "./supabaseBackend";

function env(name: string): string | null {
  const value: unknown = import.meta.env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

const url = env("VISCERA_SUPABASE_URL");
const key = env("VISCERA_SUPABASE_KEY");
const secret = env("VISCERA_SUPABASE_SECRET_KEY");
const mailpit = env("VISCERA_MAILPIT_URL");
const domain = env("VISCERA_CONTRACT_EMAIL_DOMAIN") ?? "example.com";
const TINY = { id: "contract_tiny", storageQuotaBytes: 3000, maxFileBytes: 1000, maxProjects: 2 };

class MapStorage {
  private readonly items = new Map<string, string>();
  getItem(name: string): string | null {
    return this.items.get(name) ?? null;
  }
  setItem(name: string, value: string): void {
    this.items.set(name, value);
  }
  removeItem(name: string): void {
    this.items.delete(name);
  }
}

/** Service-role REST call (bypasses row level security; only for test setup). */
async function admin(path: string, init: RequestInit): Promise<void> {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: secret as string, authorization: `Bearer ${secret}`, "content-type": "application/json", prefer: "resolution=merge-duplicates", ...init.headers },
  });
  if (!response.ok) throw new Error(`admin ${path}: HTTP ${response.status} ${await response.text()}`);
}

async function latestCode(email: string): Promise<string | null> {
  const list = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}&limit=1`);
  if (!list.ok) return null;
  const found = (await list.json()) as { messages?: Array<{ ID: string }> };
  const id = found.messages?.[0]?.ID;
  if (!id) return null;
  const message = (await (await fetch(`${mailpit}/api/v1/message/${id}`)).json()) as { Text?: string; HTML?: string };
  return /\b(\d{6})\b/.exec(`${message.Text ?? ""} ${message.HTML ?? ""}`)?.[1] ?? null;
}

if (url && key) {
  const config = parsePlatformConfig(
    {
      schema: "viscera.platform/v1",
      supabaseUrl: url,
      supabaseKey: key,
      providers: { password: true, username: true, emailCode: true },
      emailDelivery: true,
      siteUrl: "http://127.0.0.1:5180/",
    },
    { allowLoopbackHttp: true },
  );
  if (!config.enabled || config.backend !== "supabase") throw new Error("VISCERA_SUPABASE_URL / VISCERA_SUPABASE_KEY do not form a valid platform config");
  const harness: ContractHarness = {
    name: `SupabaseBackend (${url})`,
    createBackend: (): PlatformBackend => new SupabaseBackend(config, { authStorage: new MapStorage(), location: null, blobCache: null }),
    uniqueEmail: (label) => `contract.${label}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@${domain}`,
    usernameSignIn: env("VISCERA_CONTRACT_USERNAME") === "1",
    timeoutMs: 60_000,
  };
  if (mailpit) harness.readEmailCode = async (_backend, email) => latestCode(email);
  if (secret) {
    harness.tinyPlan = TINY;
    harness.setPlan = async (_backend, userId, planId) => {
      await admin("plans", {
        method: "POST",
        body: JSON.stringify({ id: TINY.id, title: "Contract", storage_quota_bytes: TINY.storageQuotaBytes, max_file_bytes: TINY.maxFileBytes, version_retention_days: 1, max_projects: TINY.maxProjects }),
      });
      await admin(`profiles?id=eq.${userId}`, { method: "PATCH", body: JSON.stringify({ plan_id: planId }) });
    };
  }
  defineBackendContract(harness);
} else {
  describe.skip("backend contract: SupabaseBackend (set VISCERA_SUPABASE_URL and VISCERA_SUPABASE_KEY to run against a stack)", () => {
    it("runs against a real Supabase stack", () => undefined);
  });
}
