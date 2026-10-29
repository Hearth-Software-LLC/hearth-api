-- Hearth Studio, part 2: the Library (screenshots, chosen mockups, ad images, uploads and app
-- icons, shared by the team's Macs, iPhones and iPads), and ad campaigns and Store Studio
-- designs, which used to be files in each repo.
--
-- Files live in the private `library` bucket at <team>/<app>/<kind>/<sha256>.<ext>, so the same
-- image is stored once. Each client keeps a sync cursor: a row's `seq` moves on with every
-- change, deletions included.

begin;

create sequence public.studio_change_seq;

create table public.library_runs (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.studio_teams (id) on delete cascade,
  app text not null check (app ~ '^[a-z0-9-]{1,40}$'),
  device text not null check (char_length(device) between 1 and 80),
  appearance text not null check (char_length(appearance) between 1 and 40),
  source text check (char_length(source) <= 120),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index library_runs_group on public.library_runs (team_id, app, device, appearance, created_at desc);

create table public.library_assets (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.studio_teams (id) on delete cascade,
  app text not null check (app ~ '^[a-z0-9-]{1,40}$'),
  kind text not null check (kind in ('screenshot', 'mockup', 'ad', 'upload', 'icon')),
  device text check (char_length(device) <= 80),
  appearance text check (char_length(appearance) <= 40),
  name text not null check (char_length(name) between 1 and 200),
  path text not null,
  thumb_path text,
  content_type text not null check (content_type in ('image/webp', 'image/png', 'image/jpeg', 'image/heic', 'video/mp4', 'video/quicktime')),
  width integer check (width between 1 and 20000),
  height integer check (height between 1 and 20000),
  bytes bigint not null check (bytes between 1 and 2147483647),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  run_id uuid references public.library_runs (id) on delete set null,
  -- Order within a run (screenshot 01, 02, …).
  position integer,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  seq bigint not null default nextval('public.studio_change_seq'),
  deleted_at timestamptz
);
create index library_assets_sync on public.library_assets (team_id, seq);
create index library_assets_app on public.library_assets (team_id, app, kind) where deleted_at is null;
create unique index library_assets_one_per_run on public.library_assets (run_id, name) where run_id is not null and deleted_at is null;

create table public.marketing_campaigns (
  team_id uuid not null references public.studio_teams (id) on delete cascade,
  app text not null check (app ~ '^[a-z0-9-]{1,40}$'),
  slug text not null check (slug ~ '^[a-z0-9-]{1,80}$'),
  name text not null check (char_length(name) between 1 and 120),
  document jsonb not null check (jsonb_typeof(document) = 'object'),
  version integer not null default 1,
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  seq bigint not null default nextval('public.studio_change_seq'),
  deleted_at timestamptz,
  primary key (team_id, app, slug)
);
create index marketing_campaigns_sync on public.marketing_campaigns (team_id, seq);

create table public.store_designs (
  team_id uuid not null references public.studio_teams (id) on delete cascade,
  app text not null check (app ~ '^[a-z0-9-]{1,40}$'),
  document jsonb not null check (jsonb_typeof(document) = 'object'),
  version integer not null default 1,
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  seq bigint not null default nextval('public.studio_change_seq'),
  primary key (team_id, app)
);
create index store_designs_sync on public.store_designs (team_id, seq);

do $$
declare
  t text;
begin
  foreach t in array array['library_runs', 'library_assets', 'marketing_campaigns', 'store_designs'] loop
    execute format('alter table public.%I enable row level security', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on public.%I from authenticated', t);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on sequence public.studio_change_seq from anon, authenticated;
  end if;
end
$$;

commit;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('library', 'library', false, 52428800)
    on conflict (id) do nothing;
  end if;
end
$$;
