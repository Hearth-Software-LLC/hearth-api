import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Config } from '../../config.js';
import { errorSchema } from '../../contracts/common.js';
import type { ApiEnvironment } from '../../contracts/common.js';
import { ApiError } from '../../errors.js';
import { searchFoods } from '../../integrations/usda.js';
import type { ReserveQuota } from '../../services/quota.js';

const querySchema = z.object({
  q: z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/).openapi({ example: 'apple' }),
  limit: z.coerce.number().int().min(1).max(25).default(20),
  cursor: z.string().regex(/^[1-9]\d{0,2}$/).optional()
    .openapi({ description: 'Page-backed cursor from nextCursor; keep q and limit unchanged' }),
});

const resultSchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    name: z.string(),
    dataType: z.string(),
    brand: z.string().nullable(),
    provider: z.literal('usda'),
  })),
  nextCursor: z.string().nullable(),
  fetchedAt: z.iso.datetime(),
  attribution: z.string(),
}).openapi('FoodSearchResults');

export function registerFoods(
  app: OpenAPIHono<ApiEnvironment>,
  config: Config,
  reserveQuota: ReserveQuota,
  fetcher: typeof fetch,
) {
  app.openapi(createRoute({
    method: 'get',
    path: '/v1/foods/search',
    summary: 'Search USDA food summaries (not normalized nutrient details)',
    tags: ['Foods'],
    security: [{ BearerAuth: [] }],
    request: { query: querySchema },
    responses: {
      200: { description: 'Food summaries', content: { 'application/json': { schema: resultSchema } } },
      400: { description: 'Invalid parameters', content: { 'application/json': { schema: errorSchema } } },
      401: { description: 'Invalid or missing token', content: { 'application/json': { schema: errorSchema } } },
      429: { description: 'User quota exceeded', content: { 'application/json': { schema: errorSchema } } },
      502: { description: 'Food provider failed or returned invalid data', content: { 'application/json': { schema: errorSchema } } },
      503: { description: 'Required service unavailable or provider quota exceeded', content: { 'application/json': { schema: errorSchema } } },
      504: { description: 'Food provider timed out', content: { 'application/json': { schema: errorSchema } } },
    },
  }), async (context) => {
    const { q: query, limit, cursor } = context.req.valid('query');
    const key = config.USDA_API_KEY;
    if (!key) throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'Food provider is not configured');
    await reserveQuota(context.get('userId'), 'foods');
    return context.json(await searchFoods(key, query, limit, Number(cursor ?? 1), fetcher), 200);
  });
}