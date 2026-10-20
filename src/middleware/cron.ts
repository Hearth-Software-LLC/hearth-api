import { timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';
import { ApiError } from '../errors.js';

/**
 * Scheduled jobs (Vercel Cron) live outside /v1, so no user token is needed. Vercel sends
 * `Authorization: Bearer <CRON_SECRET>`; anything else is a 401, and so is every call while
 * CRON_SECRET isn't set.
 */
export function requireCronSecret(config: Config, authorization: string | undefined) {
  const expected = config.CRON_SECRET;
  const given = authorization ?? '';
  const valid = expected !== undefined && given.length === expected.length + 7
    && timingSafeEqual(Buffer.from(given), Buffer.from(`Bearer ${expected}`));
  if (!valid) throw new ApiError(401, 'UNAUTHORIZED', 'A valid bearer token is required');
}
