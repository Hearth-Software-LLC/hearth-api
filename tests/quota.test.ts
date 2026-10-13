import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ratelimit } from '@upstash/ratelimit';
import { readConfig } from '../src/config.js';
import { createQuota } from '../src/services/quota.js';

const { limit } = vi.hoisted(() => ({ limit: vi.fn<Ratelimit['limit']>() }));
vi.mock('@upstash/ratelimit', () => ({
  Ratelimit: class {
    limit = limit;
    static fixedWindow = vi.fn();
  },
}));

const config = readConfig({
  UPSTASH_REDIS_REST_URL: 'https://redis.example.com',
  UPSTASH_REDIS_REST_TOKEN: 'test-redis-token',
});
const allowed = { success: true, remaining: 29, limit: 30, reset: Date.now() + 60_000, pending: Promise.resolve() };

afterEach(() => { limit.mockReset(); });

describe('shared quotas', () => {
  it('reserves a per-user quota and a separate global food quota', async () => {
    limit.mockResolvedValue(allowed);
    await createQuota(config)('user-123', 'foods');
    expect(limit).toHaveBeenCalledTimes(2);
    expect(limit.mock.calls[0]?.[0]).toMatch(/^foods:[a-f0-9]{64}$/);
    expect(limit.mock.calls[1]?.[0]).toBe('usda');
  });

  it('does not reserve a food quota for logo URL resolution', async () => {
    limit.mockResolvedValue(allowed);
    await createQuota(config)('user-123', 'logos');
    expect(limit).toHaveBeenCalledTimes(1);
  });

  it('reserves a user and global Plaid quota separate from foods', async () => {
    limit.mockResolvedValue(allowed);
    await createQuota(config)('user-123', 'plaid-link');
    expect(limit.mock.calls[0]?.[0]).toMatch(/^plaid-link:[a-f0-9]{64}$/);
    expect(limit.mock.calls[1]?.[0]).toBe('link:sandbox');
  });

  it('blocks Plaid when its global quota is exhausted', async () => {
    limit.mockResolvedValueOnce(allowed).mockResolvedValueOnce({ ...allowed, success: false });
    await expect(createQuota(config)('user-123', 'plaid-link')).rejects.toMatchObject({ status: 503, code: 'PROVIDER_QUOTA_EXCEEDED' });
  });

  it('returns a user rate-limit error before reserving global quota', async () => {
    limit.mockResolvedValue({ ...allowed, success: false });
    await expect(createQuota(config)('user-123', 'foods')).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect(limit).toHaveBeenCalledTimes(1);
  });

  it('distinguishes global provider exhaustion from a user quota failure', async () => {
    limit.mockResolvedValueOnce(allowed).mockResolvedValueOnce({ ...allowed, success: false });
    await expect(createQuota(config)('user-123', 'foods')).rejects.toMatchObject({ status: 503, code: 'PROVIDER_QUOTA_EXCEEDED' });
  });

  it('fails closed even when the library permits access on timeout', async () => {
    limit.mockResolvedValue({ ...allowed, reason: 'timeout' });
    await expect(createQuota(config)('user-123', 'foods')).rejects.toMatchObject({ status: 503, code: 'QUOTA_UNAVAILABLE' });
  });

  it('sanitizes Redis failures', async () => {
    limit.mockRejectedValue(new Error('test-redis-token'));
    await expect(createQuota(config)('user-123', 'foods')).rejects.toMatchObject({ status: 503, message: 'Provider access is temporarily unavailable' });
  });
});