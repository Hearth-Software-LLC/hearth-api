create table if not exists public.grocery_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  generated_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  item_count int not null default 0 check (item_count >= 0),
  estimated_cost numeric(10,2) not null default 0 check (estimated_cost >= 0),
  source text not null default 'manual' check (source in ('anthropic', 'fallback', 'manual')),
  sections jsonb not null default '[]'::jsonb,
  checks jsonb not null default '{}'::jsonb,
  is_active boolean not null default true
);

create index if not exists grocery_snapshots_user_generated_idx
  on public.grocery_snapshots (user_id, generated_at desc);

create unique index if not exists grocery_snapshots_one_active_per_user_idx
  on public.grocery_snapshots (user_id)
  where is_active;

alter table public.grocery_snapshots enable row level security;

drop policy if exists "Users can read own grocery snapshots" on public.grocery_snapshots;
create policy "Users can read own grocery snapshots"
  on public.grocery_snapshots
  for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own grocery snapshots" on public.grocery_snapshots;
create policy "Users can insert own grocery snapshots"
  on public.grocery_snapshots
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own grocery snapshots" on public.grocery_snapshots;
create policy "Users can update own grocery snapshots"
  on public.grocery_snapshots
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own grocery snapshots" on public.grocery_snapshots;
create policy "Users can delete own grocery snapshots"
  on public.grocery_snapshots
  for delete
  using (auth.uid() = user_id);
