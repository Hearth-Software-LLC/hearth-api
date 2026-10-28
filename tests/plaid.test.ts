import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaidApi } from 'plaid';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { ApiError } from '../src/errors.js';
import { createPlaidLinkClient } from '../src/integrations/plaid.js';
import type { CreateLinkToken } from '../src/integrations/plaid.js';

const environment = {
  PLAID_CLIENT_ID: 'test-client-id',
  PLAID_SECRET: 'test-plaid-secret',
  PLAID_PRODUCTS: 'transactions',
  PLAID_REDIRECT_URI: 'https://app.example.com/plaid/',
};
const config = readConfig(environment);
const path = '/v1/banking/link-token';
const request = { method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, body: '{}' };

function setup() {
  const plaidLinkClient = vi.fn<CreateLinkToken>().mockResolvedValue({
    link_token: 'link-sandbox-test',
    expiration: new Date(Date.now() + 3_600_000).toISOString(),
    request_id: 'plaid-request-123',
    access_token: 'must-not-be-returned',
  });
  const reserveQuota = vi.fn().mockResolvedValue(undefined);
  const logs: unknown[] = [];
  const app = createApp({ config, verifyToken: async () => 'verified-user-123', reserveQuota, plaidLinkClient, logger: (record) => { logs.push(record); } });
  return { app, plaidLinkClient, reserveQuota, logs };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('Plaid Link-token creation', () => {
  it('creates a token using verified identity and server options', async () => {
    const { app, plaidLinkClient, reserveQuota, logs } = setup();
    const response = await app.request(path, request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ linkToken: 'link-sandbox-test', expiresAt: expect.any(String), plaidRequestId: 'plaid-request-123' });
    expect(plaidLinkClient).toHaveBeenCalledWith({
      user: { client_user_id: 'verified-user-123' },
      client_name: 'Hearth', products: ['transactions'], country_codes: ['US'], language: 'en',
      redirect_uri: 'https://app.example.com/plaid/',
    }, expect.any(AbortSignal));
    expect(reserveQuota).toHaveBeenCalledWith('verified-user-123', 'plaid-link');
    expect(reserveQuota.mock.invocationCallOrder[0]).toBeLessThan(plaidLinkClient.mock.invocationCallOrder[0]!);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(JSON.stringify(logs)).not.toMatch(/link-sandbox-test|test-plaid-secret|test-token|verified-user-123/);
  });


  it('rejects anonymous users before quota and provider access', async () => {
    const plaidLinkClient = vi.fn<CreateLinkToken>();
    const reserveQuota = vi.fn().mockResolvedValue(undefined);
    const app = createApp({
      config,
      verifyToken: async () => ({ userId: 'anonymous-user', isAnonymous: true }),
      reserveQuota,
      plaidLinkClient,
    });
    const response = await app.request(path, request);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'REGISTERED_IDENTITY_REQUIRED' } });
    expect(plaidLinkClient).not.toHaveBeenCalled();
    expect(reserveQuota).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated calls before quota and provider access', async () => {
    const { app, plaidLinkClient, reserveQuota } = setup();
    expect((await app.request(path, { ...request, headers: { 'Content-Type': 'application/json' } })).status).toBe(401);
    expect(plaidLinkClient).not.toHaveBeenCalled();
    expect(reserveQuota).not.toHaveBeenCalled();
  });

  it.each([
    '{"userId":"attacker"}', '{"products":["auth"]}', '{"secret":"client-secret"}',
    '{"redirect_uri":"https://attacker.com"}', '{"access_token":"unsafe"}', 'null', '[]', 'not-json', '',
    JSON.stringify({ padding: 'x'.repeat(1024) }),
  ])('rejects invalid or client-controlled bodies: %s', async (body) => {
    const { app, plaidLinkClient, reserveQuota } = setup();
    const response = await app.request(path, { ...request, body });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(plaidLinkClient).not.toHaveBeenCalled();
    expect(reserveQuota).not.toHaveBeenCalled();
  });

  it('requires JSON content type', async () => {
    const { app, plaidLinkClient } = setup();
    const response = await app.request(path, { ...request, headers: { Authorization: 'Bearer test-token' } });
    expect(response.status).toBe(400);
    expect(plaidLinkClient).not.toHaveBeenCalled();
  });

  it('fails closed when Plaid is not configured', async () => {
    const app = createApp({ config: readConfig({}), verifyToken: async () => 'verified-user' });
    const response = await app.request(path, request);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'PROVIDER_NOT_CONFIGURED' } });
  });

  it('fails closed when Redis is not configured', async () => {
    const plaidLinkClient = vi.fn<CreateLinkToken>();
    const app = createApp({ config, verifyToken: async () => 'verified-user', plaidLinkClient });
    const response = await app.request(path, request);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'QUOTA_NOT_CONFIGURED' } });
    expect(plaidLinkClient).not.toHaveBeenCalled();
  });

  it('does not call Plaid when quota is exhausted', async () => {
    const { app, plaidLinkClient, reserveQuota } = setup();
    reserveQuota.mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'Too many requests', 30));
    const response = await app.request(path, request);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(plaidLinkClient).not.toHaveBeenCalled();
  });

  it.each([
    {}, { link_token: '', expiration: 'invalid', request_id: 'request' },
    { link_token: 'link-test', expiration: '2000-01-01T00:00:00Z', request_id: 'request' },
  ])('validates upstream responses: %j', async (result) => {
    const { app, plaidLinkClient } = setup();
    plaidLinkClient.mockResolvedValue(result);
    const response = await app.request(path, request);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'UPSTREAM_INVALID_RESPONSE' } });
  });

  it.each([
    [{ response: { status: 429 } }, 503, 'PROVIDER_QUOTA_EXCEEDED'],
    [{ response: { status: 400, data: { error_type: 'RATE_LIMIT_EXCEEDED' } } }, 503, 'PROVIDER_QUOTA_EXCEEDED'],
    [{ response: { status: 400, data: { error_code: 'INVALID_API_KEYS' } } }, 503, 'PROVIDER_CONFIGURATION_ERROR'],
    [{ response: { status: 500 } }, 502, 'UPSTREAM_UNAVAILABLE'],
    [{ code: 'ECONNABORTED' }, 504, 'UPSTREAM_TIMEOUT'],
  ] as const)('sanitizes provider failures: %j', async (error, status, code) => {
    const { app, plaidLinkClient } = setup();
    plaidLinkClient.mockRejectedValue({ ...error, message: 'test-plaid-secret' });
    const response = await app.request(path, request);
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.error.code).toBe(code);
    expect(JSON.stringify(body)).not.toContain('test-plaid-secret');
    if (code === 'PROVIDER_QUOTA_EXCEEDED') expect(response.headers.get('Retry-After')).toBe('60');
  });

  it('handles an aborted deadline without leaking network errors', async () => {
    const { app, plaidLinkClient } = setup();
    const signal = AbortSignal.abort(new DOMException('Timeout', 'TimeoutError'));
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(signal);
    plaidLinkClient.mockRejectedValue(signal.reason);
    const response = await app.request(path, request);
    expect(response.status).toBe(504);
  });

  it('documents the protected POST contract', async () => {
    const { app } = setup();
    const document = await (await app.request('/openapi.json')).json();
    const operation = document.paths[path].post;
    expect(operation.security).toEqual([{ BearerAuth: [] }]);
    expect(operation.requestBody.required).toBe(true);
    expect(operation.responses['504']).toBeDefined();
  });
});

describe('Plaid configuration', () => {
  it('defaults to sandbox, US, and a suite name but requires explicit products', () => {
    expect(readConfig(environment)).toMatchObject({ PLAID_ENV: 'sandbox', PLAID_COUNTRY_CODES: ['US'], PLAID_CLIENT_NAME: 'Hearth', PLAID_PRODUCTS: ['transactions'] });
  });

  it('parses product and country lists', () => {
    expect(readConfig({ ...environment, PLAID_PRODUCTS: 'transactions, auth', PLAID_COUNTRY_CODES: 'US, CA' })).toMatchObject({ PLAID_PRODUCTS: ['transactions', 'auth'], PLAID_COUNTRY_CODES: ['US', 'CA'] });
  });

  it.each([
    { PLAID_CLIENT_ID: 'test-only' },
    { ...environment, PLAID_PRODUCTS: '' },
    { ...environment, PLAID_PRODUCTS: 'transactions,transactions' },
    { ...environment, PLAID_PRODUCTS: 'balance' },
    { ...environment, PLAID_COUNTRY_CODES: 'ZZ' },
    { ...environment, PLAID_ENV: 'https://attacker.com' },
    { ...environment, PLAID_REDIRECT_URI: 'myapp://plaid' },
    { ...environment, PLAID_REDIRECT_URI: 'https://example.com/plaid?app=one' },
    { ...environment, PLAID_CLIENT_NAME: 'x'.repeat(31) },
  ])('rejects invalid configuration without exposing secrets: %j', (values) => {
    expect(() => readConfig(values)).toThrow('Invalid configuration fields');
    try { readConfig(values); } catch (error) {
      expect(String(error)).not.toContain('test-plaid-secret');
    }
  });
});

describe('official Plaid SDK adapter', () => {
  it.each(['sandbox', 'production'])('uses the fixed %s host, secret headers, and transport limits', async (environmentName) => {
    const failure = new Error('synthetic-sdk-failure');
    const call = vi.spyOn(PlaidApi.prototype, 'linkTokenCreate').mockRejectedValue(failure);
    const configured = readConfig({ ...environment, PLAID_ENV: environmentName });
    const client = createPlaidLinkClient(configured)!;
    const signal = AbortSignal.timeout(8000);
    const payload = {
      user: { client_user_id: 'verified-user' }, client_name: configured.PLAID_CLIENT_NAME,
      products: configured.PLAID_PRODUCTS!, country_codes: configured.PLAID_COUNTRY_CODES,
      language: 'en', redirect_uri: configured.PLAID_REDIRECT_URI!,
    };
    await expect(client(payload, signal)).rejects.toBe(failure);
    expect(call).toHaveBeenCalledWith(payload, { signal });
    expect(call.mock.contexts[0]).toMatchObject({
      configuration: {
        basePath: `https://${environmentName}.plaid.com`,
        baseOptions: {
          headers: { 'PLAID-CLIENT-ID': 'test-client-id', 'PLAID-SECRET': 'test-plaid-secret', 'Plaid-Version': '2020-09-14' },
          timeout: 8000, maxRedirects: 0, maxContentLength: 2_097_152, maxBodyLength: 16_384,
        },
      },
    });
  });

  it('does not construct a client without credentials', () => {
    expect(createPlaidLinkClient(readConfig({}))).toBeUndefined();
  });
});
describe('Request log', () => {
  it('records the error code of a failed request, never its message', async () => {
    const plaidLinkClient = vi.fn<CreateLinkToken>().mockRejectedValue(
      Object.assign(new Error('bad keys'), { response: { status: 400, data: { error_type: 'INVALID_INPUT', error_code: 'INVALID_API_KEYS' } } }),
    );
    const logs: Record<string, unknown>[] = [];
    const app = createApp({
      config, verifyToken: async () => 'verified-user-123', reserveQuota: vi.fn().mockResolvedValue(undefined),
      plaidLinkClient, logger: (record) => { logs.push(record as Record<string, unknown>); },
    });
    const response = await app.request(path, request);
    expect(response.status).toBe(503);
    expect(logs.at(-1)).toMatchObject({ route: '/v1/banking/link-token', status: 503, errorCode: 'PROVIDER_CONFIGURATION_ERROR' });
    expect(JSON.stringify(logs)).not.toMatch(/bad keys|Plaid is not available/);
  });

  it('leaves the code out of successful requests', async () => {
    const { app, logs } = setup();
    await app.request(path, request);
    expect(logs.at(-1)).not.toHaveProperty('errorCode');
  });
});
