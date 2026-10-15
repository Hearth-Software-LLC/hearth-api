-- Phase 1: recipe publishing data model foundation
-- Adds lifecycle status + versioning tables, saved recipe pinning,
-- likes, denormalized counters, and is_public compatibility behavior.

-- 1) Lifecycle enum
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'recipe_status'
      AND n.nspname = 'public'
  ) THEN
    CREATE TYPE public.recipe_status AS ENUM ('draft', 'published', 'unpublished', 'removed');
  END IF;
END
$$;

-- 2) Recipes lifecycle + denormalized counter columns
ALTER TABLE IF EXISTS public.recipes
  ADD COLUMN IF NOT EXISTS status public.recipe_status,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS current_version_id uuid,
  ADD COLUMN IF NOT EXISTS like_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS save_count integer NOT NULL DEFAULT 0;

UPDATE public.recipes
SET status = CASE WHEN is_public THEN 'published'::public.recipe_status ELSE 'draft'::public.recipe_status END
WHERE status IS NULL;

ALTER TABLE public.recipes
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'draft'::public.recipe_status;

-- 3) Version snapshots
CREATE TABLE IF NOT EXISTS public.recipe_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id uuid NOT NULL REFERENCES public.recipes(id) ON DELETE CASCADE,
  version_number integer NOT NULL,
  content jsonb NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recipe_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_recipe_versions_recipe_id_published_at
  ON public.recipe_versions (recipe_id, published_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'recipes_current_version_fkey'
  ) THEN
    ALTER TABLE public.recipes
      ADD CONSTRAINT recipes_current_version_fkey
      FOREIGN KEY (current_version_id) REFERENCES public.recipe_versions(id);
  END IF;
END
$$;

-- 4) Saved recipe version pinning
ALTER TABLE IF EXISTS public.saved_recipes
  ADD COLUMN IF NOT EXISTS version_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'saved_recipes_version_id_fkey'
  ) THEN
    ALTER TABLE public.saved_recipes
      ADD CONSTRAINT saved_recipes_version_id_fkey
      FOREIGN KEY (version_id) REFERENCES public.recipe_versions(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_saved_recipes_version_id
  ON public.saved_recipes (version_id);

-- 5) Likes
CREATE TABLE IF NOT EXISTS public.recipe_likes (
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  recipe_id uuid NOT NULL REFERENCES public.recipes(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, recipe_id)
);

CREATE INDEX IF NOT EXISTS idx_recipe_likes_recipe_id
  ON public.recipe_likes (recipe_id);

-- 6) Compatibility behavior for status <-> is_public
CREATE OR REPLACE FUNCTION public.sync_recipe_visibility_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Backward compatibility: old clients may only set is_public.
  -- Newer code may set status directly.
  IF NEW.status IS NULL THEN
    NEW.status := CASE WHEN COALESCE(NEW.is_public, false) THEN 'published'::public.recipe_status ELSE 'draft'::public.recipe_status END;
  END IF;

  NEW.is_public := (NEW.status = 'published');

  IF NEW.status = 'published' AND NEW.published_at IS NULL THEN
    NEW.published_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_recipe_visibility_columns ON public.recipes;
CREATE TRIGGER trg_sync_recipe_visibility_columns
BEFORE INSERT OR UPDATE OF status, is_public, published_at
ON public.recipes
FOR EACH ROW
EXECUTE FUNCTION public.sync_recipe_visibility_columns();

-- 7) Counter maintenance
CREATE OR REPLACE FUNCTION public.refresh_recipe_like_count()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_recipe_id uuid;
BEGIN
  target_recipe_id := COALESCE(NEW.recipe_id, OLD.recipe_id);

  UPDATE public.recipes r
  SET like_count = (
    SELECT COUNT(*)::integer
    FROM public.recipe_likes rl
    WHERE rl.recipe_id = target_recipe_id
  )
  WHERE r.id = target_recipe_id;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_refresh_recipe_like_count ON public.recipe_likes;
CREATE TRIGGER trg_refresh_recipe_like_count
AFTER INSERT OR UPDATE OF recipe_id OR DELETE
ON public.recipe_likes
FOR EACH ROW
EXECUTE FUNCTION public.refresh_recipe_like_count();

CREATE OR REPLACE FUNCTION public.refresh_recipe_save_count()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_recipe_id uuid;
BEGIN
  target_recipe_id := COALESCE(NEW.recipe_id, OLD.recipe_id);

  UPDATE public.recipes r
  SET save_count = (
    SELECT COUNT(*)::integer
    FROM public.saved_recipes sr
    WHERE sr.recipe_id = target_recipe_id
  )
  WHERE r.id = target_recipe_id;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_refresh_recipe_save_count ON public.saved_recipes;
CREATE TRIGGER trg_refresh_recipe_save_count
AFTER INSERT OR UPDATE OF recipe_id OR DELETE
ON public.saved_recipes
FOR EACH ROW
EXECUTE FUNCTION public.refresh_recipe_save_count();

UPDATE public.recipes r
SET like_count = likes.like_count
FROM (
  SELECT recipe_id, COUNT(*)::integer AS like_count
  FROM public.recipe_likes
  GROUP BY recipe_id
) likes
WHERE r.id = likes.recipe_id;

UPDATE public.recipes r
SET save_count = saves.save_count
FROM (
  SELECT recipe_id, COUNT(*)::integer AS save_count
  FROM public.saved_recipes
  GROUP BY recipe_id
) saves
WHERE r.id = saves.recipe_id;

UPDATE public.recipes
SET like_count = 0
WHERE like_count IS DISTINCT FROM 0
  AND id NOT IN (SELECT recipe_id FROM public.recipe_likes);

UPDATE public.recipes
SET save_count = 0
WHERE save_count IS DISTINCT FROM 0
  AND id NOT IN (SELECT recipe_id FROM public.saved_recipes);

-- 8) RLS for new tables
ALTER TABLE public.recipe_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipe_likes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'recipe_versions'
      AND policyname = 'Users can view recipe versions for visible recipes'
  ) THEN
    CREATE POLICY "Users can view recipe versions for visible recipes"
      ON public.recipe_versions
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1
          FROM public.recipes r
          WHERE r.id = recipe_versions.recipe_id
            AND (r.is_public = true OR r.created_by_profile_id = auth.uid())
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'recipe_versions'
      AND policyname = 'Users can manage versions for own recipes'
  ) THEN
    CREATE POLICY "Users can manage versions for own recipes"
      ON public.recipe_versions
      FOR ALL
      USING (
        EXISTS (
          SELECT 1
          FROM public.recipes r
          WHERE r.id = recipe_versions.recipe_id
            AND r.created_by_profile_id = auth.uid()
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.recipes r
          WHERE r.id = recipe_versions.recipe_id
            AND r.created_by_profile_id = auth.uid()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'recipe_likes'
      AND policyname = 'Users can view likes on visible recipes'
  ) THEN
    CREATE POLICY "Users can view likes on visible recipes"
      ON public.recipe_likes
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1
          FROM public.recipes r
          WHERE r.id = recipe_likes.recipe_id
            AND (r.is_public = true OR r.created_by_profile_id = auth.uid())
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'recipe_likes'
      AND policyname = 'Users can insert own recipe likes'
  ) THEN
    CREATE POLICY "Users can insert own recipe likes"
      ON public.recipe_likes
      FOR INSERT
      WITH CHECK (profile_id = auth.uid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'recipe_likes'
      AND policyname = 'Users can delete own recipe likes'
  ) THEN
    CREATE POLICY "Users can delete own recipe likes"
      ON public.recipe_likes
      FOR DELETE
      USING (profile_id = auth.uid());
  END IF;
END
$$;
