alter table if exists public.meal_slots
  add column if not exists dine_out jsonb;

-- Backfill dedicated dine_out payloads from legacy prefixed custom_meal values.
update public.meal_slots
set dine_out = jsonb_build_object(
  'label', btrim(substring(custom_meal from char_length('Dine Out: ') + 1)),
  'name', null,
  'address', null,
  'phone', null,
  'latitude', null,
  'longitude', null,
  'logoUrl', null
)
where dine_out is null
  and custom_meal is not null
  and lower(btrim(custom_meal)) like lower('Dine Out: %')
  and btrim(substring(custom_meal from char_length('Dine Out: ') + 1)) <> '';

-- Dine Out is now modeled separately from recipe items.
update public.meal_slots
set recipe_items = '[]'::jsonb
where dine_out is not null;