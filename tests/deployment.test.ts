import { describe, expect, it } from 'vitest';
import app from '../src/index.js';

describe('Vercel entry point', () => {
  it('serves the same health route at the root path', async () => {
    const response = await app.request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('preserves authentication on mounted routes', async () => {
    const response = await app.request('/v1/foods/search?q=apple');
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('preserves JSON errors for unmatched paths', async () => {
    const response = await app.request('/missing');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: 'RESOURCE_NOT_FOUND', requestId: response.headers.get('X-Request-ID') },
    });
  });

  it('publishes protected route schemas and bearer security', async () => {
    const response = await app.request('/openapi.json');
    const document = await response.json();
    expect(document.paths['/v1/foods/search'].get.security).toEqual([{ BearerAuth: [] }]);
    expect(document.paths['/v1/brands/logo'].get.responses['400']).toBeDefined();
    expect(document.components.securitySchemes.BearerAuth).toEqual({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
  });
});