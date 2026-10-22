// Deno entry point of maintenance (Supabase Edge Runtime): wires the handler to the environment and the
// service-role client. The logic lives in handler.ts (tested under Node in supabase/tests/functions).
// No request starts after 30 s and each request to the database or Storage is capped at 10 s, so a run ends within
// about 50 s (the platform's wall-clock limit is 150 s).
import { createServiceClient } from "../_shared/clients.ts";
import { readPlatformEnv } from "../_shared/env.ts";
import { consoleLogger } from "../_shared/log.ts";
import { createMaintenanceHandler } from "./handler.ts";

const env = readPlatformEnv((name) => Deno.env.get(name));
const client =
  env.supabaseUrl && env.secretKey
    ? createServiceClient(env.supabaseUrl, env.secretKey, { requestTimeoutMs: 10_000 })
    : null;

Deno.serve(
  createMaintenanceHandler({
    secret: env.maintenanceSecret,
    client,
    logger: consoleLogger("maintenance"),
    budgetMs: 30_000,
  }),
);
