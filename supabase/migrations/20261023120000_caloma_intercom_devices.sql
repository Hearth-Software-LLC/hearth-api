-- Caloma intercom: VoIP push tokens, so a call can wake a locked phone in the same household.
-- `room` is the SHA-256 of a secret only the household's devices know (derived from the
-- household's iCloud key); there are no accounts here. Only the API (service connection) reads
-- and writes this table, so RLS is on with no policies.
create table if not exists public.caloma_intercom_devices (
  room text not null check (room ~ '^[0-9a-f]{64}$'),
  device_id uuid not null,
  token text not null check (token ~ '^[0-9a-f]{64,200}$'),
  environment text not null check (environment in ('sandbox', 'production')),
  updated_at timestamptz not null default now(),
  primary key (room, device_id)
);

create index if not exists caloma_intercom_devices_token_idx on public.caloma_intercom_devices (token);

alter table public.caloma_intercom_devices enable row level security;
revoke all on public.caloma_intercom_devices from anon, authenticated;
