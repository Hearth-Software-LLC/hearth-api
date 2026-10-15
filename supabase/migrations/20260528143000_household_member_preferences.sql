-- Add per-member likes/dislikes preferences for profile editing

alter table public.household_members
  add column if not exists likes text[] not null default '{}',
  add column if not exists dislikes text[] not null default '{}';

update public.household_members
set likes = coalesce(likes, '{}'),
    dislikes = coalesce(dislikes, '{}')
where likes is null
   or dislikes is null;
