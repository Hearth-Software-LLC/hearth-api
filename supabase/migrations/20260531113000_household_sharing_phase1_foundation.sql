-- Phase 1: household sharing database foundation

create table if not exists public.household_memberships (
  member_id uuid primary key references public.profiles(id) on delete cascade,
  organizer_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  constraint no_self_membership check (member_id <> organizer_id)
);

create index if not exists idx_household_memberships_organizer_id
  on public.household_memberships(organizer_id);

alter table public.household_memberships enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'household_memberships'
      and policyname = 'Members and organizers can view memberships'
  ) then
    create policy "Members and organizers can view memberships"
      on public.household_memberships
      for select
      using (
        member_id = auth.uid()
        or organizer_id = auth.uid()
      );
  end if;
end
$$;

alter table public.household_members
  add column if not exists linked_profile_id uuid
  references public.profiles(id) on delete cascade;

create unique index if not exists household_members_linked_profile_per_household
  on public.household_members (profile_id, linked_profile_id)
  where linked_profile_id is not null;

create table if not exists public.household_invitations (
  id uuid primary key default gen_random_uuid(),
  organizer_id uuid not null references public.profiles(id) on delete cascade,
  invitee_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint no_self_invite check (organizer_id <> invitee_id)
);

create unique index if not exists household_invitations_pending_unique
  on public.household_invitations (organizer_id, invitee_id)
  where status = 'pending';

alter table public.household_invitations enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'household_invitations'
      and policyname = 'Organizers and invitees can view invitations'
  ) then
    create policy "Organizers and invitees can view invitations"
      on public.household_invitations
      for select
      using (
        organizer_id = auth.uid()
        or invitee_id = auth.uid()
      );
  end if;
end
$$;

create table if not exists public.blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint no_self_block check (blocker_id <> blocked_id)
);

create index if not exists idx_blocks_blocked_id
  on public.blocks(blocked_id);

alter table public.blocks enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'blocks'
      and policyname = 'Users can view blocks involving them'
  ) then
    create policy "Users can view blocks involving them"
      on public.blocks
      for select
      using (
        blocker_id = auth.uid()
        or blocked_id = auth.uid()
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'blocks'
      and policyname = 'Users can insert their own blocks'
  ) then
    create policy "Users can insert their own blocks"
      on public.blocks
      for insert
      with check (blocker_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'blocks'
      and policyname = 'Users can delete their own blocks'
  ) then
    create policy "Users can delete their own blocks"
      on public.blocks
      for delete
      using (blocker_id = auth.uid());
  end if;
end
$$;

create or replace function public.effective_profile_id(uid uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select organizer_id from public.household_memberships where member_id = uid),
    uid
  );
$$;

do $$
declare
  required_values text[] := array[
    'household_invitation',
    'household_invitation_accepted',
    'household_invitation_declined',
    'household_member_removed',
    'household_member_left'
  ];
  enum_value text;
begin
  foreach enum_value in array required_values loop
    if not exists (
      select 1
      from pg_type t
      join pg_namespace n on n.oid = t.typnamespace
      join pg_enum e on e.enumtypid = t.oid
      where n.nspname = 'public'
        and t.typname = 'notification_type'
        and e.enumlabel = enum_value
    ) then
      execute format('alter type public.notification_type add value %L', enum_value);
    end if;
  end loop;
end
$$;
