-- Phase 9.8: preserve existing organizer-side member names when a joined account
-- collides with a manual member entry of the same name.

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
