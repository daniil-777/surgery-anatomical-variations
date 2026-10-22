// Shell-only hardening (DESIGN.md §15.12). GitHub Pages cannot send headers, so the Content-Security-Policy is a meta
// tag added before the shell renders; it is never added to the studio or the labs (they share index.html). The Supabase
// hosts come from platform.json, which is why the policy is built at runtime.
import type { EnabledPlatformConfig } from "../core/config";

export function shellContentSecurityPolicy(config: EnabledPlatformConfig): string {
  const project: string[] = [];
  if (config.backend === "supabase") {
    const url = new URL(config.supabaseUrl);
    project.push(url.origin, `wss://${url.host}`);
    const [ref, ...rest] = url.host.split(".");
    // TUS uploads go to <ref>.storage.supabase.co on hosted projects
    if (ref && rest.join(".") === "supabase.co") project.push(`https://${ref}.storage.supabase.co`);
  }
  const connect = ["'self'", "blob:", "data:", ...project];
  const media = ["'self'", "blob:", "data:", ...project.filter((origin) => origin.startsWith("https://"))];
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connect.join(" ")}`,
    `img-src ${media.join(" ")}`,
    `media-src ${media.join(" ")}`,
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

/** Adds the CSP meta tag (production builds only: the dev server injects inline scripts and a websocket). */
export function applyShellSecurity(config: EnabledPlatformConfig): void {
  if (!import.meta.env.PROD || document.querySelector('meta[http-equiv="Content-Security-Policy"]')) return;
  const meta = document.createElement("meta");
  meta.httpEquiv = "Content-Security-Policy";
  meta.content = shellContentSecurityPolicy(config);
  document.head.prepend(meta);
}

/** True when another origin frames the shell (clickjacking): the shell then refuses to render any auth UI. */
export function isFramedByOtherOrigin(): boolean {
  if (window.top === window.self) return false;
  try {
    return window.top?.location.origin !== window.location.origin;
  } catch {
    return true;
  }
}
