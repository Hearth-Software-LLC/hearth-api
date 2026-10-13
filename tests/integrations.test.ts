import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { ApiError } from '../src/errors.js';

const config = readConfig({ LOGO_DEV_PUBLISHABLE_KEY: 'pk_test', USDA_API_KEY: 'usda-test-secret' });
const headers = { Authorization: 'Bearer test-token' };
const sample = {
  totalPages: 2,
  foods: [
    { fdcId: 123, description: 'Apple', dataType: 'Foundation', foodNutrients: [] },
    { fdcId: 456, description: 'Apple snack', dataType: 'Branded', brandOwner: 'Example Foods' },
  ],
};

function setup() {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(sample));
  const reserveQuota = vi.fn().mockResolvedValue(undefined);
  const verifyToken = vi.fn().mockResolvedValue('user-123');
  return { app: createApp({ config, verifyToken, reserveQuota, fetcher }), fetcher, reserveQuota };
}

afterEach(() => { vi.useRealTimers(); });

describe('Logo.dev URL resolution', () => {
  it('normalizes a domain and returns only a fixed-host image URL', async () => {
    const { app, fetcher, reserveQuota } = setup();
    const response = await app.request('/v1/brands/logo?domain=APPLE.COM&size=256&format=webp', { headers });
    expect(response.status).toBe(200);
    const body = await response.json();
    const url = new URL(body.url);
    expect(body.domain).toBe('apple.com');
    expect(url.origin).toBe('https://img.logo.dev');
    expect(url.pathname).toBe('/apple.com');
    expect(Object.fromEntries(url.searchParams)).toEqual({ token: 'pk_test', size: '256', format: 'webp', fallback: '404' });
    expect(reserveQuota).toHaveBeenCalledWith('user-123', 'logos');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    'domain=https://apple.com', 'domain=127.0.0.1', 'domain=localhost',
    'domain=apple.com%2Fsecret', 'domain=apple.com%40attacker.com',
    'domain=-invalid.com', 'domain=apple.com&size=513', 'domain=apple.com&format=svg',
  ])('rejects unsafe or unsupported parameters: %s', async (query) => {
    const { app, reserveQuota } = setup();
    expect((await app.request(`/v1/brands/logo?${query}`, { headers })).status).toBe(400);
    expect(reserveQuota).not.toHaveBeenCalled();
  });
});

describe('USDA food search', () => {
  it('maps validated summaries and keeps credentials server-side', async () => {
    const { app, fetcher, reserveQuota } = setup();
    const response = await app.request('/v1/foods/search?q=apple&limit=2', { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [
        { id: 'usda:123', name: 'Apple', dataType: 'Foundation', brand: null, provider: 'usda' },
        { id: 'usda:456', name: 'Apple snack', brand: 'Example Foods', provider: 'usda' },
      ],
      nextCursor: '2', attribution: 'USDA FoodData Central', fetchedAt: expect.any(String),
    });
    expect(reserveQuota).toHaveBeenCalledWith('user-123', 'foods');
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://api.nal.usda.gov/fdc/v1/foods/search?api_key=usda-test-secret');
    expect(options?.redirect).toBe('error');
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(options?.body))).toEqual({ query: 'apple', pageSize: 2, pageNumber: 1 });
  });

  it('uses a bounded next-page cursor and stops at the last page', async () => {
    const { app, fetcher } = setup();
    const response = await app.request('/v1/foods/search?q=apple&cursor=2', { headers });
    expect((await response.json()).nextCursor).toBeNull();
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).pageNumber).toBe(2);
  });

  it.each(['q=', 'q=apple&limit=26', 'q=apple&cursor=0', 'q=apple&cursor=1000', 'q=apple&cursor=https://attacker.com'])('rejects invalid queries: %s', async (query) => {
    const { app, fetcher, reserveQuota } = setup();
    expect((await app.request(`/v1/foods/search?${query}`, { headers })).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    expect(reserveQuota).not.toHaveBeenCalled();
  });

  it.each([429, 500, 401])('sanitizes provider errors: %s', async (status) => {
    const { app, fetcher } = setup();
    fetcher.mockResolvedValue(new Response('usda-test-secret', { status }));
    const response = await app.request('/v1/foods/search?q=apple', { headers });
    expect(response.status).toBe(status === 429 ? 503 : 502);
    expect(await response.text()).not.toContain('usda-test-secret');
    if (status === 429) expect(response.headers.get('Retry-After')).toBe('3600');
  });

  it.each([{}, { totalPages: 1, foods: [{ fdcId: '123' }] }, { totalPages: 1, foods: null }])('rejects schema drift: %j', async (payload) => {
    const { app, fetcher } = setup();
    fetcher.mockResolvedValue(Response.json(payload));
    const response = await app.request('/v1/foods/search?q=apple', { headers });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'UPSTREAM_INVALID_RESPONSE' } });
  });

  it('rejects invalid JSON', async () => {
    const { app, fetcher } = setup();
    fetcher.mockResolvedValue(new Response('not-json'));
    const response = await app.request('/v1/foods/search?q=apple', { headers });
    expect(response.status).toBe(502);
  });

  it('enforces the response size limit even without a Content-Length header', async () => {
    const { app, fetcher } = setup();
    fetcher.mockResolvedValue(new Response('x'.repeat(1_048_577)));
    const response = await app.request('/v1/foods/search?q=apple', { headers });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'UPSTREAM_INVALID_RESPONSE' } });
  });

  it('does not leak network exception details', async () => {
    const { app, fetcher } = setup();
    fetcher.mockRejectedValue(new Error('request failed: usda-test-secret'));
    const response = await app.request('/v1/foods/search?q=apple', { headers });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('usda-test-secret');
  });

  it('enforces the upstream deadline', async () => {
    const { app, fetcher } = setup();
    const timedOut = AbortSignal.abort(new DOMException('Timeout', 'TimeoutError'));
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(timedOut);
    fetcher.mockRejectedValue(timedOut.reason);
    try {
      const response = await app.request('/v1/foods/search?q=apple', { headers });
      expect(response.status).toBe(504);
      expect(await response.json()).toMatchObject({ error: { code: 'UPSTREAM_TIMEOUT' } });
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('provider access gates', () => {
  it('blocks unauthenticated provider access before any quota or provider call', async () => {
    const { app, fetcher, reserveQuota } = setup();
    expect((await app.request('/v1/foods/search?q=apple')).status).toBe(401);
    expect((await app.request('/v1/brands/logo?domain=apple.com')).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
    expect(reserveQuota).not.toHaveBeenCalled();
  });

  it('blocks provider calls when quota is exhausted', async () => {
    const { app, fetcher, reserveQuota } = setup();
    reserveQuota.mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'Too many requests', 30));
    const response = await app.request('/v1/foods/search?q=apple', { headers });
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails closed if shared quota storage is not configured', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const app = createApp({ config, verifyToken: async () => 'user-123', fetcher });
    const response = await app.request('/v1/foods/search?q=apple', { headers });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'QUOTA_NOT_CONFIGURED' } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails closed if provider credentials are not configured', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const app = createApp({ config: readConfig({}), verifyToken: async () => 'user-123', fetcher });
    for (const path of ['/v1/foods/search?q=apple', '/v1/brands/logo?domain=apple.com']) {
      const response = await app.request(path, { headers });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'PROVIDER_NOT_CONFIGURED' } });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});