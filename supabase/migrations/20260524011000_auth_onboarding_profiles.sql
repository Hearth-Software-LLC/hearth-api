-- PR2: Auth and onboarding core schema

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  household_name text,
  avatar_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.household_members (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  age int,
  created_at timestamptz not null default now()
);

create table if not exists public.dietary_restrictions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  type text not null,
  value text not null
);

create index if not exists idx_household_members_profile_id
  on public.household_members(profile_id);

create index if not exists idx_dietary_restrictions_profile_id
  on public.dietary_restrictions(profile_id);

alter table public.profiles enable row level security;
alter table public.household_members enable row level security;
alter table public.dietary_restrictions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and policyname = 'Users can view their own profile'
  ) then
    create policy "Users can view their own profile"
      on public.profiles
      for select
      using (id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and policyname = 'Users can insert their own profile'
  ) then
    create policy "Users can insert their own profile"
      on public.profiles
      for insert
      with check (id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and policyname = 'Users can update their own profile'
  ) then
    create policy "Users can update their own profile"
      on public.profiles
      for update
      using (id = auth.uid())
      with check (id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'household_members'
      and policyname = 'Users can manage their own household members'
  ) then
    create policy "Users can manage their own household members"
      on public.household_members
      for all
      using (profile_id = auth.uid())
      with check (profile_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'dietary_restrictions'
      and policyname = 'Users can manage their own dietary restrictions'
  ) then
    create policy "Users can manage their own dietary restrictions"
      on public.dietary_restrictions
      for all
      using (profile_id = auth.uid())
      with check (profile_id = auth.uid());
  end if;
end
$$;
