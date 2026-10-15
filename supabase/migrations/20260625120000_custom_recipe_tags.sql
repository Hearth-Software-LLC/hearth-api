-- Custom, user-defined recipe tags that persist for reuse across recipes.
-- The catalog is scoped per profile. `recipes.tags` continues to store the
-- normalized tag strings; this table is the reusable catalog that powers the
-- selectable chips in the Create Recipe drawer and the Manage Tags drawer.

create table if not exists public.custom_recipe_tags (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  label text not null,
  normalized text not null,
  created_at timestamptz not null default now(),
  unique (profile_id, normalized)
);

create index if not exists idx_custom_recipe_tags_profile
  on public.custom_recipe_tags(profile_id);

alter table public.custom_recipe_tags enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'custom_recipe_tags'
      and policyname = 'Users can manage own custom recipe tags'
  ) then
    create policy "Users can manage own custom recipe tags"
      on public.custom_recipe_tags
      for all
      using (profile_id = auth.uid())
      with check (profile_id = auth.uid());
  end if;
end
$$;

-- Rename a custom tag and cascade the change into the owner's recipes so the
-- normalized strings stored on `recipes.tags` stay consistent with the catalog.
-- Runs as a single transaction. Returns the tag id on success, or null when the
-- tag does not exist / is not owned by the caller. A collision with another of
-- the caller's tags raises unique_violation, which the API surfaces as a 409.
create or replace function public.rename_custom_recipe_tag(
  p_profile_id uuid,
  p_tag_id uuid,
  p_new_label text,
  p_new_normalized text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_normalized text;
begin
  select normalized
    into v_old_normalized
  from public.custom_recipe_tags
  where id = p_tag_id
    and profile_id = p_profile_id
  for update;

  if v_old_normalized is null then
    return null;
  end if;

  update public.custom_recipe_tags
  set label = p_new_label,
      normalized = p_new_normalized
  where id = p_tag_id
    and profile_id = p_profile_id;

  if v_old_normalized <> p_new_normalized then
    update public.recipes
    set tags = array_replace(tags, v_old_normalized, p_new_normalized)
    where created_by_profile_id = p_profile_id
      and v_old_normalized = any(tags);
  end if;

  return p_tag_id;
end;
$$;
