-- PR5.5: atomic usage increments for concurrent AI requests

create or replace function public.increment_ai_usage(
  p_profile_id uuid,
  p_month_key text,
  p_feature text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.ai_usage (
    profile_id,
    month_key,
    meal_plan_count,
    grocery_list_count,
    created_at,
    updated_at
  )
  values (
    p_profile_id,
    p_month_key,
    case when p_feature = 'meal_plan' then 1 else 0 end,
    case when p_feature = 'grocery_list' then 1 else 0 end,
    now(),
    now()
  )
  on conflict (profile_id, month_key)
  do update
    set meal_plan_count = ai_usage.meal_plan_count + case when p_feature = 'meal_plan' then 1 else 0 end,
        grocery_list_count = ai_usage.grocery_list_count + case when p_feature = 'grocery_list' then 1 else 0 end,
        updated_at = now();
end;
$$;

grant execute on function public.increment_ai_usage(uuid, text, text) to anon, authenticated, service_role;
