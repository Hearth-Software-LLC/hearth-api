alter table public.recipe_ingredients
  add column if not exists amount numeric,
  add column if not exists measurement_type text;

update public.recipe_ingredients
set
  amount = coalesce(amount, quantity),
  measurement_type = coalesce(measurement_type, unit)
where amount is null
   or measurement_type is null;