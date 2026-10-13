import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { ApiError } from '../src/errors.js';
import { createFatSecret } from '../src/integrations/fatsecret.js';
import { memoryCache } from '../src/services/cache.js';
import { brandMatches, createRestaurantService, normalizeName } from '../src/services/restaurants.js';
import type { FatSecretClient, FatSecretFood } from '../src/integrations/fatsecret.js';

const config = readConfig({ FATSECRET_CLIENT_ID: 'fs-client', FATSECRET_CLIENT_SECRET: 'fs-secret-value' });
const headers = { Authorization: 'Bearer test-token' };

function serving(id: string, calories: string, extra: Record<string, string> = {}) {
  return {
    serving_id: id, serving_description: '1 serving', metric_serving_amount: '340.000', metric_serving_unit: 'g',
    calories, protein: '32.00', carbohydrate: '40.00', fat: '12.00', fiber: '9.0', ...extra,
  };
}

function food(id: string, name: string, brand: string, servings: unknown = [serving(`${id}1`, '500')], category = 'Bowls') {
  return { food_id: id, food_name: name, brand_name: brand, food_type: 'Brand', food_url: 'https://foods.fatsecret.com/x',
    food_sub_categories: { food_sub_category: [category] }, servings: { serving: servings } };
}

function searchBody(foods: unknown[], total = foods.length) {
  return { foods_search: { max_results: '50', total_results: String(total), page_number: '0', results: { food: foods } } };
}

const tokenBody = { access_token: 'access-token-abcdef', expires_in: 86400, token_type: 'Bearer' };

/** A fetch that answers the token endpoint and then the given search bodies in order. */
function providerFetch(...responses: (Response | Error)[]) {
  return vi.fn<typeof fetch>(async (input) => {
    if (String(input).startsWith('https://oauth.fatsecret.com/')) return Response.json(tokenBody);
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return next;
  });
}

afterEach(() => { vi.useRealTimers(); });

describe('FatSecret adapter', () => {
  it('gets a client-credentials token once and normalizes numbers, lists and units', async () => {
    const fetcher = providerFetch(Response.json(searchBody([
      // A one-item serving list arriving as a bare object, in ounces.
      food('1', 'Chipotle Chicken Burrito Bowl', 'Chipotle', serving('11', '655', { metric_serving_amount: '12', metric_serving_unit: 'oz', is_default: '1' })),
      // No calories: dropped.
      food('2', 'Mystery Item', 'Chipotle', [serving('21', '', {})]),
      // Malformed food: dropped, the rest kept.
      { food_id: 'not-a-number', food_name: 'Bad', food_type: 'Brand' },
    ])), Response.json(searchBody([])));
    const client = createFatSecret(config, memoryCache(), fetcher)!;

    const result = await client.searchBrandFoods('chipotle', 0, 50);
    expect(result.foods).toEqual([{
      id: '1', name: 'Chipotle Chicken Burrito Bowl', brand: 'Chipotle', categories: ['Bowls'],
      servings: [{ id: '11', description: '1 serving', grams: 340.2, calories: 655, protein: 32, carbs: 40, fat: 12, fiber: 9, isDefault: true }],
    }]);
    await client.searchBrandFoods('chipotle', 1, 50);

    const tokenCalls = fetcher.mock.calls.filter(([url]) => String(url).startsWith('https://oauth.fatsecret.com/'));
    expect(tokenCalls).toHaveLength(1);
    const [, tokenInit] = tokenCalls[0]!;
    expect((tokenInit?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('fs-client:fs-secret-value').toString('base64')}`);
    expect(String(tokenInit?.body)).toBe('grant_type=client_credentials&scope=premier');

    const [searchUrl, searchInit] = fetcher.mock.calls[1]!;
    const url = new URL(String(searchUrl));
    expect(url.origin + url.pathname).toBe('https://platform.fatsecret.com/rest/foods/search/v5');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ search_expression: 'chipotle', food_type: 'brand', format: 'json', page_number: '0' });
    expect(searchInit?.redirect).toBe('error');
    expect((searchInit?.headers as Record<string, string>).Authorization).toBe('Bearer access-token-abcdef');
  });

  it('shares the token through the cache across instances', async () => {
    const cache = memoryCache();
    const first = providerFetch(Response.json(searchBody([])));
    await createFatSecret(config, cache, first)!.searchBrandFoods('a', 0, 10);
    const second = providerFetch(Response.json(searchBody([])));
    await createFatSecret(config, cache, second)!.searchBrandFoods('a', 0, 10);
    expect(second.mock.calls.some(([url]) => String(url).startsWith('https://oauth.fatsecret.com/'))).toBe(false);
  });

  it('renews a rejected token once and retries', async () => {
    const fetcher = providerFetch(Response.json({ error: { code: 13, message: 'Invalid token' } }), Response.json(searchBody([])));
    await createFatSecret(config, memoryCache(), fetcher)!.searchBrandFoods('a', 0, 10);
    expect(fetcher.mock.calls.filter(([url]) => String(url).startsWith('https://oauth.fatsecret.com/'))).toHaveLength(2);
  });

  it('retries a network failure or 5xx once, then reports the outage', async () => {
    const recovered = providerFetch(new TypeError('socket hang up'), Response.json(searchBody([])));
    await expect(createFatSecret(config, memoryCache(), recovered)!.searchBrandFoods('a', 0, 10)).resolves.toBeDefined();

    const down = providerFetch(new Response('', { status: 503 }), new Response('', { status: 502 }));
    await expect(createFatSecret(config, memoryCache(), down)!.searchBrandFoods('a', 0, 10))
      .rejects.toMatchObject({ status: 502, code: 'UPSTREAM_UNAVAILABLE' });
  });

  it.each([
    [{ error: { code: 21, message: 'Invalid IP address detected' } }, 503, 'PROVIDER_NOT_CONFIGURED'],
    [{ error: { code: 14, message: 'Missing scope' } }, 503, 'PROVIDER_NOT_CONFIGURED'],
    [{ error: { code: 22, message: 'Limit reached' } }, 503, 'PROVIDER_QUOTA_EXCEEDED'],
    [{ unexpected: true }, 502, 'UPSTREAM_INVALID_RESPONSE'],
  ])('maps provider errors without leaking them: %j', async (body, status, code) => {
    const fetcher = providerFetch(Response.json(body));
    await expect(createFatSecret(config, memoryCache(), fetcher)!.searchBrandFoods('a', 0, 10)).rejects.toMatchObject({ status, code });
  });

  it('treats a refused token request as a configuration problem', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":"invalid_client"}', { status: 400 }));
    await expect(createFatSecret(config, memoryCache(), fetcher)!.searchBrandFoods('a', 0, 10))
      .rejects.toMatchObject({ status: 503, code: 'PROVIDER_NOT_CONFIGURED' });
  });

  it('is disabled without credentials', () => {
    expect(createFatSecret(readConfig({}), memoryCache())).toBeUndefined();
  });
});

describe('restaurant matching', () => {
  it.each([
    ['Chipotle Mexican Grill', 'Chipotle', true],
    ["McDonald's", 'McDonalds', true],
    ['Taco Bell Cantina', 'Taco Bell', true],
    ['Starbucks Coffee', 'Starbucks', true],
    ['Café Rio Mexican Grill', 'Cafe Rio', true],
    ['Bell Taco Shop', 'Taco Bell', false],
    ['Grill House', 'Grill', false],
    ["Luigi's Trattoria", 'Olive Garden', false],
  ])('%s ↔ %s: %s', (place, brand, expected) => {
    expect(brandMatches(place, brand)).toBe(expected);
  });

  it('normalizes accents, apostrophes and ampersands', () => {
    expect(normalizeName("  Ben & Jerry’s Café ")).toBe('ben and jerrys cafe');
  });
});

function fsFood(id: string, name: string, brand: string | null, calories = 500, category = 'Bowls'): FatSecretFood {
  return { id, name, brand, categories: [category], servings: [{ id: `${id}0`, description: '1 serving', grams: 300, calories, protein: 30, carbs: 40, fat: 10, fiber: 5, isDefault: true }] };
}

describe('restaurant service', () => {
  const chain = [
    fsFood('1', 'Chipotle Chicken Burrito Bowl', 'Chipotle'),
    fsFood('2', 'Chipotle Steak Burrito', 'Chipotle', 900, 'Burritos'),
    fsFood('3', 'Chips', 'Chipotle', 540, 'Sides'),
    fsFood('4', 'Chipotle Peppers in Adobo', 'La Costeña'),
  ];

  it('matches the chain, strips the brand from item names and caches the menu', async () => {
    const search = vi.fn<FatSecretClient['searchBrandFoods']>().mockResolvedValue({ foods: chain, totalResults: chain.length });
    const service = createRestaurantService({ searchBrandFoods: search }, memoryCache(), 24);
    const menu = await service.menu('Chipotle Mexican Grill');
    expect(menu).toMatchObject({ restaurant: 'Chipotle', hasMenu: true, stale: false, attribution: 'Powered by fatsecret' });
    expect(menu.items.map((item) => item.name)).toEqual(['Chicken Burrito Bowl', 'Steak Burrito', 'Chips']);
    expect(menu.items[0]!.id).toBe('fatsecret:1');
    expect(menu.items[0]!.servings[0]!.id).toBe('fatsecret:1:10');

    search.mockClear();
    await service.menu('Chipotle Mexican Grill');
    expect(search).not.toHaveBeenCalled();
  });

  it('reports places without a chain menu', async () => {
    const search = vi.fn<FatSecretClient['searchBrandFoods']>().mockResolvedValue({ foods: [fsFood('9', 'Lasagna', 'Stouffers')], totalResults: 1 });
    const menu = await createRestaurantService({ searchBrandFoods: search }, memoryCache(), 24).menu("Luigi's Trattoria");
    expect(menu).toMatchObject({ restaurant: null, hasMenu: false, items: [] });
  });

  it('serves the cached menu, marked stale, when the provider fails after it ages', async () => {
    let clock = Date.parse('2026-10-13T12:00:00Z');
    const search = vi.fn<FatSecretClient['searchBrandFoods']>().mockResolvedValue({ foods: chain, totalResults: chain.length });
    const service = createRestaurantService({ searchBrandFoods: search }, memoryCache(() => clock), 24, () => clock);
    await service.menu('Chipotle');

    clock += 7 * 3_600_000;
    search.mockRejectedValue(new ApiError(502, 'UPSTREAM_UNAVAILABLE', 'down'));
    const stale = await service.menu('Chipotle');
    expect(stale.stale).toBe(true);
    expect(stale.items).toHaveLength(3);
  });

  it('fails cleanly when the provider is down and nothing is cached', async () => {
    const search = vi.fn<FatSecretClient['searchBrandFoods']>().mockRejectedValue(new ApiError(504, 'UPSTREAM_TIMEOUT', 'slow'));
    await expect(createRestaurantService({ searchBrandFoods: search }, memoryCache(), 24).menu('Chipotle'))
      .rejects.toMatchObject({ status: 504 });
  });

  it('pages through large menus and stops at the end', async () => {
    const page = (start: number, count: number) => Array.from({ length: count }, (_, i) => fsFood(String(start + i), `Item ${start + i}`, 'Chipotle'));
    const search = vi.fn<FatSecretClient['searchBrandFoods']>()
      .mockResolvedValueOnce({ foods: page(0, 50), totalResults: 70 })   // brand match
      .mockResolvedValueOnce({ foods: page(0, 50), totalResults: 70 })
      .mockResolvedValueOnce({ foods: page(50, 20), totalResults: 70 });
    const menu = await createRestaurantService({ searchBrandFoods: search }, memoryCache(), 24).menu('Chipotle');
    expect(menu.items).toHaveLength(70);
    expect(search).toHaveBeenCalledTimes(3);
  });

  it('degrades per place in a batch lookup', async () => {
    const search = vi.fn<FatSecretClient['searchBrandFoods']>(async (name) => {
      if (name === 'Broken Place') throw new ApiError(502, 'UPSTREAM_UNAVAILABLE', 'down');
      return { foods: name.startsWith('Chipotle') ? chain : [], totalResults: 3 };
    });
    const results = await createRestaurantService({ searchBrandFoods: search }, memoryCache(), 24)
      .lookup(['Chipotle Mexican Grill', 'Broken Place', 'Pho Saigon']);
    expect(results).toEqual([
      { name: 'Chipotle Mexican Grill', restaurant: 'Chipotle', hasMenu: true },
      { name: 'Broken Place', restaurant: null, hasMenu: null },
      { name: 'Pho Saigon', restaurant: null, hasMenu: false },
    ]);
  });
});

describe('restaurant routes', () => {
  function setup(fetcher = providerFetch(Response.json(searchBody([
    food('1', 'Chipotle Chicken Burrito Bowl', 'Chipotle'), food('2', 'Chipotle Steak Burrito', 'Chipotle'), food('3', 'Chips', 'Chipotle'),
  ])), Response.json(searchBody([
    food('1', 'Chipotle Chicken Burrito Bowl', 'Chipotle'), food('2', 'Chipotle Steak Burrito', 'Chipotle'), food('3', 'Chips', 'Chipotle'),
  ])))) {
    const reserveQuota = vi.fn().mockResolvedValue(undefined);
    const verifyToken = vi.fn().mockResolvedValue({ userId: 'anon-user', isAnonymous: true });
    return { app: createApp({ config, verifyToken, reserveQuota, fetcher, cache: memoryCache() }), reserveQuota, fetcher };
  }

  it('returns a menu to anonymous users and reserves quota first', async () => {
    const { app, reserveQuota } = setup();
    const response = await app.request('/v1/restaurants/menu?name=Chipotle%20Mexican%20Grill', { headers });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ restaurant: 'Chipotle', hasMenu: true, stale: false });
    expect(body.items).toHaveLength(3);
    expect(reserveQuota).toHaveBeenCalledWith('anon-user', 'restaurants');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('looks up a batch of names', async () => {
    const { app } = setup();
    const response = await app.request('/v1/restaurants/lookup', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ names: ['Chipotle Mexican Grill'] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [{ name: 'Chipotle Mexican Grill', restaurant: 'Chipotle', hasMenu: true }] });
  });

  it.each([
    ['/v1/restaurants/menu', undefined],
    ['/v1/restaurants/menu?name=', undefined],
    [`/v1/restaurants/menu?name=${'x'.repeat(121)}`, undefined],
    ['/v1/restaurants/lookup', { names: [] }],
    ['/v1/restaurants/lookup', { names: Array.from({ length: 13 }, (_, i) => `Place ${i}`) }],
  ])('rejects invalid input: %s', async (path, body) => {
    const { app, reserveQuota } = setup();
    const response = await app.request(path, body
      ? { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { headers });
    expect(response.status).toBe(400);
    expect(reserveQuota).not.toHaveBeenCalled();
  });

  it('answers 503 when FatSecret is not configured', async () => {
    const app = createApp({ config: readConfig({}), verifyToken: vi.fn().mockResolvedValue('user'), reserveQuota: vi.fn() });
    const response = await app.request('/v1/restaurants/menu?name=Chipotle', { headers });
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('never exposes credentials in errors', async () => {
    const { app } = setup(providerFetch(new Response('', { status: 500 }), new Response('', { status: 500 })));
    const response = await app.request('/v1/restaurants/menu?name=Chipotle', { headers });
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain('fs-secret-value');
    expect(text).not.toContain('access-token-abcdef');
  });
});
