// The service-role supabase-js client for the Edge Functions (Deno entry points only: supabase-js is imported through
// an npm: specifier, which Node cannot load; handlers receive the client through their dependencies instead).
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import { withTimeout } from "./http.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** A client with the secret key: bypasses row-level security, keeps no session, never refreshes tokens. */
export function createServiceClient(
  supabaseUrl: string,
  secretKey: string,
  options: { requestTimeoutMs?: number } = {},
): SupabaseClient {
  return createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: withTimeout(fetch, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) },
  });
}
