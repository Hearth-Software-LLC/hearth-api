import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('API foundation', () => {
  it('returns liveness with a server-generated request ID', async () => {
    const response = await createApp().request('/health', {
      headers: { 'X-Request-ID': 'untrusted-client-value' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(response.headers.get('X-Request-ID')).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns consistent JSON for unknown routes', async () => {
    const response = await createApp().request('/missing');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: 'RESOURCE_NOT_FOUND',
        message: 'Route not found',
        requestId: response.headers.get('X-Request-ID'),
      },
    });
  });

  it('publishes the API contract', async () => {
    const response = await createApp().request('/openapi.json');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      openapi: '3.0.0',
      paths: { '/health': { get: { responses: { '200': expect.any(Object) } } } },
    });
  });

  it('does not expose unexpected error details', async () => {
    const app = createApp();
    app.get('/failure', () => { throw new Error('provider-secret'); });
    const response = await app.request('/failure');
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('provider-secret');
  });

  it('logs matched routes, not credentials or query strings', async () => {
    const records: unknown[] = [];
    const app = createApp({ logger: (record) => { records.push(record); } });
    await app.request('/health?api_key=private-secret', {
      headers: { Authorization: 'Bearer private-token' },
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ route: '/health', method: 'GET', status: 200 });
    expect(JSON.stringify(records)).not.toContain('private-secret');
    expect(JSON.stringify(records)).not.toContain('private-token');
  });
});