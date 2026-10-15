-- Fix 1: accept_household_invitation should use the invitee's personal name
--         (household_members.name where sort_order is lowest) rather than
--         profiles.household_name (which is the household/family name).
--         We capture name + avatar + date_of_birth BEFORE deleting the rows.
--
-- Fix 2: remove_household_member should restore the leaving member's own
--         household_members row (with their name, avatar, and date_of_birth)
--         so their personal identity is preserved after leaving.

create or replace function public.accept_household_invitation(
  p_invitation_id uuid,
  p_invitee_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organizer_id uuid;
  v_member_name text;
  v_member_avatar_url text;
  v_member_dob date;
  v_next_sort_order integer;
  v_existing_manual_member_id uuid;
begin
  select organizer_id
    into v_organizer_id
  from public.household_invitations
  where id = p_invitation_id
    and invitee_id = p_invitee_id
    and status = 'pending'
  for update;

  if v_organizer_id is null then
    return null;
  end if;

  -- Read the invitee's personal name and DOB from their own household_members row
  -- (the first/primary row, sort_order ascending) BEFORE we delete those rows.
  -- Fall back to profiles.household_name only when no member row exists.
  select
    hm.name,
    coalesce(hm.avatar_url, p.avatar_url),
    hm.date_of_birth
    into v_member_name, v_member_avatar_url, v_member_dob
  from public.household_members hm
  join public.profiles p on p.id = hm.profile_id
  where hm.profile_id = p_invitee_id
    and hm.linked_profile_id is null
  order by hm.sort_order asc, hm.created_at asc, hm.id asc
  limit 1;

  -- If no member row found, fall back to the profile record.
  if v_member_name is null then
    select
      coalesce(nullif(trim(household_name), ''), 'Household Member'),
      avatar_url
      into v_member_name, v_member_avatar_url
    from public.profiles
    where id = p_invitee_id;
  end if;

  update public.household_invitations
  set status = 'accepted',
      resolved_at = now()
  where id = p_invitation_id;

  update public.household_invitations
  set status = 'cancelled',
      resolved_at = now()
  where invitee_id = p_invitee_id
    and status = 'pending'
    and id <> p_invitation_id;

  -- Delete the invitee's own household_members rows now that we've captured
  -- the data we need.
  delete from public.household_members
  where profile_id = p_invitee_id
    and linked_profile_id is null;

  insert into public.household_memberships (member_id, organizer_id)
  values (p_invitee_id, v_organizer_id)
  on conflict (member_id) do nothing;

  -- Strategy B: if organizer already has a manual entry with the same name,
  -- convert that row to the linked account row so excluded_members strings stay aligned.
  select id
    into v_existing_manual_member_id
  from public.household_members
  where profile_id = v_organizer_id
    and linked_profile_id is null
    and lower(trim(name)) = lower(trim(v_member_name))
  order by sort_order asc, created_at asc, id asc
  limit 1
  for update;

  if v_existing_manual_member_id is not null then
    update public.household_members
    set linked_profile_id = p_invitee_id,
        avatar_url = coalesce(v_member_avatar_url, avatar_url),
        date_of_birth = coalesce(v_member_dob, date_of_birth),
        likes = '{}'::text[],
        dislikes = '{}'::text[]
    where id = v_existing_manual_member_id;

    return v_organizer_id;
  end if;

  select coalesce(max(sort_order), -1) + 1
    into v_next_sort_order
  from public.household_members
  where profile_id = v_organizer_id;

  insert into public.household_members (
    profile_id,
    linked_profile_id,
    name,
    avatar_url,
    date_of_birth,
    likes,
    dislikes,
    sort_order
  )
  values (
    v_organizer_id,
    p_invitee_id,
    v_member_name,
    v_member_avatar_url,
    v_member_dob,
    '{}'::text[],
    '{}'::text[],
    v_next_sort_order
  )
  on conflict (profile_id, linked_profile_id)
  where linked_profile_id is not null
  do update set
    name = excluded.name,
    avatar_url = excluded.avatar_url,
    date_of_birth = excluded.date_of_birth;

  return v_organizer_id;
end;
$$;

-- Fix 2: restore the leaving member's own household_members row so their
--         name, avatar, and date_of_birth are available after they leave.
create or replace function public.remove_household_member(
  p_member_id uuid,
  p_requester_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organizer_id uuid;
  v_linked_name text;
  v_linked_avatar_url text;
  v_linked_dob date;
begin
  select organizer_id
    into v_organizer_id
  from public.household_memberships
  where member_id = p_member_id
  for update;

  if v_organizer_id is null then
    return null;
  end if;

  if p_requester_id <> p_member_id and p_requester_id <> v_organizer_id then
    return null;
  end if;

  -- Capture the member's personal data from the linked row in the organizer's
  -- household before we delete it, so we can restore their own row below.
  select name, avatar_url, date_of_birth
    into v_linked_name, v_linked_avatar_url, v_linked_dob
  from public.household_members
  where profile_id = v_organizer_id
    and linked_profile_id = p_member_id;

  delete from public.household_memberships
  where member_id = p_member_id;

  delete from public.household_members
  where profile_id = v_organizer_id
    and linked_profile_id = p_member_id;

  -- Restore the member's own primary household_members row so their name,
  -- avatar, and date_of_birth are preserved after leaving the household.
  -- Only insert if they don't already have their own row (idempotent).
  if v_linked_name is not null then
    insert into public.household_members (
      profile_id,
      name,
      avatar_url,
      date_of_birth,
      likes,
      dislikes,
      sort_order
    )
    values (
      p_member_id,
      v_linked_name,
      v_linked_avatar_url,
      v_linked_dob,
      '{}'::text[],
      '{}'::text[],
      0
    )
    on conflict do nothing;
  end if;

  return v_organizer_id;
end;
$$;
