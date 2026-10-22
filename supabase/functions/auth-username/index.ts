// Deno entry point of auth-username (Supabase Edge Runtime): wires the handler to the environment, the service-role
// client and fetch. The logic lives in handler.ts (tested under Node in supabase/tests/functions).
import { createServiceClient } from "../_shared/clients.ts";
import { readPlatformEnv } from "../_shared/env.ts";
import { withTimeout } from "../_shared/http.ts";
import { consoleLogger } from "../_shared/log.ts";
import { createAuthUsernameHandler } from "./handler.ts";

const env = readPlatformEnv((name) => Deno.env.get(name));
const db = env.supabaseUrl && env.secretKey ? createServiceClient(env.supabaseUrl, env.secretKey) : null;

Deno.serve(
  createAuthUsernameHandler({
    appOrigins: env.appOrigins,
    supabaseUrl: env.supabaseUrl,
    secretKey: env.secretKey,
    db,
    fetch: withTimeout(fetch, 10_000),
    logger: consoleLogger("auth-username"),
  }),
);
