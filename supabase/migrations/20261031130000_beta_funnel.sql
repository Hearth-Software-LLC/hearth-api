-- The beta funnel (Hearth Connect › Autopilot, milestone 1): the launch waitlist, the beta pages'
-- "what's new" lines, TestFlight button taps, and short links that send people to a beta page.
begin;

-- Short links can now go to an app's beta page (hearthapps.com/beta/<app>) instead of the App
-- Store. A beta link has no App Store id; its ct still names it in reports.
alter table public.campaign_links
  add column destination text not null default 'app_store' check (destination in ('app_store', 'beta')),
  add column post_id uuid,
  alter column app_store_id drop not null;
alter table public.campaign_links
  add constraint campaign_links_destination check (destination = 'beta' or app_store_id is not null);
create index campaign_links_post on public.campaign_links (post_id) where post_id is not null;

-- People who asked to hear when an app launches. One row per address; the apps are merged.
create table public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(email) and char_length(email) between 3 and 254),
  apps text[] not null check (cardinality(apps) between 1 and 20),
  -- The short link (slug) that brought them, if any, and the page they signed up on.
  via text check (via ~ '^[a-z0-9-]{2,60}$'),
  page text check (char_length(page) <= 200),
  created_at timestamptz not null default now(),
  confirm_sent_at timestamptz,
  confirmed_at timestamptz,
  resend_contact_id text,
  bounced_at timestamptz,
  unsubscribed_at timestamptz
);
create unique index waitlist_email on public.waitlist (email);
create index waitlist_confirmed on public.waitlist (confirmed_at);

-- Each beta app's page: the TestFlight link and "what's new this week" lines.
create table public.beta_apps (
  app text primary key check (app ~ '^[a-z0-9-]{1,40}$'),
  name text not null check (char_length(name) between 1 and 40),
  testflight_url text not null check (testflight_url ~ '^https://testflight\.apple\.com/join/[A-Za-z0-9]{4,20}$'),
  whats_new jsonb not null default '[]'::jsonb check (jsonb_typeof(whats_new) = 'array'),
  resend_segment_id text,
  launched_at timestamptz,
  updated_by uuid,
  updated_at timestamptz
);
insert into public.beta_apps (app, name, testflight_url) values
  ('suffice', 'Suffice', 'https://testflight.apple.com/join/eNu3hBJ6'),
  ('sated', 'Sated', 'https://testflight.apple.com/join/pp2V9MdA'),
  ('caloma', 'Caloma', 'https://testflight.apple.com/join/QDje8vqM'),
  ('hearken', 'Hearken', 'https://testflight.apple.com/join/bSxK5KSt'),
  ('trove', 'Trove', 'https://testflight.apple.com/join/A1MhYETk'),
  ('ember', 'Ember', 'https://testflight.apple.com/join/SNAUPBnr')
on conflict (app) do nothing;

-- Taps on the beta pages' TestFlight buttons, per app and day, and per short link when the page
-- was opened from one (link_id null otherwise). Nothing about who tapped.
create table public.testflight_taps_daily (
  app text not null references public.beta_apps (app) on delete cascade,
  link_id uuid references public.campaign_links (id) on delete set null,
  day date not null,
  taps integer not null default 0
);
create unique index testflight_taps_daily_key on public.testflight_taps_daily
  (app, coalesce(link_id, '00000000-0000-0000-0000-000000000000'::uuid), day);

-- Launch emails sent (one Resend broadcast per app launch).
create table public.waitlist_broadcasts (
  id uuid primary key default gen_random_uuid(),
  app text not null references public.beta_apps (app),
  resend_broadcast_id text not null,
  recipients integer not null,
  app_store_url text not null,
  sent_by uuid not null,
  sent_at timestamptz not null default now()
);

do $$
declare
  t text;
begin
  foreach t in array array['waitlist', 'beta_apps', 'testflight_taps_daily', 'waitlist_broadcasts'] loop
    execute format('alter table public.%I enable row level security', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on public.%I from authenticated', t);
    end if;
  end loop;
end
$$;

commit;
