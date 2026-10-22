// Deno entry point of account-delete (Supabase Edge Runtime): wires the handler to the environment and the
// service-role client. The logic lives in handler.ts (tested under Node in supabase/tests/functions).
import { createServiceClient } from "../_shared/clients.ts";
import { readPlatformEnv } from "../_shared/env.ts";
import { consoleLogger } from "../_shared/log.ts";
import { supabaseAssetPathPager } from "./assetPaths.ts";
import { createAccountDeleteHandler } from "./handler.ts";

const env = readPlatformEnv((name) => Deno.env.get(name));
const client = env.supabaseUrl && env.secretKey ? createServiceClient(env.supabaseUrl, env.secretKey) : null;

Deno.serve(
  createAccountDeleteHandler({
    appOrigins: env.appOrigins,
    client,
    assetPaths: client === null ? null : supabaseAssetPathPager(client),
    logger: consoleLogger("account-delete"),
  }),
);
