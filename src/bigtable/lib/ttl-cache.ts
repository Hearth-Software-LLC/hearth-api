type CacheEntry<T> = { data: T; expiresAt: number };

export function createTtlCache<T>(ttlMs: number) {
  const map = new Map<string, CacheEntry<T>>();

  return {
    get(key: string): T | null {
      const entry = map.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        map.delete(key);
        return null;
      }
      return entry.data;
    },
    set(key: string, data: T): void {
      map.set(key, { data, expiresAt: Date.now() + ttlMs });
    },
    invalidate(key: string): void {
      map.delete(key);
    },
  };
}
