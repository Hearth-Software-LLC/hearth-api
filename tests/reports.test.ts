import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import type { ReportStore } from '../src/services/reports.js';

function setup(created: string | null = '7d5a2f0e-3a1b-4c55-9b7e-0d9f6f1c2a10') {
  const store = { create: vi.fn().mockResolvedValue(created), removeByReporter: vi.fn() } satisfies ReportStore;
  const app = createApp({
    config: readConfig({}),
    verifyToken: async (token) => ({ userId: 'user-1', isAnonymous: token === 'anonymous' }),
    reports: store,
  });
  const report = (body: unknown, token = 'apple', contentType = 'application/json') => app.request('/v1/reports', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { store, report };
}

const valid = {
  app: 'hearken', kind: 'comment', targetId: '0f7b6f2e-9c1d-4f7a-8f43-2a1d3c4b5e6f',
  groupId: '5b0b8f1e-2d3c-4a5b-9c8d-7e6f5a4b3c2d', reason: 'harassment', details: '  Keeps posting this.  ',
};

describe('POST /v1/reports', () => {
  it('stores a report for the verified caller', async () => {
    const { store, report } = setup();
    const response = await report(valid);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: '7d5a2f0e-3a1b-4c55-9b7e-0d9f6f1c2a10' });
    expect(store.create).toHaveBeenCalledWith('user-1', {
      app: 'hearken', kind: 'comment', targetId: valid.targetId, groupId: valid.groupId, reason: 'harassment', details: 'Keeps posting this.',
    });
  });

  it('takes a BigTable report without a group or details', async () => {
    const { store, report } = setup();
    const response = await report({ app: 'bigtable', kind: 'recipe', targetId: 'recipe-1', reason: 'spam' });
    expect(response.status).toBe(201);
    expect(store.create).toHaveBeenCalledWith('user-1', expect.objectContaining({ groupId: null, details: null }));
  });

  it('refuses anonymous sessions', async () => {
    const { store, report } = setup();
    const response = await report(valid, 'anonymous');
    expect(response.status).toBe(401);
    expect(store.create).not.toHaveBeenCalled();
  });

  it.each([
    { ...valid, app: 'sated' },
    { ...valid, kind: 'household' },
    { ...valid, reason: 'boring' },
    { ...valid, targetId: '' },
    { ...valid, groupId: 'not-a-uuid' },
    { ...valid, details: 'x'.repeat(1001) },
    { ...valid, reporterId: 'someone-else' },
  ])('rejects an invalid report: %j', async (body) => {
    const { store, report } = setup();
    expect((await report(body)).status).toBe(400);
    expect(store.create).not.toHaveBeenCalled();
  });

  it('needs a JSON body', async () => {
    const { report } = setup();
    expect((await report(valid, 'apple', 'text/plain')).status).toBe(400);
  });

  it('answers 429 past the daily limit', async () => {
    const { report } = setup(null);
    const response = await report(valid);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(response.headers.get('Retry-After')).toBe('3600');
  });

  it('answers 503 without storage', async () => {
    const app = createApp({ config: readConfig({}), verifyToken: async () => ({ userId: 'user-1', isAnonymous: false }) });
    const response = await app.request('/v1/reports', {
      method: 'POST', headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' }, body: JSON.stringify(valid),
    });
    expect(response.status).toBe(503);
  });
});
