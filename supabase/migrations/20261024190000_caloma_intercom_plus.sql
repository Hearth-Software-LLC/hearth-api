-- Caloma intercom: calls away from home (the relay and TURN) are Hearth+. A device signed in
-- to an account with Hearth+ (its own, or its household's) marks its household's room until
-- the plan's expiry; 'infinity' for a plan that doesn't expire.
alter table public.caloma_intercom_devices
  add column if not exists plus_until timestamptz;
