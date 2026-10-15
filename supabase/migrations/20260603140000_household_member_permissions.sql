-- Household member permissions
-- Stores per-member permission flags set by the organizer.
-- Keyed on member_id which is the PK of household_memberships, so
-- the row is automatically removed when the membership ends.

create table if not exists public.household_member_permissions (
  member_id            uuid primary key
                         references public.household_memberships(member_id)
                         on delete cascade,
  can_manage_meal_plan boolean not null default false,
  can_use_ai_meal_plan boolean not null default false,
  can_use_ai_grocery   boolean not null default false,
  can_edit_members     boolean not null default false,
  updated_at           timestamptz not null default now()
);

alter table public.household_member_permissions enable row level security;

-- Organizer of the household can read and write the member's permissions.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'household_member_permissions'
      and policyname = 'Organizer can manage member permissions'
  ) then
    create policy "Organizer can manage member permissions"
      on public.household_member_permissions
      for all
      using (
        exists (
          select 1 from public.household_memberships hm
          where hm.member_id = household_member_permissions.member_id
            and hm.organizer_id = auth.uid()
        )
      );
  end if;
end
$$;

-- Member can read their own permissions row.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'household_member_permissions'
      and policyname = 'Member can read own permissions'
  ) then
    create policy "Member can read own permissions"
      on public.household_member_permissions
      for select
      using (member_id = auth.uid());
  end if;
end
$$;

-- Backfill: create a default all-false row for every existing membership.
insert into public.household_member_permissions (member_id)
select member_id
from public.household_memberships
on conflict (member_id) do nothing;

-- Add notification type for permission changes.
do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    join pg_enum e on e.enumtypid = t.oid
    where n.nspname = 'public'
      and t.typname = 'notification_type'
      and e.enumlabel = 'household_member_permissions_changed'
  ) then
    alter type public.notification_type add value 'household_member_permissions_changed';
  end if;
end
$$;
