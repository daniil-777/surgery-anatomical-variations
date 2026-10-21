-- VISCERA account platform, part 5/5: username sign-in helpers, usage, maintenance and the privilege model.
-- Maintenance runs from the `maintenance` Edge Function (service role): version retention, trash purge (30 days),
-- orphan collection (unreferenced assets after a grace period; the function deletes the Storage objects).

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
    'used_bytes', (select coalesce(sum(a.byte_size), 0) from public.assets a
                    where a.owner_id = v_uid and a.status = 'ready'),
    'pending_bytes', (select coalesce(sum(a.byte_size), 0) from public.assets a
                       where a.owner_id = v_uid and a.status = 'pending'),
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

create or replace function public.maintenance_orphan_assets(
  p_limit integer default 500,
  p_grace interval default interval '1 day',
  p_now timestamptz default now()
)
returns table (asset_id uuid, object_path text, byte_size bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.object_path, a.byte_size
    from public.assets a
   where a.last_used_at < p_now - p_grace
     and not private.asset_is_referenced(a.id)
   order by a.last_used_at
   limit greatest(1, least(coalesce(p_limit, 500), 1000))
$$;
comment on function public.maintenance_orphan_assets(integer, interval, timestamptz) is
  'Service role: unreferenced assets unused for the grace period (candidates for deletion).';

-- Deletes the rows of assets that are still orphaned (re-checked under lock) and returns their object paths;
-- the caller then removes those objects from Storage.
create or replace function public.maintenance_forget_assets(
  p_asset_ids uuid[],
  p_grace interval default interval '1 day',
  p_now timestamptz default now()
)
returns table (object_path text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_asset public.assets;
begin
  for v_asset in
    select a.* from public.assets a where a.id = any (coalesce(p_asset_ids, '{}')) for update
  loop
    if v_asset.last_used_at < p_now - p_grace and not private.asset_is_referenced(v_asset.id) then
      delete from public.assets a where a.id = v_asset.id;
      object_path := v_asset.object_path;
      return next;
    end if;
  end loop;
end
$$;

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

revoke execute on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;

grant execute on function
  public.reserve_asset(text, bigint, text),
  public.confirm_asset(uuid),
  public.create_project(text, text, uuid, text, uuid, integer, text, jsonb, text),
  public.save_draft(uuid, uuid, bigint, uuid, text, uuid, jsonb),
  public.discard_draft(uuid, bigint),
  public.commit_version(uuid, uuid, text, uuid, text, text, uuid, integer, text, jsonb),
  public.restore_version(uuid, uuid, uuid),
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
  public.maintenance_run(timestamptz),
  public.maintenance_orphan_assets(integer, interval, timestamptz),
  public.maintenance_forget_assets(uuid[], interval, timestamptz),
  public.maintenance_orphan_objects(integer, interval, timestamptz)
  to service_role;
