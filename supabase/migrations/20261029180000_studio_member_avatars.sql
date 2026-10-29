-- Hearth Studio: a profile photo for each team member. The file lives in the private `library`
-- bucket at <team>/avatars/<user>/<sha256>.<ext>; the API hands out signed links.
alter table public.studio_members
  add column if not exists avatar_path text check (char_length(avatar_path) <= 300);
