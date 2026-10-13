import { z } from 'zod';
import type { Config } from '../config.js';
import { ApiError } from '../errors.js';
import type { Cache } from '../services/cache.js';
import { jitteredDelay, readBoundedJson } from './http.js';

/**
 * FatSecret Platform: branded and restaurant foods with their servings and nutrients.
 *
 * - OAuth 2.0 client credentials. The access token (24 h) is shared through the cache so
 *   cold starts don't each request one, refreshed five minutes early, and requested once
 *   at a time per instance. A rejected token is replaced once and the call retried.
 * - Fixed hosts, no redirects, a 6-second deadline per attempt, a 2 MiB body cap.
 * - Safe reads are retried once after a network error, timeout or 5xx, with jitter.
 * - FatSecret reports many errors as HTTP 200 with an `error` object; those are mapped too.
 * - Responses are validated. Numbers arrive as strings and one-item lists may arrive as a
 *   bare object; both are normalized. A malformed food is dropped, not the whole response.
 *
 * FatSecret only accepts requests from IP addresses registered in its developer console.
 */
export type FatSecretServing = {
  id: string;
  description: string;
  grams: number | null;
  calories: number;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  fiber: number | null;
  isDefault: boolean;
};

export type FatSecretFood = {
  id: string;
  name: string;
  brand: string | null;
  categories: string[];
  servings: FatSecretServing[];
};

export type FatSecretClient = {
  searchBrandFoods: (expression: string, page: number, maxResults: number) => Promise<{ foods: FatSecretFood[]; totalResults: number }>;
};

const tokenUrl = 'https://oauth.fatsecret.com/connect/token';
const apiOrigin = 'https://platform.fatsecret.com';
const attemptTimeoutMs = 6000;
const maxBytes = 2 * 1_048_576;
const refreshMarginMs = 5 * 60_000;
const tokenCacheKey = 'fatsecret:token:v1';

const invalid = () => new ApiError(502, 'UPSTREAM_INVALID_RESPONSE', 'Restaurant data provider returned an invalid response');
const unavailable = () => new ApiError(502, 'UPSTREAM_UNAVAILABLE', 'Restaurant data provider is temporarily unavailable');
const notConfigured = () => new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'Restaurant data provider is not configured');

// Numbers arrive as strings ("12.50"); a missing or unparseable one is unknown, not zero.
const amount = z.union([z.string(), z.number()]).optional().transform((value) => {
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
});
const list = <T extends z.ZodType>(item: T) =>
  z.preprocess((value) => (value == null ? [] : Array.isArray(value) ? value : [value]), z.array(item));

const servingSchema = z.object({
  serving_id: z.union([z.string(), z.number()]).transform(String),
  serving_description: z.string().trim().min(1).max(300),
  metric_serving_amount: amount,
  metric_serving_unit: z.string().optional(),
  calories: amount,
  protein: amount,
  carbohydrate: amount,
  fat: amount,
  fiber: amount,
  is_default: z.union([z.string(), z.number()]).optional(),
});

const foodSchema = z.object({
  food_id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d{1,20}$/)),
  food_name: z.string().trim().min(1).max(300),
  brand_name: z.string().trim().max(200).optional(),
  food_type: z.string().max(40),
  food_sub_categories: z.object({ food_sub_category: list(z.string().max(120)) }).optional().nullable(),
  servings: z.object({ serving: list(z.unknown()) }).optional().nullable(),
});

const searchSchema = z.object({
  foods_search: z.object({
    total_results: amount,
    results: z.object({ food: list(z.unknown()) }).optional().nullable(),
  }),
});

const tokenSchema = z.object({
  access_token: z.string().min(10).max(8192),
  expires_in: z.coerce.number().int().positive().max(7 * 86_400),
});

const errorSchema = z.object({ error: z.object({ code: z.coerce.number(), message: z.string().optional() }) });

type Token = { token: string; expiresAt: number };

export function createFatSecret(config: Config, cache: Cache, fetcher: typeof fetch = fetch): FatSecretClient | undefined {
  const clientId = config.FATSECRET_CLIENT_ID;
  const secret = config.FATSECRET_CLIENT_SECRET;
  if (!clientId || !secret) return undefined;
  const basic = Buffer.from(`${clientId}:${secret}`).toString('base64');

  let current: Token | undefined;
  let pending: Promise<Token> | undefined;

  async function requestToken(): Promise<Token> {
    const signal = AbortSignal.timeout(attemptTimeoutMs);
    let response: Response;
    try {
      response = await fetcher(tokenUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope: config.FATSECRET_SCOPE }).toString(),
        signal,
        redirect: 'error',
      });
    } catch {
      if (signal.aborted) throw new ApiError(504, 'UPSTREAM_TIMEOUT', 'Restaurant data provider did not respond in time');
      throw unavailable();
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      // Wrong credentials or scope, or this server's IP isn't registered with FatSecret.
      await response.body?.cancel();
      throw notConfigured();
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw unavailable();
    }
    const parsed = tokenSchema.safeParse(await readBoundedJson(response, 65_536, invalid));
    if (!parsed.success) throw invalid();
    const token = { token: parsed.data.access_token, expiresAt: Date.now() + parsed.data.expires_in * 1000 };
    await cache.set(tokenCacheKey, token, (token.expiresAt - Date.now() - refreshMarginMs) / 1000);
    return token;
  }

  async function accessToken(renew: boolean): Promise<string> {
    if (!renew && current && current.expiresAt - Date.now() > refreshMarginMs) return current.token;
    if (!renew) {
      const shared = await cache.get<Token>(tokenCacheKey);
      if (shared && typeof shared.token === 'string' && shared.expiresAt - Date.now() > refreshMarginMs) {
        current = shared;
        return shared.token;
      }
    }
    pending ??= requestToken().finally(() => { pending = undefined; });
    current = await pending;
    return current.token;
  }

  async function get(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(path, apiOrigin);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set('format', 'json');

    let renewed = false;
    let renewNow = false;
    for (let attempt = 0; ; attempt += 1) {
      const token = await accessToken(renewNow);
      renewNow = false;
      const signal = AbortSignal.timeout(attemptTimeoutMs);
      let response: Response;
      try {
        response = await fetcher(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal,
          redirect: 'error',
        });
      } catch {
        if (attempt === 0) { await jitteredDelay(250); continue; }
        if (signal.aborted) throw new ApiError(504, 'UPSTREAM_TIMEOUT', 'Restaurant data provider did not respond in time');
        throw unavailable();
      }

      if (response.status === 401 && !renewed) {
        await response.body?.cancel();
        renewed = true;
        renewNow = true;
        attempt -= 1;
        continue;
      }
      if (response.status === 429) {
        await response.body?.cancel();
        const seconds = Number(response.headers.get('Retry-After'));
        throw new ApiError(503, 'PROVIDER_QUOTA_EXCEEDED', 'Restaurant data provider quota is exhausted',
          Number.isInteger(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 60);
      }
      if (response.status >= 500) {
        await response.body?.cancel();
        if (attempt === 0) { await jitteredDelay(250); continue; }
        throw unavailable();
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw unavailable();
      }

      const body = await readBoundedJson(response, maxBytes, invalid);
      const failure = errorSchema.safeParse(body);
      if (failure.success) {
        const code = failure.data.error.code;
        // 13: invalid or expired token. Renew once.
        if (code === 13 && !renewed) { renewed = true; renewNow = true; attempt -= 1; continue; }
        // 12/14: method or scope not available on this plan; 21: IP not registered.
        if (code === 12 || code === 14 || code === 21) throw notConfigured();
        // 22: request limit reached.
        if (code === 22) throw new ApiError(503, 'PROVIDER_QUOTA_EXCEEDED', 'Restaurant data provider quota is exhausted', 60);
        throw unavailable();
      }
      return body;
    }
  }

  return {
    async searchBrandFoods(expression, page, maxResults) {
      const body = await get('/rest/foods/search/v5', {
        search_expression: expression,
        food_type: 'brand',
        page_number: String(page),
        max_results: String(maxResults),
        flag_default_serving: 'true',
        include_sub_categories: 'true',
      });
      const parsed = searchSchema.safeParse(body);
      if (!parsed.success) throw invalid();
      const foods: FatSecretFood[] = [];
      for (const raw of parsed.data.foods_search.results?.food ?? []) {
        const food = foodSchema.safeParse(raw);
        if (!food.success) continue;
        const servings = (food.data.servings?.serving ?? [])
          .map((entry) => servingSchema.safeParse(entry))
          .filter((result) => result.success)
          .map(({ data }) => toServing(data))
          .filter((serving): serving is FatSecretServing => serving !== null);
        if (servings.length === 0) continue;
        foods.push({
          id: food.data.food_id,
          name: food.data.food_name,
          brand: food.data.brand_name?.trim() || null,
          categories: food.data.food_sub_categories?.food_sub_category ?? [],
          servings,
        });
      }
      return { foods, totalResults: parsed.data.foods_search.total_results ?? foods.length };
    },
  };
}

function toServing(raw: z.infer<typeof servingSchema>): FatSecretServing | null {
  // Calories are the one value a menu item can't be logged without.
  if (raw.calories === null) return null;
  const unit = raw.metric_serving_unit?.toLowerCase();
  const grams = raw.metric_serving_amount === null ? null
    : unit === 'g' ? raw.metric_serving_amount
      : unit === 'oz' ? raw.metric_serving_amount * 28.3495
        : null;
  return {
    id: raw.serving_id,
    description: raw.serving_description,
    grams: grams === null ? null : Math.round(grams * 10) / 10,
    calories: raw.calories,
    protein: raw.protein,
    carbs: raw.carbohydrate,
    fat: raw.fat,
    fiber: raw.fiber,
    isDefault: String(raw.is_default ?? '') === '1',
  };
}
