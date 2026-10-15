-- Improve recipe browsing performance as library size grows.
-- 1) Fast sort/filter for public recipes feed
-- 2) Fast tag containment filter for quick chips (tags @> ARRAY['Breakfast'])

create index if not exists idx_recipes_public_created_at
  on public.recipes (is_public, created_at desc);

create index if not exists idx_recipes_tags_gin
  on public.recipes using gin (tags);
