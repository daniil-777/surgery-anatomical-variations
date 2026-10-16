// api.ts — where the VISCERA API lives, whether it answers, and what the public copy uses instead.
//
// Every request to the API goes through apiUrl(): VITE_API_URL ("" by default: the same origin, which the development
// server proxies to port 8000 and the web entry point serves itself) prefixes the /api path. The public copy of the
// studio is a static site without an API: one health probe at start decides (apiOnline, useApiOnline), and the
// catalogue and the reference specimens it needs are files written at build time (tools/build-anatomy.mjs in the site
// repository) under static/api/. Everything else the API would do reports OFFLINE_MESSAGE instead of failing obscurely.
// publicUrl() resolves a bundled file against the base the app is served from ("/" in development, "./" in the public
// copy, which may sit at any path).
import { useEffect, useState } from "react";

export const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
let online: boolean | null = null;
let probe: Promise<boolean> | null = null;
let runtimeBase: string | null = null;
/** The public copy may name a hosted API at run time (api.json next to its index.html, read by main.tsx before the
 *  first render): "https://host" prefixes every /api path from then on; "" or null keeps the build-time base. */
export function configureApiBase(base: string | null | undefined): void {
  runtimeBase = typeof base === "string" && /^https?:\/\//.test(base) ? base.replace(/\/$/, "") : null;
  online = null; probe = null;
}
export const apiUrl = (path: string): string => `${runtimeBase ?? API_BASE}${path}`;
export const publicUrl = (path: string): string => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, "")}`;
/** main.tsx: read api.json if the copy carries one; a missing or malformed file means the build-time base. */
export async function loadRuntimeApiConfig(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  try {
    const response = await fetch(publicUrl("api.json"), { cache: "no-store", signal: AbortSignal.timeout(4000) });
    if (!response.ok) return null;
    const config = await response.json() as { api?: unknown };
    configureApiBase(typeof config.api === "string" ? config.api : null);
    return runtimeBase;
  } catch { return null; }
}
const STATIC_API = "static/api";

export const OFFLINE_MESSAGE =
  "This public copy has no generation service. Shape controls, appearance, surface recipes, sculpting, the hands-on liver, the whole scene, disease morphology, the trained shape and disease samplers and the joint flow (healthy or with a disease) run here, in the browser; the trained material sampler, text commands, the analysis of your own photograph, recorded physics experiments and the textured exports need the VISCERA API, which runs with the local studio.";

const listeners = new Set<(value: boolean) => void>();

/** Whether the API answers; one probe per page load. Outside a browser (the unit tests) the API counts as present. */
export function apiOnline(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(true);
  probe ??= fetch(apiUrl("/api/health"), { signal: AbortSignal.timeout(6000) })
    .then((response) => response.ok, () => false)
    .then((ok) => { online = ok; status().api = ok; for (const listener of listeners) listener(ok); return ok; });
  return probe;
}
/** null until the probe has answered, then whether the API is there. */
export function useApiOnline(): boolean | null {
  const [value, setValue] = useState<boolean | null>(online);
  // the probe may settle between the first render and this effect: read its answer as well as listening for it
  useEffect(() => { listeners.add(setValue); void apiOnline().then(setValue); return () => { listeners.delete(setValue); }; }, []);
  return value;
}

/** A GET answered by the API — or, when the API is absent and the public copy bundles the answer, by that file. */
export async function apiGet(path: string, init?: RequestInit, bundled?: string): Promise<Response> {
  if (bundled && !(await apiOnline())) return fetch(publicUrl(`${STATIC_API}/${bundled}`), init);
  return fetch(apiUrl(path), init);
}

/** A bundled JSON file of the public copy, gzipped on disk (GitHub Pages serves it as is) and inflated here; a host
 *  that inflates it on the way is fine too (the gzip magic decides). */
export async function bundledJson(name: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(publicUrl(`${STATIC_API}/${name}`), signal ? { signal } : {});
  if (!response.ok) throw new Error(`${name.split("/").pop()} is not bundled with this public copy (${response.status}); the API renders it.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const gzipped = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  const text = gzipped
    ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text()
    : new TextDecoder().decode(bytes);
  return JSON.parse(text) as unknown;
}

// what the page reports to the site that embeds it and to the smoke test: ready once a studio shows its first model
export interface StudioStatus { ready: boolean; mode: string; errors: string[]; api: boolean | null }
declare global { interface Window { __viscera?: StudioStatus } }
const detached: StudioStatus = { ready: false, mode: "", errors: [], api: null };   // tests run without a window
const status = (): StudioStatus => (typeof window === "undefined" ? detached : (window.__viscera ??= { ready: false, mode: "", errors: [], api: null }));
export function reportReady(mode: string): void { const s = status(); s.ready = true; s.mode = mode; }
export function reportError(message: string): void { const s = status(); if (message && !s.errors.includes(message)) s.errors.push(message); }
// the first probe happens once main.tsx has read the runtime API configuration; each probe records its answer above
