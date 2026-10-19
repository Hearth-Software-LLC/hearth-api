import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import type { EffectiveEntitlement } from '../src/bigtable/lib/entitlements.js';
import type { HearkenService } from '../src/hearken/service.js';
import type { ReserveQuota } from '../src/services/quota.js';

const headers = { Authorization: 'Bearer test-token' };
const json = { ...headers, 'Content-Type': 'application/json' };

function setup(enforce: boolean, entitlements: EffectiveEntitlement[]) {
  const source = vi.fn(async (_userId: string) => entitlements);
  const reserveQuota = vi.fn<ReserveQuota>(async () => undefined);
  const hearken = {
    createGroup: vi.fn(async () => ({ id: 'group-1' })),
    join: vi.fn(async () => ({ id: 'group-1' })),
    previewInvite: vi.fn(async () => ({ groupId: 'group-1' })),
  } as unknown as HearkenService;
  const app = createApp({
    config: readConfig(enforce ? { ENFORCE_ENTITLEMENTS: 'true' } : {}),
    verifyToken: async () => 'user-42',
    reserveQuota,
    entitlements: source,
    hearken,
  });
  return { app, source, hearken };
}

const groupBody = {
  name: 'Jensen Family', symbol: 'house.fill', planId: 'bofm-90', startDate: '2026-08-30', displayName: 'Sarah Jensen', initials: 'SJ',
};

describe('ENFORCE_ENTITLEMENTS config', () => {
  it('defaults to off and parses true', () => {
    expect(readConfig({}).ENFORCE_ENTITLEMENTS).toBe(false);
    expect(readConfig({ ENFORCE_ENTITLEMENTS: 'true' }).ENFORCE_ENTITLEMENTS).toBe(true);
    expect(readConfig({ ENFORCE_ENTITLEMENTS: 'false' }).ENFORCE_ENTITLEMENTS).toBe(false);
    expect(() => readConfig({ ENFORCE_ENTITLEMENTS: 'yes' })).toThrow('ENFORCE_ENTITLEMENTS');
  });
});

describe('GET /v1/me/entitlements', () => {
  it('returns own and household entitlements with app access', async () => {
    const { app, source } = setup(false, [
      { id: 'hearth_plus', expiresAt: null, source: 'household' },
      { id: 'suffice_plus', expiresAt: '2026-11-19T12:00:00.000Z', source: 'own' },
    ]);
    const response = await app.request('/v1/me/entitlements', { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      entitlements: [
        { id: 'hearth_plus', expiresAt: null, source: 'household' },
        { id: 'suffice_plus', expiresAt: '2026-11-19T12:00:00.000Z', source: 'own' },
      ],
      hearthPlus: true,
      apps: { bigtable: true, suffice: true, sated: true, caloma: true, hearken: true },
    });
    expect(source).toHaveBeenCalledWith('user-42');
  });

  it('reports only the apps a plan unlocks', async () => {
    const { app } = setup(false, [{ id: 'sated_plus', expiresAt: null, source: 'own' }]);
    const body = await (await app.request('/v1/me/entitlements', { headers })).json();
    expect(body.hearthPlus).toBe(false);
    expect(body.apps).toEqual({ bigtable: false, suffice: false, sated: true, caloma: false, hearken: false });
  });

  it('requires a token', async () => {
    const { app } = setup(false, []);
    expect((await app.request('/v1/me/entitlements')).status).toBe(401);
  });

  it('answers 503 when subscriptions cannot be read', async () => {
    const app = createApp({
      config: readConfig({}), verifyToken: async () => 'user-42',
      entitlements: async () => { throw new Error('db down'); },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await app.request('/v1/me/entitlements', { headers });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'ENTITLEMENTS_UNAVAILABLE' } });
  });

  it('is in the OpenAPI document', async () => {
    const { app } = setup(false, []);
    const document = await (await app.request('/openapi.json')).json();
    expect(document.paths['/v1/me/entitlements'].get.security).toEqual([{ BearerAuth: [] }]);
  });
});

describe('entitlement enforcement', () => {
  const routes = [
    { app: 'suffice', plan: 'Suffice Plus', request: ['/v1/banking/link-token', { method: 'POST', headers: json, body: '{}' }] },
    { app: 'sated', plan: 'Sated Plus', request: ['/v1/restaurants/menu?name=Chipotle', { headers }] },
    { app: 'hearken', plan: 'Hearken Plus', request: ['/v1/hearken/groups', { method: 'POST', headers: json, body: JSON.stringify(groupBody) }] },
  ] as const;

  for (const route of routes) {
    describe(route.request[0], () => {
      it('answers 402 naming the plan when enforced and the user has neither plan', async () => {
        const { app } = setup(true, [{ id: 'caloma_plus', expiresAt: null, source: 'own' }]);
        const response = await app.request(route.request[0], route.request[1] as RequestInit);
        expect(response.status).toBe(402);
        const body = await response.json();
        expect(body.error.code).toBe('ENTITLEMENT_REQUIRED');
        expect(body.error.message).toContain(`${route.plan} or Hearth+`);
      });

      it('lets the app\'s own plan through when enforced', async () => {
        const { app } = setup(true, [{ id: `${route.app}_plus` as EffectiveEntitlement['id'], expiresAt: null, source: 'own' }]);
        expect((await app.request(route.request[0], route.request[1] as RequestInit)).status).not.toBe(402);
      });

      it('lets a household organizer\'s Hearth+ through when enforced', async () => {
        const { app } = setup(true, [{ id: 'hearth_plus', expiresAt: null, source: 'household' }]);
        expect((await app.request(route.request[0], route.request[1] as RequestInit)).status).not.toBe(402);
      });

      it('changes nothing when not enforced', async () => {
        const { app, source } = setup(false, []);
        expect((await app.request(route.request[0], route.request[1] as RequestInit)).status).not.toBe(402);
        expect(source).not.toHaveBeenCalled();
      });
    });
  }

  it('gates bank connection creation and joining a study group too', async () => {
    const { app, hearken } = setup(true, []);
    const connect = await app.request('/v1/banking/connections', { method: 'POST', headers: json, body: JSON.stringify({ publicToken: 'public-sandbox-1' }) });
    expect(connect.status).toBe(402);
    const join = await app.request('/v1/hearken/invites/ABCD2345/join', { method: 'POST', headers: json, body: JSON.stringify({ displayName: 'Ben', initials: 'B' }) });
    expect(join.status).toBe(402);
    expect(hearken.join).not.toHaveBeenCalled();
    // Reading groups is never gated.
    expect((await app.request('/v1/hearken/invites/ABCD2345', { headers })).status).toBe(200);
  });

  it('creates a study group when not enforced', async () => {
    const { app, hearken } = setup(false, []);
    const response = await app.request('/v1/hearken/groups', { method: 'POST', headers: json, body: JSON.stringify(groupBody) });
    expect(response.status).toBe(201);
    expect(hearken.createGroup).toHaveBeenCalled();
  });
});
