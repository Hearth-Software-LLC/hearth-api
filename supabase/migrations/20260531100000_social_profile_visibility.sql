-- Phase 6+: profile-level social visibility

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS social_profile_visible boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_profiles_social_profile_visible
  ON public.profiles (social_profile_visible);
