-- PR4 follow-up: make source conflict target compatible with upsert

drop index if exists public.idx_recipes_source_unique;

create unique index if not exists idx_recipes_source_unique
  on public.recipes(source_name, source_id);
