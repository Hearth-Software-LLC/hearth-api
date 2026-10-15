-- PR4: Recipe library, favorites, and source attribution

create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  image_url text,
  prep_minutes int,
  cook_minutes int,
  base_servings int not null default 8,
  difficulty text,
  tags text[] not null default '{}',
  instructions jsonb not null default '[]'::jsonb,
  source_name text not null default 'user',
  source_id text,
  source_url text,
  attribution_required boolean not null default false,
  attribution_text text,
  created_by_profile_id uuid references public.profiles(id) on delete set null,
  is_public boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_recipes_source_unique
  on public.recipes(source_name, source_id)
  where source_id is not null;

create index if not exists idx_recipes_created_at
  on public.recipes(created_at desc);

create index if not exists idx_recipes_tags
  on public.recipes using gin(tags);

create table if not exists public.recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  name text not null,
  quantity numeric,
  unit text,
  notes text
);

create index if not exists idx_recipe_ingredients_recipe_id
  on public.recipe_ingredients(recipe_id);

create table if not exists public.saved_recipes (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  saved_at timestamptz not null default now(),
  primary key (profile_id, recipe_id)
);

alter table public.recipes enable row level security;
alter table public.recipe_ingredients enable row level security;
alter table public.saved_recipes enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipes'
      and policyname = 'Public can view public recipes'
  ) then
    create policy "Public can view public recipes"
      on public.recipes
      for select
      using (is_public = true or created_by_profile_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipes'
      and policyname = 'Users can insert their own recipes'
  ) then
    create policy "Users can insert their own recipes"
      on public.recipes
      for insert
      with check (created_by_profile_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipes'
      and policyname = 'Users can update their own recipes'
  ) then
    create policy "Users can update their own recipes"
      on public.recipes
      for update
      using (created_by_profile_id = auth.uid())
      with check (created_by_profile_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipes'
      and policyname = 'Users can delete their own recipes'
  ) then
    create policy "Users can delete their own recipes"
      on public.recipes
      for delete
      using (created_by_profile_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipe_ingredients'
      and policyname = 'Users can view ingredients for visible recipes'
  ) then
    create policy "Users can view ingredients for visible recipes"
      on public.recipe_ingredients
      for select
      using (
        exists (
          select 1 from public.recipes r
          where r.id = recipe_ingredients.recipe_id
            and (r.is_public = true or r.created_by_profile_id = auth.uid())
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'recipe_ingredients'
      and policyname = 'Users can manage ingredients for own recipes'
  ) then
    create policy "Users can manage ingredients for own recipes"
      on public.recipe_ingredients
      for all
      using (
        exists (
          select 1 from public.recipes r
          where r.id = recipe_ingredients.recipe_id
            and r.created_by_profile_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1 from public.recipes r
          where r.id = recipe_ingredients.recipe_id
            and r.created_by_profile_id = auth.uid()
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'saved_recipes'
      and policyname = 'Users can manage own saved recipes'
  ) then
    create policy "Users can manage own saved recipes"
      on public.saved_recipes
      for all
      using (profile_id = auth.uid())
      with check (profile_id = auth.uid());
  end if;
end
$$;
