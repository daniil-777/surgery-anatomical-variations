-- VISCERA account platform, part 4/5: the personal media library and imported objects.
-- Library items group files (a shape = mesh + textures + spec; a recording = video + data + thumbnail …) that are
-- ready assets of the same owner. Imported objects keep the original file from Unity/Blender/… plus a GLB used for
-- preview, a thumbnail and the analysis (stats, detected source application).

create or replace function private.valid_tags(p_tags text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_tags is not null
     and cardinality(p_tags) <= 20
     and coalesce(array_position(p_tags, null), 0) = 0
     and not exists (
       select 1 from unnest(p_tags) t
        where char_length(t) not between 1 and 32 or t <> btrim(t) or t ~ '[[:cntrl:]]'
     )
     and cardinality(p_tags) = (select count(distinct lower(t)) from unnest(p_tags) t)
$$;
comment on function private.valid_tags(text[]) is 'At most 20 distinct (case-insensitive) trimmed tags of 1-32 chars.';

create table public.library_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('shape', 'material', 'texture', 'recording', 'scene', 'image', 'model')),
  title text not null check (char_length(title) between 1 and 120 and title = btrim(title)),
  description text not null default '' check (char_length(description) <= 2000),
  tags text[] not null default '{}' check (private.valid_tags(tags)),
  lab_id text check (lab_id is null or lab_id ~ '^[a-z][a-z0-9-]{1,31}$'),
  source_project_id uuid references public.projects (id) on delete set null,
  source_version_id uuid references public.project_versions (id) on delete set null,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 65536),
  thumbnail_asset_id uuid references public.assets (id),
  favorite boolean not null default false,
  byte_size bigint not null default 0 check (byte_size >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  trashed_at timestamptz
);
comment on table public.library_items is 'Personal media library: kept shapes, materials, textures, physics recordings, images.';
create index library_items_owner_kind_idx on public.library_items (owner_id, trashed_at, kind, created_at desc);
create index library_items_tags_idx on public.library_items using gin (tags);
create index library_items_thumbnail_idx on public.library_items (thumbnail_asset_id);
create index library_items_source_project_idx on public.library_items (source_project_id);
create index library_items_source_version_idx on public.library_items (source_version_id);

create table public.library_item_files (
  item_id uuid not null references public.library_items (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  filename text not null check (filename ~ '^[^/\\[:cntrl:]]{1,180}$' and filename !~ '^[.]' and filename = btrim(filename)),
  asset_id uuid not null references public.assets (id),
  role text not null check (role in (
    'primary', 'mesh', 'albedo', 'normal', 'roughness', 'metalness', 'height', 'ao', 'emissive', 'opacity',
    'thumbnail', 'preview', 'video', 'data', 'spec', 'material', 'other'
  )),
  position integer not null default 0 check (position between 0 and 1000),
  primary key (item_id, filename)
);
comment on table public.library_item_files is 'Files of a library item (download name, role, content-addressed asset).';
create index library_item_files_asset_idx on public.library_item_files (asset_id);

create table public.imported_objects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120 and title = btrim(title)),
  source_app text not null default 'unknown' check (source_app in (
    'unity', 'blender', 'maya', '3ds-max', 'cinema-4d', 'houdini', 'sketchup', 'substance', 'zbrush',
    'reality-composer', 'sketchfab', 'other', 'unknown'
  )),
  source_detail text check (source_detail is null or char_length(source_detail) between 1 and 200),
  detected_by text not null default 'none' check (detected_by in ('metadata', 'filename', 'user', 'none')),
  format text not null check (format in ('glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', 'usdz', 'dae', 'zip')),
  original_asset_id uuid not null references public.assets (id),
  display_asset_id uuid references public.assets (id),
  thumbnail_asset_id uuid references public.assets (id),
  stats jsonb not null default '{}'::jsonb
    check (jsonb_typeof(stats) = 'object' and octet_length(stats::text) <= 65536),
  tags text[] not null default '{}' check (private.valid_tags(tags)),
  favorite boolean not null default false,
  byte_size bigint not null default 0 check (byte_size >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  trashed_at timestamptz
);
comment on table public.imported_objects is 'Objects imported from Unity, Blender and other tools (original file kept).';
create index imported_objects_owner_source_idx on public.imported_objects (owner_id, trashed_at, source_app, created_at desc);
create index imported_objects_original_idx on public.imported_objects (original_asset_id);
create index imported_objects_display_idx on public.imported_objects (display_asset_id);
create index imported_objects_thumbnail_idx on public.imported_objects (thumbnail_asset_id);

create trigger library_items_touch_updated_at
  before update on public.library_items
  for each row execute function private.touch_updated_at();
create trigger library_items_normalize_stamps
  before update on public.library_items
  for each row execute function private.normalize_client_stamps();
create trigger imported_objects_touch_updated_at
  before update on public.imported_objects
  for each row execute function private.touch_updated_at();
create trigger imported_objects_normalize_stamps
  before update on public.imported_objects
  for each row execute function private.normalize_client_stamps();

alter table public.library_items enable row level security;
alter table public.library_item_files enable row level security;
alter table public.imported_objects enable row level security;

create policy library_items_select_own on public.library_items
  for select to authenticated using (owner_id = (select auth.uid()));
create policy library_items_update_own on public.library_items
  for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy library_items_delete_trashed on public.library_items
  for delete to authenticated using (owner_id = (select auth.uid()) and trashed_at is not null);
create policy library_item_files_select_own on public.library_item_files
  for select to authenticated using (owner_id = (select auth.uid()));
create policy imported_objects_select_own on public.imported_objects
  for select to authenticated using (owner_id = (select auth.uid()));
create policy imported_objects_update_own on public.imported_objects
  for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy imported_objects_delete_trashed on public.imported_objects
  for delete to authenticated using (owner_id = (select auth.uid()) and trashed_at is not null);

create or replace function public.create_library_item(
  p_kind text,
  p_title text,
  p_files jsonb,
  p_description text default '',
  p_tags text[] default '{}',
  p_lab_id text default null,
  p_source_project_id uuid default null,
  p_source_version_id uuid default null,
  p_metadata jsonb default '{}'::jsonb,
  p_thumbnail_asset_id uuid default null
)
returns public.library_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_title text := btrim(coalesce(p_title, ''));
  v_item public.library_items;
  v_file jsonb;
  v_names text[] := '{}';
  v_filename text;
  v_role text;
  v_asset_text text;
  v_position integer;
begin
  if p_kind is null or p_kind not in ('shape', 'material', 'texture', 'recording', 'scene', 'image', 'model') then
    perform private.raise_error('invalid_input', 422, 'kind');
  end if;
  if char_length(v_title) not between 1 and 120 then
    perform private.raise_error('invalid_input', 422, 'title');
  end if;
  if char_length(coalesce(p_description, '')) > 2000 then
    perform private.raise_error('invalid_input', 422, 'description');
  end if;
  if not private.valid_tags(coalesce(p_tags, '{}')) then
    perform private.raise_error('invalid_input', 422, 'tags');
  end if;
  if p_lab_id is not null and p_lab_id !~ '^[a-z][a-z0-9-]{1,31}$' then
    perform private.raise_error('invalid_input', 422, 'lab_id');
  end if;
  if p_metadata is null or jsonb_typeof(p_metadata) <> 'object' or octet_length(p_metadata::text) > 65536 then
    perform private.raise_error('invalid_input', 422, 'metadata');
  end if;
  if p_files is null or jsonb_typeof(p_files) <> 'array'
     or jsonb_array_length(p_files) not between 1 and 64 then
    perform private.raise_error('invalid_input', 422, 'files: 1 to 64 entries');
  end if;
  if p_source_project_id is not null and not exists (
    select 1 from public.projects p where p.id = p_source_project_id and p.owner_id = v_uid) then
    perform private.raise_error('not_found', 404, 'source_project_id');
  end if;
  if p_source_version_id is not null and not exists (
    select 1 from public.project_versions v
     where v.id = p_source_version_id and v.owner_id = v_uid
       and (p_source_project_id is null or v.project_id = p_source_project_id)) then
    perform private.raise_error('not_found', 404, 'source_version_id');
  end if;
  perform private.ready_asset_size(v_uid, p_thumbnail_asset_id, 'thumbnail_asset_id');

  insert into public.library_items
    (owner_id, kind, title, description, tags, lab_id, source_project_id, source_version_id, metadata, thumbnail_asset_id)
  values
    (v_uid, p_kind, v_title, coalesce(p_description, ''), coalesce(p_tags, '{}'), p_lab_id, p_source_project_id,
     p_source_version_id, p_metadata, p_thumbnail_asset_id)
  returning * into v_item;

  for v_file in select e.value from jsonb_array_elements(p_files) e loop
    if jsonb_typeof(v_file) <> 'object' then
      perform private.raise_error('invalid_input', 422, 'file entry must be an object');
    end if;
    v_filename := v_file ->> 'filename';
    v_role := coalesce(v_file ->> 'role', 'other');
    v_asset_text := v_file ->> 'asset_id';
    v_position := coalesce((v_file ->> 'position')::integer, 0);
    if v_filename is null or v_filename !~ '^[^/\\[:cntrl:]]{1,180}$' or v_filename ~ '^[.]'
       or v_filename <> btrim(v_filename) then
      perform private.raise_error('invalid_input', 422, 'filename');
    end if;
    if lower(v_filename) = any (v_names) then
      perform private.raise_error('invalid_input', 422, 'duplicate filename ' || v_filename);
    end if;
    v_names := v_names || lower(v_filename);
    if v_asset_text is null
       or v_asset_text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      perform private.raise_error('invalid_input', 422, 'asset_id of ' || v_filename);
    end if;
    perform private.ready_asset_size(v_uid, v_asset_text::uuid, v_filename);
    insert into public.library_item_files (item_id, owner_id, filename, asset_id, role, position)
    values (v_item.id, v_uid, v_filename, v_asset_text::uuid, v_role, v_position);
  end loop;

  update public.library_items i
     set byte_size = (
       select coalesce(sum(a.byte_size), 0) from public.assets a
        where a.id in (select f.asset_id from public.library_item_files f where f.item_id = i.id)
           or a.id = i.thumbnail_asset_id
     )
   where i.id = v_item.id
  returning * into v_item;
  return v_item;
end
$$;
comment on function public.create_library_item(text, text, jsonb, text, text[], text, uuid, uuid, jsonb, uuid) is
  'Adds a library item from ready assets: files = [{filename, asset_id, role, position}].';

create or replace function public.create_imported_object(
  p_title text,
  p_format text,
  p_original_asset_id uuid,
  p_source_app text default 'unknown',
  p_source_detail text default null,
  p_detected_by text default 'none',
  p_display_asset_id uuid default null,
  p_thumbnail_asset_id uuid default null,
  p_stats jsonb default '{}'::jsonb,
  p_tags text[] default '{}'
)
returns public.imported_objects
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_title text := btrim(coalesce(p_title, ''));
  v_detail text := nullif(btrim(coalesce(p_source_detail, '')), '');
  v_object public.imported_objects;
begin
  if char_length(v_title) not between 1 and 120 then
    perform private.raise_error('invalid_input', 422, 'title');
  end if;
  if p_format is null or p_format not in ('glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', 'usdz', 'dae', 'zip') then
    perform private.raise_error('invalid_input', 422, 'format');
  end if;
  if p_source_app is null or p_source_app not in (
    'unity', 'blender', 'maya', '3ds-max', 'cinema-4d', 'houdini', 'sketchup', 'substance', 'zbrush',
    'reality-composer', 'sketchfab', 'other', 'unknown') then
    perform private.raise_error('invalid_input', 422, 'source_app');
  end if;
  if p_detected_by is null or p_detected_by not in ('metadata', 'filename', 'user', 'none') then
    perform private.raise_error('invalid_input', 422, 'detected_by');
  end if;
  if v_detail is not null then
    v_detail := left(v_detail, 200);
  end if;
  if p_stats is null or jsonb_typeof(p_stats) <> 'object' or octet_length(p_stats::text) > 65536 then
    perform private.raise_error('invalid_input', 422, 'stats');
  end if;
  if not private.valid_tags(coalesce(p_tags, '{}')) then
    perform private.raise_error('invalid_input', 422, 'tags');
  end if;
  perform private.ready_asset_size(v_uid, p_original_asset_id, 'original_asset_id');
  perform private.ready_asset_size(v_uid, p_display_asset_id, 'display_asset_id');
  perform private.ready_asset_size(v_uid, p_thumbnail_asset_id, 'thumbnail_asset_id');

  insert into public.imported_objects
    (owner_id, title, source_app, source_detail, detected_by, format, original_asset_id, display_asset_id,
     thumbnail_asset_id, stats, tags)
  values
    (v_uid, v_title, p_source_app, v_detail, p_detected_by, p_format, p_original_asset_id, p_display_asset_id,
     p_thumbnail_asset_id, p_stats, coalesce(p_tags, '{}'))
  returning * into v_object;

  update public.imported_objects o
     set byte_size = (
       select coalesce(sum(a.byte_size), 0) from public.assets a
        where a.id in (o.original_asset_id, o.display_asset_id, o.thumbnail_asset_id)
     )
   where o.id = v_object.id
  returning * into v_object;
  return v_object;
end
$$;
comment on function public.create_imported_object(text, text, uuid, text, text, text, uuid, uuid, jsonb, text[]) is
  'Registers an imported object (original file + optional preview GLB and thumbnail) with its analysis.';
