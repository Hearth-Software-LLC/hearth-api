-- Fix function_search_path_mutable: add SET search_path = '' to trigger functions.
-- Without this, a superuser could inject objects into the search path to influence
-- function behavior. Fully-qualifying all identifiers (public.*) keeps it safe.

CREATE OR REPLACE FUNCTION public.sync_recipe_visibility_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
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

CREATE OR REPLACE FUNCTION public.refresh_recipe_like_count()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
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

CREATE OR REPLACE FUNCTION public.refresh_recipe_save_count()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
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

-- Add covering indexes for unindexed foreign keys flagged by the performance advisor.

-- recipes.current_version_id → recipe_versions(id)
CREATE INDEX IF NOT EXISTS idx_recipes_current_version_id
  ON public.recipes (current_version_id);

-- saved_recipes.recipe_id → recipes(id)
CREATE INDEX IF NOT EXISTS idx_saved_recipes_recipe_id
  ON public.saved_recipes (recipe_id);

-- household_members.linked_profile_id → profiles(id)
CREATE INDEX IF NOT EXISTS idx_household_members_linked_profile_id
  ON public.household_members (linked_profile_id)
  WHERE linked_profile_id IS NOT NULL;

-- household_invitations.invitee_id → profiles(id)
CREATE INDEX IF NOT EXISTS idx_household_invitations_invitee_id
  ON public.household_invitations (invitee_id);

-- notifications.actor_profile_id → profiles(id)
CREATE INDEX IF NOT EXISTS idx_notifications_actor_profile_id
  ON public.notifications (actor_profile_id);

-- notifications.recipe_id → recipes(id)
CREATE INDEX IF NOT EXISTS idx_notifications_recipe_id
  ON public.notifications (recipe_id)
  WHERE recipe_id IS NOT NULL;

-- notifications.version_id → recipe_versions(id)
CREATE INDEX IF NOT EXISTS idx_notifications_version_id
  ON public.notifications (version_id)
  WHERE version_id IS NOT NULL;
