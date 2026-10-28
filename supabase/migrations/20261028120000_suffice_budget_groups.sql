-- Suffice group budgets: a budget shared with people outside the household (a trip with friends,
-- a gift with siblings). Everything else in Suffice stays in iCloud; only what members share here
-- comes up: the group's name and plan, members' display names, and shared expenses (payee, amount,
-- date, who paid, an optional note) and settle-up payments. Never bank data.
--
-- Like the hk_* tables: only the API reads and writes these, over a direct Postgres connection
-- (DATABASE_URL). Row-level security is on with no policies and the app-facing roles have no
-- grants, so the Supabase REST and Realtime APIs can't reach them with a client key.
--
-- Members are Hearth account ids (the verified JWT subject). There are no foreign keys to
-- auth.users: deleting a Hearth account (DELETE /v1/me) deletes the groups the person owns and
-- removes their memberships elsewhere explicitly.
--
-- Expenses and settlements hang off the membership of the people in them, so removing a member
-- (leaving, being removed, account deletion) takes their expenses and any settlement to or from
-- them with it. Deleting a group takes everything in it.

begin;

create table public.sf_budget_groups (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  name text not null check (char_length(name) between 1 and 60),
  plan_cents integer not null check (plan_cents between 0 and 100000000),
  start_date date,
  end_date date,
  invite_code text not null unique check (invite_code ~ '^[A-Z2-9]{8}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (start_date is null or end_date is null or end_date >= start_date)
);
create index sf_budget_groups_owner on public.sf_budget_groups (owner_id);

create table public.sf_budget_members (
  group_id uuid not null references public.sf_budget_groups (id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('owner', 'member')),
  display_name text not null check (char_length(display_name) between 1 and 40),
  -- Opaque to the server: lets the app tell which members share a Suffice household.
  household_key text check (char_length(household_key) between 1 and 128),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index sf_budget_members_user on public.sf_budget_members (user_id);

create table public.sf_budget_expenses (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.sf_budget_groups (id) on delete cascade,
  -- The device's id for this expense: adding it again returns the same row.
  client_id uuid not null,
  paid_by uuid not null,
  payee text not null check (char_length(payee) between 1 and 120),
  amount_cents integer not null check (amount_cents between 1 and 100000000),
  date date not null,
  note text check (char_length(note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, paid_by, client_id),
  foreign key (group_id, paid_by) references public.sf_budget_members (group_id, user_id) on delete cascade
);
create index sf_budget_expenses_group_date on public.sf_budget_expenses (group_id, date desc, created_at desc);

create table public.sf_budget_settlements (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.sf_budget_groups (id) on delete cascade,
  client_id uuid not null,
  -- Who recorded it. Not a foreign key: a settlement between two others stays when its recorder leaves.
  created_by uuid not null,
  from_user_id uuid not null,
  to_user_id uuid not null,
  amount_cents integer not null check (amount_cents between 1 and 100000000),
  created_at timestamptz not null default now(),
  check (from_user_id <> to_user_id),
  unique (group_id, created_by, client_id),
  foreign key (group_id, from_user_id) references public.sf_budget_members (group_id, user_id) on delete cascade,
  foreign key (group_id, to_user_id) references public.sf_budget_members (group_id, user_id) on delete cascade
);
create index sf_budget_settlements_group_created on public.sf_budget_settlements (group_id, created_at desc);
create index sf_budget_settlements_from on public.sf_budget_settlements (group_id, from_user_id);
create index sf_budget_settlements_to on public.sf_budget_settlements (group_id, to_user_id);

do $$
declare
  t text;
begin
  foreach t in array array['sf_budget_groups', 'sf_budget_members', 'sf_budget_expenses', 'sf_budget_settlements'] loop
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
