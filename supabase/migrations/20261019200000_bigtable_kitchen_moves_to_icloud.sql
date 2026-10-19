-- BigTable's kitchen moves to the family's iCloud.
--
-- Additive. Private recipes, custom tags, meal plans, grocery lists and the household now live in
-- the family's iCloud; the server keeps published recipes, the community, AI, subscriptions,
-- places and push. This migration adds:
--   1. bigtable_join_codes: a household's join code (replaces invitations for new builds).
--   2. public.bigtable_join_household(): the invitation-free twin of accept_household_invitation.
--   3. profiles.display_name: the public name on a cook's recipes and profile.
--   4. profiles.kitchen_moved_at: when the app finished moving the kitchen to iCloud.
--   5. public.bigtable_purge_moved_kitchens(): deletes a moved kitchen's server copy 30 days later.
-- Nothing here deletes data on apply; only the purge function does, when it is run.

-- 1. Join codes -------------------------------------------------------------------------------

create table if not exists public.bigtable_join_codes (
  organizer_id uuid primary key references public.profiles(id) on delete cascade,
  code text unique not null,
  created_at timestamptz default now()
);

-- Service role only (the API). No policies: clients can't read or write codes directly.
alter table public.bigtable_join_codes enable row level security;

-- 2. Joining by code ----------------------------------------------------------------------------
-- Same membership as accept_household_invitation (20260601120000_household_fix_join_leave_identity),
-- without an invitation row: the member's own household_members rows give way to a linked seat in
-- the organizer's household (reusing a manual seat with the same name), and any pending
-- invitations to the member are cancelled. Returns the organizer id, or null when the member
-- already belongs to a household. It touches only the seat's name and avatar, so it keeps working
-- once the family-profile columns (date_of_birth, likes, dislikes) are dropped.

create or replace function public.bigtable_join_household(
  p_member_id uuid,
  p_organizer_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member_name text;
  v_member_avatar_url text;
  v_next_sort_order integer;
  v_existing_manual_member_id uuid;
  v_existing_organizer_id uuid;
begin
  if p_member_id is null or p_organizer_id is null or p_member_id = p_organizer_id then
    return null;
  end if;

  -- Serialize joins for this member.
  perform 1 from public.profiles where id = p_member_id for update;

  select organizer_id
    into v_existing_organizer_id
  from public.household_memberships
  where member_id = p_member_id;

  if v_existing_organizer_id is not null then
    if v_existing_organizer_id = p_organizer_id then
      return p_organizer_id;
    end if;
    return null;
  end if;

  select
    hm.name,
    coalesce(hm.avatar_url, p.avatar_url)
    into v_member_name, v_member_avatar_url
  from public.household_members hm
  join public.profiles p on p.id = hm.profile_id
  where hm.profile_id = p_member_id
    and hm.linked_profile_id is null
  order by hm.sort_order asc, hm.created_at asc, hm.id asc
  limit 1;

  if v_member_name is null then
    select
      coalesce(nullif(trim(display_name), ''), nullif(trim(household_name), ''), 'Household Member'),
      avatar_url
      into v_member_name, v_member_avatar_url
    from public.profiles
    where id = p_member_id;
  end if;

  update public.household_invitations
  set status = 'cancelled',
      resolved_at = now()
  where invitee_id = p_member_id
    and status = 'pending';

  delete from public.household_members
  where profile_id = p_member_id
    and linked_profile_id is null;

  insert into public.household_memberships (member_id, organizer_id)
  values (p_member_id, p_organizer_id)
  on conflict (member_id) do nothing;

  select id
    into v_existing_manual_member_id
  from public.household_members
  where profile_id = p_organizer_id
    and linked_profile_id is null
    and lower(trim(name)) = lower(trim(v_member_name))
  order by sort_order asc, created_at asc, id asc
  limit 1
  for update;

  if v_existing_manual_member_id is not null then
    update public.household_members
    set linked_profile_id = p_member_id,
        avatar_url = coalesce(v_member_avatar_url, avatar_url)
    where id = v_existing_manual_member_id;

    return p_organizer_id;
  end if;

  select coalesce(max(sort_order), -1) + 1
    into v_next_sort_order
  from public.household_members
  where profile_id = p_organizer_id;

  insert into public.household_members (
    profile_id,
    linked_profile_id,
    name,
    avatar_url,
    sort_order
  )
  values (
    p_organizer_id,
    p_member_id,
    v_member_name,
    v_member_avatar_url,
    v_next_sort_order
  )
  on conflict (profile_id, linked_profile_id)
  where linked_profile_id is not null
  do update set
    name = excluded.name,
    avatar_url = excluded.avatar_url;

  return p_organizer_id;
end;
$$;

revoke all on function public.bigtable_join_household(uuid, uuid) from public, anon, authenticated;
grant execute on function public.bigtable_join_household(uuid, uuid) to service_role;

-- 3 & 4. Profile columns ----------------------------------------------------------------------------

alter table public.profiles
  add column if not exists display_name text,
  add column if not exists kitchen_moved_at timestamptz;

-- The API caps it at 60; this keeps the column honest if something else writes it.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_display_name_length'
  ) then
    alter table public.profiles
      add constraint profiles_display_name_length
      check (display_name is null or char_length(display_name) <= 60);
  end if;
end
$$;

create index if not exists idx_profiles_kitchen_moved_at
  on public.profiles (kitchen_moved_at)
  where kitchen_moved_at is not null;

-- 5. The 30-day purge ----------------------------------------------------------------------------
-- For each profile whose kitchen moved more than 30 days ago, deletes the server copy of its
-- private kitchen: meal plans and their meal slots, grocery snapshots, custom tags, household
-- members, dietary restrictions, and its user recipes that are draft or removed and were never
-- published or saved by anyone. Published and
-- unpublished recipes stay: they are the community's, and other families' plans and saves still
-- point at them. Safe to run repeatedly. Returns the number of profiles purged.

create or replace function public.bigtable_purge_moved_kitchens()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_ids uuid[];
begin
  select coalesce(array_agg(id), '{}')
    into v_profile_ids
  from public.profiles
  where kitchen_moved_at is not null
    and kitchen_moved_at < now() - interval '30 days';

  if coalesce(array_length(v_profile_ids, 1), 0) = 0 then
    return 0;
  end if;

  delete from public.meal_slots
  where plan_id in (
    select id from public.weekly_plans where profile_id = any(v_profile_ids)
  );

  delete from public.weekly_plans
  where profile_id = any(v_profile_ids);

  delete from public.grocery_snapshots
  where user_id = any(v_profile_ids);

  delete from public.custom_recipe_tags
  where profile_id = any(v_profile_ids);

  delete from public.household_members
  where profile_id = any(v_profile_ids);

  -- The pending Hearth household cleanup drops this table; skip it once it's gone.
  if to_regclass('public.dietary_restrictions') is not null then
    execute 'delete from public.dietary_restrictions where profile_id = any($1)' using v_profile_ids;
  end if;

  delete from public.recipes
  where created_by_profile_id = any(v_profile_ids)
    and source_name = 'user'
    and status in ('draft'::public.recipe_status, 'removed'::public.recipe_status)
    -- Never one that was published: other families may have saved or planned it.
    and published_at is null
    and not exists (select 1 from public.saved_recipes s where s.recipe_id = recipes.id);

  return array_length(v_profile_ids, 1);
end;
$$;

revoke all on function public.bigtable_purge_moved_kitchens() from public, anon, authenticated;
grant execute on function public.bigtable_purge_moved_kitchens() to service_role;

-- Daily at 04:17 UTC, once pg_cron is enabled and this has been reviewed:
-- select cron.schedule('bigtable-purge-moved-kitchens', '17 4 * * *', $$select public.bigtable_purge_moved_kitchens()$$);
