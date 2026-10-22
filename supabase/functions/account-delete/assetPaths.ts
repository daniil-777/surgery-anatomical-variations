// Asset object paths of one account, read with the service role through PostgREST in keyset pages: object_path is
// unique, so "after the last path" pages stay correct while rows change, and a server-side row cap only means more
// pages. Only a type is imported from supabase-js, so this module also loads under Node for its tests.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import { isRecord } from "../_shared/http.ts";
import { UpstreamError } from "../_shared/ports.ts";
import type { AssetPathPager } from "./handler.ts";

export function supabaseAssetPathPager(client: SupabaseClient): AssetPathPager {
  return async (ownerId, after, limit) => {
    let query = client
      .from("assets")
      .select("object_path")
      .eq("owner_id", ownerId)
      .order("object_path", { ascending: true })
      .limit(limit);
    if (after !== null) query = query.gt("object_path", after);
    const { data, error } = await query;
    if (error) throw new UpstreamError("assets", error.message);
    const rows: unknown[] = Array.isArray(data) ? data : [];
    return rows.map((row) => {
      const path = isRecord(row) ? row.object_path : undefined;
      if (typeof path !== "string" || path === "") throw new UpstreamError("assets", "unexpected asset row");
      return path;
    });
  };
}
