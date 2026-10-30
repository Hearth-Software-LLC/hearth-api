-- Collections: Hearth Content items people browse, download, rate and report in the apps.
--
-- A downloadable type (its definition's `listing.downloadable`) gives each version a listing: a
-- title, an about, up to three categories, Free or Plus, and a cover. The listing is saved and
-- reviewed with the version. Free bundles stay in the public `hearth-content` bucket; Plus bundles
-- go to the private `hearth-content-plus` bucket and are handed out as 10-minute signed links to
-- people with the plan.
--
-- Authors have a public profile (name, bio, a monogram color, an optional photo). People rate
-- (1 to 5 stars, one rating per person per item) and report items; publishers review the reports.
-- Each app's catalog gains a featured list (up to five items) with its own version.
--
-- Like the other content tables: row-level security on, no policies, no grants to app roles.

begin;

alter table public.content_versions add column if not exists listing jsonb;

alter table public.content_entries
  add column if not exists rating_average numeric(3, 2),
  add column if not exists rating_count integer not null default 0 check (rating_count >= 0);

alter table public.content_catalogs
  add column if not exists featured jsonb not null default '[]'::jsonb,
  add column if not exists featured_version integer not null default 0;

-- Rolling back rebuilds the catalog entry from the release: the full hash and the download size.
alter table public.content_releases
  add column if not exists sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  add column if not exists download_bytes bigint;

create table public.content_authors (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.studio_teams (id) on delete cascade,
  user_id uuid not null,
  name text not null check (char_length(name) between 1 and 40),
  bio text not null default '' check (char_length(bio) <= 160),
  color text not null check (color ~ '^#[0-9A-F]{6}$'),
  photo_media_id uuid references public.content_media (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (team_id, user_id)
);

create table public.content_ratings (
  entry_id uuid not null references public.content_entries (id) on delete cascade,
  user_id uuid not null,
  stars smallint not null check (stars between 1 and 5),
  updated_at timestamptz not null default now(),
  primary key (entry_id, user_id)
);
create index content_ratings_user on public.content_ratings (user_id);

create table public.content_collection_reports (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.content_entries (id) on delete cascade,
  user_id uuid not null,
  reason text not null check (reason in ('harmful', 'broken', 'copyright', 'other')),
  details text not null default '' check (char_length(details) <= 1000),
  state text not null default 'open' check (state in ('open', 'dismissed', 'actioned')),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid
);
create index content_collection_reports_open on public.content_collection_reports (entry_id, created_at) where state = 'open';
create index content_collection_reports_user on public.content_collection_reports (user_id, created_at desc);

-- Learning modules are Collections: counted in lessons.
update public.content_types
set definition = definition || '{"listing":{"downloadable":true,"unit":{"one":"lesson","many":"lessons"},"countFrom":"sections"}}'::jsonb
where slug = 'learning-module' and not (definition ? 'listing');

do $$
declare
  t text;
begin
  foreach t in array array['content_authors', 'content_ratings', 'content_collection_reports'] loop
    execute format('alter table public.%I enable row level security', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on public.%I from authenticated', t);
    end if;
  end loop;
end
$$;

commit;

-- Plus bundles: private, read only through signed links hearth-api makes after a plan check.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('hearth-content-plus', 'hearth-content-plus', false, 52428800)
    on conflict (id) do nothing;
  end if;
end
$$;
