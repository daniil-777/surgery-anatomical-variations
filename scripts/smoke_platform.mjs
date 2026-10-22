// Smoke test of the account shell on a built copy (or a live site): the bare URL boots the shell signed out without a
// single request to Supabase and without console errors, a lab URL still boots the studio, and an embedded lab boots the
// studio without the shell. Runs after scripts/platform/write-platform-config.mjs in .github/workflows/pages.yml.
//   node scripts/smoke_platform.mjs [dir=public-copy] [--url https://host/path/] [--chrome PATH] [--port 8124] [--budget 240000] [--out DIR]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { serve } from "./serve-static.mjs";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");

const argv = process.argv.slice(2);
const opt = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) opt[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  else positional.push(argv[i]);
}
const DIR = path.resolve(positional[0] || "public-copy");
const LIVE = typeof opt.url === "string" ? opt.url.replace(/\/?$/, "/") : null;
const PORT = +(opt.port || 8124);
const BUDGET = +(opt.budget || 240000);
const OUT = opt.out ? path.resolve(opt.out) : null;
const CHROME = [opt.chrome, process.env.CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium-browser", "/usr/bin/chromium"]
  .filter(Boolean)
  .find((candidate) => fs.existsSync(candidate));
if (!CHROME) {
  console.error("no Chrome found: pass --chrome PATH or set $CHROME");
  process.exit(2);
}

const server = LIVE ? null : await serve(DIR, PORT);
const BASE = LIVE ?? `http://127.0.0.1:${PORT}/`;
const config = await fetch(new URL("platform.json", BASE), { cache: "no-store" }).then((response) => (response.ok ? response.json() : null), () => null);
const accounts = Boolean(config && config.supabaseUrl);
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "viscera-platform-smoke-")),
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1380,820", ...(process.platform === "darwin" ? ["--use-angle=metal"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])],
});

const failures = [];
async function check(name, url, expect) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1380, height: 820 });
  const errors = [];
  const supabaseRequests = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !/favicon|Failed to load resource/.test(message.text())) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("request", (request) => {
    if (/\.supabase\.co\b/.test(request.url())) supabaseRequests.push(request.url());
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status >= 400 && !/favicon|\/api\//.test(response.url())) errors.push(`HTTP ${status} ${response.url()}`);
  });
  const started = Date.now();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: BUDGET });
    await page.waitForFunction(expect.ready, { timeout: BUDGET, polling: 250 });
    if (expect.settleMs) await new Promise((resolve) => setTimeout(resolve, expect.settleMs));
    const detail = await page.evaluate(expect.detail ?? (() => null));
    if (expect.noSupabase && supabaseRequests.length) errors.push(`requests to Supabase while signed out: ${supabaseRequests.slice(0, 3).join(", ")}`);
    if (OUT) {
      fs.mkdirSync(OUT, { recursive: true });
      await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    }
    if (errors.length) throw new Error(errors.join("\n  "));
    console.log(`✓ ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)${detail ? ` ${JSON.stringify(detail)}` : ""}`);
  } catch (error) {
    failures.push(name);
    console.error(`✗ ${name}: ${String(error.message ?? error)}`);
  } finally {
    await page.close();
  }
}

if (accounts) {
  await check("shell", BASE, {
    ready: () => document.documentElement.classList.contains("px-shell") && !document.querySelector('[aria-label="Loading VISCERA"]') && (document.querySelector("#root")?.children.length ?? 0) > 0,
    settleMs: 1500,
    noSupabase: true,
    detail: () => ({ title: document.title, heading: document.querySelector("h1")?.textContent?.trim() ?? null }),
  });
} else {
  console.log("platform.json has no project: the bare URL is the studio (checked by smoke_public_copy.mjs)");
}
await check("studio-at-mode-atlas", `${BASE}?mode=atlas`, {
  ready: () => window.__viscera?.ready === true && window.__viscera?.mode === "atlas",
  detail: () => ({ shell: document.documentElement.classList.contains("px-shell") }),
});
await check("embedded-lab", `${BASE}?mode=atlas&embed=1&lab=organ`, {
  ready: () => window.__viscera?.ready === true && !document.documentElement.classList.contains("px-shell"),
});

await browser.close();
server?.close();
if (failures.length) {
  console.error(`platform smoke failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("platform smoke passed");
