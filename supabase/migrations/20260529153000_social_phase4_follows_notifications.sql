-- Phase 4: follows + in-app notifications foundation

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'notification_type'
      AND n.nspname = 'public'
  ) THEN
    CREATE TYPE public.notification_type AS ENUM (
      'recipe_published',
      'recipe_updated',
      'recipe_liked',
      'recipe_saved',
      'new_follower'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.follows (
  follower_profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  followee_profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_profile_id, followee_profile_id),
  CONSTRAINT follows_no_self_follow CHECK (follower_profile_id <> followee_profile_id)
);

CREATE INDEX IF NOT EXISTS idx_follows_followee_profile_id
  ON public.follows (followee_profile_id);

CREATE INDEX IF NOT EXISTS idx_follows_follower_profile_id
  ON public.follows (follower_profile_id);

CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type public.notification_type NOT NULL,
  actor_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  recipe_id uuid REFERENCES public.recipes(id) ON DELETE CASCADE,
  version_id uuid REFERENCES public.recipe_versions(id) ON DELETE SET NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_created_at
  ON public.notifications (recipient_profile_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_unread
  ON public.notifications (recipient_profile_id)
  WHERE read_at IS NULL;

ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'follows'
      AND policyname = 'Users can view own follow graph'
  ) THEN
    CREATE POLICY "Users can view own follow graph"
      ON public.follows
      FOR SELECT
      USING (
        follower_profile_id = auth.uid()
        OR followee_profile_id = auth.uid()
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'follows'
      AND policyname = 'Users can follow from own profile'
  ) THEN
    CREATE POLICY "Users can follow from own profile"
      ON public.follows
      FOR INSERT
      WITH CHECK (follower_profile_id = auth.uid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'follows'
      AND policyname = 'Users can unfollow from own profile'
  ) THEN
    CREATE POLICY "Users can unfollow from own profile"
      ON public.follows
      FOR DELETE
      USING (follower_profile_id = auth.uid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'notifications'
      AND policyname = 'Users can read own notifications'
  ) THEN
    CREATE POLICY "Users can read own notifications"
      ON public.notifications
      FOR SELECT
      USING (recipient_profile_id = auth.uid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'notifications'
      AND policyname = 'Users can update own notifications'
  ) THEN
    CREATE POLICY "Users can update own notifications"
      ON public.notifications
      FOR UPDATE
      USING (recipient_profile_id = auth.uid())
      WITH CHECK (recipient_profile_id = auth.uid());
  END IF;
END
$$;
