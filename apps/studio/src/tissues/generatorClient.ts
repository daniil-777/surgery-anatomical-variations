/** Client for the optional local tile generator (scripts/tissue_lora_server.py).
 * Only loopback hosts are accepted, the page never contacts the generator on its own,
 * and responses are untrusted data: bundles go through importTissuePbrBundle like any file. */
export const DEFAULT_GENERATOR = "http://127.0.0.1:8790";
export const GENERATOR_MODES = ["clean", "guided", "delit", "raw"] as const;
export type GeneratorMode = typeof GENERATOR_MODES[number];
export const MODE_LABELS: Record<GeneratorMode, string> = {
  clean: "Clean · glints removed, organ colour",
  guided: "Guided · authored structure + learned texture",
  delit: "Delit · also flatten sheen and shading",
  raw: "Raw model output",
};
export interface GeneratorHealth {
  schema: "viscera.tissue-generator/v1";
  ready: boolean;
  busy: boolean;
  families: string[];
  modes: GeneratorMode[];
  run_id: string | null;
  rights: { training_profile: string; rights: string[] };
}
export interface GenerateTileRequest { family: string; mode: GeneratorMode; seed?: string; guidance?: number; steps?: number }

const MAX_BUNDLE_CHARS = 32 * 1024 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function generatorBaseUrl(search: string = typeof location === "undefined" ? "" : location.search): string {
  const requested = new URLSearchParams(search).get("generator");
  if (!requested) return DEFAULT_GENERATOR;
  let url: URL;
  try { url = new URL(requested); } catch { throw new Error("The generator address is not a valid URL."); }
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("The tile generator must be an http address on this computer (127.0.0.1 or localhost).");
  }
  return url.origin;
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string") return body.error.slice(0, 300);
  } catch { /* fall through */ }
  return `HTTP ${response.status}`;
}

export function validateHealth(value: unknown): GeneratorHealth {
  const health = value as Partial<GeneratorHealth> | null;
  if (!health || health.schema !== "viscera.tissue-generator/v1" || typeof health.ready !== "boolean" || typeof health.busy !== "boolean"
    || !Array.isArray(health.families) || !health.families.length || !health.families.every(f => typeof f === "string" && /^[a-z][a-z0-9_]{1,40}$/.test(f))
    || !Array.isArray(health.modes) || !health.modes.every(m => (GENERATOR_MODES as readonly string[]).includes(m as string))
    || !health.rights || typeof health.rights.training_profile !== "string") throw new Error("The local generator answered with an unsupported status.");
  return health as GeneratorHealth;
}

export async function checkGenerator(base: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<GeneratorHealth> {
  let response: Response;
  try {
    response = await fetcher(`${base}/health`, { signal: withTimeout(signal, 5000), cache: "no-store" });
  } catch (reason) {
    if (signal?.aborted) throw reason;
    throw new Error("No local tile generator is answering. Start scripts/tissue_lora_server.py on this computer, then connect again.");
  }
  if (!response.ok) throw new Error(`The local generator refused the connection: ${await errorMessage(response)}`);
  return validateHealth(await response.json());
}

export async function requestGeneratedTile(base: string, request: GenerateTileRequest, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<string> {
  if (!(GENERATOR_MODES as readonly string[]).includes(request.mode)) throw new Error("Unsupported generation mode");
  if (request.seed !== undefined && !/^(0|[1-9][0-9]{0,19})$/.test(request.seed)) throw new Error("Seed must be a whole number");
  let response: Response;
  try {
    response = await fetcher(`${base}/generate`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request), signal: withTimeout(signal, 10 * 60 * 1000), cache: "no-store" });
  } catch (reason) {
    if (signal?.aborted) throw reason;
    throw new Error("The local generator stopped answering during generation.");
  }
  if (response.status === 409) throw new Error("The generator is busy with another tile. Try again when it finishes.");
  if (!response.ok) throw new Error(`Generation failed: ${await errorMessage(response)}`);
  const declared = Number(response.headers.get("Content-Length") ?? 0);
  if (declared > MAX_BUNDLE_CHARS) throw new Error("The generated bundle exceeds the 32 MiB import limit.");
  const source = await response.text();
  if (source.length > MAX_BUNDLE_CHARS) throw new Error("The generated bundle exceeds the 32 MiB import limit.");
  return source;
}
