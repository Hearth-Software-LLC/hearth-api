-- Hearth Ship's social pages, part 2: where post media lives, and the job that publishes
-- scheduled posts and syncs comments and numbers.
--
-- Media: a private Storage bucket. Hearth Ship uploads to a signed upload URL from
-- POST /v1/social/media; Meta fetches each file from a signed URL when the post goes out.
--
-- The job: pg_cron calls GET /internal/social/cron every 5 minutes (Vercel's own cron runs only
-- daily on this plan), with the API's CRON_SECRET from Vault. Add the secret once, in the SQL
-- editor, with the same value as the API's CRON_SECRET:
--
--   select vault.create_secret('<CRON_SECRET>', 'hearth_api_cron_secret');
--
-- Until it's there the job's calls are refused (401) and nothing happens.

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public)
    values ('social-media', 'social-media', false)
    on conflict (id) do nothing;
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_extension where extname = 'pg_net') then
    perform cron.schedule(
      'hearth_social_every_5_minutes',
      '*/5 * * * *',
      $job$
        select net.http_get(
          url := 'https://api.hearthapps.com/internal/social/cron',
          headers := jsonb_build_object('Authorization', 'Bearer ' || coalesce(
            (select decrypted_secret from vault.decrypted_secrets where name = 'hearth_api_cron_secret'), '')),
          timeout_milliseconds := 60000
        );
      $job$
    );
  end if;
end
$$;
