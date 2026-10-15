-- PR5: subscription tiers and monthly AI usage tracking

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade unique,
  tier text not null default 'free',
  revenuecat_user_id text,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  month_key text not null,
  meal_plan_count int not null default 0,
  grocery_list_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(profile_id, month_key)
);

create index if not exists idx_ai_usage_profile_month
  on public.ai_usage(profile_id, month_key);

alter table public.subscriptions enable row level security;
alter table public.ai_usage enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'subscriptions'
      and policyname = 'Users can view own subscription'
  ) then
    create policy "Users can view own subscription"
      on public.subscriptions
      for select
      using (profile_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'subscriptions'
      and policyname = 'Users can insert own subscription'
  ) then
    create policy "Users can insert own subscription"
      on public.subscriptions
      for insert
      with check (profile_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'subscriptions'
      and policyname = 'Users can update own subscription'
  ) then
    create policy "Users can update own subscription"
      on public.subscriptions
      for update
      using (profile_id = auth.uid())
      with check (profile_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'ai_usage'
      and policyname = 'Users can view own ai usage'
  ) then
    create policy "Users can view own ai usage"
      on public.ai_usage
      for select
      using (profile_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'ai_usage'
      and policyname = 'Users can insert own ai usage'
  ) then
    create policy "Users can insert own ai usage"
      on public.ai_usage
      for insert
      with check (profile_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'ai_usage'
      and policyname = 'Users can update own ai usage'
  ) then
    create policy "Users can update own ai usage"
      on public.ai_usage
      for update
      using (profile_id = auth.uid())
      with check (profile_id = auth.uid());
  end if;
end
$$;
