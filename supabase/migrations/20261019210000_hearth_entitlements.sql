-- Hearth+ and per-app plans. One RevenueCat project sells every Hearth app's plan plus Hearth+,
-- so a subscription is now a set of entitlements, not one tier. `entitlements` maps each active
-- entitlement's lookup key (`hearth_plus`, `BigTable Pro`, `suffice_plus`, `sated_plus`,
-- `caloma_plus`, `hearken_plus`) to its expiry as an ISO 8601 string, or null when it never
-- expires (lifetime). The RevenueCat webhook refreshes it on every event. `tier` stays, and
-- stays 'pro' while `BigTable Pro` or `hearth_plus` is active: BigTable's AI limits read it.
--
-- Additive only: existing rows get '{}' and keep their tier until their next webhook event.

alter table public.subscriptions
  add column if not exists entitlements jsonb not null default '{}'::jsonb;

comment on column public.subscriptions.entitlements is
  'RevenueCat entitlement lookup key -> ISO expiry (null = never). Written by the RevenueCat webhook.';
