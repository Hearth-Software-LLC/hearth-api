-- Phase 6: cleanup and hardening
-- 1) Replace remaining is_public-driven RLS visibility with status='published'
-- 2) Add feed/notification performance indexes

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'recipes'
      AND policyname = 'Public can view public recipes'
  ) THEN
    DROP POLICY "Public can view public recipes" ON public.recipes;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'recipes'
      AND policyname = 'Public can view published recipes'
  ) THEN
    CREATE POLICY "Public can view published recipes"
      ON public.recipes
      FOR SELECT
      USING (status = 'published'::public.recipe_status OR created_by_profile_id = auth.uid());
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'recipe_ingredients'
      AND policyname = 'Users can view ingredients for visible recipes'
  ) THEN
    DROP POLICY "Users can view ingredients for visible recipes" ON public.recipe_ingredients;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'recipe_ingredients'
      AND policyname = 'Users can view ingredients for published or owned recipes'
  ) THEN
    CREATE POLICY "Users can view ingredients for published or owned recipes"
      ON public.recipe_ingredients
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.recipes r
          WHERE r.id = recipe_ingredients.recipe_id
            AND (r.status = 'published'::public.recipe_status OR r.created_by_profile_id = auth.uid())
        )
      );
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'recipe_versions'
      AND policyname = 'Users can view recipe versions for visible recipes'
  ) THEN
    DROP POLICY "Users can view recipe versions for visible recipes" ON public.recipe_versions;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'recipe_versions'
      AND policyname = 'Users can view recipe versions for published or owned recipes'
  ) THEN
    CREATE POLICY "Users can view recipe versions for published or owned recipes"
      ON public.recipe_versions
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1
          FROM public.recipes r
          WHERE r.id = recipe_versions.recipe_id
            AND (r.status = 'published'::public.recipe_status OR r.created_by_profile_id = auth.uid())
        )
      );
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'recipe_likes'
      AND policyname = 'Users can view likes on visible recipes'
  ) THEN
    DROP POLICY "Users can view likes on visible recipes" ON public.recipe_likes;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'recipe_likes'
      AND policyname = 'Users can view likes on published or owned recipes'
  ) THEN
    CREATE POLICY "Users can view likes on published or owned recipes"
      ON public.recipe_likes
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1
          FROM public.recipes r
          WHERE r.id = recipe_likes.recipe_id
            AND (r.status = 'published'::public.recipe_status OR r.created_by_profile_id = auth.uid())
        )
      );
  END IF;
END
$$;

-- Feed-oriented indexes (status + title ordering and owner fallback)
CREATE INDEX IF NOT EXISTS idx_recipes_status_title_id
  ON public.recipes (status, title, id);

CREATE INDEX IF NOT EXISTS idx_recipes_owner_title_id
  ON public.recipes (created_by_profile_id, title, id);

-- Notification inbox-oriented index
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_read_created_at
  ON public.notifications (recipient_profile_id, read_at, created_at DESC);
