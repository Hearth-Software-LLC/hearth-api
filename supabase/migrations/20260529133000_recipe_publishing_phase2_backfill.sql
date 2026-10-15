-- Phase 2: backfill and safety rails for recipe publishing
-- 1) Backfill v1 snapshots for published recipes missing versions
-- 2) Set recipes.current_version_id for published recipes
-- 3) Backfill saved_recipes.version_id from current pointers
-- 4) Enforce published recipes must have a current version pointer

WITH published_without_versions AS (
  SELECT r.id,
         r.title,
         r.description,
         r.image_url,
         r.prep_minutes,
         r.cook_minutes,
         r.base_servings,
         r.difficulty,
         r.tags,
         r.instructions,
         r.source_name,
         r.source_id,
         r.source_url,
         r.attribution_required,
         r.attribution_text,
         r.created_by_profile_id,
         r.created_at,
         r.published_at
  FROM public.recipes r
  WHERE r.status = 'published'::public.recipe_status
    AND NOT EXISTS (
      SELECT 1
      FROM public.recipe_versions rv
      WHERE rv.recipe_id = r.id
    )
)
INSERT INTO public.recipe_versions (
  recipe_id,
  version_number,
  content,
  published_at
)
SELECT
  r.id,
  1,
  jsonb_build_object(
    'title', r.title,
    'description', r.description,
    'imageUrl', r.image_url,
    'prepMinutes', r.prep_minutes,
    'cookMinutes', r.cook_minutes,
    'baseServings', r.base_servings,
    'difficulty', r.difficulty,
    'tags', COALESCE(to_jsonb(r.tags), '[]'::jsonb),
    'instructions', COALESCE(r.instructions, '[]'::jsonb),
    'sourceName', r.source_name,
    'sourceId', r.source_id,
    'sourceUrl', r.source_url,
    'attributionRequired', COALESCE(r.attribution_required, false),
    'attributionText', r.attribution_text,
    'createdByProfileId', r.created_by_profile_id,
    'ingredients', COALESCE(ri.ingredients, '[]'::jsonb)
  ),
  COALESCE(r.published_at, r.created_at, now())
FROM published_without_versions r
LEFT JOIN LATERAL (
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', i.id,
      'name', i.name,
      'amount', COALESCE(i.amount, i.quantity),
      'measurementType', COALESCE(i.measurement_type, i.unit),
      'notes', i.notes
    )
    ORDER BY i.name
  ) AS ingredients
  FROM public.recipe_ingredients i
  WHERE i.recipe_id = r.id
) ri ON true;

-- Set current pointer for published rows still missing one.
WITH latest_recipe_versions AS (
  SELECT DISTINCT ON (rv.recipe_id)
    rv.recipe_id,
    rv.id
  FROM public.recipe_versions rv
  ORDER BY rv.recipe_id, rv.version_number DESC, rv.published_at DESC, rv.created_at DESC, rv.id DESC
)
UPDATE public.recipes r
SET current_version_id = latest.id
FROM latest_recipe_versions latest
WHERE r.id = latest.recipe_id
  AND r.status = 'published'::public.recipe_status
  AND r.current_version_id IS NULL;

-- Backfill pinned saved versions from current recipe pointer.
UPDATE public.saved_recipes sr
SET version_id = r.current_version_id
FROM public.recipes r
WHERE sr.recipe_id = r.id
  AND sr.version_id IS NULL
  AND r.current_version_id IS NOT NULL;

-- Safety rail: fail migration if any published recipe still lacks pointer.
DO $$
DECLARE
  missing_count bigint;
BEGIN
  SELECT COUNT(*)
  INTO missing_count
  FROM public.recipes
  WHERE status = 'published'::public.recipe_status
    AND current_version_id IS NULL;

  IF missing_count > 0 THEN
    RAISE EXCEPTION 'Phase 2 invariant failed: % published recipes have null current_version_id', missing_count;
  END IF;
END
$$;

-- Safety rail: enforce invariant going forward.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'recipes_published_requires_current_version'
  ) THEN
    ALTER TABLE public.recipes
      ADD CONSTRAINT recipes_published_requires_current_version
      CHECK (status <> 'published'::public.recipe_status OR current_version_id IS NOT NULL);
  END IF;
END
$$;
