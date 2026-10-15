import { beforeEach, describe, expect, it, vi } from 'vitest';

const fromMock = vi.fn();

vi.mock('../../src/bigtable/lib/supabase.js', () => ({
  supabaseAdmin: { from: fromMock },
}));

const { createApp } = await import('../../src/app.js');

function app() {
  return createApp({
    verifyToken: async (token) => {
      if (token === 'member-token') return { userId: 'user-1', isAnonymous: false };
      if (token === 'anonymous-token') return { userId: 'anon-1', isAnonymous: true };
      throw new Error('invalid');
    },
    logger: () => {},
  });
}

function publishedRecipeTable(found: boolean) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => ({
      data: found ? { id: 'recipe-1', title: 'Soup', description: null, image_url: null } : null,
      error: null,
    })),
  };
  return builder;
}

describe('BigTable routes on the Hearth API', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('mounts BigTable routes under /v1/bigtable and rejects missing tokens', async () => {
    const response = await app().request('/v1/bigtable/usage/check');
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');
    expect(await response.json()).toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
        requestId: response.headers.get('X-Request-ID'),
      },
    });
  });

  it('refuses anonymous sessions on BigTable routes', async () => {
    const response = await app().request('/v1/bigtable/notifications/unread-count', {
      headers: { Authorization: 'Bearer anonymous-token' },
    });
    expect(response.status).toBe(401);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('requires a signed-in user for place search', async () => {
    const response = await app().request('/v1/bigtable/places/search?q=pizza&latitude=40&longitude=-111');
    expect(response.status).toBe(401);
  });

  it('serves the public recipe preview without a token and keeps its CDN caching', async () => {
    fromMock.mockImplementation(() => publishedRecipeTable(true));
    const response = await app().request('/v1/bigtable/recipes/recipe-1/og');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'recipe-1', title: 'Soup', description: null, imageUrl: null });
    expect(response.headers.get('Cache-Control')).toContain('s-maxage=300');
    expect(response.headers.get('X-Request-ID')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('passes path parameters through and normalizes not-found errors', async () => {
    fromMock.mockImplementation(() => publishedRecipeTable(false));
    const response = await app().request('/v1/bigtable/recipes/missing/og');
    expect(response.status).toBe(404);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(body.error.message).toBe('Recipe not found');
  });

  it('keeps the shared suite routes behind the bearer middleware', async () => {
    const response = await app().request('/v1/me');
    expect(response.status).toBe(401);
    const signedIn = await app().request('/v1/me', { headers: { Authorization: 'Bearer member-token' } });
    expect(await signedIn.json()).toEqual({ id: 'user-1' });
  });

  it('accepts the RevenueCat webhook outside /v1 and rejects a bad secret', async () => {
    vi.stubEnv('REVENUECAT_WEBHOOK_SECRET', 'expected-secret');
    const response = await app().request('/webhooks/revenuecat', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: {} }),
    });
    expect(response.status).toBe(401);
    vi.unstubAllEnvs();
  });

  it('lists BigTable routes in the OpenAPI contract', async () => {
    const response = await app().request('/openapi.json');
    const contract = await response.json() as { info: { title: string }; paths: Record<string, Record<string, unknown>> };
    expect(contract.info.title).toBe('Hearth API');
    expect(contract.paths['/v1/bigtable/recipes/{id}']).toHaveProperty('patch');
    expect(contract.paths['/webhooks/revenuecat']).toHaveProperty('post');
    expect(contract.paths['/v1/banking/connections']).toBeDefined();
  });
});
