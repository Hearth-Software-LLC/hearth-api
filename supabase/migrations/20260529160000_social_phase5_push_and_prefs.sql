-- Phase 5: push tokens + notification preferences

CREATE TABLE IF NOT EXISTS public.push_tokens (
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  token text NOT NULL,
  platform text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, token)
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_profile_id
  ON public.push_tokens (profile_id);

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS notification_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'push_tokens'
      AND policyname = 'Users can manage own push tokens'
  ) THEN
    CREATE POLICY "Users can manage own push tokens"
      ON public.push_tokens
      FOR ALL
      USING (profile_id = auth.uid())
      WITH CHECK (profile_id = auth.uid());
  END IF;
END
$$;
