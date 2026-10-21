import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import type { HearkenService } from '../src/hearken/service.js';
import type { PlaidDataClient } from '../src/integrations/plaid.js';
import type { ConnectionStore } from '../src/services/connections.js';
import type { ReportStore } from '../src/services/reports.js';

// DELETE /v1/me: one deletion for every Hearth app. Supabase and RevenueCat are mocked; Hearken,
// Plaid and the report store are injected.
const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  deleteUser: vi.fn(),
  listAvatars: vi.fn(),
  removeAvatars: vi.fn(),
  rpc: vi.fn(),
  deleteRevenueCatSubscriber: vi.fn(),
  insertNotification: vi.fn(),
  deletePushTokens: vi.fn(),
  state: { managesMembers: false, organizerId: null as string | null, tier: 'free' },
}));

vi.mock('../src/services/supabase.js', () => ({
  supabaseAdmin: {
    from: mocks.from,
    rpc: mocks.rpc,
    storage: { from: () => ({ list: mocks.listAvatars, remove: mocks.removeAvatars }) },
    auth: { admin: { deleteUser: mocks.deleteUser } },
  },
}));
vi.mock('../src/services/revenuecat.js', () => ({
  deleteRevenueCatSubscriber: mocks.deleteRevenueCatSubscriber,
  ensureRevenueCatSubscriber: vi.fn(),
}));
vi.mock('../src/bigtable/lib/notifications.js', () => ({ insertNotification: mocks.insertNotification }));

function table(name: string) {
  if (name === 'household_memberships') {
    return {
      select: () => ({
        eq: (column: string) => column === 'organizer_id'
          ? { limit: () => ({ maybeSingle: async () => ({ data: mocks.state.managesMembers ? { member_id: 'someone' } : null, error: null }) }) }
          : { maybeSingle: async () => ({ data: mocks.state.organizerId ? { organizer_id: mocks.state.organizerId } : null, error: null }) },
      }),
    };
  }
  if (name === 'subscriptions') {
    return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { tier: mocks.state.tier, revenuecat_user_id: null }, error: null }) }) }) };
  }
  if (name === 'profiles') {
    return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'user-1', household_name: 'Jensens' }, error: null }) }) }) };
  }
  if (name === 'push_tokens') {
    return { delete: () => ({ eq: mocks.deletePushTokens }) };
  }
  throw new Error(`Unexpected table: ${name}`);
}

const plaidError = (code: string) => Object.assign(new Error(code), { response: { status: 400, data: { error_code: code } } });

function setup(options: { connections?: string[] } = {}) {
  const purgeUser = vi.fn().mockResolvedValue(undefined);
  const removeItem = vi.fn<PlaidDataClient['removeItem']>().mockResolvedValue({});
  const items = options.connections ?? ['item-1', 'item-2'];
  const connectionStore = {
    save: vi.fn(),
    list: vi.fn(async () => items.map((itemId) => ({ itemId, institution: 'Bank', createdAt: '2026-10-01T00:00:00Z' }))),
    get: vi.fn(async (_owner: string, itemId: string) => ({ itemId, institution: 'Bank', sealedToken: `sealed-${itemId}`, createdAt: '2026-10-01T00:00:00Z' })),
    remove: vi.fn().mockResolvedValue(undefined),
  } satisfies ConnectionStore;
  const reports = { create: vi.fn(), removeByReporter: vi.fn().mockResolvedValue(undefined) } satisfies ReportStore;
  const app = createApp({
    config: readConfig({}),
    verifyToken: async (token) => ({ userId: token === 'anonymous' ? 'anon-1' : 'user-1', isAnonymous: token === 'anonymous' }),
    hearken: { purgeUser } as unknown as HearkenService,
    plaidDataClient: { removeItem } as unknown as PlaidDataClient,
    connectionStore,
    tokenSeal: { seal: vi.fn(), open: (sealed: string) => sealed.replace('sealed-', 'token-') },
    reports,
  });
  const call = (token = 'apple') => app.request('/v1/me', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  return { call, purgeUser, removeItem, connectionStore, reports };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.state.managesMembers = false;
  mocks.state.organizerId = null;
  mocks.state.tier = 'free';
  mocks.from.mockImplementation(table);
  mocks.deleteUser.mockResolvedValue({ error: null });
  mocks.listAvatars.mockResolvedValue({ data: [], error: null });
  mocks.removeAvatars.mockResolvedValue({ error: null });
  mocks.deletePushTokens.mockResolvedValue({ error: null });
  mocks.deleteRevenueCatSubscriber.mockResolvedValue(undefined);
  vi.stubEnv('REVENUECAT_SECRET_API_KEY', 'sk_test');
  vi.stubEnv('REVENUECAT_PROJECT_ID', 'proj_test');
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('DELETE /v1/me', () => {
  it('deletes the account in every app', async () => {
    const { call, purgeUser, removeItem, connectionStore, reports } = setup();
    const response = await call();
    expect(response.status).toBe(204);
    expect(purgeUser).toHaveBeenCalledWith('user-1');
    expect(reports.removeByReporter).toHaveBeenCalledWith('user-1');
    expect(removeItem).toHaveBeenCalledTimes(2);
    expect(removeItem).toHaveBeenCalledWith('token-item-1', expect.any(AbortSignal));
    expect(connectionStore.remove).toHaveBeenCalledWith('user-1', 'item-1');
    expect(connectionStore.remove).toHaveBeenCalledWith('user-1', 'item-2');
    // Whatever the tier.
    expect(mocks.deleteRevenueCatSubscriber).toHaveBeenCalledWith('user-1');
    expect(mocks.deletePushTokens).toHaveBeenCalledWith('profile_id', 'user-1');
    expect(mocks.deleteUser).toHaveBeenCalledWith('user-1');
    expect(mocks.deleteUser.mock.invocationCallOrder[0]).toBeGreaterThan(removeItem.mock.invocationCallOrder[1]!);
  });

  it('refuses while the caller runs a household with other people, deleting nothing', async () => {
    mocks.state.managesMembers = true;
    const { call, purgeUser, removeItem } = setup();
    const response = await call();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'HOUSEHOLD_HAS_MEMBERS' } });
    expect(purgeUser).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });

  it('forgets a bank Plaid no longer knows', async () => {
    const { call, removeItem, connectionStore } = setup({ connections: ['item-1'] });
    removeItem.mockRejectedValueOnce(plaidError('ITEM_NOT_FOUND'));
    expect((await call()).status).toBe(204);
    expect(connectionStore.remove).toHaveBeenCalledWith('user-1', 'item-1');
  });

  it('keeps the account when Plaid fails', async () => {
    const { call, removeItem, connectionStore } = setup({ connections: ['item-1'] });
    removeItem.mockRejectedValueOnce(Object.assign(new Error('down'), { response: { status: 500, data: { error_code: 'INTERNAL_SERVER_ERROR' } } }));
    const response = await call();
    expect(response.status).toBe(502);
    expect(connectionStore.remove).not.toHaveBeenCalled();
    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });

  it('keeps the account when RevenueCat fails, in the API error shape', async () => {
    mocks.deleteRevenueCatSubscriber.mockRejectedValueOnce(new Error('RevenueCat 500'));
    const { call } = setup({ connections: [] });
    const response = await call();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toMatchObject({ code: 'ACCOUNT_DELETION_FAILED', requestId: expect.any(String) });
    expect(JSON.stringify(body)).not.toContain('RevenueCat 500');
    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });

  it('tells a household organizer when a member deletes their account', async () => {
    mocks.state.organizerId = 'organizer-1';
    const { call } = setup({ connections: [] });
    expect((await call()).status).toBe(204);
    expect(mocks.insertNotification).toHaveBeenCalledWith(expect.objectContaining({
      recipientProfileId: 'organizer-1', type: 'household_member_left',
    }));
  });

  it('only deletes the auth user for an anonymous session', async () => {
    const { call, purgeUser, removeItem } = setup();
    expect((await call('anonymous')).status).toBe(204);
    expect(mocks.deleteUser).toHaveBeenCalledWith('anon-1');
    expect(purgeUser).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('needs a token', async () => {
    const { purgeUser } = setup();
    const app = createApp({ config: readConfig({}), verifyToken: async () => 'user-1' });
    expect((await app.request('/v1/me', { method: 'DELETE' })).status).toBe(401);
    expect(purgeUser).not.toHaveBeenCalled();
  });
});

describe('GET /internal/bigtable/cron', () => {
  const supabase = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_0123456789abcdef' };

  it('runs the moved-kitchen purge with the service role, behind CRON_SECRET', async () => {
    mocks.rpc.mockResolvedValue({ data: 3, error: null });
    const app = createApp({ config: readConfig({ ...supabase, CRON_SECRET: 'cron-secret-0123456789' }) });
    expect((await app.request('/internal/bigtable/cron')).status).toBe(401);
    expect((await app.request('/internal/bigtable/cron', { headers: { Authorization: 'Bearer wrong-secret-0123456789' } })).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
    const response = await app.request('/internal/bigtable/cron', { headers: { Authorization: 'Bearer cron-secret-0123456789' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ purgedKitchens: 3 });
    expect(mocks.rpc).toHaveBeenCalledWith('bigtable_purge_moved_kitchens');
  });

  it('refuses every call while CRON_SECRET is unset', async () => {
    const app = createApp({ config: readConfig(supabase), purgeMovedKitchens: vi.fn() });
    expect((await app.request('/internal/bigtable/cron', { headers: { Authorization: 'Bearer ' } })).status).toBe(401);
  });

  it('answers 503 when the purge fails', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '42883', message: 'function does not exist' } });
    const app = createApp({ config: readConfig({ ...supabase, CRON_SECRET: 'cron-secret-0123456789' }) });
    const response = await app.request('/internal/bigtable/cron', { headers: { Authorization: 'Bearer cron-secret-0123456789' } });
    expect(response.status).toBe(503);
  });
});
