import postgres from 'postgres';
import type { Sql } from 'postgres';

/**
 * The Postgres connection study groups use. Connects on first query, so the API still starts
 * when the database is down. Prepared statements are off because Supabase's transaction pooler
 * (the serverless-friendly port, 6543) doesn't keep them between transactions.
 */
export function createDatabase(url: string): Sql {
  return postgres(url, {
    max: 3,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 5,
    onnotice: () => undefined,
    connection: { application_name: 'hearth-api' },
  });
}
