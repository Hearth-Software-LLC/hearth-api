-- PR7: RevenueCat webhook idempotency log table

create table if not exists public.revenuecat_webhook_events (
  event_id text primary key,
  event_type text not null,
  profile_id uuid references public.profiles(id) on delete set null,
  payload jsonb not null,
  processed_at timestamptz not null default now()
);

create index if not exists idx_revenuecat_webhook_events_profile_id
  on public.revenuecat_webhook_events(profile_id);
