import { createHash } from 'node:crypto';
import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';
import type { Config } from '../config.js';
import { ApiError } from '../errors.js';

export type ReserveQuota = (userId: string, operation: 'foods' | 'logos' | 'plaid-link' | 'banking') => Promise<void>;

export function createQuota(config: Config): ReserveQuota {
  if (!config.UPSTASH_REDIS_REST_URL || !config.UPSTASH_REDIS_REST_TOKEN) {
    return async () => { throw new ApiError(503, 'QUOTA_NOT_CONFIGURED', 'Provider access is not configured'); };
  }

  const redis = new Redis({
    url: config.UPSTASH_REDIS_REST_URL,
    token: config.UPSTASH_REDIS_REST_TOKEN,
    retry: false,
  });
  const userLimit = new Ratelimit({
    redis,
    limiter: Ratelimit.fixedWindow(30, '1 m'),
    prefix: `${config.RATE_LIMIT_PREFIX}:user`,
    analytics: false,
    ephemeralCache: false,
    timeout: 3000,
  });
  const foodLimit = new Ratelimit({
    redis,
    limiter: Ratelimit.fixedWindow(600, '1 h'),
    prefix: `${config.RATE_LIMIT_PREFIX}:provider`,
    analytics: false,
    ephemeralCache: false,
    timeout: 3000,
  });
  const plaidUserLimit = new Ratelimit({
    redis,
    limiter: Ratelimit.fixedWindow(5, '1 m'),
    prefix: `${config.RATE_LIMIT_PREFIX}:plaid-user`,
    analytics: false,
    ephemeralCache: false,
    timeout: 3000,
  });
  const plaidGlobalLimit = new Ratelimit({
    redis,
    limiter: Ratelimit.fixedWindow(100, '1 h'),
    prefix: `${config.RATE_LIMIT_PREFIX}:plaid-provider`,
    analytics: false,
    ephemeralCache: false,
    timeout: 3000,
  });

  return async (userId, operation) => {
    try {
      const identifier = createHash('sha256').update(userId).digest('hex');
      const limiter = operation === 'plaid-link' ? plaidUserLimit : userLimit;
      const userResult = await limiter.limit(`${operation}:${identifier}`);
      if (userResult.reason === 'timeout') throw new Error('Quota timeout');
      if (!userResult.success) {
        throw new ApiError(429, 'RATE_LIMITED', 'Too many requests', retryAfter(userResult.reset));
      }
      if (operation === 'foods') {
        const providerResult = await foodLimit.limit('usda');
        if (providerResult.reason === 'timeout') throw new Error('Quota timeout');
        if (!providerResult.success) {
          throw new ApiError(503, 'PROVIDER_QUOTA_EXCEEDED', 'Food provider quota is exhausted', retryAfter(providerResult.reset));
        }
      }
      if (operation === 'plaid-link') {
        const providerResult = await plaidGlobalLimit.limit(`link:${config.PLAID_ENV}`);
        if (providerResult.reason === 'timeout') throw new Error('Quota timeout');
        if (!providerResult.success) {
          throw new ApiError(503, 'PROVIDER_QUOTA_EXCEEDED', 'Plaid request quota is exhausted', retryAfter(providerResult.reset));
        }
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'QUOTA_UNAVAILABLE', 'Provider access is temporarily unavailable');
    }
  };
}

function retryAfter(reset: number) {
  return Math.max(1, Math.ceil((reset - Date.now()) / 1000));
}