#!/usr/bin/env node
// Writes <dir>/platform.json (the account shell's runtime switch, DESIGN.md D3) from environment variables, so the built
// site talks to the production Supabase project without committing its address. Only public values: the project URL
// and the publishable key (row-level security protects the data, not the key). Without the variables it writes the
// disabled file, so a fork or a deploy without accounts keeps the studio at "/".
//
//   PLATFORM_SUPABASE_URL=https://<ref>.supabase.co PLATFORM_SUPABASE_KEY=sb_publishable_… \
//   PLATFORM_PROVIDERS=password,username PLATFORM_EMAIL_DELIVERY=false PLATFORM_SITE_URL=https://…/ \
//   node scripts/platform/write-platform-config.mjs public-copy
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/platform/write-platform-config.mjs <site-dir>");
  process.exit(2);
}

const PROVIDERS = ["password", "username", "emailCode", "google", "apple", "github", "azure"];
const url = (process.env.PLATFORM_SUPABASE_URL ?? "").trim();
const key = (process.env.PLATFORM_SUPABASE_KEY ?? "").trim();
const siteUrl = (process.env.PLATFORM_SITE_URL ?? "").trim() || null;
const emailDelivery = /^(1|true|yes)$/i.test((process.env.PLATFORM_EMAIL_DELIVERY ?? "").trim());
const enabled = new Set(
  (process.env.PLATFORM_PROVIDERS ?? "password,username")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

let config;
if (!url || !key) {
  config = {
    schema: "viscera.platform/v1",
    supabaseUrl: null,
    note: "Accounts are off in this build (no PLATFORM_SUPABASE_URL/PLATFORM_SUPABASE_KEY).",
  };
  console.log("platform.json: accounts off (repository variables not set)");
} else {
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url) && !/^https:\/\//.test(url)) {
    console.error(`platform.json: PLATFORM_SUPABASE_URL must be an https URL, got ${url}`);
    process.exit(1);
  }
  if (key.startsWith("sb_secret_")) {
    console.error("platform.json: refusing a secret key; use the publishable (sb_publishable_…) or anon key");
    process.exit(1);
  }
  const unknown = [...enabled].filter((provider) => !PROVIDERS.includes(provider));
  if (unknown.length) console.warn(`platform.json: ignoring unknown providers ${unknown.join(", ")}`);
  config = {
    schema: "viscera.platform/v1",
    supabaseUrl: url.replace(/\/$/, ""),
    supabaseKey: key,
    providers: Object.fromEntries(PROVIDERS.map((provider) => [provider, enabled.has(provider)])),
    emailDelivery,
    siteUrl,
  };
  console.log(`platform.json: accounts on (${config.supabaseUrl}; providers ${[...enabled].join(", ")}; email ${emailDelivery})`);
}
writeFileSync(join(dir, "platform.json"), `${JSON.stringify(config, null, 2)}\n`);
