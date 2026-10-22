#!/usr/bin/env node
// Provisions (or updates) the Supabase project behind the VISCERA account platform. Idempotent: every step checks what
// exists first. Secrets never touch the repository: the database password, the secret key and the maintenance secret
// live in the macOS keychain (service "viscera-platform"), in Supabase function secrets and in GitHub secrets.
//
//   node scripts/platform/provision.mjs [--project viscera] [--region eu-central-1] [--org <id>]
//                                       [--skip-functions] [--skip-github] [--dry-run]
//   Optional owner account (one-off, never stored): PLATFORM_OWNER_EMAIL=… PLATFORM_OWNER_PASSWORD=… \
//     [PLATFORM_OWNER_USERNAME=…] [PLATFORM_OWNER_NAME=…] node scripts/platform/provision.mjs
// Needs: `supabase login` done once; `gh` logged in with repo scope.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KEYCHAIN_SERVICE = "viscera-platform";
const REPO = "daniil-777/surgery-anatomical-variations";
const SITE_URL = "https://daniil-777.github.io/surgery-anatomical-variations/";
const APP_ORIGINS = "https://daniil-777.github.io,http://127.0.0.1:5180,http://localhost:5180";
const FUNCTIONS = ["auth-username", "account-delete", "maintenance"];

const args = parseArgs(process.argv.slice(2));
const projectName = args.project ?? "viscera";
const region = args.region ?? "eu-central-1";
const dryRun = Boolean(args["dry-run"]);
const secrets = new Set();

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function redact(text) {
  let result = String(text);
  for (const secret of secrets) if (secret) result = result.split(secret).join("•••");
  return result;
}

function step(message) {
  console.log(`\n▸ ${message}`);
}

function run(command, argv, options = {}) {
  console.log(`  $ ${redact([command, ...argv].join(" "))}`);
  if (dryRun && !options.readOnly) return "";
  try {
    return execFileSync(command, argv, {
      cwd: ROOT,
      env: { ...process.env, ...(options.env ?? {}) },
      input: options.input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (options.allowFail) return null;
    const detail = redact(`${error.stdout ?? ""}${error.stderr ?? ""}`).trim();
    throw new Error(`${command} ${argv[0] ?? ""} failed${detail ? `:\n${detail}` : ""}`);
  }
}

function supabaseJson(argv) {
  const text = run("supabase", [...argv, "--output", "json"], { readOnly: true });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`could not parse JSON from supabase ${argv.join(" ")}:\n${redact(text).slice(0, 400)}`);
  }
}

function keychainGet(account) {
  const value = run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"], {
    allowFail: true,
    readOnly: true,
  });
  return value ? value.trim() : null;
}

function keychainSet(account, value) {
  secrets.add(value);
  run("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", value]);
}

function randomSecret(length = 40) {
  // alphanumeric only: safe in connection strings, env files and shells
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(length * 2);
  let out = "";
  for (const byte of bytes) {
    if (byte < 232) out += alphabet[byte % alphabet.length];
    if (out.length === length) break;
  }
  return out;
}

async function waitFor(check, { timeoutMs, intervalMs, label }) {
  const started = Date.now();
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function projectRef(project) {
  return project.id ?? project.ref ?? project.reference_id;
}

function projectStatus(project) {
  return String(project.status ?? "").toUpperCase();
}

function pickKeys(raw) {
  const list = Array.isArray(raw) ? raw : (raw?.keys ?? []);
  const find = (predicate) => list.find(predicate);
  const publishable = find((key) => key.type === "publishable") ?? find((key) => key.name === "anon");
  const secret = find((key) => key.type === "secret") ?? find((key) => key.name === "service_role");
  const value = (key) => key?.api_key ?? key?.apiKey ?? key?.key ?? null;
  return { publishable: value(publishable), secret: value(secret) };
}

async function adminFetch(url, secretKey, path, init = {}) {
  const headers = { apikey: secretKey, "content-type": "application/json" };
  // legacy service_role keys are JWTs and may also go in Authorization; sb_secret_ keys only in apikey
  if (secretKey.split(".").length === 3) headers.authorization = `Bearer ${secretKey}`;
  const response = await fetch(`${url}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${response.status} ${redact(text).slice(0, 300)}`);
  return body;
}

async function ensureOwner(url, secretKey) {
  const email = process.env.PLATFORM_OWNER_EMAIL;
  const password = process.env.PLATFORM_OWNER_PASSWORD;
  if (!email || !password) {
    console.log("  (no PLATFORM_OWNER_EMAIL/PLATFORM_OWNER_PASSWORD: owner account skipped)");
    return null;
  }
  secrets.add(password);
  const username = (process.env.PLATFORM_OWNER_USERNAME ?? "").trim().toLowerCase() || null;
  const displayName = (process.env.PLATFORM_OWNER_NAME ?? "").trim() || null;
  const metadata = { ...(username ? { username } : {}), ...(displayName ? { display_name: displayName } : {}) };
  if (dryRun) return null;
  let existing = null;
  for (let page = 1; page <= 50 && !existing; page += 1) {
    const listing = await adminFetch(url, secretKey, `/auth/v1/admin/users?page=${page}&per_page=200`);
    const users = listing?.users ?? [];
    existing = users.find((candidate) => String(candidate.email ?? "").toLowerCase() === email.toLowerCase()) ?? null;
    if (users.length < 200) break;
  }
  let user;
  if (existing) {
    user = await adminFetch(url, secretKey, `/auth/v1/admin/users/${existing.id}`, {
      method: "PUT",
      body: JSON.stringify({ password, email_confirm: true, user_metadata: { ...(existing.user_metadata ?? {}), ...metadata } }),
    });
    console.log(`  owner account exists (${existing.id}); password and metadata updated`);
  } else {
    user = await adminFetch(url, secretKey, "/auth/v1/admin/users", {
      method: "POST",
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: metadata }),
    });
    console.log(`  owner account created (${user.id ?? user.user?.id})`);
  }
  const id = user.id ?? user.user?.id ?? existing?.id;
  const profilePatch = { ...(username ? { username } : {}), ...(displayName ? { display_name: displayName } : {}), plan_id: "free" };
  await adminFetch(url, secretKey, `/rest/v1/profiles?id=eq.${id}`, {
    method: "PATCH",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify(profilePatch),
  });
  console.log(`  profile set: ${JSON.stringify(profilePatch)}`);
  return id;
}

async function main() {
  step("Supabase login");
  const orgs = supabaseJson(["orgs", "list"]);
  const orgList = Array.isArray(orgs) ? orgs : (orgs.organizations ?? []);
  if (!orgList.length) throw new Error("no Supabase organisation found: create one at supabase.com first");
  const org = args.org ? orgList.find((candidate) => candidate.id === args.org || candidate.slug === args.org) : orgList[0];
  if (!org) throw new Error(`organisation ${args.org} not found`);
  console.log(`  organisation: ${org.name ?? org.slug ?? org.id}`);

  step(`Project "${projectName}" in ${region}`);
  let projects = supabaseJson(["projects", "list"]);
  let project = (Array.isArray(projects) ? projects : []).find((candidate) => candidate.name === projectName);
  let dbPassword = keychainGet(`db-password:${projectName}`);
  if (dbPassword) secrets.add(dbPassword);
  if (!project) {
    dbPassword = randomSecret(40);
    keychainSet(`db-password:${projectName}`, dbPassword);
    run("supabase", ["projects", "create", projectName, "--org-id", org.id, "--db-password", dbPassword, "--region", region, "--yes"]);
    if (!dryRun) {
      project = await waitFor(
        () => {
          projects = supabaseJson(["projects", "list"]);
          const found = projects.find((candidate) => candidate.name === projectName);
          return found && projectStatus(found) === "ACTIVE_HEALTHY" ? found : null;
        },
        { timeoutMs: 15 * 60_000, intervalMs: 10_000, label: "the project to become healthy" },
      );
    }
  } else if (!dbPassword) {
    throw new Error(`project ${projectName} exists but its database password is not in the keychain (account db-password:${projectName}); reset it in the dashboard and store it with: security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a db-password:${projectName} -w`);
  }
  const ref = project ? projectRef(project) : "<new-project>";
  const url = `https://${ref}.supabase.co`;
  console.log(`  project ref: ${ref} · ${url} · status ${project ? projectStatus(project) : "(dry run)"}`);

  step("Link, migrations, configuration");
  const dbEnv = { SUPABASE_DB_PASSWORD: dbPassword ?? "" };
  run("supabase", ["link", "--project-ref", ref, "--workdir", ROOT], { env: dbEnv });
  run("supabase", ["db", "push", "--linked", "--workdir", ROOT, "--yes"], { env: dbEnv });
  run("supabase", ["config", "push", "--project-ref", ref, "--workdir", ROOT, "--yes"]);

  step("API keys");
  let keys = { publishable: null, secret: null };
  if (!dryRun) {
    keys = pickKeys(supabaseJson(["projects", "api-keys", "--project-ref", ref]));
    if (!keys.publishable || !keys.secret) throw new Error("could not read the project's publishable/secret keys");
    secrets.add(keys.secret);
    keychainSet(`secret-key:${ref}`, keys.secret);
    console.log(`  publishable key: ${keys.publishable.slice(0, 18)}… (public) · secret key stored in the keychain`);
  }

  step("Edge Function secrets and deploy");
  let maintenanceSecret = keychainGet(`maintenance-secret:${ref}`);
  if (!maintenanceSecret) {
    maintenanceSecret = randomSecret(48);
    keychainSet(`maintenance-secret:${ref}`, maintenanceSecret);
  }
  secrets.add(maintenanceSecret);
  if (!args["skip-functions"]) {
    const directory = mkdtempSync(join(tmpdir(), "viscera-secrets-"));
    const envFile = join(directory, "functions.env");
    writeFileSync(
      envFile,
      [
        `PLATFORM_SECRET_KEY=${keys.secret ?? ""}`,
        `PLATFORM_PUBLISHABLE_KEY=${keys.publishable ?? ""}`,
        `APP_ORIGINS=${APP_ORIGINS}`,
        `MAINTENANCE_SECRET=${maintenanceSecret}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    chmodSync(envFile, 0o600);
    try {
      run("supabase", ["secrets", "set", "--env-file", envFile, "--project-ref", ref]);
    } finally {
      writeFileSync(envFile, "");
      unlinkSync(envFile);
    }
    run("supabase", ["functions", "deploy", ...FUNCTIONS, "--use-api", "--project-ref", ref, "--workdir", ROOT]);
  }

  step("GitHub repository variables and secrets");
  if (!args["skip-github"]) {
    run("gh", ["variable", "set", "PLATFORM_SUPABASE_URL", "--repo", REPO, "--body", url]);
    run("gh", ["variable", "set", "PLATFORM_SUPABASE_KEY", "--repo", REPO, "--body", keys.publishable ?? ""]);
    run("gh", ["variable", "set", "PLATFORM_PROVIDERS", "--repo", REPO, "--body", args.providers ?? "password,username"]);
    run("gh", ["variable", "set", "PLATFORM_EMAIL_DELIVERY", "--repo", REPO, "--body", args["email-delivery"] ? "true" : "false"]);
    run("gh", ["variable", "set", "PLATFORM_SITE_URL", "--repo", REPO, "--body", SITE_URL]);
    run("gh", ["secret", "set", "PLATFORM_MAINTENANCE_SECRET", "--repo", REPO], { input: maintenanceSecret });
  }

  step("Owner account");
  if (keys.secret) await ensureOwner(url, keys.secret);

  step("Done");
  console.log(`  Supabase URL: ${url}`);
  console.log(`  Site: ${SITE_URL} (deploys from main; pages.yml writes platform.json from the repository variables)`);
}

main().catch((error) => {
  console.error(`\n✗ ${redact(error.message ?? error)}`);
  process.exit(1);
});
