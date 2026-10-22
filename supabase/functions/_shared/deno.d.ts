// Ambient types for the two Deno globals the entry points use, so `tsc -p supabase/functions` can check them under
// Node. The Supabase Edge Runtime has the real Deno types; nothing imports this file, so Deno never reads it.
declare namespace Deno {
  interface Env {
    get(key: string): string | undefined;
  }
  const env: Env;
  function serve(handler: (request: Request) => Response | Promise<Response>): unknown;
}
