-- Add sort_order to household_members to reliably identify the primary display member (position 0).
-- Bulk inserts give all rows the same created_at, making ordering by created_at non-deterministic.

alter table public.household_members
  add column if not exists sort_order integer not null default 0;

-- Backfill existing rows: assign a stable sort_order based on created_at within each profile.
-- Row with the earliest created_at per profile gets sort_order 0 (primary display member).
update public.household_members hm
set sort_order = ranked.rn
from (
  select
    id,
    row_number() over (partition by profile_id order by created_at asc, id asc) - 1 as rn
  from public.household_members
) ranked
where hm.id = ranked.id;

create index if not exists idx_household_members_profile_id_sort_order
  on public.household_members(profile_id, sort_order);
