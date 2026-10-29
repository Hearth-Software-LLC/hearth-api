import { readFileSync } from 'node:fs';
import type postgres from 'postgres';

/** The social and Studio tables, from their migrations, in a scratch database. */
export const STUDIO_MIGRATIONS = [
  '20261029000000_social_pages.sql',
  '20261029000100_social_pages_media_and_cron.sql',
  '20261029100000_studio_team.sql',
  '20261029100100_studio_library.sql',
  '20261029120000_library_one_version.sql',
  '20261029180000_studio_member_avatars.sql',
  '20261029200000_affiliates_and_links.sql',
];

export const STUDIO_TABLES = [
  'asc_report_requests', 'campaign_stats_daily', 'link_taps_daily', 'campaign_links', 'affiliate_flags', 'affiliate_credits',
  'affiliate_payouts', 'affiliate_attributions', 'affiliate_invites', 'affiliate_codes', 'affiliates',
  'library_assets', 'library_runs', 'marketing_campaigns', 'store_designs',
  'social_metrics', 'social_comments', 'social_targets', 'social_posts', 'social_connections',
  'studio_devices', 'plan_grants_log', 'studio_invites', 'studio_members', 'studio_teams',
];

/**
 * Builds the tables, holding a lock until the returned release runs: the social and Studio test
 * files share them, and vitest runs files side by side.
 */
export async function migrate(sql: postgres.Sql): Promise<() => Promise<void>> {
  const lock = await sql.reserve();
  await lock`select pg_advisory_lock(4729)`;
  const release = async () => {
    await lock`select pg_advisory_unlock(4729)`.catch(() => undefined);
    lock.release();
  };
  await sql.unsafe(`drop table if exists ${STUDIO_TABLES.join(', ')} cascade`);
  await sql.unsafe('drop sequence if exists studio_change_seq cascade');
  const reserved = await sql.reserve();
  try {
    for (const file of STUDIO_MIGRATIONS) {
      await reserved.unsafe(readFileSync(new URL(`../../supabase/migrations/${file}`, import.meta.url), 'utf8'));
    }
  } finally {
    reserved.release();
  }
  return release;
}

/** Empties everything but the team row the migration made. */
export async function reset(sql: postgres.Sql) {
  await sql.unsafe(`truncate ${STUDIO_TABLES.filter((table) => table !== 'studio_teams').join(', ')} cascade`);
  await sql`update studio_teams set keep_runs = 2`;
}
