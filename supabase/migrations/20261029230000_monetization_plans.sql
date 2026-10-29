-- Hearth Studio: the plans each app sells, as the team defines them (billing, US price, trial,
-- one line on what it unlocks). Store › Monetization › Set Up Plans fills in App Store Connect and
-- RevenueCat from these. scope: an app's key, or 'hearth' for Hearth+ (sold in every app).
create table public.monetization_plans (
  team_id uuid not null references public.studio_teams (id) on delete cascade,
  scope text not null check (scope ~ '^[a-z0-9-]{1,40}$'),
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  version integer not null default 1,
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  primary key (team_id, scope)
);

alter table public.monetization_plans enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.monetization_plans from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.monetization_plans from authenticated;
  end if;
end
$$;
