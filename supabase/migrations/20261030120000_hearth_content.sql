-- Hearth Content (content.hearthapps.com): content for the Hearth apps, written, reviewed and
-- published by the Hearth Software team.
--
-- Who can do what lives on the existing team: each member gains a content role (author, reviewer
-- or publisher) and the apps it covers (null = every app, which shared content needs). Owners can
-- do everything; admins publish everywhere. Invite codes carry the same two fields.
--
-- Published items are immutable JSON bundles in the public `hearth-content` bucket at
-- apps/<app>/<type>/<slug>.v<version>.<hash>.json (shared/... for shared content). Each app reads
-- its catalog from GET /v1/content/<app>/catalog, which merges in the shared catalog.
--
-- Like the other API-only tables: row-level security on, no policies, no grants to app roles.

begin;

alter table public.studio_members
  add column if not exists content_role text check (content_role in ('author', 'reviewer', 'publisher')),
  add column if not exists content_apps text[];
alter table public.studio_invites
  add column if not exists content_role text check (content_role in ('author', 'reviewer', 'publisher')),
  add column if not exists content_apps text[];

-- Wrong invite codes, to slow guessing (5 per account per 15 minutes).
create table public.studio_invite_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  at timestamptz not null default now()
);
create index studio_invite_attempts_user on public.studio_invite_attempts (user_id, at desc);

-- A content type: its fields, whether it has sections (a Learning module's lessons), which blocks
-- it allows and its review steps. Changing the shape bumps schema_version.
create table public.content_types (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.studio_teams (id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9-]{1,40}$'),
  -- null: shared, offered in every app.
  app_key text check (app_key ~ '^[a-z0-9-]{1,40}$'),
  name text not null check (char_length(name) between 1 and 60),
  description text not null default '' check (char_length(description) <= 300),
  schema_version integer not null default 1 check (schema_version >= 1),
  definition jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, slug)
);

create table public.content_entries (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.studio_teams (id) on delete cascade,
  -- 'shared' for shared content.
  app_key text not null check (app_key ~ '^[a-z0-9-]{1,40}$'),
  type_id uuid not null references public.content_types (id),
  slug text not null check (slug ~ '^[a-z0-9-]{1,80}$'),
  title text not null check (char_length(title) between 1 and 120),
  owner_id uuid not null,
  latest_version integer not null default 1,
  live_version integer,
  live_release_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index content_entries_slug on public.content_entries (team_id, app_key, slug) where deleted_at is null;
create index content_entries_team on public.content_entries (team_id, updated_at desc);

create table public.content_versions (
  entry_id uuid not null references public.content_entries (id) on delete cascade,
  version integer not null check (version >= 1),
  body jsonb not null,
  schema_version integer not null,
  state text not null default 'draft' check (state in ('draft', 'in_review', 'changes_requested', 'approved', 'published')),
  -- Bumped on every save; a save names the revision it started from.
  revision integer not null default 1,
  created_by uuid not null,
  updated_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  published_at timestamptz,
  primary key (entry_id, version)
);

create table public.content_reviews (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null,
  version integer not null,
  step text not null check (char_length(step) between 1 and 60),
  state text not null default 'pending' check (state in ('pending', 'approved', 'changes_requested')),
  reviewer_id uuid,
  note text check (char_length(note) <= 2000),
  decided_at timestamptz,
  unique (entry_id, version, step),
  foreign key (entry_id, version) references public.content_versions (entry_id, version) on delete cascade
);

create table public.content_comments (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.content_entries (id) on delete cascade,
  version integer not null,
  block_id text check (char_length(block_id) <= 80),
  author_id uuid not null,
  body text not null check (char_length(body) between 1 and 4000),
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);
create index content_comments_entry on public.content_comments (entry_id, created_at);

create table public.content_media (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.studio_teams (id) on delete cascade,
  app_key text not null check (app_key ~ '^[a-z0-9-]{1,40}$'),
  path text not null unique check (char_length(path) <= 300),
  content_type text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  bytes bigint not null check (bytes > 0),
  width integer,
  height integer,
  alt text not null default '' check (char_length(alt) <= 500),
  uploaded boolean not null default false,
  created_by uuid not null,
  created_at timestamptz not null default now()
);
create index content_media_app on public.content_media (team_id, app_key, created_at desc);

create table public.content_releases (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.studio_teams (id) on delete cascade,
  app_key text not null,
  entry_id uuid not null references public.content_entries (id) on delete cascade,
  version integer not null,
  action text not null check (action in ('publish', 'rollback', 'unpublish')),
  bundle_path text,
  hash text,
  bytes integer,
  catalog_version integer,
  override boolean not null default false,
  state text not null default 'done' check (state in ('done', 'scheduled', 'canceled')),
  scheduled_for timestamptz,
  published_by uuid not null,
  created_at timestamptz not null default now()
);
create index content_releases_team on public.content_releases (team_id, created_at desc);
create index content_releases_due on public.content_releases (scheduled_for) where state = 'scheduled';

-- The current catalog per app ('shared' too): what GET /v1/content/<app>/catalog serves.
create table public.content_catalogs (
  team_id uuid not null references public.studio_teams (id) on delete cascade,
  app_key text not null,
  version integer not null default 0,
  min_app_version text not null default '1.0',
  entries jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (team_id, app_key)
);

create table public.content_audit_log (
  id bigint generated always as identity primary key,
  team_id uuid not null references public.studio_teams (id) on delete cascade,
  actor_id uuid not null,
  action text not null,
  target text,
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index content_audit_log_team on public.content_audit_log (team_id, at desc);

-- The starting content types.
insert into public.content_types (team_id, slug, app_key, name, description, definition)
select t.id, v.slug, v.app_key, v.name, v.description, v.definition::jsonb
from public.studio_teams t, (values
  ('learning-module', 'hearken', 'Learning module', 'A subject unit made of ordered lessons, each a stack of blocks.',
   '{"fields":[{"key":"subject","label":"Subject","type":"text","required":true},{"key":"summary","label":"Summary","type":"text","required":false}],"sections":{"label":"Lesson","fields":[{"key":"objective","label":"Objective","type":"text","required":false}]},"blocks":["text","scripture","callout","quiz","match","timeline","image","video"],"reviewSteps":["Doctrine review","Copy edit"]}'),
  ('help-article', null, 'Help article', 'A support article shown in an app''s help.',
   '{"fields":[{"key":"summary","label":"Summary","type":"text","required":true}],"sections":null,"blocks":["text","callout","image","video"],"reviewSteps":["Copy edit"]}'),
  ('whats-new', null, 'What''s New', 'Release notes shown after an update.',
   '{"fields":[{"key":"appVersion","label":"App version","type":"text","required":true}],"sections":null,"blocks":["text","callout","image"],"reviewSteps":["Copy edit"]}'),
  ('onboarding', null, 'Onboarding', 'Cards shown the first time someone opens an app.',
   '{"fields":[],"sections":{"label":"Card","fields":[]},"blocks":["text","image","callout"],"reviewSteps":["Copy edit"]}')
) as v(slug, app_key, name, description, definition)
where t.slug = 'hearth';

do $$
declare
  t text;
begin
  foreach t in array array['studio_invite_attempts', 'content_types', 'content_entries', 'content_versions', 'content_reviews',
    'content_comments', 'content_media', 'content_releases', 'content_catalogs', 'content_audit_log'] loop
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

-- Bundles and media: public, served by Supabase's CDN. Only hearth-api writes here.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('hearth-content', 'hearth-content', true, 52428800)
    on conflict (id) do nothing;
  end if;
end
$$;
