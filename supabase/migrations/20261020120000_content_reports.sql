-- Reports of objectionable content or people, from any Hearth app (POST /v1/reports).
--
-- Only the API reads and writes this table: row-level security on, no policies, and no grants for
-- the app-facing roles, so client keys can't reach it through the REST or Realtime APIs.
--
-- reporter_id is the Hearth account id (the verified JWT subject). There is no foreign key to
-- auth.users: deleting an account goes through DELETE /v1/me, which deletes the person's reports
-- explicitly. target_id is the reported thing's id as the app knows it (a recipe, a profile, a
-- Hearken post, comment, answer, question or member).

begin;

create table if not exists public.content_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null,
  app text not null check (app in ('bigtable', 'hearken')),
  kind text not null check (kind in ('recipe', 'profile', 'post', 'comment', 'answer', 'question', 'member')),
  target_id text not null check (char_length(target_id) between 1 and 300),
  -- The Hearken group the reported content is in, when there is one.
  group_id uuid,
  reason text not null check (reason in ('spam', 'harassment', 'hate', 'sexual', 'violence', 'self_harm', 'other')),
  details text check (details is null or char_length(details) <= 1000),
  status text not null default 'open' check (status in ('open', 'reviewing', 'actioned', 'dismissed')),
  created_at timestamptz not null default now()
);

-- The daily per-person limit, and account deletion.
create index if not exists content_reports_reporter_created on public.content_reports (reporter_id, created_at desc);
-- The review queue.
create index if not exists content_reports_open on public.content_reports (created_at) where status = 'open';

alter table public.content_reports enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.content_reports from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.content_reports from authenticated;
  end if;
end
$$;

comment on table public.content_reports is
  'Content and people reported from the Hearth apps. Written by hearth-api only; reviewed within 24 hours.';

commit;
