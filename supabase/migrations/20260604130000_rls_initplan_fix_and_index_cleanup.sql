-- Fix auth_rls_initplan: replace auth.uid() with (select auth.uid()) in all RLS policies.
-- auth.uid() called bare re-evaluates once per row; wrapping in a sub-select causes
-- Postgres to evaluate it once per query, which is significantly faster at scale.
--
-- Also drops idx_recipes_tags which is an exact duplicate of idx_recipes_tags_gin.

-- ── profiles ─────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users can view their own profile" ON public.profiles;
CREATE POLICY "Users can view their own profile"
  ON public.profiles FOR SELECT
  USING (id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can insert their own profile" ON public.profiles;
CREATE POLICY "Users can insert their own profile"
  ON public.profiles FOR INSERT
  WITH CHECK (id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE
  USING (id = (SELECT auth.uid()))
  WITH CHECK (id = (SELECT auth.uid()));

-- ── household_members ────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users can manage their own household members" ON public.household_members;
CREATE POLICY "Users can manage their own household members"
  ON public.household_members FOR ALL
  USING (profile_id = (SELECT auth.uid()))
  WITH CHECK (profile_id = (SELECT auth.uid()));

-- ── dietary_restrictions ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users can manage their own dietary restrictions" ON public.dietary_restrictions;
CREATE POLICY "Users can manage their own dietary restrictions"
  ON public.dietary_restrictions FOR ALL
  USING (profile_id = (SELECT auth.uid()))
  WITH CHECK (profile_id = (SELECT auth.uid()));

-- ── weekly_plans ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users can manage their own plans" ON public.weekly_plans;
CREATE POLICY "Users can manage their own plans"
  ON public.weekly_plans FOR ALL
  USING (profile_id = (SELECT auth.uid()))
  WITH CHECK (profile_id = (SELECT auth.uid()));

-- ── meal_slots ───────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users can manage slots in their own plans" ON public.meal_slots;
CREATE POLICY "Users can manage slots in their own plans"
  ON public.meal_slots FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.weekly_plans wp
      WHERE wp.id = meal_slots.plan_id
        AND wp.profile_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.weekly_plans wp
      WHERE wp.id = meal_slots.plan_id
        AND wp.profile_id = (SELECT auth.uid())
    )
  );

-- ── recipes ──────────────────────────────────────────────────────────────────

-- Drop legacy policy name from early migration if it still exists.
DROP POLICY IF EXISTS "Public can view public recipes" ON public.recipes;

DROP POLICY IF EXISTS "Public can view published recipes" ON public.recipes;
CREATE POLICY "Public can view published recipes"
  ON public.recipes FOR SELECT
  USING (status = 'published'::public.recipe_status OR created_by_profile_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can insert their own recipes" ON public.recipes;
CREATE POLICY "Users can insert their own recipes"
  ON public.recipes FOR INSERT
  WITH CHECK (created_by_profile_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can update their own recipes" ON public.recipes;
CREATE POLICY "Users can update their own recipes"
  ON public.recipes FOR UPDATE
  USING (created_by_profile_id = (SELECT auth.uid()))
  WITH CHECK (created_by_profile_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can delete their own recipes" ON public.recipes;
CREATE POLICY "Users can delete their own recipes"
  ON public.recipes FOR DELETE
  USING (created_by_profile_id = (SELECT auth.uid()));

-- ── recipe_ingredients ───────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users can view ingredients for published or owned recipes" ON public.recipe_ingredients;
CREATE POLICY "Users can view ingredients for published or owned recipes"
  ON public.recipe_ingredients FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.recipes r
      WHERE r.id = recipe_ingredients.recipe_id
        AND (r.status = 'published'::public.recipe_status OR r.created_by_profile_id = (SELECT auth.uid()))
    )
  );

DROP POLICY IF EXISTS "Users can manage ingredients for own recipes" ON public.recipe_ingredients;
CREATE POLICY "Users can manage ingredients for own recipes"
  ON public.recipe_ingredients FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.recipes r
      WHERE r.id = recipe_ingredients.recipe_id
        AND r.created_by_profile_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.recipes r
      WHERE r.id = recipe_ingredients.recipe_id
        AND r.created_by_profile_id = (SELECT auth.uid())
    )
  );

-- ── saved_recipes ────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users can manage own saved recipes" ON public.saved_recipes;
CREATE POLICY "Users can manage own saved recipes"
  ON public.saved_recipes FOR ALL
  USING (profile_id = (SELECT auth.uid()))
  WITH CHECK (profile_id = (SELECT auth.uid()));

-- ── subscriptions ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users can view own subscription" ON public.subscriptions;
CREATE POLICY "Users can view own subscription"
  ON public.subscriptions FOR SELECT
  USING (profile_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can insert own subscription" ON public.subscriptions;
CREATE POLICY "Users can insert own subscription"
  ON public.subscriptions FOR INSERT
  WITH CHECK (profile_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can update own subscription" ON public.subscriptions;
CREATE POLICY "Users can update own subscription"
  ON public.subscriptions FOR UPDATE
  USING (profile_id = (SELECT auth.uid()))
  WITH CHECK (profile_id = (SELECT auth.uid()));

-- ── ai_usage ──────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users can view own ai usage" ON public.ai_usage;
CREATE POLICY "Users can view own ai usage"
  ON public.ai_usage FOR SELECT
  USING (profile_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can insert own ai usage" ON public.ai_usage;
CREATE POLICY "Users can insert own ai usage"
  ON public.ai_usage FOR INSERT
  WITH CHECK (profile_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can update own ai usage" ON public.ai_usage;
CREATE POLICY "Users can update own ai usage"
  ON public.ai_usage FOR UPDATE
  USING (profile_id = (SELECT auth.uid()))
  WITH CHECK (profile_id = (SELECT auth.uid()));

-- ── grocery_snapshots ────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users can read own grocery snapshots" ON public.grocery_snapshots;
CREATE POLICY "Users can read own grocery snapshots"
  ON public.grocery_snapshots FOR SELECT
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own grocery snapshots" ON public.grocery_snapshots;
CREATE POLICY "Users can insert own grocery snapshots"
  ON public.grocery_snapshots FOR INSERT
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own grocery snapshots" ON public.grocery_snapshots;
CREATE POLICY "Users can update own grocery snapshots"
  ON public.grocery_snapshots FOR UPDATE
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own grocery snapshots" ON public.grocery_snapshots;
CREATE POLICY "Users can delete own grocery snapshots"
  ON public.grocery_snapshots FOR DELETE
  USING ((SELECT auth.uid()) = user_id);

-- ── recipe_versions ───────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users can view recipe versions for published or owned recipes" ON public.recipe_versions;
CREATE POLICY "Users can view recipe versions for published or owned recipes"
  ON public.recipe_versions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.recipes r
      WHERE r.id = recipe_versions.recipe_id
        AND (r.status = 'published'::public.recipe_status OR r.created_by_profile_id = (SELECT auth.uid()))
    )
  );

DROP POLICY IF EXISTS "Users can manage versions for own recipes" ON public.recipe_versions;
CREATE POLICY "Users can manage versions for own recipes"
  ON public.recipe_versions FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.recipes r
      WHERE r.id = recipe_versions.recipe_id
        AND r.created_by_profile_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.recipes r
      WHERE r.id = recipe_versions.recipe_id
        AND r.created_by_profile_id = (SELECT auth.uid())
    )
  );

-- ── recipe_likes ──────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users can view likes on published or owned recipes" ON public.recipe_likes;
CREATE POLICY "Users can view likes on published or owned recipes"
  ON public.recipe_likes FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.recipes r
      WHERE r.id = recipe_likes.recipe_id
        AND (r.status = 'published'::public.recipe_status OR r.created_by_profile_id = (SELECT auth.uid()))
    )
  );

DROP POLICY IF EXISTS "Users can insert own recipe likes" ON public.recipe_likes;
CREATE POLICY "Users can insert own recipe likes"
  ON public.recipe_likes FOR INSERT
  WITH CHECK (profile_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can delete own recipe likes" ON public.recipe_likes;
CREATE POLICY "Users can delete own recipe likes"
  ON public.recipe_likes FOR DELETE
  USING (profile_id = (SELECT auth.uid()));

-- ── follows ───────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users can view own follow graph" ON public.follows;
CREATE POLICY "Users can view own follow graph"
  ON public.follows FOR SELECT
  USING (
    follower_profile_id = (SELECT auth.uid())
    OR followee_profile_id = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS "Users can follow from own profile" ON public.follows;
CREATE POLICY "Users can follow from own profile"
  ON public.follows FOR INSERT
  WITH CHECK (follower_profile_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can unfollow from own profile" ON public.follows;
CREATE POLICY "Users can unfollow from own profile"
  ON public.follows FOR DELETE
  USING (follower_profile_id = (SELECT auth.uid()));

-- ── notifications ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users can read own notifications" ON public.notifications;
CREATE POLICY "Users can read own notifications"
  ON public.notifications FOR SELECT
  USING (recipient_profile_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can update own notifications" ON public.notifications;
CREATE POLICY "Users can update own notifications"
  ON public.notifications FOR UPDATE
  USING (recipient_profile_id = (SELECT auth.uid()))
  WITH CHECK (recipient_profile_id = (SELECT auth.uid()));

-- ── push_tokens ───────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users can manage own push tokens" ON public.push_tokens;
CREATE POLICY "Users can manage own push tokens"
  ON public.push_tokens FOR ALL
  USING (profile_id = (SELECT auth.uid()))
  WITH CHECK (profile_id = (SELECT auth.uid()));

-- ── household_memberships ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Members and organizers can view memberships" ON public.household_memberships;
CREATE POLICY "Members and organizers can view memberships"
  ON public.household_memberships FOR SELECT
  USING (
    member_id = (SELECT auth.uid())
    OR organizer_id = (SELECT auth.uid())
  );

-- ── household_invitations ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Organizers and invitees can view invitations" ON public.household_invitations;
CREATE POLICY "Organizers and invitees can view invitations"
  ON public.household_invitations FOR SELECT
  USING (
    organizer_id = (SELECT auth.uid())
    OR invitee_id = (SELECT auth.uid())
  );

-- ── blocks ────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users can view blocks involving them" ON public.blocks;
CREATE POLICY "Users can view blocks involving them"
  ON public.blocks FOR SELECT
  USING (
    blocker_id = (SELECT auth.uid())
    OR blocked_id = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS "Users can insert their own blocks" ON public.blocks;
CREATE POLICY "Users can insert their own blocks"
  ON public.blocks FOR INSERT
  WITH CHECK (blocker_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can delete their own blocks" ON public.blocks;
CREATE POLICY "Users can delete their own blocks"
  ON public.blocks FOR DELETE
  USING (blocker_id = (SELECT auth.uid()));

-- ── household_member_permissions ──────────────────────────────────────────────

DROP POLICY IF EXISTS "Organizer can manage member permissions" ON public.household_member_permissions;
CREATE POLICY "Organizer can manage member permissions"
  ON public.household_member_permissions FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.household_memberships hm
      WHERE hm.member_id = household_member_permissions.member_id
        AND hm.organizer_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Member can read own permissions" ON public.household_member_permissions;
CREATE POLICY "Member can read own permissions"
  ON public.household_member_permissions FOR SELECT
  USING (member_id = (SELECT auth.uid()));

-- ── duplicate index cleanup ───────────────────────────────────────────────────

-- idx_recipes_tags is a plain btree index on tags[] created in the initial migration.
-- idx_recipes_tags_gin (GIN) was added shortly after and covers the same column better.
-- The btree index has never been used and can't support @> containment queries anyway.
DROP INDEX IF EXISTS public.idx_recipes_tags;
