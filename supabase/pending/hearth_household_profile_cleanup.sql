-- Hearth household: the server stops keeping family profiles.
--
-- NOT APPLIED. Kept outside supabase/migrations so `supabase db push` can't pick it up.
-- When it's time, move it to supabase/migrations/<timestamp>_hearth_household_profile_cleanup.sql.
--
-- Family profiles (birthdays, likes, dislikes, allergies, diets) now live in the family's
-- Hearth household in iCloud, end-to-end encrypted where sensitive. AI requests carry them as an
-- unnamed summary (`household` in POST /v1/bigtable/ai/meal-plan and /ai/grocery-list).
-- BigTable keeps a seat per person here (id, name, linked account) for meal-slot picks.
--
-- Apply only after ALL of these are true:
--   1. Every supported BigTable build sends `household` (the Hearth release is the minimum version).
--   2. Households in use have been moved to Hearth (each organizer has opened the Hearth build,
--      which copies their people into the household before anything here is dropped).
--   3. The API no longer reads these columns: routes/me.ts (GET/PUT select and write
--      date_of_birth, likes, dislikes), routes/ai.meal-plan.ts and routes/ai.grocery-list.ts
--      (getHouseholdContext's fallback). Nothing else in src/ reads them today.
--   4. A backup of household_members and dietary_restrictions has been taken.
--   5. The SQL function accept_household_invitation (and anything else that writes
--      date_of_birth, likes or dislikes) is replaced or dropped; BigTable's old invitations are
--      no longer used by current builds (they join with the household join code).
--
-- This permanently deletes data. There is no down migration.

begin;

alter table public.household_members
  drop column if exists date_of_birth,
  drop column if exists likes,
  drop column if exists dislikes;

-- Allergies and diets are in the Hearth household now.
drop table if exists public.dietary_restrictions;

commit;
