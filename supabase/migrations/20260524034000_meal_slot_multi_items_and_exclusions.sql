alter table if exists public.meal_slots
  add column if not exists recipe_items jsonb not null default '[]'::jsonb,
  add column if not exists excluded_members text[] not null default '{}';

-- Backfill recipe_items from legacy custom_meal values when empty.
update public.meal_slots
set recipe_items = jsonb_build_array(
  jsonb_build_object('title', trim(custom_meal), 'role', 'entree')
)
where (recipe_items is null or recipe_items = '[]'::jsonb)
  and custom_meal is not null
  and trim(custom_meal) <> '';
