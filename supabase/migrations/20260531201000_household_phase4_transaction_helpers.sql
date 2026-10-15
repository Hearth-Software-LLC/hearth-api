-- Phase 4: transactional helper functions for invitation acceptance and member removal

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
  v_next_sort_order integer;
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

  delete from public.household_members
  where profile_id = p_invitee_id
    and linked_profile_id is null;

  insert into public.household_memberships (member_id, organizer_id)
  values (p_invitee_id, v_organizer_id)
  on conflict (member_id) do nothing;

  select
    coalesce(nullif(trim(household_name), ''), 'Household Member'),
    avatar_url
    into v_member_name, v_member_avatar_url
  from public.profiles
  where id = p_invitee_id;

  select coalesce(max(sort_order), -1) + 1
    into v_next_sort_order
  from public.household_members
  where profile_id = v_organizer_id;

  insert into public.household_members (
    profile_id,
    linked_profile_id,
    name,
    avatar_url,
    likes,
    dislikes,
    sort_order
  )
  values (
    v_organizer_id,
    p_invitee_id,
    v_member_name,
    v_member_avatar_url,
    '{}'::text[],
    '{}'::text[],
    v_next_sort_order
  )
  on conflict (profile_id, linked_profile_id)
  where linked_profile_id is not null
  do update set
    name = excluded.name,
    avatar_url = excluded.avatar_url;

  return v_organizer_id;
end;
$$;

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

  delete from public.household_memberships
  where member_id = p_member_id;

  delete from public.household_members
  where profile_id = v_organizer_id
    and linked_profile_id = p_member_id;

  return v_organizer_id;
end;
$$;
