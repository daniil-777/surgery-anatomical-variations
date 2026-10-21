-- VISCERA account platform, part 3/5: lab projects with Adobe-style version history.
-- A project belongs to one lab. Its history is a list of immutable numbered versions (seq 1..n); head_version_id is
-- the latest. Between versions the lab autosaves a mutable cloud "draft" (working copy). Every write is optimistic:
-- callers pass the head (and draft revision) they started from and get 409 version_conflict / draft_conflict when
-- another tab or device moved it. Restoring never rewrites history: it commits a new version that reuses the old
-- version's immutable snapshot.

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  lab_id text not null check (lab_id ~ '^[a-z][a-z0-9-]{1,31}$'),
  title text not null check (char_length(title) between 1 and 120 and title = btrim(title)),
  description text not null default '' check (char_length(description) <= 2000),
  head_version_id uuid,
  head_seq integer not null default 0 check (head_seq >= 0),
  draft_asset_id uuid references public.assets (id),
  draft_state_sha256 text check (draft_state_sha256 ~ '^[0-9a-f]{64}$'),
  draft_thumbnail_asset_id uuid references public.assets (id),
  draft_rev bigint not null default 0 check (draft_rev >= 0),
  draft_saved_at timestamptz,
  thumbnail_asset_id uuid references public.assets (id),
  favorite boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  opened_at timestamptz,
  trashed_at timestamptz,
  check ((draft_asset_id is null) = (draft_state_sha256 is null))
);
comment on table public.projects is 'Lab projects. head_* = latest committed version; draft_* = autosaved working copy since then.';
comment on column public.projects.updated_at is 'Last content change (commit or draft save); renames and favourites do not move it.';
create index projects_owner_recent_idx on public.projects (owner_id, trashed_at, updated_at desc);
create index projects_owner_lab_idx on public.projects (owner_id, lab_id);
create index projects_draft_asset_idx on public.projects (draft_asset_id);
create index projects_draft_thumbnail_idx on public.projects (draft_thumbnail_asset_id);
create index projects_thumbnail_idx on public.projects (thumbnail_asset_id);

create table public.project_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  seq integer not null check (seq >= 1),
  parent_version_id uuid references public.project_versions (id) on delete set null,
  kind text not null check (kind in ('initial', 'autosave', 'manual', 'named', 'restore', 'duplicate', 'import')),
  label text check (label is null or (char_length(label) between 1 and 120 and label = btrim(label))),
  snapshot_asset_id uuid not null references public.assets (id),
  state_sha256 text not null check (state_sha256 ~ '^[0-9a-f]{64}$'),
  thumbnail_asset_id uuid references public.assets (id),
  restored_from_version_id uuid references public.project_versions (id) on delete set null,
  lab_schema_version integer not null check (lab_schema_version between 1 and 1000000),
  app_build text check (app_build is null or char_length(app_build) between 1 and 64),
  byte_size bigint not null default 0 check (byte_size >= 0),
  created_at timestamptz not null default now(),
  unique (project_id, seq)
);
comment on table public.project_versions is 'Immutable project versions (only label changes). Labelled versions are kept forever.';
create index project_versions_project_seq_idx on public.project_versions (project_id, seq desc);
create index project_versions_owner_idx on public.project_versions (owner_id, created_at);
create index project_versions_snapshot_idx on public.project_versions (snapshot_asset_id);
create index project_versions_thumbnail_idx on public.project_versions (thumbnail_asset_id);
create index project_versions_parent_idx on public.project_versions (parent_version_id);
create index project_versions_restored_from_idx on public.project_versions (restored_from_version_id);

alter table public.projects
  add constraint projects_head_version_fk
  foreign key (head_version_id) references public.project_versions (id) on delete set null;
create index projects_head_version_idx on public.projects (head_version_id);

create table public.project_version_assets (
  version_id uuid not null references public.project_versions (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  asset_id uuid not null references public.assets (id),
  primary key (version_id, name)
);
comment on table public.project_version_assets is 'Binary attachments of a version snapshot (named, content-addressed).';
create index project_version_assets_asset_idx on public.project_version_assets (asset_id);

create table public.project_draft_assets (
  project_id uuid not null references public.projects (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  asset_id uuid not null references public.assets (id),
  primary key (project_id, name)
);
comment on table public.project_draft_assets is 'Binary attachments of the current draft.';
create index project_draft_assets_asset_idx on public.project_draft_assets (asset_id);

alter table public.projects enable row level security;
alter table public.project_versions enable row level security;
alter table public.project_version_assets enable row level security;
alter table public.project_draft_assets enable row level security;

create policy projects_select_own on public.projects
  for select to authenticated using (owner_id = (select auth.uid()));
create policy projects_update_own on public.projects
  for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy projects_delete_trashed on public.projects
  for delete to authenticated using (owner_id = (select auth.uid()) and trashed_at is not null);
create policy project_versions_select_own on public.project_versions
  for select to authenticated using (owner_id = (select auth.uid()));
create policy project_version_assets_select_own on public.project_version_assets
  for select to authenticated using (owner_id = (select auth.uid()));
create policy project_draft_assets_select_own on public.project_draft_assets
  for select to authenticated using (owner_id = (select auth.uid()));

-- Client edits may only stamp "now" into trashed_at / opened_at (no back-dating into an early purge).
create or replace function private.normalize_client_stamps()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.trashed_at is distinct from old.trashed_at and new.trashed_at is not null then
    new.trashed_at := now();
  end if;
  -- nested so that tables without opened_at never plan an expression that names it
  if tg_table_name = 'projects' then
    if new.opened_at is distinct from old.opened_at and new.opened_at is not null then
      new.opened_at := now();
    end if;
  end if;
  return new;
end
$$;
create trigger projects_normalize_stamps
  before update on public.projects
  for each row execute function private.normalize_client_stamps();

-- Helpers --------------------------------------------------------------------------------------------------------

create or replace function private.require_sha256(p_value text, p_field text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_value is null or p_value !~ '^[0-9a-f]{64}$' then
    perform private.raise_error('invalid_input', 422, p_field);
  end if;
end
$$;

-- Validates [{"name": "...", "asset_id": "<uuid>"}, …] (≤ 64, unique names, ready assets of p_uid).
create or replace function private.attachment_rows(p_uid uuid, p_attachments jsonb)
returns table (att_name text, att_asset_id uuid, att_bytes bigint)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_item jsonb;
  v_names text[] := '{}';
  v_id text;
begin
  if p_attachments is null or jsonb_typeof(p_attachments) = 'null' then
    return;
  end if;
  if jsonb_typeof(p_attachments) <> 'array' then
    perform private.raise_error('invalid_input', 422, 'attachments must be an array');
  end if;
  if jsonb_array_length(p_attachments) > 64 then
    perform private.raise_error('invalid_input', 422, 'at most 64 attachments');
  end if;
  for v_item in select e.value from jsonb_array_elements(p_attachments) e loop
    if jsonb_typeof(v_item) <> 'object' then
      perform private.raise_error('invalid_input', 422, 'attachment must be an object');
    end if;
    att_name := v_item ->> 'name';
    v_id := v_item ->> 'asset_id';
    if att_name is null or att_name !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' then
      perform private.raise_error('invalid_input', 422, 'attachment name');
    end if;
    if att_name = any (v_names) then
      perform private.raise_error('invalid_input', 422, 'duplicate attachment name ' || att_name);
    end if;
    if v_id is null or v_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      perform private.raise_error('invalid_input', 422, 'attachment asset_id');
    end if;
    v_names := v_names || att_name;
    att_asset_id := v_id::uuid;
    att_bytes := private.ready_asset_size(p_uid, att_asset_id, 'attachment ' || att_name);
    return next;
  end loop;
end
$$;

-- Inserts the version's attachments and sets its byte_size (snapshot + distinct attachments).
create or replace function private.attach_version_assets(p_uid uuid, p_version_id uuid, p_attachments jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into public.project_version_assets (version_id, owner_id, name, asset_id)
  select p_version_id, p_uid, r.att_name, r.att_asset_id from private.attachment_rows(p_uid, p_attachments) r;
  update public.project_versions v
     set byte_size = (
       select coalesce(sum(a.byte_size), 0) from public.assets a
        where a.id = v.snapshot_asset_id
           or a.id in (select x.asset_id from public.project_version_assets x where x.version_id = v.id)
     )
   where v.id = p_version_id;
end
$$;

create or replace function private.lock_own_project(p_uid uuid, p_project_id uuid)
returns public.projects
language plpgsql
set search_path = ''
as $$
declare
  v_project public.projects;
begin
  select p.* into v_project from public.projects p where p.id = p_project_id and p.owner_id = p_uid for update;
  if not found then
    perform private.raise_error('not_found', 404, 'project');
  end if;
  if v_project.trashed_at is not null then
    perform private.raise_error('project_trashed', 409, 'restore the project from the trash first');
  end if;
  return v_project;
end
$$;

create or replace function private.require_head(p_project public.projects, p_expected_head uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_project.head_version_id is distinct from p_expected_head then
    perform private.raise_error('version_conflict', 409,
      json_build_object('head_version_id', p_project.head_version_id, 'head_seq', p_project.head_seq)::text);
  end if;
end
$$;

create or replace function private.clear_draft(p_project_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  delete from public.project_draft_assets d where d.project_id = p_project_id;
  update public.projects p
     set draft_asset_id = null, draft_state_sha256 = null, draft_thumbnail_asset_id = null,
         draft_saved_at = null, draft_rev = p.draft_rev + 1
   where p.id = p_project_id;
end
$$;

-- RPCs -----------------------------------------------------------------------------------------------------------

create or replace function public.create_project(
  p_lab_id text,
  p_title text,
  p_snapshot_asset_id uuid,
  p_state_sha256 text,
  p_thumbnail_asset_id uuid default null,
  p_lab_schema_version integer default 1,
  p_app_build text default null,
  p_attachments jsonb default '[]'::jsonb,
  p_description text default ''
)
returns public.projects
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_title text := btrim(coalesce(p_title, ''));
  v_max integer;
  v_count integer;
  v_project public.projects;
  v_version_id uuid;
begin
  if p_lab_id is null or p_lab_id !~ '^[a-z][a-z0-9-]{1,31}$' then
    perform private.raise_error('invalid_input', 422, 'lab_id');
  end if;
  if char_length(v_title) not between 1 and 120 then
    perform private.raise_error('invalid_input', 422, 'title');
  end if;
  if char_length(coalesce(p_description, '')) > 2000 then
    perform private.raise_error('invalid_input', 422, 'description');
  end if;
  perform private.require_sha256(p_state_sha256, 'state_sha256');
  if p_lab_schema_version is null or p_lab_schema_version not between 1 and 1000000 then
    perform private.raise_error('invalid_input', 422, 'lab_schema_version');
  end if;
  if p_app_build is not null and char_length(p_app_build) not between 1 and 64 then
    perform private.raise_error('invalid_input', 422, 'app_build');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('viscera.projects:' || v_uid::text, 0));
  select pl.max_projects into v_max
    from public.profiles pr join public.plans pl on pl.id = pr.plan_id where pr.id = v_uid;
  if not found then
    perform private.raise_error('not_found', 404, 'profile');
  end if;
  select count(*) into v_count from public.projects p where p.owner_id = v_uid and p.trashed_at is null;
  if v_count >= v_max then
    perform private.raise_error('limit_reached', 403, format('at most %s projects on this plan', v_max));
  end if;

  perform private.ready_asset_size(v_uid, p_snapshot_asset_id, 'snapshot_asset_id');
  perform private.ready_asset_size(v_uid, p_thumbnail_asset_id, 'thumbnail_asset_id');

  insert into public.projects (owner_id, lab_id, title, description, thumbnail_asset_id)
  values (v_uid, p_lab_id, v_title, coalesce(p_description, ''), p_thumbnail_asset_id)
  returning * into v_project;

  insert into public.project_versions
    (project_id, owner_id, seq, kind, snapshot_asset_id, state_sha256, thumbnail_asset_id, lab_schema_version, app_build)
  values
    (v_project.id, v_uid, 1, 'initial', p_snapshot_asset_id, p_state_sha256, p_thumbnail_asset_id,
     p_lab_schema_version, p_app_build)
  returning id into v_version_id;
  perform private.attach_version_assets(v_uid, v_version_id, p_attachments);

  update public.projects p set head_version_id = v_version_id, head_seq = 1
   where p.id = v_project.id
  returning * into v_project;
  return v_project;
end
$$;
comment on function public.create_project(text, text, uuid, text, uuid, integer, text, jsonb, text) is
  'Creates a project with version 1 (kind initial) from an uploaded snapshot.';

create or replace function public.save_draft(
  p_project_id uuid,
  p_expected_head_version_id uuid,
  p_expected_draft_rev bigint,
  p_snapshot_asset_id uuid,
  p_state_sha256 text,
  p_thumbnail_asset_id uuid default null,
  p_attachments jsonb default '[]'::jsonb
)
returns public.projects
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_project public.projects;
begin
  v_project := private.lock_own_project(v_uid, p_project_id);
  perform private.require_head(v_project, p_expected_head_version_id);
  if p_expected_draft_rev is distinct from v_project.draft_rev then
    perform private.raise_error('draft_conflict', 409, json_build_object('draft_rev', v_project.draft_rev)::text);
  end if;
  perform private.require_sha256(p_state_sha256, 'state_sha256');
  perform private.ready_asset_size(v_uid, p_snapshot_asset_id, 'snapshot_asset_id');
  perform private.ready_asset_size(v_uid, p_thumbnail_asset_id, 'thumbnail_asset_id');

  delete from public.project_draft_assets d where d.project_id = p_project_id;
  insert into public.project_draft_assets (project_id, owner_id, name, asset_id)
  select p_project_id, v_uid, r.att_name, r.att_asset_id from private.attachment_rows(v_uid, p_attachments) r;

  update public.projects p
     set draft_asset_id = p_snapshot_asset_id,
         draft_state_sha256 = p_state_sha256,
         draft_thumbnail_asset_id = p_thumbnail_asset_id,
         draft_rev = p.draft_rev + 1,
         draft_saved_at = now(),
         updated_at = now(),
         thumbnail_asset_id = coalesce(p_thumbnail_asset_id, p.thumbnail_asset_id)
   where p.id = p_project_id
  returning * into v_project;
  return v_project;
end
$$;
comment on function public.save_draft(uuid, uuid, bigint, uuid, text, uuid, jsonb) is
  'Autosave: replaces the working copy. 409 version_conflict if the head moved, draft_conflict if the draft did.';

create or replace function public.discard_draft(p_project_id uuid, p_expected_draft_rev bigint)
returns public.projects
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_project public.projects;
begin
  v_project := private.lock_own_project(v_uid, p_project_id);
  if p_expected_draft_rev is distinct from v_project.draft_rev then
    perform private.raise_error('draft_conflict', 409, json_build_object('draft_rev', v_project.draft_rev)::text);
  end if;
  perform private.clear_draft(p_project_id);
  update public.projects p
     set thumbnail_asset_id = coalesce(
       (select v.thumbnail_asset_id from public.project_versions v where v.id = p.head_version_id),
       p.thumbnail_asset_id)
   where p.id = p_project_id
  returning * into v_project;
  return v_project;
end
$$;

create or replace function public.commit_version(
  p_project_id uuid,
  p_expected_head_version_id uuid,
  p_kind text,
  p_snapshot_asset_id uuid,
  p_state_sha256 text,
  p_label text default null,
  p_thumbnail_asset_id uuid default null,
  p_lab_schema_version integer default 1,
  p_app_build text default null,
  p_attachments jsonb default '[]'::jsonb
)
returns public.project_versions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_project public.projects;
  v_label text := nullif(btrim(coalesce(p_label, '')), '');
  v_version public.project_versions;
begin
  v_project := private.lock_own_project(v_uid, p_project_id);
  perform private.require_head(v_project, p_expected_head_version_id);
  if p_kind is null or p_kind not in ('autosave', 'manual', 'named') then
    perform private.raise_error('invalid_input', 422, 'kind');
  end if;
  if p_kind = 'named' and v_label is null then
    perform private.raise_error('invalid_input', 422, 'a named version needs a label');
  end if;
  if v_label is not null and char_length(v_label) > 120 then
    perform private.raise_error('invalid_input', 422, 'label');
  end if;
  perform private.require_sha256(p_state_sha256, 'state_sha256');
  if p_lab_schema_version is null or p_lab_schema_version not between 1 and 1000000 then
    perform private.raise_error('invalid_input', 422, 'lab_schema_version');
  end if;
  if p_app_build is not null and char_length(p_app_build) not between 1 and 64 then
    perform private.raise_error('invalid_input', 422, 'app_build');
  end if;
  perform private.ready_asset_size(v_uid, p_snapshot_asset_id, 'snapshot_asset_id');
  perform private.ready_asset_size(v_uid, p_thumbnail_asset_id, 'thumbnail_asset_id');

  insert into public.project_versions
    (project_id, owner_id, seq, parent_version_id, kind, label, snapshot_asset_id, state_sha256, thumbnail_asset_id,
     lab_schema_version, app_build)
  values
    (p_project_id, v_uid, v_project.head_seq + 1, v_project.head_version_id, p_kind, v_label, p_snapshot_asset_id,
     p_state_sha256, p_thumbnail_asset_id, p_lab_schema_version, p_app_build)
  returning * into v_version;
  perform private.attach_version_assets(v_uid, v_version.id, p_attachments);
  perform private.clear_draft(p_project_id);
  update public.projects p
     set head_version_id = v_version.id,
         head_seq = v_version.seq,
         updated_at = now(),
         thumbnail_asset_id = coalesce(p_thumbnail_asset_id, p.thumbnail_asset_id)
   where p.id = p_project_id;
  select v.* into v_version from public.project_versions v where v.id = v_version.id;
  return v_version;
end
$$;
comment on function public.commit_version(uuid, uuid, text, uuid, text, text, uuid, integer, text, jsonb) is
  'Creates the next version (autosave checkpoint, manual save or named version) and clears the draft.';

create or replace function public.restore_version(
  p_project_id uuid,
  p_version_id uuid,
  p_expected_head_version_id uuid
)
returns public.project_versions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_project public.projects;
  v_source public.project_versions;
  v_version public.project_versions;
begin
  v_project := private.lock_own_project(v_uid, p_project_id);
  perform private.require_head(v_project, p_expected_head_version_id);
  select v.* into v_source from public.project_versions v
   where v.id = p_version_id and v.project_id = p_project_id and v.owner_id = v_uid;
  if not found then
    perform private.raise_error('not_found', 404, 'version');
  end if;

  insert into public.project_versions
    (project_id, owner_id, seq, parent_version_id, kind, snapshot_asset_id, state_sha256, thumbnail_asset_id,
     restored_from_version_id, lab_schema_version, app_build, byte_size)
  values
    (p_project_id, v_uid, v_project.head_seq + 1, v_project.head_version_id, 'restore', v_source.snapshot_asset_id,
     v_source.state_sha256, v_source.thumbnail_asset_id, v_source.id, v_source.lab_schema_version,
     v_source.app_build, v_source.byte_size)
  returning * into v_version;
  insert into public.project_version_assets (version_id, owner_id, name, asset_id)
  select v_version.id, v_uid, x.name, x.asset_id from public.project_version_assets x where x.version_id = v_source.id;
  perform private.clear_draft(p_project_id);
  update public.projects p
     set head_version_id = v_version.id,
         head_seq = v_version.seq,
         updated_at = now(),
         thumbnail_asset_id = coalesce(v_source.thumbnail_asset_id, p.thumbnail_asset_id)
   where p.id = p_project_id;
  return v_version;
end
$$;
comment on function public.restore_version(uuid, uuid, uuid) is
  'Non-destructive restore: a new head version that reuses the chosen version''s snapshot; clears the draft.';

create or replace function public.label_version(p_version_id uuid, p_label text)
returns public.project_versions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_label text := nullif(btrim(coalesce(p_label, '')), '');
  v_version public.project_versions;
begin
  if v_label is not null and char_length(v_label) > 120 then
    perform private.raise_error('invalid_input', 422, 'label');
  end if;
  update public.project_versions v set label = v_label
   where v.id = p_version_id and v.owner_id = v_uid
  returning * into v_version;
  if not found then
    perform private.raise_error('not_found', 404, 'version');
  end if;
  return v_version;
end
$$;
comment on function public.label_version(uuid, text) is 'Names (keeps forever) or un-names a version.';

create or replace function public.delete_version(p_version_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_version public.project_versions;
  v_head uuid;
begin
  select v.* into v_version from public.project_versions v where v.id = p_version_id and v.owner_id = v_uid;
  if not found then
    perform private.raise_error('not_found', 404, 'version');
  end if;
  select p.head_version_id into v_head from public.projects p where p.id = v_version.project_id for update;
  if v_head = v_version.id then
    perform private.raise_error('invalid_input', 422, 'the current version cannot be deleted');
  end if;
  if v_version.label is not null then
    perform private.raise_error('invalid_input', 422, 'remove the name before deleting a named version');
  end if;
  delete from public.project_versions v where v.id = p_version_id;
end
$$;

create or replace function public.duplicate_project(p_project_id uuid, p_title text, p_version_id uuid default null)
returns public.projects
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_title text := btrim(coalesce(p_title, ''));
  v_source_project public.projects;
  v_source public.project_versions;
  v_max integer;
  v_count integer;
  v_project public.projects;
  v_version_id uuid;
begin
  if char_length(v_title) not between 1 and 120 then
    perform private.raise_error('invalid_input', 422, 'title');
  end if;
  select p.* into v_source_project from public.projects p where p.id = p_project_id and p.owner_id = v_uid;
  if not found then
    perform private.raise_error('not_found', 404, 'project');
  end if;
  select v.* into v_source from public.project_versions v
   where v.id = coalesce(p_version_id, v_source_project.head_version_id)
     and v.project_id = p_project_id and v.owner_id = v_uid;
  if not found then
    perform private.raise_error('not_found', 404, 'version');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('viscera.projects:' || v_uid::text, 0));
  select pl.max_projects into v_max
    from public.profiles pr join public.plans pl on pl.id = pr.plan_id where pr.id = v_uid;
  select count(*) into v_count from public.projects p where p.owner_id = v_uid and p.trashed_at is null;
  if v_count >= v_max then
    perform private.raise_error('limit_reached', 403, format('at most %s projects on this plan', v_max));
  end if;

  insert into public.projects (owner_id, lab_id, title, description, thumbnail_asset_id)
  values (v_uid, v_source_project.lab_id, v_title, v_source_project.description, v_source.thumbnail_asset_id)
  returning * into v_project;
  insert into public.project_versions
    (project_id, owner_id, seq, kind, snapshot_asset_id, state_sha256, thumbnail_asset_id, restored_from_version_id,
     lab_schema_version, app_build, byte_size)
  values
    (v_project.id, v_uid, 1, 'duplicate', v_source.snapshot_asset_id, v_source.state_sha256,
     v_source.thumbnail_asset_id, v_source.id, v_source.lab_schema_version, v_source.app_build, v_source.byte_size)
  returning id into v_version_id;
  insert into public.project_version_assets (version_id, owner_id, name, asset_id)
  select v_version_id, v_uid, x.name, x.asset_id from public.project_version_assets x where x.version_id = v_source.id;
  update public.projects p set head_version_id = v_version_id, head_seq = 1
   where p.id = v_project.id
  returning * into v_project;
  return v_project;
end
$$;
comment on function public.duplicate_project(uuid, text, uuid) is
  'Save/open as copy: a new project whose version 1 shares the chosen version''s immutable files.';
