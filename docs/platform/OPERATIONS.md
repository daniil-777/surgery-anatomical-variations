# Operating the VISCERA account platform

Runbook for the Supabase project behind the account shell. Secret values never go into this repository: they live in the
Supabase project (Edge Function secrets), GitHub Actions secrets and the operator's macOS keychain (service
`viscera-platform`).

## What runs where

| Piece | Where | Configured by |
|---|---|---|
| Static site (studio + shell) | GitHub Pages, `https://daniil-777.github.io/surgery-anatomical-variations/` | `.github/workflows/pages.yml` |
| Shell switch | `public/platform.json` (committed disabled; Pages writes the production copy) | repository variables `PLATFORM_SUPABASE_URL`, `PLATFORM_SUPABASE_KEY`, `PLATFORM_PROVIDERS`, `PLATFORM_EMAIL_DELIVERY` |
| Database, Auth, Storage | Supabase project `viscera` (eu-central-1) | `supabase/migrations/*`, `supabase/config.toml` |
| Edge Functions | `auth-username`, `account-delete`, `maintenance` | `supabase/functions/*`, secrets below |
| Daily maintenance | `.github/workflows/platform-maintenance.yml` (cron) | secret `PLATFORM_MAINTENANCE_SECRET`, variable `PLATFORM_SUPABASE_URL` |

Edge Function secrets: `PLATFORM_SECRET_KEY` (`sb_secret_…`), `PLATFORM_PUBLISHABLE_KEY` (`sb_publishable_…`),
`APP_ORIGINS` (comma-separated exact origins allowed by CORS), `MAINTENANCE_SECRET`.

## First provisioning

Prerequisite: `supabase login` once on the operator's Mac (opens the browser; the token is kept in the keychain).

```sh
cd ~/dev/viscera-platform
node scripts/platform/provision.mjs --project viscera --region eu-central-1
```

The script is idempotent and prints every step:
1. finds the organisation, creates the project if missing (random database password → keychain), waits until healthy;
2. `supabase link`, `supabase db push` (migrations), `supabase config push` (auth, storage, email templates, providers);
3. `supabase functions deploy auth-username account-delete maintenance --use-api` and `supabase secrets set …`;
4. reads the publishable/secret keys, stores the secret key in the keychain only, sets the GitHub repository
   variables/secrets above with `gh`;
5. creates or updates the owner account through the Admin API when `PLATFORM_OWNER_EMAIL` and
   `PLATFORM_OWNER_PASSWORD` are set in the environment of that one command (never written to disk).

Deploy the site afterwards by merging to `main`; `pages.yml` writes the production `platform.json` after the existing
public-copy smoke and runs `scripts/smoke_platform.mjs` against the final artifact before uploading.

## Turning on more ways to sign in

All providers ship disabled in `supabase/config.toml`. After creating the credentials below, set the matching
environment variables when running `supabase config push`, flip `enabled = true`, and add the provider to the
`PLATFORM_PROVIDERS` repository variable so the button appears.

- **Email codes and password reset (custom SMTP).** Supabase's built-in mailer only reaches the project team (2 emails
  per hour). Options: Gmail with an app password (`smtp.gmail.com:587`, sender = the Gmail address; requires 2-step
  verification), or Resend/Postmark/SES with a verified domain. Set `[auth.email.smtp]` (host, port, user, pass,
  admin_email, sender_name), raise `rate_limit_email_sent`, then set `PLATFORM_EMAIL_DELIVERY=true`. Consider turning
  `enable_confirmations` on at the same time.
- **Google.** Google Auth Platform → Branding, Audience (publish to *In production*; *Testing* allows only 100 listed
  users), Data access (`openid`, `userinfo.email`, `userinfo.profile`). Create an OAuth client of type *Web
  application*: authorised JavaScript origin `https://daniil-777.github.io`, redirect URI
  `https://<ref>.supabase.co/auth/v1/callback`. Variables: `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID`,
  `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET`.
- **Apple.** Needs the Apple Developer Program (99 USD/year): an App ID, a Services ID (domain `<ref>.supabase.co`,
  return URL `https://<ref>.supabase.co/auth/v1/callback`), a Sign in with Apple key (.p8) with its Key ID, and your Team
  ID. Generate the client-secret JWT (ES256, max 6 months) and put it in `SUPABASE_AUTH_EXTERNAL_APPLE_SECRET`; the
  Services ID is the client id. **Rotate the secret before it expires (calendar reminder every 5 months).**
- **GitHub.** Settings → Developer settings → OAuth Apps → New: homepage = the site URL, callback =
  `https://<ref>.supabase.co/auth/v1/callback`.
- **Microsoft.** Azure app registration (web) with the same callback; `azure` provider.
- **CAPTCHA** (recommended before public promotion): Cloudflare Turnstile or hCaptcha keys in `[auth.captcha]`; the
  shell sends the token on sign-up, sign-in and reset.

## Limits and when to upgrade

Free plan: 500 MB database, 1 GB files in total, 50 MB per file, ~10 GB egress per month, 50k monthly active users,
no backups, and the project pauses after 7 days without database activity (the daily maintenance job counts as
activity). Platform plans in the database (`public.plans`): free = 500 MB per account, 50 MB per file, 30-day version
history. Move to Supabase Pro ($25/month: 100 GB files, 500 GB per file, daily backups, no pausing) when real users
arrive, then raise the `pro` plan row and the bucket `file_size_limit`. Change an account's plan with
`update public.profiles set plan_id = 'pro' where id = '<uuid>';` (SQL editor, service role).

## Routine tasks

- **Backups (free plan):** `supabase db dump --linked -f backup.sql` (schema + data; needs Docker or a local
  `pg_dump`), plus Storage objects via the API. Keep dumps encrypted and off the public repo.
- **Rotate keys:** create a new secret key in the dashboard, `supabase secrets set PLATFORM_SECRET_KEY=…`, update the
  keychain, delete the old key. The publishable key is public; rotating it means updating the repository variable.
- **Restore a deleted project:** projects go to the trash first and stay restorable for 30 days (Trash in the shell).
  After purge, only a database backup can bring rows back; Storage objects are collected one day after they become
  unreferenced.
- **A user asks for deletion:** Settings → Delete account (removes files, then the account). Admins can call the
  `account-delete` function with that user's session or delete the user in the dashboard (files are then collected by
  the maintenance job via `maintenance_orphan_objects`).
- **Watch:** Supabase dashboard → Logs (Auth, Storage, Edge Functions); GitHub Actions → platform-maintenance runs.

## Security notes

- Every table has row-level security; the browser can only read its own rows and write through checked functions.
- Storage objects are private; downloads use short-lived signed URLs; only images, video, 3D formats, JSON, gzip/zip and
  plain text are accepted (never HTML/SVG/scripts).
- The site shares the `daniil-777.github.io` origin with the user's other Pages sites, which could read the session in
  localStorage. Serving the app from its own custom domain removes that; then update `site_url`, the redirect list,
  `APP_ORIGINS` and `PLATFORM_SUPABASE_URL` consumers.
