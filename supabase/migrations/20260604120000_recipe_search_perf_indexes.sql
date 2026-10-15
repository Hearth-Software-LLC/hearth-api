-- Enable trigram extension for fast ILIKE '%query%' searches on title.
-- Without this, every title search is a full table scan.
create extension if not exists pg_trgm;

-- Trigram index on title for substring search (ILIKE '%query%').
-- Turns full-table-scans into index seeks when the user types in the search bar.
create index if not exists idx_recipes_title_trgm
  on public.recipes using gin (title gin_trgm_ops);

-- Allow efficient lookup of a user's saved recipes by profile_id.
-- The existing idx_saved_recipes_version_id only indexes version_id,
-- so "give me all saves for user X" currently scans the whole table.
create index if not exists idx_saved_recipes_profile_id
  on public.saved_recipes (profile_id);

-- Same gap on recipe_likes — profile_id has no index.
-- The existing idx_recipe_likes_recipe_id covers recipe-centric lookups,
-- but per-user like checks (used on every recipe list fetch) can't use it.
create index if not exists idx_recipe_likes_profile_id
  on public.recipe_likes (profile_id);
