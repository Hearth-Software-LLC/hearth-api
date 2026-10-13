import { ApiError } from '../errors.js';
import type { FatSecretClient, FatSecretFood, FatSecretServing } from '../integrations/fatsecret.js';
import type { Cache } from './cache.js';

/**
 * Restaurant menus for the apps: match a place's name (as Apple Maps spells it, "Chipotle
 * Mexican Grill") to a chain in the provider's catalog ("Chipotle"), then gather that
 * chain's items.
 *
 * Reliability:
 * - Brand matches are cached for a week (a miss for a day); they're names, not nutrition.
 * - Menus are cached for RESTAURANT_CACHE_HOURS. After six hours a menu is refreshed, and if
 *   the provider fails then, the cached copy is served with `stale: true` instead of an error.
 * - Batch lookups run at most four provider calls at a time and degrade per place: one
 *   failure marks that place unknown instead of failing the batch.
 */
export type MenuItem = {
  id: string;
  name: string;
  category: string | null;
  servings: (Omit<FatSecretServing, 'id'> & { id: string })[];
};

export type Menu = {
  query: string;
  restaurant: string | null;
  hasMenu: boolean;
  items: MenuItem[];
  fetchedAt: string;
  stale: boolean;
  attribution: string;
};

export type Lookup = { name: string; restaurant: string | null; hasMenu: boolean | null };

export type RestaurantService = {
  menu: (name: string) => Promise<Menu>;
  lookup: (names: string[]) => Promise<Lookup[]>;
};

const attribution = 'Powered by fatsecret';
const freshMs = 6 * 3_600_000;
const brandTtl = 7 * 86_400;
const missTtl = 86_400;
const pageSize = 50;
const maxPages = 4;
const minimumItems = 3;

/** Words that describe a kind of place rather than name it; a brand needs more than these. */
const genericWords = new Set([
  'the', 'and', 'of', 'a', 'co', 'company', 'inc', 'llc', 'restaurant', 'restaurants', 'grill', 'grille',
  'kitchen', 'cafe', 'bar', 'eatery', 'house', 'express', 'coffee', 'pizza', 'pizzeria', 'burger', 'burgers',
  'taco', 'tacos', 'sushi', 'bbq', 'deli', 'bakery', 'diner', 'mexican', 'chinese', 'thai', 'indian',
  'italian', 'japanese', 'korean', 'vietnamese', 'greek', 'american', 'food', 'foods', 'bistro', 'cantina',
  'shop', 'place', 'market', 'drive', 'thru', 'in', 'to', 'go',
]);

export function normalizeName(name: string): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/['’`.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokens(name: string): string[] {
  return normalizeName(name).split(' ').filter(Boolean);
}

/**
 * Whether a catalog brand is this place: every word of the brand appears in the place's name
 * in order ("chipotle" in "chipotle mexican grill", but "taco bell" not in "bell taco shop"),
 * and the brand has at least one distinctive word, so "Pizza Kitchen" never matches.
 */
export function brandMatches(place: string, brand: string): boolean {
  const placeWords = tokens(place);
  const brandWords = tokens(brand);
  if (!brandWords.some((word) => !genericWords.has(word))) return false;
  let from = 0;
  for (const word of brandWords) {
    const index = placeWords.indexOf(word, from);
    if (index < 0) return false;
    from = index + 1;
  }
  return true;
}

function menuItem(food: FatSecretFood, brand: string): MenuItem {
  // "Chipotle Chicken Burrito Bowl" from brand "Chipotle" reads better as "Chicken Burrito Bowl".
  let name = food.name.trim();
  if (normalizeName(name).startsWith(`${normalizeName(brand)} `)) {
    name = name.slice(brand.length).replace(/^[\s:–—-]+/, '').trim() || food.name;
  }
  return {
    id: `fatsecret:${food.id}`,
    name,
    category: food.categories[0] ?? null,
    servings: food.servings.map((serving) => ({ ...serving, id: `fatsecret:${food.id}:${serving.id}` })),
  };
}

async function mapLimited<T, R>(values: T[], limit: number, work: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await work(values[index]!);
    }
  }));
  return results;
}

export function createRestaurantService(
  client: FatSecretClient,
  cache: Cache,
  cacheHours: number,
  now: () => number = Date.now,
): RestaurantService {
  const menuTtl = cacheHours * 3600;

  /** The catalog brand for a place's name, or null when there's no chain by that name. */
  async function resolveBrand(name: string): Promise<string | null> {
    const key = `restaurants:brand:v1:${normalizeName(name)}`;
    const cached = await cache.get<{ brand: string | null }>(key);
    if (cached && (cached.brand === null || typeof cached.brand === 'string')) return cached.brand;

    const { foods } = await client.searchBrandFoods(name, 0, pageSize);
    const counts = new Map<string, number>();
    for (const food of foods) {
      if (food.brand && brandMatches(name, food.brand)) counts.set(food.brand, (counts.get(food.brand) ?? 0) + 1);
    }
    // The brand with the most items; on a tie, the longer (more specific) name.
    const best = [...counts.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0]?.[0] ?? null;
    await cache.set(key, { brand: best }, best ? brandTtl : missTtl);
    return best;
  }

  async function fetchMenu(brand: string): Promise<MenuItem[]> {
    const target = normalizeName(brand);
    const items = new Map<string, MenuItem>();
    for (let page = 0; page < maxPages; page += 1) {
      const { foods, totalResults } = await client.searchBrandFoods(brand, page, pageSize);
      for (const food of foods) {
        if (food.brand && normalizeName(food.brand) === target && !items.has(food.id)) {
          items.set(food.id, menuItem(food, brand));
        }
      }
      if (foods.length < pageSize || (page + 1) * pageSize >= totalResults) break;
    }
    return [...items.values()].sort((a, b) =>
      (a.category ?? '~').localeCompare(b.category ?? '~') || a.name.localeCompare(b.name));
  }

  async function menu(name: string): Promise<Menu> {
    const brand = await resolveBrand(name);
    const empty = { query: name, restaurant: null, hasMenu: false, items: [], fetchedAt: new Date(now()).toISOString(), stale: false, attribution };
    if (!brand) return empty;

    const key = `restaurants:menu:v1:${normalizeName(brand)}`;
    const cached = await cache.get<{ items: MenuItem[]; fetchedAt: string }>(key);
    const age = cached ? now() - Date.parse(cached.fetchedAt) : Infinity;
    if (cached && Array.isArray(cached.items) && age < freshMs) {
      return { query: name, restaurant: brand, hasMenu: cached.items.length >= minimumItems, items: cached.items, fetchedAt: cached.fetchedAt, stale: false, attribution };
    }

    try {
      const items = await fetchMenu(brand);
      const fetchedAt = new Date(now()).toISOString();
      await cache.set(key, { items, fetchedAt }, menuTtl);
      return { query: name, restaurant: brand, hasMenu: items.length >= minimumItems, items, fetchedAt, stale: false, attribution };
    } catch (error) {
      // The provider failed: an older copy (still within the cache's lifetime) beats nothing.
      if (cached && Array.isArray(cached.items) && error instanceof ApiError && error.status >= 502) {
        return { query: name, restaurant: brand, hasMenu: cached.items.length >= minimumItems, items: cached.items, fetchedAt: cached.fetchedAt, stale: true, attribution };
      }
      throw error;
    }
  }

  async function lookup(names: string[]): Promise<Lookup[]> {
    return mapLimited(names, 4, async (name) => {
      try {
        const brand = await resolveBrand(name);
        return { name, restaurant: brand, hasMenu: brand !== null };
      } catch {
        // Unknown for now; the app shows the place without a badge and can ask again later.
        return { name, restaurant: null, hasMenu: null };
      }
    });
  }

  return { menu, lookup };
}
