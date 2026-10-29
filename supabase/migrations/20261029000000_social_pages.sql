-- Hearth Ship's social pages: the Hearth apps' own social accounts, the posts made for them
-- (drafts, scheduled, published), what came back (comments, numbers). Only the developer
-- accounts in SOCIAL_OWNER_IDS use these, through /v1/social/*.
--
-- Facebook Pages and Instagram are reached through Meta's Graph API with tokens sealed by the
-- API (SOCIAL_TOKEN_KEY, never stored here). Every other platform is "hand-off": Hearth Ship
-- prepares the post and you post it yourself, then mark it posted; their numbers come in as
-- imported CSV rows.
--
-- Like the sf_* and hk_* tables: only the API reads and writes these, over DATABASE_URL.
-- Row-level security is on with no policies, and the app-facing roles have no grants.

begin;

create table public.social_connections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  platform text not null check (platform in ('facebook', 'instagram')),
  -- The Page id or Instagram account id.
  external_id text not null check (char_length(external_id) between 1 and 64),
  name text not null check (char_length(name) between 1 and 200),
  handle text check (char_length(handle) <= 100),
  avatar_url text check (char_length(avatar_url) <= 2000),
  -- The Hearth app this account belongs to (ship.sh's key, e.g. "sated"); null until chosen.
  app text check (app ~ '^[a-z0-9-]{1,40}$'),
  token_sealed text not null,
  status text not null default 'active' check (status in ('active', 'needs_reconnect')),
  last_error text check (char_length(last_error) <= 500),
  posts_synced_at timestamptz,
  metrics_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, platform, external_id)
);
create index social_connections_owner on public.social_connections (owner_id, app);

create table public.social_posts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  app text not null check (app ~ '^[a-z0-9-]{1,40}$'),
  text text not null default '' check (char_length(text) <= 5000),
  link text check (char_length(link) <= 2000),
  first_comment text check (char_length(first_comment) <= 2200),
  -- [{ "path": "<owner>/<uuid>.jpg", "kind": "image" | "video", "width": 1080, "height": 1350 }]
  media jsonb not null default '[]'::jsonb check (jsonb_typeof(media) = 'array'),
  draft boolean not null default true,
  scheduled_for timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index social_posts_owner on public.social_posts (owner_id, app, updated_at desc);

-- One row per account a post goes to, and one per post found on a connected account (or in an
-- import) that wasn't made in Hearth Ship (post_id null).
create table public.social_targets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  post_id uuid references public.social_posts (id) on delete cascade,
  app text not null check (app ~ '^[a-z0-9-]{1,40}$'),
  platform text not null check (platform in ('instagram', 'facebook', 'tiktok', 'youtube', 'x', 'linkedin', 'pinterest', 'snapchat')),
  connection_id uuid references public.social_connections (id) on delete set null,
  delivery text not null check (delivery in ('api', 'handoff')),
  format text not null default 'feed' check (format in ('feed', 'reel', 'story')),
  -- This platform's own text; null uses the post's.
  text text check (char_length(text) <= 5000),
  status text not null check (status in ('draft', 'scheduled', 'publishing', 'processing', 'published', 'failed')),
  scheduled_for timestamptz,
  attempts integer not null default 0,
  -- Instagram's media container while a video is processing.
  container_id text,
  remote_id text check (char_length(remote_id) <= 200),
  permalink text check (char_length(permalink) <= 2000),
  published_at timestamptz,
  error text check (char_length(error) <= 500),
  -- What the post looks like on the platform (synced or imported posts).
  preview_text text check (char_length(preview_text) <= 5000),
  preview_media_url text check (char_length(preview_media_url) <= 4000),
  like_count integer,
  comment_count integer,
  share_count integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index social_targets_post on public.social_targets (post_id);
create index social_targets_owner on public.social_targets (owner_id, app, published_at desc);
create index social_targets_due on public.social_targets (scheduled_for) where status in ('scheduled', 'processing');
create unique index social_targets_remote on public.social_targets (owner_id, app, platform, remote_id) where remote_id is not null;

create table public.social_comments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  connection_id uuid not null references public.social_connections (id) on delete cascade,
  app text not null,
  platform text not null,
  remote_id text not null,
  remote_post_id text not null,
  parent_remote_id text,
  author text not null default '',
  text text not null default '',
  like_count integer not null default 0,
  -- Written by the account itself (a reply from Hearth Ship or the platform's app).
  from_account boolean not null default false,
  status text not null default 'open' check (status in ('open', 'done', 'hidden')),
  commented_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (connection_id, remote_id)
);
create index social_comments_owner on public.social_comments (owner_id, app, status, commented_at desc);

-- Numbers by day. Account-wide numbers have post_key ''; a post's are its lifetime totals as of
-- that day (the latest day is the current total). post_key is the target's remote_id.
create table public.social_metrics (
  owner_id uuid not null,
  app text not null,
  platform text not null,
  post_key text not null default '',
  day date not null,
  metric text not null check (metric in ('followers', 'reach', 'impressions', 'views', 'likes', 'comments', 'shares', 'saves', 'clicks', 'engagements')),
  value double precision not null,
  source text not null check (source in ('api', 'import')),
  updated_at timestamptz not null default now(),
  primary key (owner_id, app, platform, post_key, day, metric)
);

do $$
declare
  t text;
begin
  foreach t in array array['social_connections', 'social_posts', 'social_targets', 'social_comments', 'social_metrics'] loop
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
