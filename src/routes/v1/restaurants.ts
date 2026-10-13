import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { errorSchema } from '../../contracts/common.js';
import type { ApiEnvironment } from '../../contracts/common.js';
import { ApiError } from '../../errors.js';
import type { ReserveQuota } from '../../services/quota.js';
import type { RestaurantService } from '../../services/restaurants.js';

// A place's name as a map shows it: printable text, no control characters.
const placeName = z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/);

const servingSchema = z.object({
  id: z.string(),
  description: z.string(),
  grams: z.number().nullable(),
  calories: z.number(),
  protein: z.number().nullable(),
  carbs: z.number().nullable(),
  fat: z.number().nullable(),
  fiber: z.number().nullable(),
  isDefault: z.boolean(),
}).openapi('MenuServing');

const menuSchema = z.object({
  query: z.string(),
  restaurant: z.string().nullable().openapi({ description: 'The matched chain, or null when the place has no published menu' }),
  hasMenu: z.boolean(),
  items: z.array(z.object({
    id: z.string(),
    name: z.string(),
    category: z.string().nullable(),
    servings: z.array(servingSchema),
  }).openapi('MenuItem')),
  fetchedAt: z.iso.datetime(),
  stale: z.boolean().openapi({ description: 'True when the provider failed and a cached copy was served' }),
  attribution: z.string(),
}).openapi('RestaurantMenu');

const lookupSchema = z.object({
  items: z.array(z.object({
    name: z.string(),
    restaurant: z.string().nullable(),
    hasMenu: z.boolean().nullable().openapi({ description: 'null when the lookup failed for this place; ask again later' }),
  })),
}).openapi('RestaurantLookup');

const errors = {
  400: { description: 'Invalid parameters', content: { 'application/json': { schema: errorSchema } } },
  401: { description: 'Invalid or missing token', content: { 'application/json': { schema: errorSchema } } },
  429: { description: 'User quota exceeded', content: { 'application/json': { schema: errorSchema } } },
  502: { description: 'Provider failed or returned invalid data', content: { 'application/json': { schema: errorSchema } } },
  503: { description: 'Provider not configured, provider quota exhausted, or quota service unavailable', content: { 'application/json': { schema: errorSchema } } },
  504: { description: 'Provider timed out', content: { 'application/json': { schema: errorSchema } } },
};

export function registerRestaurants(
  app: OpenAPIHono<ApiEnvironment>,
  service: RestaurantService | undefined,
  reserveQuota: ReserveQuota,
) {
  const available = () => {
    if (!service) throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'Restaurant data provider is not configured');
    return service;
  };

  app.openapi(createRoute({
    method: 'get',
    path: '/v1/restaurants/menu',
    summary: 'A chain restaurant\'s menu with nutrition per serving, matched from a place name',
    tags: ['Restaurants'],
    security: [{ BearerAuth: [] }],
    request: { query: z.object({ name: placeName.openapi({ example: 'Chipotle Mexican Grill' }) }) },
    responses: {
      200: { description: 'The menu, or hasMenu false for places without one', content: { 'application/json': { schema: menuSchema } } },
      ...errors,
    },
  }), async (context) => {
    const { name } = context.req.valid('query');
    const restaurants = available();
    await reserveQuota(context.get('userId'), 'restaurants');
    return context.json(await restaurants.menu(name), 200);
  });

  app.openapi(createRoute({
    method: 'post',
    path: '/v1/restaurants/lookup',
    summary: 'Which nearby places are chains with published menus',
    tags: ['Restaurants'],
    security: [{ BearerAuth: [] }],
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: z.object({ names: z.array(placeName).min(1).max(12) }) } },
      },
    },
    responses: {
      200: { description: 'One result per name, in order', content: { 'application/json': { schema: lookupSchema } } },
      ...errors,
    },
  }), async (context) => {
    const { names } = context.req.valid('json');
    const restaurants = available();
    await reserveQuota(context.get('userId'), 'restaurants');
    return context.json({ items: await restaurants.lookup(names) }, 200);
  });
}
