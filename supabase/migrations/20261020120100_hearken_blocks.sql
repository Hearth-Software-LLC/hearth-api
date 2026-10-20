-- Hearken: people a member has blocked. Their posts, replies and answers are left out of the
-- blocker's group reads (GET /v1/hearken/groups..., /items, /comments, /questions).
--
-- Like the other hk_* tables: only the API reaches it, over DATABASE_URL; row-level security on
-- with no policies and no grants for the app-facing roles. No foreign keys to auth.users: account
-- deletion (DELETE /v1/me, DELETE /v1/hearken/me) removes rows on either side explicitly.

begin;

create table if not exists public.hk_blocks (
  blocker_id uuid not null,
  blocked_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists hk_blocks_blocked on public.hk_blocks (blocked_id);

alter table public.hk_blocks enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.hk_blocks from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.hk_blocks from authenticated;
  end if;
end
$$;

commit;
