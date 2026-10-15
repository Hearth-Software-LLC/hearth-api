-- PR3: Weekly planner core schema

create table if not exists public.weekly_plans (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  week_start date not null,
  created_at timestamptz not null default now(),
  unique (profile_id, week_start)
);

create table if not exists public.meal_slots (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.weekly_plans(id) on delete cascade,
  day text not null,
  slot text not null,
  recipe_id uuid,
  custom_meal text,
  servings int,
  completed boolean not null default false,
  unique (plan_id, day, slot)
);

create index if not exists idx_weekly_plans_profile_id_week_start
  on public.weekly_plans(profile_id, week_start);

create index if not exists idx_meal_slots_plan_id
  on public.meal_slots(plan_id);

alter table public.weekly_plans enable row level security;
alter table public.meal_slots enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'weekly_plans'
      and policyname = 'Users can manage their own plans'
  ) then
    create policy "Users can manage their own plans"
      on public.weekly_plans
      for all
      using (profile_id = auth.uid())
      with check (profile_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'meal_slots'
      and policyname = 'Users can manage slots in their own plans'
  ) then
    create policy "Users can manage slots in their own plans"
      on public.meal_slots
      for all
      using (
        exists (
          select 1 from public.weekly_plans wp
          where wp.id = meal_slots.plan_id
            and wp.profile_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1 from public.weekly_plans wp
          where wp.id = meal_slots.plan_id
            and wp.profile_id = auth.uid()
        )
      );
  end if;
end
$$;
