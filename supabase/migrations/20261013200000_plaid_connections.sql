-- Bank connections made through Plaid. The only thing the Lifestyle API stores for banking:
-- who connected which Plaid item, the institution's name, and the item's access token,
-- sealed with AES-256-GCM by the API (the key is in the API's environment, not here).
-- Transactions and balances are never stored server-side.

create table if not exists public.plaid_connections (
  item_id text primary key,
  owner_id text not null,
  institution text not null default '',
  access_token_sealed text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists plaid_connections_owner_id_idx on public.plaid_connections (owner_id);

-- Only the API's secret key may touch this table: row-level security on, no policies, and no
-- grants for the app-facing roles.
alter table public.plaid_connections enable row level security;
revoke all on table public.plaid_connections from anon, authenticated;

comment on table public.plaid_connections is
  'Plaid items per user. Access tokens are sealed by lifestyle-api; never readable by app keys.';
