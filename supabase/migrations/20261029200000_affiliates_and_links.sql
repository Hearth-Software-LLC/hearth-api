-- Hearth Studio: affiliates, their codes and exact credit, campaign links and their numbers.
--
-- Affiliates are paid only from credits: one row per purchase, renewal or refund that RevenueCat
-- reported with an affiliate's code (an App Store offer code, or a referral code the app saved
-- to the customer). Credits are never edited; a refund or a correction is a new row. A payout
-- covers the unpaid credits up to a date.
--
-- No people: an attribution is keyed on an HMAC of the store's original transaction id, enough to
-- credit renewals and refunds of that subscription and nothing more. Affiliates and the team see
-- the plan, date and amount only.
--
-- Campaign links (an App Store link's ct= code, maybe behind hearthapps.com/go/<slug>) are for
-- reporting: App Store Connect totals and short-link tap counts. They never create money owed.
--
-- Like the other API-only tables: row-level security on, no policies, no grants to app roles.

begin;

-- Who may see amounts owed, change terms and mark payouts (owners always can).
alter table public.studio_members add column if not exists can_affiliates boolean not null default false;
alter table public.studio_invites add column if not exists can_affiliates boolean not null default false;

create table public.affiliates (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.studio_teams (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  -- How to reach them for payment (an email, a handle): never shown to anyone but the team.
  contact text check (char_length(contact) <= 200),
  -- Either a share of Apple's proceeds in basis points, or a flat amount per paying subscription.
  rate_bps integer check (rate_bps between 0 and 10000),
  flat_cents integer check (flat_cents between 0 and 1000000),
  -- How long a subscription earns credit after its first purchase.
  window_months integer not null default 12 check (window_months between 1 and 120),
  active boolean not null default true,
  -- The affiliate's own sign-in, once they've joined with an invite (they see only their own).
  user_id uuid unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((rate_bps is null) <> (flat_cents is null))
);
create index affiliates_team on public.affiliates (team_id);

create table public.affiliate_codes (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.studio_teams (id) on delete cascade,
  affiliate_id uuid not null references public.affiliates (id) on delete cascade,
  -- The Hearth app it's for (its key).
  app text not null check (app ~ '^[a-z0-9-]{1,40}$'),
  -- What the subscriber types (KRISTEN20), kept upper case.
  code text not null check (code ~ '^[A-Z0-9_-]{3,40}$'),
  kind text not null check (kind in ('apple_offer', 'referral')),
  -- For an App Store offer code: the offer's reference name, which purchases may report instead of the code.
  offer_ref text check (char_length(offer_ref) <= 100),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index affiliate_codes_code on public.affiliate_codes (team_id, code);

create table public.affiliate_invites (
  code text primary key check (code ~ '^[A-Z2-9]{8}$'),
  team_id uuid not null references public.studio_teams (id) on delete cascade,
  affiliate_id uuid not null references public.affiliates (id) on delete cascade,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_by uuid,
  used_at timestamptz
);

-- A subscription credited to an affiliate: its first code wins, for window_months.
create table public.affiliate_attributions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.studio_teams (id) on delete cascade,
  affiliate_id uuid not null references public.affiliates (id) on delete cascade,
  code_id uuid not null references public.affiliate_codes (id) on delete cascade,
  app text not null,
  -- HMAC-SHA256 of the store and original transaction id, with the server's secret.
  subscription_key text not null check (subscription_key ~ '^[0-9a-f]{64}$'),
  started_at timestamptz not null,
  ends_at timestamptz not null,
  -- A flat-rate affiliate is paid once per subscription: set when that credit is made.
  flat_paid boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index affiliate_attributions_key on public.affiliate_attributions (team_id, subscription_key);

create table public.affiliate_payouts (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.studio_teams (id) on delete cascade,
  affiliate_id uuid not null references public.affiliates (id) on delete cascade,
  -- Every unpaid credit up to the end of this day (UTC).
  through date not null,
  total_cents integer not null,
  paid_by uuid not null,
  note text check (char_length(note) <= 300),
  paid_at timestamptz not null default now()
);
create index affiliate_payouts_affiliate on public.affiliate_payouts (affiliate_id, paid_at desc);

create table public.affiliate_credits (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.studio_teams (id) on delete cascade,
  affiliate_id uuid not null references public.affiliates (id) on delete cascade,
  attribution_id uuid references public.affiliate_attributions (id) on delete set null,
  -- The RevenueCat event that made it: a replayed webhook makes nothing new.
  event_id text not null unique,
  -- HMAC of the store transaction, so a refund finds the purchase it undoes.
  transaction_key text check (transaction_key ~ '^[0-9a-f]{64}$'),
  app text not null,
  product text not null check (char_length(product) <= 200),
  kind text not null check (kind in ('purchase', 'renewal', 'refund', 'adjustment')),
  proceeds_cents integer not null,
  commission_cents integer not null,
  occurred_at timestamptz not null,
  payout_id uuid references public.affiliate_payouts (id) on delete set null,
  note text check (char_length(note) <= 300),
  created_at timestamptz not null default now()
);
create index affiliate_credits_affiliate on public.affiliate_credits (affiliate_id, occurred_at desc);
create index affiliate_credits_unpaid on public.affiliate_credits (affiliate_id) where payout_id is null;
create index affiliate_credits_transaction on public.affiliate_credits (transaction_key);

-- What the monthly reconciliation found that needs a look before paying.
create table public.affiliate_flags (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.studio_teams (id) on delete cascade,
  affiliate_id uuid references public.affiliates (id) on delete cascade,
  kind text not null check (kind in ('missing_credit', 'unknown_code', 'refund_without_purchase')),
  detail text not null check (char_length(detail) <= 500),
  event_id text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid
);
create unique index affiliate_flags_event on public.affiliate_flags (kind, event_id) where event_id is not null;

create table public.campaign_links (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.studio_teams (id) on delete cascade,
  app text not null check (app ~ '^[a-z0-9-]{1,40}$'),
  name text not null check (char_length(name) between 1 and 80),
  -- App Store Connect's campaign token: what the totals are reported under.
  ct text not null check (ct ~ '^[A-Za-z0-9._-]{1,40}$'),
  app_store_id text not null check (app_store_id ~ '^\d{5,15}$'),
  -- hearthapps.com/go/<slug>, when the link has a short form.
  slug text unique check (slug ~ '^[a-z0-9-]{2,60}$'),
  affiliate_id uuid references public.affiliates (id) on delete set null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index campaign_links_ct on public.campaign_links (team_id, app, ct) where deleted_at is null;

-- Short-link taps: a count per link per day, nothing about who tapped.
create table public.link_taps_daily (
  link_id uuid not null references public.campaign_links (id) on delete cascade,
  day date not null,
  taps integer not null default 0,
  primary key (link_id, day)
);

-- App Store Connect's campaign totals per app, ct and day.
create table public.campaign_stats_daily (
  team_id uuid not null references public.studio_teams (id) on delete cascade,
  app text not null,
  ct text not null,
  day date not null,
  metric text not null check (metric in ('page_views', 'downloads', 'redownloads', 'proceeds_cents', 'paying_users')),
  value numeric not null,
  primary key (team_id, app, ct, day, metric)
);

-- The ongoing App Store Connect analytics report request for each app.
create table public.asc_report_requests (
  app_store_id text primary key,
  request_id text not null,
  imported_through date,
  created_at timestamptz not null default now()
);

do $$
declare
  t text;
begin
  foreach t in array array['affiliates', 'affiliate_codes', 'affiliate_invites', 'affiliate_attributions', 'affiliate_payouts',
                           'affiliate_credits', 'affiliate_flags', 'campaign_links', 'link_taps_daily', 'campaign_stats_daily',
                           'asc_report_requests'] loop
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
