import { beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { createTokenVerifier } from '../src/middleware/auth.js';

const config = readConfig({
  AUTH_ISSUER: 'https://identity.example.com',
  AUTH_AUDIENCE: 'authenticated',
  AUTH_JWKS_URL: 'https://identity.example.com/jwks.json',
});
let keys: Awaited<ReturnType<typeof generateKeyPair>>;

beforeAll(async () => { keys = await generateKeyPair('ES256'); });

async function token(overrides: { issuer?: string; audience?: string; expiration?: string; subject?: string; isAnonymous?: boolean } = {}) {
  return new SignJWT({ is_anonymous: overrides.isAnonymous ?? false })
    .setProtectedHeader({ alg: 'ES256' })
    .setSubject(overrides.subject ?? 'user-123')
    .setIssuer(overrides.issuer ?? config.AUTH_ISSUER!)
    .setAudience(overrides.audience ?? config.AUTH_AUDIENCE!)
    .setIssuedAt()
    .setExpirationTime(overrides.expiration ?? '5m')
    .sign(keys.privateKey);
}

function app() {
  return createApp({ config, verifyToken: createTokenVerifier(config, async () => keys.publicKey) });
}

describe('JWT authentication', () => {
  it('derives identity from a verified JWT, not app metadata', async () => {
    const response = await app().request('/v1/me', {
      headers: { Authorization: `Bearer ${await token()}`, 'X-App-ID': 'another-user' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'user-123' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });


  it('retains the anonymous identity claim for route authorization', async () => {
    const verify = createTokenVerifier(config, async () => keys.publicKey);
    await expect(verify(await token({ isAnonymous: true }))).resolves.toEqual({
      userId: 'user-123',
      isAnonymous: true,
    });
  });

  it.each([
    { issuer: 'https://attacker.example.com' },
    { audience: 'another-app' },
    { expiration: '-1m' },
    { subject: '' },
  ])('rejects invalid claims: %j', async (claims) => {
    const response = await app().request('/v1/me', { headers: { Authorization: `Bearer ${await token(claims)}` } });
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');
  });

  it('rejects a JWT signed by an untrusted key', async () => {
    const otherKeys = await generateKeyPair('ES256');
    const untrusted = await new SignJWT({ sub: 'user-123' })
      .setProtectedHeader({ alg: 'ES256' }).setIssuer(config.AUTH_ISSUER!)
      .setAudience(config.AUTH_AUDIENCE!).setIssuedAt().setExpirationTime('5m').sign(otherKeys.privateKey);
    const response = await app().request('/v1/me', { headers: { Authorization: `Bearer ${untrusted}` } });
    expect(response.status).toBe(401);
  });

  it.each([undefined, 'Basic credentials', 'Bearer malformed', 'Bearer first second'])('rejects missing or malformed authorization: %s', async (authorization) => {
    const response = await app().request('/v1/me', { headers: authorization ? { Authorization: authorization } : {} });
    expect(response.status).toBe(401);
  });

  it('fails closed when authentication is not configured', async () => {
    const response = await createApp({ config: readConfig({}) }).request('/v1/me', {
      headers: { Authorization: `Bearer ${await token()}` },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'AUTH_NOT_CONFIGURED' } });
  });

  it('maps JWKS network failures to an availability error without leaking details', async () => {
    const instance = createApp({ config, verifyToken: createTokenVerifier(config, async () => { throw new Error('secret-in-fetch-error'); }) });
    const response = await instance.request('/v1/me', { headers: { Authorization: `Bearer ${await token()}` } });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('secret-in-fetch-error');
  });
});

describe('configuration', () => {
  it('permits a health-only deployment without credentials', () => {
    expect(readConfig({})).toMatchObject({ RATE_LIMIT_PREFIX: 'lifestyle:quota:v1' });
  });
  it('rejects partial identity or Redis configuration', () => {
    expect(() => readConfig({ AUTH_ISSUER: 'https://example.com' })).toThrow('AUTH_ISSUER');
    expect(() => readConfig({ UPSTASH_REDIS_REST_URL: 'https://example.com' })).toThrow('UPSTASH_REDIS_REST_URL');
  });
  it('rejects a secret logo key without printing its value', () => {
    expect(() => readConfig({ LOGO_DEV_PUBLISHABLE_KEY: 'sk_secret-example' })).toThrow('LOGO_DEV_PUBLISHABLE_KEY');
    try { readConfig({ LOGO_DEV_PUBLISHABLE_KEY: 'sk_secret-example' }); } catch (error) {
      expect(String(error)).not.toContain('sk_secret-example');
    }
  });
});