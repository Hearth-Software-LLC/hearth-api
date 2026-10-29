-- Hearth Studio, part 1: the team. Hearth Software's members and what each can do, and the
-- social tables moved from one owner to the team, so everyone on it sees the same accounts,
-- posts, comments and numbers.
--
-- A member's permissions: post (post and reply), plans (grant plans to accounts), accounts
-- (connect and disconnect social accounts). Owners can do everything and manage the team. The
-- accounts in STUDIO_OWNER_IDS (or SOCIAL_OWNER_IDS) are made owners of the team the first time
-- they use the API.
--
-- Like the other API-only tables: row-level security on, no policies, no grants to app roles.

begin;

create table public.studio_teams (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{1,40}$'),
  name text not null check (char_length(name) between 1 and 80),
  -- How many screenshot runs to keep per app, device and appearance.
  keep_runs integer not null default 2 check (keep_runs between 1 and 20),
  created_at timestamptz not null default now()
);
insert into public.studio_teams (slug, name) values ('hearth', 'Hearth Software');

create table public.studio_members (
  team_id uuid not null references public.studio_teams (id) on delete cascade,
  user_id uuid not null,
  role text not null default 'member' check (role in ('owner', 'member')),
  can_post boolean not null default true,
  can_plans boolean not null default false,
  can_accounts boolean not null default false,
  display_name text check (char_length(display_name) <= 80),
  -- Which notifications this member wants.
  notify_due boolean not null default true,
  notify_comments boolean not null default true,
  notify_failed boolean not null default true,
  added_by uuid,
  added_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index studio_members_user on public.studio_members (user_id);

create table public.studio_invites (
  code text primary key check (code ~ '^[A-Z2-9]{8}$'),
  team_id uuid not null references public.studio_teams (id) on delete cascade,
  can_post boolean not null default true,
  can_plans boolean not null default false,
  can_accounts boolean not null default false,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_by uuid,
  used_at timestamptz
);

-- Every plan granted or removed from Hearth Studio.
create table public.plan_grants_log (
  id bigint generated always as identity primary key,
  team_id uuid not null references public.studio_teams (id) on delete cascade,
  actor_id uuid not null,
  account_id text not null,
  entitlement text not null,
  action text not null check (action in ('grant', 'revoke')),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index plan_grants_log_account on public.plan_grants_log (account_id, created_at desc);

-- Where to push Hearth Studio notifications (iPhone, iPad, Mac).
create table public.studio_devices (
  token text primary key check (char_length(token) between 32 and 200),
  team_id uuid not null references public.studio_teams (id) on delete cascade,
  user_id uuid not null,
  topic text not null check (topic ~ '^[A-Za-z0-9.-]+$'),
  environment text not null check (environment in ('sandbox', 'production')),
  updated_at timestamptz not null default now()
);
create index studio_devices_user on public.studio_devices (team_id, user_id);

-- The social tables now belong to the team. Connections remember who connected them: their
-- tokens are sealed to that person.
do $$
declare
  team uuid := (select id from public.studio_teams where slug = 'hearth');
begin
  alter table public.social_connections rename column owner_id to connected_by;
  alter table public.social_connections add column team_id uuid references public.studio_teams (id) on delete cascade;
  update public.social_connections set team_id = team;
  alter table public.social_connections alter column team_id set not null;
  alter table public.social_connections drop constraint if exists social_connections_owner_id_platform_external_id_key;
  alter table public.social_connections add constraint social_connections_team_platform_external unique (team_id, platform, external_id);
  drop index if exists public.social_connections_owner;
  create index social_connections_team on public.social_connections (team_id, app);

  alter table public.social_posts rename column owner_id to team_id;
  update public.social_posts set team_id = team;
  alter table public.social_posts add column created_by uuid;
  alter table public.social_targets rename column owner_id to team_id;
  update public.social_targets set team_id = team;
  -- When a reminder or failure was pushed for this target.
  alter table public.social_targets add column notified_at timestamptz;
  alter table public.social_comments rename column owner_id to team_id;
  update public.social_comments set team_id = team;
  alter table public.social_comments add column notified_at timestamptz;
  alter table public.social_metrics rename column owner_id to team_id;
  update public.social_metrics set team_id = team;
end
$$;

do $$
declare
  t text;
begin
  foreach t in array array['studio_teams', 'studio_members', 'studio_invites', 'plan_grants_log', 'studio_devices'] loop
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
