# VISCERA account platform — design

Status: v2, 2026-10-21 (after an eight-part code and fact survey). Author: Claude, on the user's delegation.
Branch `platform/accounts` in a separate clone (`~/dev/viscera-platform`), based on `origin/main` 21b6ece.
Companion documents: [APPLE_STYLE_SPEC.md](APPLE_STYLE_SPEC.md) (tokens, components, screens),
[INTEGRATING_LABS.md](INTEGRATING_LABS.md) (lab contract and per-lab adoption), [OPERATIONS.md](OPERATIONS.md)
(provisioning, providers, runbook).

## 1. Intent

VISCERA Studio generates anatomical variations in the browser (organ design, materials, whole-body scene, physics).
It is anonymous today: everything disappears with the tab. The user asked:

> 1 I want you to wrap the current code app into professional account based web app, where everyone can login with
> login, password or with google or email, apple account etc · 2 Style is apple UI style · 3 Every account should have
> a personal media library where a user can store final shapes with textures that he liked for now and recorded physics
> experiments · 4 Also have a space and UI to show all imported objects from unity or blender etc · 5 Lab projects
> professionally as adobe, so people can save changes and return to previous latest changes in anatomy design.
> Do a free login for me … decide on external online database … test everything and deploy.
> Later: "make sure we develop the code for tissue lab, work separately professionally".

Success: a visitor opens the site, signs in (or keeps exploring as a guest), sees projects, library and imports in a
calm macOS-style shell, opens a lab inside a project and never loses work. Changes autosave, versions accumulate like
Adobe cloud documents, any version can be restored, and finished shapes, materials and recordings land in a personal
library. The user's own account works on day one.

## 2. Goals, non-goals, anti-goals

Goals
- G1 Sign-in: email + password, username + password, 6-digit email code, Google, Apple (GitHub and Microsoft ready);
  sign-up, password reset, sign-out (this device / everywhere), account deletion.
- G2 Apple-style shell: macOS density, light/dark, Liquid Glass chrome only on the functional layer.
- G3 Library per account: shapes (+ material/vertex-colour bake), materials, textures, recordings (video + data),
  images; favourites, tags, search, trash, preview (3D/image/video), download.
- G4 Imports space for objects from Unity, Blender and other tools: GLB/glTF (+ sidecars or zip), FBX, OBJ (+MTL),
  STL, PLY, USDZ; source-application detection; stats; 3D viewer; original file kept.
- G5 Lab projects with Adobe-style history: continuous cloud autosave (draft), checkpoint versions every 10 minutes
  of editing, ⌘S manual versions, named versions kept forever, non-destructive restore, open/save as copy,
  conflict handling across tabs and devices.
- G6 Per-account isolation enforced by the database (rows and files), never only by the UI.
- G7 Tested at every layer and deployed.
- G8 Isolation from the in-flight lab work in the other working tree (no edits there; labs opt in later).

Non-goals (this iteration): sharing and teams, payments, restyling lab interiors, server-side 3D processing, native apps,
the legacy procedural studio (`?mode=legacy`) as a project lab.

Anti-goals: any cross-account read or write; silent loss of work; secrets in the repository or the built site; breaking
the public studio (`?mode=…`, `textures.html`, the WIP labs' entry points and e2e contracts); claims the app cannot
support (labs' honesty strings are copied verbatim; nothing is labelled validated, measured, learned or approved by the
platform).

## 3. Constraints (verified)

- Site: GitHub Pages, built by `.github/workflows/pages.yml` on push to `main` (public repo). Origin
  `https://daniil-777.github.io` is shared by all of the user's project pages; no custom headers (CSP only via meta, no
  `frame-ancestors`); no SPA fallback; base `./` → only top-level sibling pages plus query/hash routes.
- The deploy gate fails on any HTTP status ≥ 400 or console error on smoke-tested pages: signed-out platform code must
  make no failing requests.
- 18 of 28 e2e specs, the public-copy smoke (`atlas`, `physics` checks) and the portfolio smoke open `/` and expect the
  organ studio.
- No Docker locally (GitHub runners have it). Only `gh` is logged in; Supabase needs one `supabase login`.
- Supabase Free: 500 MB DB, 1 GB storage, 50 MB per file, 5+5 GB egress, 50k MAU, pauses after 7 idle days, no backups;
  built-in mailer only reaches the project team (2/h). New keys: `sb_publishable_…` (browser) / `sb_secret_…` (server);
  legacy anon/service_role keys retire by end of 2026. SQL deletes on `storage.objects` are blocked (use the API).
- WIP tree: ~270 uncommitted changes (Tissue/Fat/Blood/Cutting labs, imports, recording, display settings) plus four
  unpushed commits. Shared hot files: `main.tsx`, `vite.config.ts`, `AtlasStudio.tsx`, `WholeScene*.tsx`,
  `AtlasPhysics*.tsx`, `App.tsx`, `atlas.css`, `wholeScene.css`, `api.ts`, `scripts/{build,smoke}_public_copy.mjs`.
  Byte-identical in both trees: `index.html`, `styles.css`, `tokens.css`, `packages/ui`, package manifests, lockfile,
  tsconfigs, `vitest.config.ts`, `playwright.config.ts`, `pages.yml`, `stage_deploy.py`.
- WIP's PostCSS plugin rescales every px `font-size` in all CSS; WIP dev servers occupy ports 5174, 5176, 8000, 5188.

## 4. Decisions (my calls)

| # | Decision | Why |
|---|---|---|
| D1 | **Supabase** (Postgres 17 + RLS, Auth, Storage, Edge Functions) in **eu-central-1** | Relational, versioned data with invariants fits Postgres; RLS isolates rows and files in the database; Auth covers every requested provider; S3-compatible storage with signed URLs and resumable uploads; free tier without a card (Firebase Storage now requires Blaze, and since Feb 2026 Spark projects have no Storage access at all); open source and portable to a self-hosted server; EU region. |
| D2 | Labs run in a **same-origin iframe** under a 44 px project bar; they talk to the platform through the dependency-free **lab-session registry** (`apps/studio/src/platform/bridge/labSession.ts`) | CSS isolation (the shell never inherits studio globals, labs keep pixel-identical looks), clean teardown of WebGL contexts, generic thumbnails/recording without lab edits, and the lab side is one opt-in call. |
| D3 | **Accounts are a runtime switch**: `index.html` loads `src/boot.ts`; lab URLs (`?mode`, `?embed`, `?template`, `meta viscera-mode`) boot the studio exactly as today; a bare URL boots the shell only when `platform.json` (committed default: disabled) names a Supabase project | `main.tsx` stays untouched; dev servers, the 18 e2e specs, the public-copy smoke and the portfolio keep the studio at `/`. The Pages workflow runs the existing smoke unchanged, then writes the production `platform.json` from repository variables and runs a platform smoke before upload. |
| D4 | Shell routes in the **hash** (`#/library`), auth callbacks with **PKCE** (`?code=`), client `storageKey` `viscera.platform.auth` | Static hosting; PKCE keeps tokens out of URLs; distinct key on the shared origin. |
| D5 | **Content-addressed assets**: `user-content/<uid>/<sha[0:2]>/<sha>`, one row per (owner, sha256) | Dedup across versions/library/imports, immutable bytes (cache forever, verify on download), no cross-account dedup (would leak existence). |
| D6 | **Drafts + versions**: mutable cloud draft per project; immutable numbered versions from checkpoints (10 min of editing), ⌘S, named versions, restores, copies | Adobe/Google-Docs behaviour: nothing lost between versions, history not flooded. |
| D7 | Reads through RLS; writes with invariants through SECURITY DEFINER RPCs; plain edits through column grants; errors as `PT<status>` | Invariants (sequence, head, quotas, asset readiness, ownership) cannot be bypassed from a browser. |
| D8 | Optimistic concurrency: `expected_head_version_id`, `expected_draft_rev` → 409 | No silent overwrite across tabs/devices; the UI offers reload / save mine as a copy / overwrite. |
| D9 | Username sign-in through the `auth-username` Edge Function (secret key, server-side email lookup, throttled per username and per IP) | Supabase Auth has no usernames; no email enumeration. |
| D10 | Providers config-driven; email confirmation off until custom SMTP exists; passwordless uses a **6-digit code** (works across devices) shown only when `emailDelivery` is true | The built-in mailer reaches only the team; links break across devices with PKCE. |
| D11 | Uploads ≤ 6 MB standard, larger via **TUS** (6 MB chunks) | Supabase guidance; recordings and imports are large. |
| D12 | Tests: PGlite (Postgres 18.6 WASM) for migrations/RLS/RPCs; memory backend for fast UI e2e; real stack (`supabase start`) in GitHub Actions for integration + e2e | Hermetic local feedback without Docker; full fidelity in CI. |
| D13 | Look: [APPLE_STYLE_SPEC.md](APPLE_STYLE_SPEC.md) — `--px-*` tokens via `light-dark()`, WCAG-checked colours, glass only on chrome (never over WebGL), lab routes in dark appearance, font sizes only through custom properties | User asked for Apple style; isolation from studio CSS and the WIP font plugin. |
| D14 | Guests can browse Home and open labs ("Try without an account"); saving needs an account | Keeps the portfolio demo working. |
| D15 | Edge Functions verify users themselves (`auth.getUser(token)`); maintenance is called by a GitHub Actions cron with a shared secret (also keeps the free project awake) | Works with publishable/secret keys; observable scheduling. |
| D16 | The user's account: `daniil.emtsev.ig@gmail.com`, the password from the conversation (never written to disk or repo), plan `free`, email confirmed, username `daniil`, display name "Daniil Emtsev" | "Do a free login for me". Username/display name are guesses, editable in Settings; change the password after first sign-in. |

## 5. Architecture

```
GitHub Pages (one origin)                                    Supabase (eu-central-1)
index.html → src/boot.ts                                     auth.users ─► profiles ─► plans
  ├─ lab URL ─────────► src/main.tsx (studio, unchanged)     assets ◄── storage.objects (user-content, RLS by uid/)
  └─ bare URL + config ► src/platform/main.tsx (shell)       projects ─► project_versions ─► project_version_assets
        AuthProvider · hash router · sidebar/toolbar                 └─► project_draft_assets
        pages: Home, Projects, Library, Imports, Settings    library_items ─► library_item_files
        ProjectEditor ─ ProjectBar · VersionHistory          imported_objects
                       └─ LabHost <iframe ?embed=1&mode=…>   RPCs (definer): reserve/confirm_asset, create_project,
                              lab registers labSession          save_draft, commit_version, restore_version, …
        core: config, backend (supabase | memory), assets,   Edge Functions: auth-username, account-delete,
              snapshot, versioning, imports, labs host,          maintenance (cron)
              recorder
GitHub Actions: platform.yml (typecheck, vitest + PGlite DB tests, platform e2e, supabase-start integration),
                pages.yml (build → existing smoke → production platform.json → platform smoke → deploy),
                platform-maintenance.yml (daily cron → maintenance function)
```

Code layout (all new, no new path aliases):
`apps/studio/src/boot.ts`; `apps/studio/public/platform.json`; `apps/studio/src/platform/{core,bridge,ui,app,pages,labs}`;
`supabase/{config.toml,migrations,functions,tests}`; `tests/platform/*.spec.ts` + `playwright.platform.config.ts`
(port 5180, strictPort, never reuse servers); `docs/platform/*`.

## 6. Data model

Implemented in `supabase/migrations/20261021180000…180400` (see the comments there for every rule).

- `plans(id, title, storage_quota_bytes, max_file_bytes, version_retention_days, max_projects)`: free = 500 MB / 50 MB /
  30 days / 100; pro = 20 GB / 1 GB / 180 days / 10 000.
- `profiles(id → auth.users, username unique (3–30, a-z 0-9 . _ -, not reserved), display_name, avatar_asset_id,
  plan_id, appearance)`, created by a trigger (bad or taken usernames never fail sign-up).
- `assets(owner_id, sha256, byte_size, mime_type, object_path = <uid>/<sha2>/<sha>, status pending|ready,
  last_used_at)`; `reserve_asset` (quota, per-file limit, dedup, advisory lock per owner) → Storage upload (policy:
  own folder + own pending reservation; no client deletes; upsert only while pending) → `confirm_asset` (object exists
  with the reserved size). Bucket `user-content`: private, 50 MB, MIME allow-list (never HTML/SVG/XML/JS).
- `projects(lab_id, title, description, head_version_id, head_seq, draft_* (asset, state_sha256, thumbnail, rev,
  saved_at), thumbnail, favorite, created/updated/opened/trashed_at)`; `project_versions(seq unique per project,
  parent, kind initial|autosave|manual|named|restore|duplicate|import, label (named = kept forever), snapshot,
  state_sha256, thumbnail, restored_from, lab_schema_version, app_build, byte_size)`; attachments in
  `project_version_assets` / `project_draft_assets`. RPCs: `create_project`, `save_draft`, `discard_draft`,
  `commit_version`, `restore_version`, `label_version`, `delete_version`, `duplicate_project`.
- `library_items(kind shape|material|texture|recording|scene|image|model, title, description, tags ≤ 20, lab_id,
  source_project/version, metadata jsonb ≤ 64 KB (claims, provenance, lab metadata), thumbnail, favorite, byte_size,
  trash)` + `library_item_files(filename, asset, role, position)`; RPC `create_library_item`.
- `imported_objects(title, source_app, source_detail, detected_by metadata|filename|user|none, format, original,
  display GLB, thumbnail, stats jsonb, tags, favorite, byte_size, trash)`; RPC `create_imported_object`.
- `my_usage()`; `username_available()` (anon); service-role only: `resolve_login_email`, `login_failures`,
  `note_login_attempt`, `maintenance_run` (retention: unnamed non-head versions older than the plan window beyond the
  newest five; 30-day trash purge), `maintenance_orphan_assets` / `maintenance_forget_assets` (unreferenced assets
  after a 1-day grace, re-checked under lock) and `maintenance_orphan_objects` (objects without an asset row).
- Privileges: every API-role privilege revoked, then minimal grants (select for authenticated; column-level updates;
  delete only for trashed rows; RPC execute per function).

## 7. Authentication

supabase-js 2.118 with `flowType: 'pkce'`, `storageKey: 'viscera.platform.auth'`, `detectSessionInUrl` only when the
URL carries `?code=`; redirect targets `…/?auth=callback` (OAuth) and `…/?auth=recovery` (reset); the query is removed
after the exchange. Email+password (`signUp` with username/display-name metadata; `signInWithPassword`); username +
password via `auth-username` → `setSession`; 6-digit email code (`signInWithOtp` + `verifyOtp`) when email delivery
is configured; OAuth (Google, Apple, GitHub, Microsoft) when enabled in `platform.json`; identity linking in Settings;
password reset; sign-out local/global; account deletion via `account-delete` (typed confirmation; removes Storage
objects through the API, then the user). Password policy: ≥ 8 characters, no composition rules (NIST style); leaked-
password protection when on Pro. Signed-out shells make no data requests.

## 8. Client architecture (`apps/studio/src/platform/core`, React-free, unit-tested)

`types.ts` (domain + ports, written), `config.ts` (platform.json loader: no-store, 4 s timeout, validation, disabled =
silent), `errors.ts` (PostgREST/Storage/Auth/function errors → `PlatformError` codes), `json.ts` (canonical JSON, no
`instanceof` across realms), `hash.ts` (SHA-256), `snapshot.ts` (canonical JSON → gzip; attachments manifest;
`state_sha256` of the canonical uncompressed state), `assets.ts` (hash → reserve → upload (standard ≤ 6 MB, TUS above)
→ confirm; progress, abort, retry; download with SHA-256 verification; IndexedDB cache by SHA-256 with memory
fallback), `supabase/` (SupabaseBackend), `memory/` (MemoryBackend: same semantics as the SQL), `versioning.ts`
(ProjectSession: debounced drafts 2 s idle / 15 s max, checkpoints every 10 min of editing, ⌘S/⌘⇧S, restore, conflicts,
offline queue, flush on pagehide/visibilitychange, no-op detection by state hash, never while the lab is busy or
recording), `labs/` (registry of labs, iframe host: registry discovery, cross-realm Blob normalisation, generic
thumbnail from the largest visible canvas, navigation interception, ⌘S forwarding), `recorder.ts` (captureStream +
MediaRecorder; MP4/H.264 where supported, else WebM; size budget under the plan's file limit; physics DOM snapshot
attached when present), `imports/` (sniffing, source-app detection, three.js loaders, stats, GLB normalisation,
thumbnail).

## 9. Lab integration

Contract: `apps/studio/src/platform/bridge/labSession.ts` (read the header comment). Host guarantees: restore only on a
freshly loaded iframe; no serialize/thumbnail while busy or while any `canvas[data-scene-recording-active="true"]`;
attachments byte-exact; claims verbatim. v1 labs in this branch:
- **Organ Design** (`mode=atlas`) and **Texture Lab** (`mode=textures`): full project support through an organ adapter
  (`platform/labs/organ/*`): session = committed spec + provenance + vessels + photo detail + camera + view, sculpt as a
  sparse float32 attachment; restore through the studio's own `generate` path with template/renderer/material
  binding checks; thumbnail via a new viewport method; "Add shape to Library" = browser vertex-colour bake GLB
  (honestly labelled) + spec + thumbnail; minimal additive edits in `AtlasStudio.tsx`/`AtlasViewport.tsx` only at the
  lines verified to merge without conflicts against the WIP tree.
- **Whole Body** (`mode=scene`): opens, records and screenshots to the library; project save arrives with its adapter.
- **Physics experiments**: recorded from inside Organ Design (the physics lab is a dialog there): video of the lab
  canvas + the playground's diagnostics snapshot + organ session, stored as a `recording` library item.
- Tissue, Fat, Blood, Cutting, Imports (WIP): adopt after their work lands — see INTEGRATING_LABS.md (sent to the
  Tissue Lab session).

## 10. Interface

Routes: `#/signin`, `#/signup`, `#/code`, `#/forgot`, `#/reset`; `#/` Home; `#/projects`; `#/projects/<id>`;
`#/library[?kind=]`, `#/library/<id>`; `#/imports[?source=]`, `#/imports/<id>`; `#/trash`; `#/settings`;
`#/lab/<labId>` (scratch/guest). Layout, tokens, components, screens and shortcuts: APPLE_STYLE_SPEC.md, adapted to
D2/D13 (UI kit in `platform/ui`, no `packages/px-ui`, LabHost = iframe + registry).

## 11. Security and privacy

RLS on every table and `storage.objects`; RPC-only invariant writes; column grants; no client deletes in Storage;
secret key only in Edge Function secrets, CI secrets and the macOS keychain. React escaping only; user files served
only from the Supabase domain via signed URLs with a MIME allow-list. CSP meta on the shell page (self + project URL;
blob:, data:, wasm). The shell refuses to render auth/account UI when framed by another origin. Shared github.io origin:
distinct storage key now, custom domain recommended. Quotas, per-file limits, login throttling, auth rate limits,
CAPTCHA ready. Data in the EU; account deletion in Settings; no analytics. Lab privacy promises ("files stay on this
device") are respected: nothing from a lab is uploaded except by an explicit save or "Add to Library".

## 12. Testing

Unit (Vitest, node): core modules, adapters, detection fixtures. Database (Vitest + PGlite, `supabase/tests`): RLS
matrix, RPC invariants, storage policies, grants, maintenance. Functions: handler logic with injected dependencies.
E2E (Playwright, installed Chrome, port 5180): memory backend for every UI flow + axe-core + screenshots in light/dark;
CI job with `supabase start` for integration and real-backend e2e; live smoke after deploy with a throwaway account.

## 13. Deployment and operations

1. `supabase login` (user). 2. Create project `viscera` (eu-central-1, free), link. 3. `db push`, `config push`,
`functions deploy --use-api`, secrets. 4. Repository variables for `platform.json`; GitHub secret for the maintenance
cron. 5. Create the user's account with the Admin API (secret key from the keychain; password never written). 6. PR →
CI green → merge → Pages deploy → live smoke. Runbook: OPERATIONS.md.

## 14. Needs the user

`supabase login` (blocking for deploy). Optional: Google OAuth client, Apple Developer membership + Services ID + key,
GitHub OAuth app, SMTP (Gmail app password or Resend), CAPTCHA keys, a custom domain, Supabase Pro.
