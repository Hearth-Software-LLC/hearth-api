import { z } from 'zod';
import type { Config } from '../config.js';
import { ApiError } from '../errors.js';

/**
 * Where bank connections live: one row per Plaid item with its owner (the verified JWT
 * subject), the institution's name and the sealed access token. That's all the API stores:
 * transactions and balances pass through to the app and are never saved here.
 *
 * Backed by Supabase's REST API with a server-only secret key; the table has row-level
 * security on and no policies, so app-facing keys can't read it.
 */
export type StoredConnection = { itemId: string; institution: string; sealedToken: string; createdAt: string };

export type ConnectionStore = {
  save: (ownerId: string, connection: Omit<StoredConnection, 'createdAt'>) => Promise<void>;
  get: (ownerId: string, itemId: string) => Promise<StoredConnection | undefined>;
  list: (ownerId: string) => Promise<Omit<StoredConnection, 'sealedToken'>[]>;
  remove: (ownerId: string, itemId: string) => Promise<void>;
};

const rowSchema = z.object({
  item_id: z.string(),
  institution: z.string(),
  access_token_sealed: z.string().optional(),
  created_at: z.string(),
});

export function createConnectionStore(config: Config, fetcher: typeof fetch = fetch): ConnectionStore | undefined {
  if (!config.SUPABASE_URL || !config.SUPABASE_SECRET_KEY) return undefined;
  const table = new URL('/rest/v1/plaid_connections', config.SUPABASE_URL).toString();
  const key = config.SUPABASE_SECRET_KEY;
  // New-style secret keys (sb_secret_…) go in `apikey` only; legacy service_role JWTs also
  // go in Authorization.
  const headers: Record<string, string> = key.startsWith('sb_')
    ? { apikey: key }
    : { apikey: key, Authorization: `Bearer ${key}` };

  async function call(query: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await fetcher(`${table}?${query}`, {
        ...init,
        headers: { ...headers, Accept: 'application/json', ...(init.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
    } catch {
      throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Bank connections are temporarily unavailable');
    }
    if (!response.ok) throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Bank connections are temporarily unavailable');
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }

  const eq = (value: string) => `eq.${encodeURIComponent(value)}`;

  return {
    async save(ownerId, connection) {
      await call('on_conflict=item_id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          item_id: connection.itemId,
          owner_id: ownerId,
          institution: connection.institution,
          access_token_sealed: connection.sealedToken,
          updated_at: new Date().toISOString(),
        }),
      });
    },
    async get(ownerId, itemId) {
      const rows = z.array(rowSchema).safeParse(await call(
        `select=item_id,institution,access_token_sealed,created_at&owner_id=${eq(ownerId)}&item_id=${eq(itemId)}&limit=1`,
      ));
      if (!rows.success) throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Bank connections are temporarily unavailable');
      const row = rows.data[0];
      if (!row?.access_token_sealed) return undefined;
      return { itemId: row.item_id, institution: row.institution, sealedToken: row.access_token_sealed, createdAt: row.created_at };
    },
    async list(ownerId) {
      const rows = z.array(rowSchema).safeParse(await call(
        `select=item_id,institution,created_at&owner_id=${eq(ownerId)}&order=created_at.asc`,
      ));
      if (!rows.success) throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Bank connections are temporarily unavailable');
      return rows.data.map((row) => ({ itemId: row.item_id, institution: row.institution, createdAt: row.created_at }));
    },
    async remove(ownerId, itemId) {
      await call(`owner_id=${eq(ownerId)}&item_id=${eq(itemId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    },
  };
}
