import { Redis } from '@upstash/redis';
import type { Config } from '../config.js';

/**
 * A small shared cache for public reference data (restaurant menus, brand matches) and the
 * FatSecret access token. Best effort by design: a slow or failing cache never fails a
 * request, it only means the provider is asked again. Never put personal data in it.
 */
export type Cache = {
  get: <T>(key: string) => Promise<T | undefined>;
  set: (key: string, value: unknown, ttlSeconds: number) => Promise<void>;
};

const timeoutMs = 1500;

function within<T>(promise: Promise<T>): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
  ]).catch(() => undefined);
}

export function createCache(config: Config): Cache {
  if (!config.UPSTASH_REDIS_REST_URL || !config.UPSTASH_REDIS_REST_TOKEN) return memoryCache();
  const redis = new Redis({ url: config.UPSTASH_REDIS_REST_URL, token: config.UPSTASH_REDIS_REST_TOKEN, retry: false });
  const prefix = `${config.RATE_LIMIT_PREFIX}:cache:`;
  return {
    async get<T>(key: string) {
      const value = await within(redis.get<T>(prefix + key));
      return value ?? undefined;
    },
    async set(key, value, ttlSeconds) {
      if (ttlSeconds <= 0) return;
      await within(redis.set(prefix + key, value, { ex: Math.ceil(ttlSeconds) }));
    },
  };
}

/** Per-instance cache, for tests and when Redis isn't configured. */
export function memoryCache(now: () => number = Date.now): Cache {
  const entries = new Map<string, { value: unknown; expiresAt: number }>();
  return {
    async get<T>(key: string) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      return structuredClone(entry.value) as T;
    },
    async set(key, value, ttlSeconds) {
      if (ttlSeconds <= 0) return;
      if (entries.size > 500) entries.delete(entries.keys().next().value!);
      entries.set(key, { value: structuredClone(value), expiresAt: now() + ttlSeconds * 1000 });
    },
  };
}
