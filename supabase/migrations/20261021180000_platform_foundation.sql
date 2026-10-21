-- VISCERA account platform, part 1/5: foundation.
-- Private helper schema, error helper, plans (quotas), profiles (one per auth user) and the sign-up trigger.
-- Applied by `supabase db push` / `supabase db reset`; supabase/tests applies it with PGlite on top of a shim.
-- Conventions for every platform migration:
--   * tables live in public with row level security; owner_id = auth.users.id
--   * writes that carry invariants go through SECURITY DEFINER functions with search_path = '' and an explicit
--     auth.uid() check; errors use stable codes in MESSAGE and SQLSTATE 'PT<http status>' so PostgREST answers
--     with that status (409 conflicts, 413 too large, 404, 422 invalid input, 403 limits, 401 signed out)
--   * the API roles get no privileges by default: part 5 revokes everything and grants the minimum

create schema if not exists private;
revoke all on schema private from public;
comment on schema private is 'VISCERA platform internals; not exposed through the Data API.';

create or replace function private.raise_error(p_code text, p_status integer, p_detail text default null)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    message = p_code,
    errcode = 'PT' || lpad(p_status::text, 3, '0'),
    detail = coalesce(p_detail, '');
end
$$;
comment on function private.raise_error(text, integer, text) is
  'Raises a platform error: MESSAGE = stable code, SQLSTATE PT<status> (PostgREST maps it to that HTTP status).';

create or replace function private.require_uid()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    perform private.raise_error('not_authenticated', 401);
  end if;
  return v_uid;
end
$$;

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- Plans ----------------------------------------------------------------------------------------------------------

create table public.plans (
  id text primary key check (id ~ '^[a-z][a-z0-9_]{1,30}$'),
  title text not null check (char_length(title) between 1 and 60),
  storage_quota_bytes bigint not null check (storage_quota_bytes > 0),
  max_file_bytes bigint not null check (max_file_bytes > 0),
  version_retention_days integer not null check (version_retention_days between 1 and 3650),
  max_projects integer not null check (max_projects > 0),
  created_at timestamptz not null default now()
);
comment on table public.plans is 'Account plans: storage quota, per-file limit, version retention, project limit.';

insert into public.plans (id, title, storage_quota_bytes, max_file_bytes, version_retention_days, max_projects)
values
  ('free', 'Free', 524288000, 52428800, 30, 100),
  ('pro', 'Pro', 21474836480, 1073741824, 180, 10000)
on conflict (id) do update set
  title = excluded.title,
  storage_quota_bytes = excluded.storage_quota_bytes,
  max_file_bytes = excluded.max_file_bytes,
  version_retention_days = excluded.version_retention_days,
  max_projects = excluded.max_projects;

alter table public.plans enable row level security;
create policy plans_read on public.plans for select to authenticated using (true);

-- Usernames ------------------------------------------------------------------------------------------------------

create or replace function private.is_valid_username(p_username text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_username is not null
     and p_username ~ '^[a-z0-9](?:[a-z0-9._-]{1,28}[a-z0-9])$'
     and p_username !~ '[._-]{2}'
     and p_username <> all (array[
       'admin', 'administrator', 'root', 'support', 'help', 'viscera', 'system', 'api', 'auth', 'login', 'logout',
       'signin', 'signup', 'sign-in', 'sign-up', 'account', 'accounts', 'settings', 'security', 'null', 'undefined',
       'owner', 'staff', 'team', 'official', 'moderator', 'mod', 'info', 'contact', 'abuse', 'postmaster', 'webmaster',
       'noreply', 'no-reply', 'billing', 'privacy', 'terms', 'library', 'imports', 'projects', 'home', 'trash'
     ])
$$;
comment on function private.is_valid_username(text) is
  'Usernames: 3-30 chars of a-z 0-9 . _ -, alphanumeric at both ends, no repeated separators, not reserved.';

-- Profiles -------------------------------------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text unique check (username is null or private.is_valid_username(username)),
  display_name text check (display_name is null or (char_length(display_name) between 1 and 80
                                                   and display_name = btrim(display_name))),
  avatar_asset_id uuid,
  plan_id text not null default 'free' references public.plans (id),
  appearance text not null default 'system' check (appearance in ('system', 'light', 'dark')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.profiles is 'One row per account (created by a trigger on auth.users).';
comment on column public.profiles.username is 'Optional sign-in name (lower case); sign-in resolves it server-side.';

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function private.touch_updated_at();

alter table public.profiles enable row level security;
create policy profiles_select_own on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy profiles_update_own on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- The profile is created with the account. Username/display name come from the sign-up metadata when valid; a bad or
-- taken username never fails the sign-up (the profile is created without it and the app asks again in Settings).
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_username text := lower(nullif(btrim(v_meta ->> 'username'), ''));
  v_display text := nullif(btrim(coalesce(v_meta ->> 'display_name', v_meta ->> 'full_name', v_meta ->> 'name')), '');
begin
  if v_username is not null and not private.is_valid_username(v_username) then
    v_username := null;
  end if;
  if v_display is not null then
    v_display := btrim(left(v_display, 80));
  end if;
  begin
    insert into public.profiles (id, username, display_name)
    values (new.id, v_username, v_display)
    on conflict (id) do nothing;
  exception when unique_violation then
    insert into public.profiles (id, display_name)
    values (new.id, v_display)
    on conflict (id) do nothing;
  end;
  return new;
end
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();
