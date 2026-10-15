alter table public.meal_slots
  add column if not exists snack_items jsonb not null default '[]'::jsonb;
