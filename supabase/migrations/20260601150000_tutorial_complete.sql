ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS tutorial_complete boolean NOT NULL DEFAULT false;
