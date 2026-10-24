-- Caloma intercom broadcasts: an ordinary notification token beside the VoIP one, so devices
-- off the network hear that someone is broadcasting.
alter table public.caloma_intercom_devices
  add column if not exists alert_token text check (alert_token ~ '^[0-9a-f]{64,200}$');
