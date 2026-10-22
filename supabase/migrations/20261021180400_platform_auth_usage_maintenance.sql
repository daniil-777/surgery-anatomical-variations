-- VISCERA account platform, part 5/5: username sign-in helpers, usage, maintenance and the privilege model.
-- Maintenance runs hourly from the `maintenance` Edge Function (service role): version retention, trash purge
-- (30 days) and two-phase orphan collection: maintenance_forget_assets marks unreferenced assets past their grace
-- 'deleting', the function removes their objects through the Storage API, maintenance_finish_assets drops the rows.

-- Username sign-in --------------------------------------------------------------------------------------------------

create or replace function public.username_available(p_username text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_valid_username(p_username)
     and not exists (select 1 from public.profiles p where p.username = p_username)
$$;
comment on function public.username_available(text) is 'True when the (lower-case) username is valid and free.';

create or replace function public.resolve_login_email(p_username text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.email::text
    from public.profiles p
    join auth.users u on u.id = p.id
   where p.username = lower(btrim(p_username))
$$;
comment on function public.resolve_login_email(text) is 'Service role only: the email behind a username (auth-username function).';

create table private.login_attempts (
  key text not null check (char_length(key) between 1 and 200),
  window_start timestamptz not null,
  failures integer not null default 0 check (failures >= 0),
  primary key (key, window_start)
);
comment on table private.login_attempts is 'Failed username sign-ins per key (u:<username>, ip:<address>) per 15-minute window.';

create or replace function public.login_failures(p_keys text[])
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(max(a.failures), 0)
    from private.login_attempts a
   where a.key = any (coalesce(p_keys, '{}'))
     and a.window_start = date_bin(interval '15 minutes', now(), timestamptz '2000-01-01 00:00:00+00')
$$;

create or replace function public.note_login_attempt(p_keys text[], p_success boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz := date_bin(interval '15 minutes', now(), timestamptz '2000-01-01 00:00:00+00');
  v_key text;
begin
  foreach v_key in array coalesce(p_keys, '{}') loop
    if v_key is null or char_length(v_key) not between 1 and 200 then
      continue;
    end if;
    if p_success then
      -- a successful sign-in clears that username's counter; shared addresses keep theirs
      if v_key like 'u:%' then
        delete from private.login_attempts a where a.key = v_key;
      end if;
    else
      insert into private.login_attempts (key, window_start, failures)
      values (v_key, v_window, 1)
      on conflict (key, window_start) do update set failures = private.login_attempts.failures + 1;
    end if;
  end loop;
end
$$;

-- Claims one username sign-in attempt before the password is checked (auth-username, DESIGN.md §15.10): every valid
-- key's counter in the current 15-minute window goes up in one statement, so parallel attempts cannot slip past the
-- limit. allowed = no key is over p_limit after the claim. A successful sign-in then clears the username's counter
-- (note_login_attempt with p_success = true); a locked caller retries after retry_after_seconds.
create or replace function public.claim_login_attempt(p_keys text[], p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz := date_bin(interval '15 minutes', now(), timestamptz '2000-01-01 00:00:00+00');
  v_attempts integer;
begin
  if p_limit is null or p_limit < 1 then
    perform private.raise_error('invalid_input', 422, 'limit');
  end if;
  with claimed as (
    insert into private.login_attempts as a (key, window_start, failures)
    select distinct k.key, v_window, 1
      from unnest(coalesce(p_keys, '{}')) as k (key)
     where k.key is not null and char_length(k.key) between 1 and 200
    on conflict (key, window_start) do update set failures = a.failures + 1
    returning a.failures
  )
  select coalesce(max(c.failures), 0) into v_attempts from claimed c;
  return jsonb_build_object(
    'allowed', v_attempts <= p_limit,
    'attempts', v_attempts,
    'retry_after_seconds', case
      when v_attempts <= p_limit then 0
      else greatest(1, ceil(extract(epoch from (v_window + interval '15 minutes' - now())))::integer)
    end
  );
end
$$;
comment on function public.claim_login_attempt(text[], integer) is
  'Service role only: counts a username sign-in attempt for every key; {allowed, attempts, retry_after_seconds}.';

-- Profiles -----------------------------------------------------------------------------------------------------------

-- Operator changes to a profile (plan, username, display name) for provisioning with the secret key: the service role
-- has no table privileges, and nothing in the browser can ever change a plan. Null or blank arguments keep the field.
create or replace function public.admin_set_profile(
  p_user_id uuid,
  p_plan_id text default null,
  p_username text default null,
  p_display_name text default null
)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_username text := lower(nullif(btrim(coalesce(p_username, '')), ''));
  v_display text := nullif(btrim(coalesce(p_display_name, '')), '');
  v_profile public.profiles;
begin
  if p_plan_id is not null and not exists (select 1 from public.plans pl where pl.id = p_plan_id) then
    perform private.raise_error('not_found', 404, 'plan');
  end if;
  if v_username is not null and not private.is_valid_username(v_username) then
    perform private.raise_error('invalid_input', 422, 'username');
  end if;
  if v_username is not null
     and exists (select 1 from public.profiles pr where pr.username = v_username and pr.id is distinct from p_user_id) then
    perform private.raise_error('invalid_input', 422, 'username taken');
  end if;
  if v_display is not null and char_length(v_display) > 80 then
    perform private.raise_error('invalid_input', 422, 'display_name');
  end if;
  update public.profiles pr
     set plan_id = coalesce(p_plan_id, pr.plan_id),
         username = coalesce(v_username, pr.username),
         display_name = coalesce(v_display, pr.display_name)
   where pr.id = p_user_id
  returning * into v_profile;
  if not found then
    perform private.raise_error('not_found', 404, 'profile');
  end if;
  return v_profile;
end
$$;
comment on function public.admin_set_profile(uuid, text, text, text) is
  'Service role only: sets a profile''s plan, username or display name (null or blank keeps the current value).';

-- Operator changes to the plans themselves (a quota for every free account, a plan for one account, the CI contract's
-- tiny plan) with the secret key, for the same reason: the service role has no table privileges.
create or replace function public.admin_upsert_plan(
  p_id text,
  p_title text,
  p_storage_quota_bytes bigint,
  p_max_file_bytes bigint,
  p_version_retention_days integer,
  p_max_projects integer
)
returns public.plans
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_plan public.plans;
begin
  if p_id is null or p_id !~ '^[a-z][a-z0-9_]{1,30}$' then
    perform private.raise_error('invalid_input', 422, 'id');
  end if;
  if char_length(v_title) not between 1 and 60 then
    perform private.raise_error('invalid_input', 422, 'title');
  end if;
  if p_storage_quota_bytes is null or p_storage_quota_bytes <= 0 then
    perform private.raise_error('invalid_input', 422, 'storage_quota_bytes');
  end if;
  if p_max_file_bytes is null or p_max_file_bytes <= 0 then
    perform private.raise_error('invalid_input', 422, 'max_file_bytes');
  end if;
  if p_version_retention_days is null or p_version_retention_days not between 1 and 3650 then
    perform private.raise_error('invalid_input', 422, 'version_retention_days');
  end if;
  if p_max_projects is null or p_max_projects <= 0 then
    perform private.raise_error('invalid_input', 422, 'max_projects');
  end if;
  insert into public.plans (id, title, storage_quota_bytes, max_file_bytes, version_retention_days, max_projects)
  values (p_id, v_title, p_storage_quota_bytes, p_max_file_bytes, p_version_retention_days, p_max_projects)
  on conflict (id) do update set
    title = excluded.title,
    storage_quota_bytes = excluded.storage_quota_bytes,
    max_file_bytes = excluded.max_file_bytes,
    version_retention_days = excluded.version_retention_days,
    max_projects = excluded.max_projects
  returning * into v_plan;
  return v_plan;
end
$$;
comment on function public.admin_upsert_plan(text, text, bigint, bigint, integer, integer) is
  'Service role only: creates or changes a plan (limits apply to every account on it at once).';

-- Usage --------------------------------------------------------------------------------------------------------------

create or replace function public.my_usage()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_usage jsonb;
begin
  select jsonb_build_object(
    'plan_id', pl.id,
    'plan_title', pl.title,
    'storage_quota_bytes', pl.storage_quota_bytes,
    'max_file_bytes', pl.max_file_bytes,
    'version_retention_days', pl.version_retention_days,
    'max_projects', pl.max_projects,
    -- used + pending is what the quota counts: stored files (ready, or being collected) and uploads that are not
    -- usable files (in progress, or stored with another size and awaiting collection)
    'used_bytes', (select coalesce(sum(a.byte_size), 0) from public.assets a
                    where a.owner_id = v_uid and a.status in ('ready', 'deleting')),
    'pending_bytes', (select coalesce(sum(a.byte_size), 0) from public.assets a
                       where a.owner_id = v_uid and a.status in ('pending', 'rejected')),
    'project_count', (select count(*) from public.projects p where p.owner_id = v_uid and p.trashed_at is null),
    'version_count', (select count(*) from public.project_versions v where v.owner_id = v_uid),
    'library_count', (select count(*) from public.library_items i where i.owner_id = v_uid and i.trashed_at is null),
    'import_count', (select count(*) from public.imported_objects o where o.owner_id = v_uid and o.trashed_at is null),
    'trash_count', (select (select count(*) from public.projects p where p.owner_id = v_uid and p.trashed_at is not null)
                         + (select count(*) from public.library_items i where i.owner_id = v_uid and i.trashed_at is not null)
                         + (select count(*) from public.imported_objects o where o.owner_id = v_uid and o.trashed_at is not null))
  )
    into v_usage
    from public.profiles pr
    join public.plans pl on pl.id = pr.plan_id
   where pr.id = v_uid;
  if v_usage is null then
    perform private.raise_error('not_found', 404, 'profile');
  end if;
  return v_usage;
end
$$;
comment on function public.my_usage() is 'Plan limits and current usage of the signed-in account.';

-- Maintenance (service role) --------------------------------------------------------------------------------------

create or replace function public.maintenance_run(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_versions integer;
  v_projects integer;
  v_items integer;
  v_imports integer;
  v_attempts integer;
begin
  -- version retention: unnamed, not the head, older than the plan's window, beyond the newest five of the project
  with ranked as (
    select v.id,
           v.label,
           v.created_at,
           p.head_version_id,
           pl.version_retention_days,
           row_number() over (partition by v.project_id order by v.seq desc) as recency
      from public.project_versions v
      join public.projects p on p.id = v.project_id
      join public.profiles pr on pr.id = p.owner_id
      join public.plans pl on pl.id = pr.plan_id
  )
  delete from public.project_versions v
   using ranked r
   where v.id = r.id
     and r.label is null
     and r.id is distinct from r.head_version_id
     and r.recency > 5
     and r.created_at < p_now - make_interval(days => r.version_retention_days);
  get diagnostics v_versions = row_count;

  delete from public.projects p where p.trashed_at < p_now - interval '30 days';
  get diagnostics v_projects = row_count;
  delete from public.library_items i where i.trashed_at < p_now - interval '30 days';
  get diagnostics v_items = row_count;
  delete from public.imported_objects o where o.trashed_at < p_now - interval '30 days';
  get diagnostics v_imports = row_count;
  delete from private.login_attempts a where a.window_start < p_now - interval '1 day';
  get diagnostics v_attempts = row_count;

  return jsonb_build_object(
    'versions_pruned', v_versions,
    'projects_purged', v_projects,
    'library_items_purged', v_items,
    'imports_purged', v_imports,
    'login_windows_dropped', v_attempts
  );
end
$$;
comment on function public.maintenance_run(timestamptz) is 'Service role: version retention, 30-day trash purge, throttle cleanup.';

create or replace function private.asset_is_referenced(p_asset_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from public.project_versions v where v.snapshot_asset_id = p_asset_id)
      or exists (select 1 from public.project_versions v where v.thumbnail_asset_id = p_asset_id)
      or exists (select 1 from public.project_version_assets x where x.asset_id = p_asset_id)
      or exists (select 1 from public.project_draft_assets x where x.asset_id = p_asset_id)
      or exists (select 1 from public.projects p where p.draft_asset_id = p_asset_id)
      or exists (select 1 from public.projects p where p.draft_thumbnail_asset_id = p_asset_id)
      or exists (select 1 from public.projects p where p.thumbnail_asset_id = p_asset_id)
      or exists (select 1 from public.library_items i where i.thumbnail_asset_id = p_asset_id)
      or exists (select 1 from public.library_item_files f where f.asset_id = p_asset_id)
      or exists (select 1 from public.imported_objects o where o.original_asset_id = p_asset_id)
      or exists (select 1 from public.imported_objects o where o.display_asset_id = p_asset_id)
      or exists (select 1 from public.imported_objects o where o.thumbnail_asset_id = p_asset_id)
      or exists (select 1 from public.profiles pr where pr.avatar_asset_id = p_asset_id)
$$;

-- Whether an asset's state and age make it collectable (references are checked separately): ready files 1 hour after
-- their last reservation or confirmation, pending reservations after 6 hours (slow resumable uploads), rejected
-- uploads at once, and rows already being collected (left by an interrupted run) always.
create or replace function private.asset_is_collectable(
  p_status text,
  p_last_used_at timestamptz,
  p_ready_grace interval,
  p_pending_grace interval,
  p_now timestamptz
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_status
    when 'deleting' then true
    when 'rejected' then true
    when 'pending' then p_last_used_at < p_now - coalesce(p_pending_grace, interval '6 hours')
    when 'ready' then p_last_used_at < p_now - coalesce(p_ready_grace, interval '1 hour')
    else false
  end
$$;

create or replace function public.maintenance_orphan_assets(
  p_limit integer default 500,
  p_ready_grace interval default interval '1 hour',
  p_pending_grace interval default interval '6 hours',
  p_now timestamptz default now()
)
returns table (asset_id uuid, object_path text, byte_size bigint, status text)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.object_path, a.byte_size, a.status
    from public.assets a
   where (a.status in ('deleting', 'rejected')
          or (a.status = 'pending' and a.last_used_at < coalesce(p_now, now()) - coalesce(p_pending_grace, interval '6 hours'))
          or (a.status = 'ready' and a.last_used_at < coalesce(p_now, now()) - coalesce(p_ready_grace, interval '1 hour')))
     and not private.asset_is_referenced(a.id)
   -- rows an interrupted run left 'deleting' first: until they are finished, their bytes cannot be reserved again
   order by a.status = 'deleting' desc, a.last_used_at, a.id
   limit greatest(1, least(coalesce(p_limit, 500), 1000))
$$;
comment on function public.maintenance_orphan_assets(integer, interval, interval, timestamptz) is
  'Service role: collectable assets (unreferenced; ready 1 h, pending 6 h, rejected at once, deleting always).';

-- Phase 1 of collecting assets. Re-checks every candidate under its owner's assets lock (the lock reserve_asset takes)
-- and its row lock, marks the ones still collectable 'deleting' and returns them: from then on reserve_asset and
-- confirm_asset answer asset_busy and nothing can reference them. The caller removes the objects through the Storage
-- API, then calls maintenance_finish_assets with the ids whose objects are gone. Rows already 'deleting' are returned
-- again, so an interrupted collection is simply repeated.
create or replace function public.maintenance_forget_assets(
  p_asset_ids uuid[],
  p_ready_grace interval default interval '1 hour',
  p_pending_grace interval default interval '6 hours',
  p_now timestamptz default now()
)
returns table (asset_id uuid, object_path text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[] := coalesce(p_asset_ids, '{}');
  v_now timestamptz := coalesce(p_now, now());
  v_owner uuid;
  v_asset public.assets;
begin
  -- owners in a fixed order, so overlapping runs wait for each other instead of deadlocking
  for v_owner in select distinct a.owner_id from public.assets a where a.id = any (v_ids) order by 1 loop
    perform pg_advisory_xact_lock(hashtextextended('viscera.assets:' || v_owner::text, 0));
    for v_asset in
      select a.* from public.assets a where a.owner_id = v_owner and a.id = any (v_ids) order by a.id for update
    loop
      if private.asset_is_collectable(v_asset.status, v_asset.last_used_at, p_ready_grace, p_pending_grace, v_now)
         and not private.asset_is_referenced(v_asset.id) then
        if v_asset.status <> 'deleting' then
          update public.assets a set status = 'deleting' where a.id = v_asset.id;
        end if;
        asset_id := v_asset.id;
        object_path := v_asset.object_path;
        return next;
      end if;
    end loop;
  end loop;
end
$$;
comment on function public.maintenance_forget_assets(uuid[], interval, interval, timestamptz) is
  'Service role, phase 1: marks still-collectable assets deleting (under the owner''s lock) and returns their paths.';

-- Phase 2: drops the rows of collected assets once the caller removed their objects. Only rows still 'deleting' go
-- (nothing turns a row back, and a row with a reference is kept rather than failing the batch); returns the dropped.
create or replace function public.maintenance_finish_assets(p_asset_ids uuid[])
returns table (asset_id uuid, object_path text)
language sql
security definer
set search_path = ''
as $$
  delete from public.assets a
   where a.id = any (coalesce(p_asset_ids, '{}'))
     and a.status = 'deleting'
     and not private.asset_is_referenced(a.id)
  returning a.id, a.object_path
$$;
comment on function public.maintenance_finish_assets(uuid[]) is
  'Service role, phase 2: drops asset rows still marked deleting, after their Storage objects were removed.';

-- Stored objects without an asset row: left behind by deleted accounts (their rows cascade, Storage objects do not)
-- or by uploads whose reservation was collected. Storage blocks SQL deletes, so the caller removes them through the
-- Storage API.
create or replace function public.maintenance_orphan_objects(
  p_limit integer default 500,
  p_grace interval default interval '1 day',
  p_now timestamptz default now()
)
returns table (object_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.name
    from storage.objects o
   where o.bucket_id = 'user-content'
     and o.created_at < p_now - p_grace
     and not exists (select 1 from public.assets a where a.object_path = o.name)
   order by o.created_at
   limit greatest(1, least(coalesce(p_limit, 500), 1000))
$$;
comment on function public.maintenance_orphan_objects(integer, interval, timestamptz) is
  'Service role: user-content objects with no asset row (deleted accounts, collected reservations).';

-- Privileges -----------------------------------------------------------------------------------------------------
-- Supabase grants ALL on new public tables/functions to anon and authenticated by default. Start from nothing and
-- grant the minimum. A future migration that adds a table or function must repeat this pattern for it.

revoke all on all tables in schema public from anon, authenticated;
grant select on
  public.plans, public.profiles, public.assets, public.projects, public.project_versions,
  public.project_version_assets, public.project_draft_assets, public.library_items, public.library_item_files,
  public.imported_objects
  to authenticated;
grant update (username, display_name, avatar_asset_id, appearance) on public.profiles to authenticated;
grant update (title, description, favorite, opened_at, trashed_at) on public.projects to authenticated;
grant update (title, description, tags, favorite, trashed_at) on public.library_items to authenticated;
grant update (title, tags, favorite, trashed_at, source_app, detected_by) on public.imported_objects to authenticated;
grant delete on public.projects, public.library_items, public.imported_objects to authenticated;
-- The account-delete function lists a user's object paths through the Data API with the service role. Projects on
-- the newer default grant nothing to the API roles implicitly, so this read must be granted explicitly.
grant select on public.assets to service_role;

revoke execute on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
-- CHECK constraints run their functions with the privileges of whoever writes the row, so the roles that edit rows
-- directly (column grants; the service role in operations) need these pure validators, or every such update fails
-- with "permission denied for function". The private schema itself stays closed (no USAGE).
grant execute on function
  private.is_valid_username(text),
  private.valid_tags(text[]),
  private.is_allowed_mime(text)
  to authenticated, service_role;

grant execute on function
  public.reserve_asset(text, bigint, text),
  public.confirm_asset(uuid),
  public.create_project(text, text, uuid, text, uuid, integer, text, jsonb, text),
  public.save_draft(uuid, uuid, bigint, uuid, text, uuid, jsonb, integer, text),
  public.discard_draft(uuid, bigint),
  public.commit_version(uuid, uuid, bigint, text, uuid, text, text, uuid, integer, text, jsonb),
  public.restore_version(uuid, uuid, uuid, bigint),
  public.label_version(uuid, text),
  public.delete_version(uuid),
  public.duplicate_project(uuid, text, uuid),
  public.create_library_item(text, text, jsonb, text, text[], text, uuid, uuid, jsonb, uuid),
  public.create_imported_object(text, text, uuid, text, text, text, uuid, uuid, jsonb, text[]),
  public.my_usage()
  to authenticated;
grant execute on function public.username_available(text) to anon, authenticated;
grant execute on function
  public.resolve_login_email(text),
  public.login_failures(text[]),
  public.note_login_attempt(text[], boolean),
  public.claim_login_attempt(text[], integer),
  public.admin_set_profile(uuid, text, text, text),
  public.admin_upsert_plan(text, text, bigint, bigint, integer, integer),
  public.maintenance_run(timestamptz),
  public.maintenance_orphan_assets(integer, interval, interval, timestamptz),
  public.maintenance_forget_assets(uuid[], interval, interval, timestamptz),
  public.maintenance_finish_assets(uuid[]),
  public.maintenance_orphan_objects(integer, interval, timestamptz)
  to service_role;

-- Functions a later migration adds are executable by nobody until that migration grants them (DESIGN.md §15.11).
-- The global form is needed to drop PUBLIC's built-in EXECUTE; the per-schema form undoes Supabase's grant in public.
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
