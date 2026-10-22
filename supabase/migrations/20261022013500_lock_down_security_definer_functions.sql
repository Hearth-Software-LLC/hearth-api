-- These SECURITY DEFINER functions trust caller-supplied ids (p_requester_id, p_profile_id, ...),
-- so they must not be callable through PostgREST by anon or signed-in users. hearth-api calls
-- them with the service role, which keeps EXECUTE. Trigger functions don't need EXECUTE to fire.
do $$
declare fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prosecdef
      and p.proname in (
        'accept_household_invitation',
        'effective_profile_id',
        'increment_ai_usage',
        'remove_household_member',
        'rename_custom_recipe_tag',
        'rls_auto_enable',
        'set_subscription_revenuecat_user_id'
      )
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;
