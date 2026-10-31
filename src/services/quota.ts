import { createHash } from 'node:crypto';
import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';
import type { Config } from '../config.js';
import { ApiError } from '../errors.js';

export type ReserveQuota = (userId: string, operation: 'foods' | 'logos' | 'restaurants' | 'plaid-link' | 'banking' | 'ember' | 'ember-speech' | 'marketing' | 'collections' | 'content-ai') => Promise<void>;

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
  // Restaurant requests can each make a few FatSecret calls (a menu is up to four pages);
  // most are answered from the cache. This caps what a burst can spend upstream.
  const restaurantLimit = new Ratelimit({
    redis,
    limiter: Ratelimit.fixedWindow(1200, '1 h'),
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
  // Writing ad copy is one or two Sonnet calls; a campaign needs a handful.
  const marketingUserLimit = new Ratelimit({
    redis,
    limiter: Ratelimit.fixedWindow(30, '1 h'),
    prefix: `${config.RATE_LIMIT_PREFIX}:marketing-user`,
    analytics: false,
    ephemeralCache: false,
    timeout: 3000,
  });
  // Hearth Content's Write with AI: an outline plus a call per section, so each is a dozen or so
  // Sonnet calls. 20 drafts per person per day.
  const contentAiUserLimit = new Ratelimit({
    redis,
    limiter: Ratelimit.fixedWindow(20, '1 d'),
    prefix: `${config.RATE_LIMIT_PREFIX}:content-ai-user`,
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

  // Ember's cloud voice: a few sentences per answer. Caps what all accounts together can spend
  // on Google Text-to-Speech in an hour.
  const speechLimit = new Ratelimit({
    redis,
    limiter: Ratelimit.fixedWindow(3000, '1 h'),
    prefix: `${config.RATE_LIMIT_PREFIX}:provider`,
    analytics: false,
    ephemeralCache: false,
    timeout: 3000,
  });

  return async (userId, operation) => {
    try {
      const identifier = createHash('sha256').update(userId).digest('hex');
      const limiter = operation === 'plaid-link' ? plaidUserLimit : operation === 'marketing' ? marketingUserLimit
        : operation === 'content-ai' ? contentAiUserLimit : userLimit;
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
      if (operation === 'restaurants') {
        const providerResult = await restaurantLimit.limit('fatsecret');
        if (providerResult.reason === 'timeout') throw new Error('Quota timeout');
        if (!providerResult.success) {
          throw new ApiError(503, 'PROVIDER_QUOTA_EXCEEDED', 'Restaurant data quota is exhausted', retryAfter(providerResult.reset));
        }
      }
      if (operation === 'ember-speech') {
        const providerResult = await speechLimit.limit('google-tts');
        if (providerResult.reason === 'timeout') throw new Error('Quota timeout');
        if (!providerResult.success) {
          throw new ApiError(503, 'PROVIDER_QUOTA_EXCEEDED', 'The cloud voice is busy', retryAfter(providerResult.reset));
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
/**
 * The website's waitlist form: 5 sign-ups an hour per address and network. Undefined (no limit)
 * when Upstash isn't configured.
 */
export function createWaitlistLimit(config: Config): ((key: string) => Promise<boolean>) | undefined {
  if (!config.UPSTASH_REDIS_REST_URL || !config.UPSTASH_REDIS_REST_TOKEN) return undefined;
  const limit = new Ratelimit({
    redis: new Redis({ url: config.UPSTASH_REDIS_REST_URL, token: config.UPSTASH_REDIS_REST_TOKEN, retry: false }),
    limiter: Ratelimit.fixedWindow(5, '1 h'),
    prefix: `${config.RATE_LIMIT_PREFIX}:waitlist`,
    analytics: false,
    ephemeralCache: false,
    timeout: 3000,
  });
  return async (key) => {
    try {
      return (await limit.limit(key)).success;
    } catch {
      return true;   // Upstash down: let the sign-up through rather than lose it.
    }
  };
}
