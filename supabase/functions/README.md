# Platform Edge Functions

Three Supabase Edge Functions serve the account platform (DESIGN.md §7, §13, §15):

| Function | Called by | Purpose |
|---|---|---|
| `auth-username` | the shell's sign-in form (`supabase.functions.invoke`) | password sign-in with a username instead of an email |
| `account-delete` | Settings → Delete account | removes every file of the account through the Storage API, then the account |
| `maintenance` | the hourly `platform-maintenance` GitHub Actions cron | version retention, trash purge, orphaned files |

Layout: each function has a pure `handler.ts` (`create…Handler(deps)`, Web-standard `Request` → `Response`) and an
`index.ts` that wires it to `Deno.serve`, the environment and supabase-js. `_shared/` holds environment parsing, CORS,
JSON helpers, the client-address rules, JWT claims, a constant-time secret comparison, the service client and
Storage helpers. Only Web APIs and `npm:@supabase/supabase-js@2.118.0` are used, so the handlers run unchanged under
Node in `supabase/tests/functions`.

## auth-username

`POST /functions/v1/auth-username` with `{"username": "...", "password": "..."}` (JSON). Other fields are ignored.

| Status | Body | When |
|---|---|---|
| 200 | `{access_token, refresh_token, expires_in, expires_at, token_type, user}` | signed in; the client calls `supabase.auth.setSession()` |
| 400 | `{"error": "invalid_input"}` | the username breaks the format of `private.is_valid_username` (3–30 of `a-z 0-9 . _ -`, no repeated separators) or the password is not 1–512 characters |
| 401 | `{"error": "invalid_credentials"}` | wrong password **or** unknown (or reserved) username: identical bytes and headers, same minimum delay |
| 403 | `{"error": "email_not_confirmed"}` | the password was right but the address is unconfirmed |
| 429 | `{"error": "rate_limited", "retry_after_seconds": n}` + `Retry-After` | throttle (below) or Auth's own limit |
| 403 / 405 / 413 / 415 | `origin_not_allowed` / `method_not_allowed` / `payload_too_large` / `unsupported_media_type` | |
| 502 / 503 / 500 | `upstream` / `not_configured` / `internal` | |

- **No enumeration.** An unknown username runs the same steps as a known one, including a password grant against a
  random address under the reserved `.invalid` domain; every `invalid_credentials` answer leaves no sooner than 800 ms
  (+ up to 200 ms jitter) after the request arrived. The email behind a username never leaves the server and nothing
  personal is logged.
- **Throttle** (`private.login_attempts`, 15-minute windows): an address with 30 failures in the window is refused first.
  Then `claim_login_attempt(['u:<name>'], 10)` counts the attempt against the username *before* the password is
  checked, in one atomic statement (DESIGN.md §15.10), so parallel guesses cannot pass together: exactly ten attempts
  per username and window reach Auth, every further one answers 429 with the database's `retry_after_seconds` until the
  window ends. Success clears the username's counter; an address counts failures only and keeps its counter (it may be
  shared). Email sign-in is not affected, so a locked username never locks the owner out.
- **Client address:** `CF-Connecting-IP`, else `X-Real-IP`, else the leftmost `X-Forwarded-For` entry. On hosted
  projects Cloudflare sets `CF-Connecting-IP` (and rejects requests that bring their own) and the gateway rebuilds
  `X-Forwarded-For` as `<client>, <client>, <internal hop>`, so the rightmost entry is never used. IPv6 callers are
  throttled per /64 network. Values that are not IP addresses are ignored.
- **Auth call:** `POST {SUPABASE_URL}/auth/v1/token?grant_type=password` with the secret key in `apikey` (never in
  `Authorization`, which the gateway parses as a JWT) and `Sb-Forwarded-For: <client address>`, so Auth's own
  per-address limits apply to the caller instead of to this function.

## account-delete

`POST /functions/v1/account-delete` with `Authorization: Bearer <access token>` and `{"confirm": "DELETE"}`
(`{"confirmation": "DELETE"}`, the `AccountPort` parameter name, is accepted as well).

| Status | Body | When |
|---|---|---|
| 200 | `{"deleted": true, "objectsRemoved": n}` | files removed, account deleted (rows cascade) |
| 400 | `{"error": "invalid_input"}` | missing or wrong confirmation |
| 401 | `{"error": "not_authenticated"}` | no token, or Auth rejects it |
| 401 | `{"error": "reauthentication_needed", "max_age_seconds": 600}` | the session's last sign-in is older than 10 minutes |
| 500 | `{"error": "storage_cleanup_failed", "removed": n, "remaining": m}` | some files remain; **the account is kept**, repeat the request |
| 403 / 405 / 413 / 415 / 502 / 503 / 500 | as above | |

1. The token is verified by Auth (`auth.getUser(token)` with the secret-key client); its `sub` must match.
2. Recent sign-in: the newest `amr` timestamp of the token must be at most 600 s old. `amr` records when a sign-in
   method was used for the session and survives token refreshes; `iat` does not prove a sign-in (every refresh renews it).
3. Paths come from two sources: every `public.assets.object_path` of the user (keyset pages through the Data API; needs
   `grant select on public.assets to service_role`) and a recursive listing of `user-content/<uid>/` (100 entries per
   page, folders followed). Nothing outside `<uid>/` is ever touched. Removal goes through the Storage API in batches
   of at most 1000 (SQL deletes on `storage.objects` are blocked).
4. A fresh listing must show the folder empty; only then is `auth.admin.deleteUser(uid)` called. Any failure leaves the
   account in place; repeating the request is safe. A repeat *after* success answers 401 (the user no longer exists).

## maintenance

`POST /functions/v1/maintenance` with header `x-maintenance-secret: <MAINTENANCE_SECRET>`.

1. `maintenance_run()`: version retention, 30-day trash purge, old throttle windows.
2. Rounds (at most 20) of two-phase asset collection (DESIGN.md §15.3):
   - `maintenance_orphan_assets(p_limit 500)` lists unreferenced assets past their grace: ready files 1 hour after their
     last reservation or confirmation, pending reservations after 6 hours, rejected uploads at once, and rows an
     interrupted run left `deleting` first;
   - `maintenance_forget_assets(ids)` re-checks each one under its owner's assets lock (the lock `reserve_asset` takes)
     and its row lock, marks the ones still collectable `deleting` and returns `{asset_id, object_path}`. From then on
     `reserve_asset` and `confirm_asset` answer 409 `asset_busy` for those bytes and no RPC can reference them;
   - their objects are removed through the Storage API (a failed batch is retried once at once);
   - `maintenance_finish_assets(ids)` drops the rows whose objects are gone (only rows still `deleting`). A row whose
     removal failed stays `deleting` and is the first thing the next run picks up.
   Then `maintenance_orphan_objects(p_limit 500)` (stored files without any asset row, e.g. of deleted accounts) →
   Storage removal.
3. Time: no request starts after 30 s, except removing the objects of rows just marked and finishing those rows (that
   completes what marking began); each request is capped at 10 s, so a run ends within about a minute (the platform
   allows 150 s). What is left waits for the next run.

| Status | Body |
|---|---|
| 200 | `{run, assetsMarked, assetsForgotten, objectsRemoved, orphanObjectsRemoved, rounds, durationMs, stoppedBy, failedRemovals}`; `assetsMarked` = rows marked `deleting`, `assetsForgotten` = rows dropped after their objects were removed; `stoppedBy` is `drained`, `round_limit` or `time_budget` |
| 401 | `{"error": "not_authenticated"}` (wrong or missing secret; compared in constant time) |
| 405 | `{"error": "method_not_allowed"}` (only POST) |
| 503 | `{"error": "not_configured"}` (no `MAINTENANCE_SECRET`, one shorter than 16 characters, or no service client) |
| 502 | `{"error": "upstream", "step": "<function or storage.remove>", …summary}`: the work done before the failure is listed; rows left `deleting` are finished by the next run |

## Environment and secrets

| Variable | Read by | Source | Notes |
|---|---|---|---|
| `SUPABASE_URL` | all | injected by Supabase | |
| `PLATFORM_SECRET_KEY` | all | function secret (optional) | `sb_secret_…`; wins over the injected keys (pin or rotate a dedicated key) |
| `SUPABASE_SECRET_KEYS` | all | injected by Supabase | JSON `{"default": "sb_secret_…"}`; used when `PLATFORM_SECRET_KEY` is unset |
| `SUPABASE_SERVICE_ROLE_KEY` | all | injected (legacy) | last fallback, e.g. a local `supabase start` stack |
| `APP_ORIGINS` | auth-username, account-delete | function secret | exact origins, comma-separated: `https://daniil-777.github.io,http://127.0.0.1:5180,http://localhost:5180` |
| `MAINTENANCE_SECRET` | maintenance | function secret | ≥ 16 characters (`openssl rand -hex 32`); the same value as the GitHub secret `PLATFORM_MAINTENANCE_SECRET` |

`PLATFORM_PUBLISHABLE_KEY` is not read (Auth is called with the secret key); setting it does no harm. Secret names may
not start with `SUPABASE_`. Callers without an `Origin` header (servers, curl) are served without CORS headers: CORS
only protects browsers, and a request with an `Origin` that is not listed is refused with 403 before any work.

## Project settings the functions rely on

1. **JWT verification off at the gateway for all three functions.** With publishable keys, supabase-js sends no
   `Authorization` header while signed out, the cron sends none, and a publishable key is not a JWT. Each function
   authenticates its caller itself (throttle; `auth.getUser`; shared secret). `supabase/config.toml` sets
   `verify_jwt = false` in `[functions.auth-username]`, `[functions.account-delete]` and `[functions.maintenance]`, and
   `supabase functions deploy` applies it when run from the repository root (or with `--workdir` pointing there).
   Deploying without that config needs `--no-verify-jwt`.
2. **Auth → Rate Limits → IP address forwarding: on.** Without it Auth ignores `Sb-Forwarded-For` and counts every
   username sign-in against the function's own address.
3. **CAPTCHA:** Auth does not check CAPTCHA for requests with service-role credentials (`verifyCaptcha` in
   supabase/auth), and this function calls Auth with the secret key, so username sign-in is protected by the throttle.
   The client sends no CAPTCHA token on this path. If CAPTCHA is turned on and Auth does demand a token here, sign-ins
   answer 502 and the logs show `code: "captcha_failed"`; verifying the token inside `auth-username` before the grant
   is not built.
4. **Database grants** (migration `…180400`): `service_role` executes `resolve_login_email`, `login_failures`,
   `claim_login_attempt`, `note_login_attempt`, `admin_set_profile`, `maintenance_run`, `maintenance_orphan_assets`,
   `maintenance_forget_assets`, `maintenance_finish_assets`, `maintenance_orphan_objects`, and selects `public.assets`.

## Deploy (no Docker needed)

```sh
supabase secrets set --project-ref <ref> \
  APP_ORIGINS="https://daniil-777.github.io,http://127.0.0.1:5180,http://localhost:5180" \
  MAINTENANCE_SECRET="$(openssl rand -hex 32)"          # store the same value as PLATFORM_MAINTENANCE_SECRET in GitHub
supabase functions deploy auth-username account-delete maintenance --use-api --project-ref <ref>
```

`--use-api` bundles on Supabase's side (5 MB limit per function), so Docker is not needed. The `verify_jwt = false`
settings come from `supabase/config.toml` (see above). `scripts/platform/provision.mjs` runs both steps (it also sets
`PLATFORM_SECRET_KEY`).

The cron calls:

```sh
curl -fsS -X POST "https://<ref>.supabase.co/functions/v1/maintenance" \
  -H "x-maintenance-secret: $PLATFORM_MAINTENANCE_SECRET"
```

Logs: Supabase dashboard → Edge Functions → Logs. Each function writes one JSON line per event
(`{"fn", "level", "event", …counts}`); passwords, emails, usernames, tokens, user ids, object paths and addresses are
never logged.

## Tests

```sh
node node_modules/vitest/vitest.mjs run supabase/tests/functions
node node_modules/typescript/bin/tsc --noEmit -p supabase/functions/tsconfig.json
```

`shared.test.ts`, `auth-username.test.ts`, `account-delete.test.ts` and `maintenance.test.ts` drive the handlers with
fakes that follow the SQL and the Storage v1 listing semantics; `entrypoints.test.ts` evaluates each `index.ts` with a
stubbed `Deno` global and a mocked supabase-js to check the wiring. Not covered here: the Deno runtime itself and a
live project (`supabase start` + `supabase functions serve` need Docker, so that check belongs in CI).

## Known limits

- The address limit counts failures with a check before the attempt and a note after it, so a burst of parallel
  sign-ins from one address can pass 30 failures before the counter catches up. Each username stays bounded exactly
  (the atomic claim), and Auth's own per-address limit applies through `Sb-Forwarded-For`. An attempt that ends in an
  Auth 429 or 5xx still counts against the username (counters cannot be decremented). Windows are fixed, so a burst
  across a window boundary can reach 20 attempts.
- A row whose object removal failed stays `deleting` until the next run (hourly): uploading exactly those bytes again
  answers `asset_busy` meanwhile (the client retries for a few seconds, then reports a transient failure).
- Objects without any asset row (deleted accounts) are removed after a listing; for a live account such an object can
  only exist after a Storage upload that completed after its reservation was collected. If that account uploads exactly
  those bytes again between the listing and the removal (one Storage request), the new copy is removed with it; the
  client's SHA-256 check on download detects it. Closing this would need a `deleting` placeholder row per object.
- `confirm_asset` marks a size mismatch `rejected` and still answers 409: it returns PostgREST's error body and sets
  `response.status` instead of raising, so the mark is committed. Verified against the SQL in PGlite only; the
  `supabase start` CI job should confirm the HTTP answer of a real stack.
