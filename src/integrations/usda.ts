import { z } from 'zod';
import { ApiError } from '../errors.js';

const searchResponseSchema = z.object({
  totalPages: z.number().int().nonnegative(),
  foods: z.array(z.object({
    fdcId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    description: z.string().min(1).max(4096),
    dataType: z.string().min(1).max(100),
    brandName: z.string().max(1024).nullish(),
    brandOwner: z.string().max(1024).nullish(),
  })).max(25),
});

const maxResponseBytes = 1_048_576;

async function readBoundedJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('Content-Length')) > maxResponseBytes || !response.body) {
    await response.body?.cancel();
    throw new ApiError(502, 'UPSTREAM_INVALID_RESPONSE', 'Food provider returned an invalid response');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) {
        await reader.cancel();
        throw new ApiError(502, 'UPSTREAM_INVALID_RESPONSE', 'Food provider returned an invalid response');
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new ApiError(502, 'UPSTREAM_INVALID_RESPONSE', 'Food provider returned an invalid response');
    }
  } finally {
    reader.releaseLock();
  }
}

export async function searchFoods(
  key: string,
  query: string,
  limit: number,
  page: number,
  fetcher: typeof fetch = fetch,
) {
  const url = new URL('https://api.nal.usda.gov/fdc/v1/foods/search');
  url.searchParams.set('api_key', key);
  const signal = AbortSignal.timeout(8000);

  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, pageSize: limit, pageNumber: page }),
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429) {
        const retrySeconds = Number(response.headers.get('Retry-After'));
        const retryAfter = Number.isInteger(retrySeconds) && retrySeconds > 0
          ? Math.min(retrySeconds, 3600) : 3600;
        throw new ApiError(503, 'PROVIDER_QUOTA_EXCEEDED', 'Food provider quota is exhausted', retryAfter);
      }
      throw new ApiError(502, 'UPSTREAM_UNAVAILABLE', 'Food provider is temporarily unavailable');
    }

    const parsed = searchResponseSchema.safeParse(await readBoundedJson(response));
    if (!parsed.success) {
      throw new ApiError(502, 'UPSTREAM_INVALID_RESPONSE', 'Food provider returned an invalid response');
    }
    return {
      items: parsed.data.foods.map((food) => ({
        id: `usda:${food.fdcId}`,
        name: food.description,
        dataType: food.dataType,
        brand: food.brandName ?? food.brandOwner ?? null,
        provider: 'usda' as const,
      })),
      nextCursor: page < parsed.data.totalPages && page < 999 ? String(page + 1) : null,
      fetchedAt: new Date().toISOString(),
      attribution: 'USDA FoodData Central',
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (signal.aborted) {
      throw new ApiError(504, 'UPSTREAM_TIMEOUT', 'Food provider did not respond in time');
    }
    throw new ApiError(502, 'UPSTREAM_UNAVAILABLE', 'Food provider is temporarily unavailable');
  }
}