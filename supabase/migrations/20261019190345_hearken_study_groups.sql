-- Hearken study groups, moved off CloudKit sharing onto the Hearth API.
--
-- Only the API reads and writes these tables, over a direct Postgres connection
-- (DATABASE_URL). Row-level security is on with no policies and the app-facing roles have no
-- grants, so the Supabase REST and Realtime APIs can't reach them with a client key.
--
-- Members are Hearth account ids (the verified JWT subject). There are no foreign keys to
-- auth.users: deleting a Hearth account goes through DELETE /v1/hearken/me, which hands off or
-- deletes owned groups and removes what the person wrote.

begin;

create table public.hk_groups (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  -- The creating device's id for this group (idempotent create), or the CloudKit zone name for
  -- a group imported from iCloud.
  client_id text check (char_length(client_id) <= 128),
  name text not null check (char_length(name) between 1 and 60),
  symbol text not null check (char_length(symbol) between 1 and 64),
  plan_id text not null check (char_length(plan_id) between 1 and 64),
  custom_plan jsonb,
  start_date date not null,
  invite_code text not null unique check (invite_code ~ '^[A-Z2-9]{8}$'),
  -- Set on groups imported from CloudKit: members still on iCloud claim their seat with it.
  migration_token text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (owner_id, client_id)
);
create index hk_groups_deleted_at on public.hk_groups (deleted_at) where deleted_at is not null;

create table public.hk_members (
  group_id uuid not null references public.hk_groups (id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('owner', 'leader', 'member')),
  display_name text not null check (char_length(display_name) between 1 and 60),
  initials text not null check (char_length(initials) between 1 and 3),
  -- { replies, mentions, allReplies, question, activity }: booleans; missing keys use defaults.
  notify jsonb not null default '{}'::jsonb,
  -- The CloudKit user record name this member had before the move, if any.
  legacy_id text,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index hk_members_user on public.hk_members (user_id);

-- Members of an imported group who haven't opened the new version yet.
create table public.hk_legacy_members (
  group_id uuid not null references public.hk_groups (id) on delete cascade,
  legacy_id text not null check (char_length(legacy_id) between 1 and 255),
  display_name text not null check (char_length(display_name) between 1 and 60),
  initials text not null check (char_length(initials) between 1 and 3),
  progress jsonb,
  primary key (group_id, legacy_id)
);

create table public.hk_progress (
  group_id uuid not null,
  user_id uuid not null,
  week_start date,
  week_read integer not null default 0 check (week_read between 0 and 10000),
  week_total integer not null default 0 check (week_total between 0 and 10000),
  last_done_day date,
  chapters_read integer not null default 0 check (chapters_read between 0 and 100000),
  streak integer not null default 0 check (streak between 0 and 100000),
  updated_at timestamptz not null default now(),
  primary key (group_id, user_id),
  foreign key (group_id, user_id) references public.hk_members (group_id, user_id) on delete cascade
);

create table public.hk_items (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.hk_groups (id) on delete cascade,
  client_id text check (char_length(client_id) <= 128),
  author_id uuid,
  legacy_author_id text,
  author_name text not null check (char_length(author_name) between 1 and 60),
  kind text not null check (kind in ('highlight', 'reflection')),
  chapter_id text not null default '' check (char_length(chapter_id) <= 64),
  start_verse integer not null default 0 check (start_verse between 0 and 1000),
  end_verse integer not null default 0 check (end_verse between 0 and 1000),
  -- A highlight's verse text, or a reflection's chapter range ("Alma 34").
  text text not null default '' check (char_length(text) <= 4000),
  note text not null default '' check (char_length(note) <= 2000),
  -- "Alma 34:32", for notifications.
  reference text not null default '' check (char_length(reference) <= 80),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (author_id is not null or legacy_author_id is not null),
  unique (group_id, client_id)
);
create index hk_items_group_created on public.hk_items (group_id, created_at desc) where deleted_at is null;

create table public.hk_questions (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.hk_groups (id) on delete cascade,
  client_id text check (char_length(client_id) <= 128),
  author_id uuid not null,
  author_name text not null check (char_length(author_name) between 1 and 60),
  text text not null check (char_length(text) between 1 and 300),
  reference text not null default '' check (char_length(reference) <= 80),
  chapter_id text not null default '' check (char_length(chapter_id) <= 64),
  post_at timestamptz not null default now(),
  closes_at timestamptz not null,
  hide_answers boolean not null default true,
  notified_at timestamptz,
  waiting_notified_at timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (closes_at > post_at),
  unique (group_id, client_id)
);
create index hk_questions_group_post on public.hk_questions (group_id, post_at desc) where deleted_at is null;
create index hk_questions_unnotified on public.hk_questions (post_at) where notified_at is null and deleted_at is null;

create table public.hk_answers (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.hk_questions (id) on delete cascade,
  group_id uuid not null references public.hk_groups (id) on delete cascade,
  user_id uuid not null,
  author_name text not null check (char_length(author_name) between 1 and 60),
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (question_id, user_id)
);

create table public.hk_comments (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.hk_groups (id) on delete cascade,
  client_id text check (char_length(client_id) <= 128),
  target_type text not null check (target_type in ('item', 'answer')),
  target_id uuid not null,
  -- Replies go two levels deep: a reply to a reply hangs off the same top-level comment.
  parent_id uuid references public.hk_comments (id) on delete cascade,
  author_id uuid not null,
  author_name text not null check (char_length(author_name) between 1 and 60),
  body text not null check (char_length(body) between 1 and 1000),
  mentions uuid[] not null default '{}' check (cardinality(mentions) <= 50),
  mentions_everyone boolean not null default false,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (group_id, client_id)
);
create index hk_comments_target on public.hk_comments (target_type, target_id, created_at);

create table public.hk_reactions (
  id bigint generated always as identity primary key,
  group_id uuid not null references public.hk_groups (id) on delete cascade,
  target_type text not null check (target_type in ('item', 'comment', 'answer')),
  target_id uuid not null,
  user_id uuid,
  legacy_user_id text,
  kind text not null check (kind in ('heart', 'insight')),
  created_at timestamptz not null default now(),
  check (user_id is not null or legacy_user_id is not null)
);
create unique index hk_reactions_unique on public.hk_reactions
  (target_type, target_id, coalesce(user_id::text, 'legacy:' || legacy_user_id), kind);

create table public.hk_push_tokens (
  token text primary key check (token ~ '^[0-9a-f]{64,200}$'),
  user_id uuid not null,
  environment text not null check (environment in ('sandbox', 'production')),
  updated_at timestamptz not null default now()
);
create index hk_push_tokens_user on public.hk_push_tokens (user_id);

do $$
declare
  t text;
begin
  foreach t in array array['hk_groups', 'hk_members', 'hk_legacy_members', 'hk_progress', 'hk_items',
                           'hk_questions', 'hk_answers', 'hk_comments', 'hk_reactions', 'hk_push_tokens'] loop
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
