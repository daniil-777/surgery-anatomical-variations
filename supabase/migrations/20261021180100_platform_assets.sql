-- VISCERA account platform, part 2/5: content-addressed assets and the private storage bucket.
-- Every file a user keeps (snapshots, thumbnails, meshes, textures, videos, imported objects) is one asset row keyed by
-- (owner, sha256) and one object at user-content/<owner>/<sha[0:2]>/<sha>. Upload protocol:
--   1. reserve_asset(sha256, size, mime)  -> quota + per-file checks, dedup (ready rows need no upload)
--   2. Storage upload to object_path       -> allowed only for the caller's own pending reservations
--   3. confirm_asset(asset_id)              -> the object exists with the same size -> status 'ready'
-- Only ready assets can be referenced. Objects are never deleted by clients; the maintenance function removes
-- unreachable ones (service role).

create or replace function private.is_allowed_mime(p_mime text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_mime is not null and p_mime = any (array[
    'image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/ktx2',
    'video/mp4', 'video/webm',
    'model/gltf-binary', 'model/gltf+json', 'model/obj', 'model/stl', 'model/vnd.usdz+zip',
    'application/json', 'application/gzip', 'application/zip', 'application/octet-stream', 'text/plain'
  ])
$$;
comment on function private.is_allowed_mime(text) is
  'MIME types accepted for user files. Never HTML, SVG, XML or scripts (signed URLs serve files as stored).';

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint not null check (byte_size > 0),
  mime_type text not null check (private.is_allowed_mime(mime_type)),
  object_path text not null unique,
  status text not null default 'pending' check (status in ('pending', 'ready')),
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  ready_at timestamptz,
  unique (owner_id, sha256),
  check (object_path = owner_id::text || '/' || substr(sha256, 1, 2) || '/' || sha256)
);
comment on table public.assets is 'Content-addressed user files (one per owner and SHA-256); bytes live in Storage.';
comment on column public.assets.last_used_at is 'Last reservation; orphan collection waits for a grace period after it.';
create index assets_owner_created_idx on public.assets (owner_id, created_at);

alter table public.assets enable row level security;
create policy assets_select_own on public.assets
  for select to authenticated using (owner_id = (select auth.uid()));

alter table public.profiles
  add constraint profiles_avatar_asset_fk foreign key (avatar_asset_id) references public.assets (id) on delete set null;
create index profiles_avatar_asset_idx on public.profiles (avatar_asset_id);

-- Size of an asset the caller owns and may reference (ready). 0 for null.
create or replace function private.ready_asset_size(p_uid uuid, p_asset_id uuid, p_field text)
returns bigint
language plpgsql
stable
set search_path = ''
as $$
declare
  v_size bigint;
  v_status text;
begin
  if p_asset_id is null then
    return 0;
  end if;
  select a.byte_size, a.status into v_size, v_status
    from public.assets a
   where a.id = p_asset_id and a.owner_id = p_uid;
  if not found then
    perform private.raise_error('not_found', 404, p_field);
  end if;
  if v_status <> 'ready' then
    perform private.raise_error('asset_not_ready', 409, p_field);
  end if;
  return v_size;
end
$$;

create or replace function private.check_profile_avatar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.avatar_asset_id is not null and new.avatar_asset_id is distinct from old.avatar_asset_id then
    perform private.ready_asset_size(new.id, new.avatar_asset_id, 'avatar_asset_id');
  end if;
  return new;
end
$$;
create trigger profiles_check_avatar
  before update of avatar_asset_id on public.profiles
  for each row execute function private.check_profile_avatar();

create or replace function public.reserve_asset(p_sha256 text, p_byte_size bigint, p_mime_type text)
returns table (asset_id uuid, object_path text, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_quota bigint;
  v_max_file bigint;
  v_used bigint;
  v_row public.assets;
begin
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    perform private.raise_error('invalid_input', 422, 'sha256');
  end if;
  if p_byte_size is null or p_byte_size <= 0 then
    perform private.raise_error('invalid_input', 422, 'byte_size');
  end if;
  if not private.is_allowed_mime(p_mime_type) then
    perform private.raise_error('invalid_input', 422, 'mime_type');
  end if;

  -- one reservation at a time per account keeps the quota sum exact
  perform pg_advisory_xact_lock(hashtextextended('viscera.assets:' || v_uid::text, 0));

  select a.* into v_row from public.assets a where a.owner_id = v_uid and a.sha256 = p_sha256;
  if found then
    if v_row.byte_size <> p_byte_size then
      perform private.raise_error('invalid_input', 422, 'byte_size differs from the stored file with this sha256');
    end if;
    update public.assets a set last_used_at = now() where a.id = v_row.id;
    return query select v_row.id, v_row.object_path, v_row.status;
    return;
  end if;

  select pl.storage_quota_bytes, pl.max_file_bytes into v_quota, v_max_file
    from public.profiles pr join public.plans pl on pl.id = pr.plan_id
   where pr.id = v_uid;
  if not found then
    perform private.raise_error('not_found', 404, 'profile');
  end if;
  if p_byte_size > v_max_file then
    perform private.raise_error('file_too_large', 413, format('%s bytes; the limit is %s', p_byte_size, v_max_file));
  end if;
  select coalesce(sum(a.byte_size), 0) into v_used from public.assets a where a.owner_id = v_uid;
  if v_used + p_byte_size > v_quota then
    perform private.raise_error('quota_exceeded', 413, format('%s of %s bytes used', v_used, v_quota));
  end if;

  insert into public.assets (owner_id, sha256, byte_size, mime_type, object_path)
  values (v_uid, p_sha256, p_byte_size, p_mime_type, v_uid::text || '/' || substr(p_sha256, 1, 2) || '/' || p_sha256)
  returning * into v_row;
  return query select v_row.id, v_row.object_path, v_row.status;
end
$$;
comment on function public.reserve_asset(text, bigint, text) is
  'Step 1 of an upload: quota/size checks and dedup. Returns the object path; status ready = already stored.';

create or replace function public.confirm_asset(p_asset_id uuid)
returns public.assets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_row public.assets;
  v_size bigint;
begin
  select a.* into v_row from public.assets a where a.id = p_asset_id and a.owner_id = v_uid for update;
  if not found then
    perform private.raise_error('not_found', 404, 'asset');
  end if;
  if v_row.status = 'ready' then
    return v_row;
  end if;
  select (o.metadata ->> 'size')::bigint into v_size
    from storage.objects o
   where o.bucket_id = 'user-content' and o.name = v_row.object_path;
  if not found then
    perform private.raise_error('upload_missing', 409, v_row.object_path);
  end if;
  if v_size is distinct from v_row.byte_size then
    perform private.raise_error('size_mismatch', 409, format('stored %s bytes, reserved %s', v_size, v_row.byte_size));
  end if;
  update public.assets a set status = 'ready', ready_at = now() where a.id = v_row.id returning * into v_row;
  return v_row;
end
$$;
comment on function public.confirm_asset(uuid) is
  'Step 3 of an upload: the stored object must exist with the reserved size; then the asset is ready.';

-- Storage --------------------------------------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'user-content', 'user-content', false, 52428800,
  array[
    'image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/ktx2',
    'video/mp4', 'video/webm',
    'model/gltf-binary', 'model/gltf+json', 'model/obj', 'model/stl', 'model/vnd.usdz+zip',
    'application/json', 'application/gzip', 'application/zip', 'application/octet-stream', 'text/plain'
  ]
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "user-content: read own objects" on storage.objects
  for select to authenticated
  using (bucket_id = 'user-content' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "user-content: upload reserved objects" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'user-content'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1 from public.assets a
       where a.object_path = name and a.owner_id = (select auth.uid()) and a.status = 'pending'
    )
  );

create policy "user-content: replace pending uploads" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'user-content'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1 from public.assets a
       where a.object_path = name and a.owner_id = (select auth.uid()) and a.status = 'pending'
    )
  )
  with check (
    bucket_id = 'user-content'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1 from public.assets a
       where a.object_path = name and a.owner_id = (select auth.uid()) and a.status = 'pending'
    )
  );
