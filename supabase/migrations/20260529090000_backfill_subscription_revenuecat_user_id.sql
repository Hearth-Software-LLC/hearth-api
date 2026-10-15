-- Ensure every subscription row has a RevenueCat user id.

update public.subscriptions
set revenuecat_user_id = profile_id::text
where revenuecat_user_id is null
   or btrim(revenuecat_user_id) = '';

create or replace function public.set_subscription_revenuecat_user_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.revenuecat_user_id is null or btrim(new.revenuecat_user_id) = '' then
    new.revenuecat_user_id := new.profile_id::text;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_set_subscription_revenuecat_user_id on public.subscriptions;

create trigger trg_set_subscription_revenuecat_user_id
before insert or update on public.subscriptions
for each row
execute function public.set_subscription_revenuecat_user_id();