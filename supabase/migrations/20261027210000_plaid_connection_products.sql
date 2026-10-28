-- What each Plaid item was linked for: bank transactions (every item until now) or a
-- brokerage's investments. Suffice uses it to show an item under Accounts or Investments.

alter table public.plaid_connections
  add column if not exists products text[] not null default '{transactions}';

alter table public.plaid_connections
  drop constraint if exists plaid_connections_products_check;
alter table public.plaid_connections
  add constraint plaid_connections_products_check
  check (products <@ array['transactions', 'investments']::text[] and cardinality(products) > 0);
