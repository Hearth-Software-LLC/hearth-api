import { randomUUID } from 'node:crypto';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { secureHeaders } from 'hono/secure-headers';
import { HTTPException } from 'hono/http-exception';
import { readConfig } from './config.js';
import type { Config } from './config.js';
import { errorSchema } from './contracts/common.js';
import type { ApiEnvironment } from './contracts/common.js';
import { ApiError } from './errors.js';
import { authMiddleware, createTokenVerifier } from './middleware/auth.js';
import type { VerifyToken } from './middleware/auth.js';
import { registerBrands } from './routes/v1/brands.js';
import { registerFoods } from './routes/v1/foods.js';
import { createQuota } from './services/quota.js';
import type { ReserveQuota } from './services/quota.js';
import { registerBanking } from './routes/v1/banking.js';
import { createPlaidDataClient, createPlaidLinkClient } from './integrations/plaid.js';
import type { CreateLinkToken, PlaidDataClient } from './integrations/plaid.js';
import { createConnectionStore } from './services/connections.js';
import type { ConnectionStore } from './services/connections.js';
import { createTokenSeal } from './services/token-seal.js';
import type { TokenSeal } from './services/token-seal.js';
import { createCache } from './services/cache.js';
import type { Cache } from './services/cache.js';
import { createFatSecret } from './integrations/fatsecret.js';
import { createRestaurantService } from './services/restaurants.js';
import { registerRestaurants } from './routes/v1/restaurants.js';
import { registerBigTable } from './bigtable/register.js';
import { registerAppLinks } from './routes/app-links.js';

export type AppOptions = {
  config?: Config;
  verifyToken?: VerifyToken;
  reserveQuota?: ReserveQuota;
  fetcher?: typeof fetch;
  logger?: (record: RequestLog) => void;
  plaidLinkClient?: CreateLinkToken;
  plaidDataClient?: PlaidDataClient;
  connectionStore?: ConnectionStore;
  tokenSeal?: TokenSeal;
  cache?: Cache;
};

type RequestLog = {
  requestId: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
};

export function createApp(options: AppOptions = {}) {
  const config = options.config ?? readConfig();
  const logger = options.logger ?? ((record: RequestLog) => {
    if (process.env.NODE_ENV !== 'test') console.info(JSON.stringify(record));
  });
  const app = new OpenAPIHono<ApiEnvironment>({
    defaultHook: (result) => {
      if (!result.success) throw new ApiError(400, 'INVALID_REQUEST', 'Request parameters are invalid');
    },
  });

  app.use('*', async (context, next) => {
    const startedAt = performance.now();
    const requestId = randomUUID();
    context.set('requestId', requestId);
    context.header('X-Request-ID', requestId);
    context.header('Cache-Control', 'no-store');
    await next();
    logger({
      requestId,
      method: context.req.method,
      route: context.req.routePath ?? 'unmatched',
      status: context.res.status,
      durationMs: Math.round(performance.now() - startedAt),
    });
  });
  app.use('*', secureHeaders());

  app.onError((error, context) => {
    if (error instanceof HTTPException && error.status === 400) {
      error = new ApiError(400, 'INVALID_REQUEST', 'Request body is invalid');
    }
    if (error instanceof ApiError) {
      if (error.status === 401) context.header('WWW-Authenticate', 'Bearer');
      if (error.retryAfter !== undefined) context.header('Retry-After', String(error.retryAfter));
      return context.json({
        error: { code: error.code, message: error.message, requestId: context.get('requestId') },
      }, error.status);
    }
    return context.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        requestId: context.get('requestId'),
      },
    }, 500);
  });
  app.notFound((context) => context.json({
    error: {
      code: 'RESOURCE_NOT_FOUND',
      message: 'Route not found',
      requestId: context.get('requestId'),
    },
  }, 404));

  app.openapi(createRoute({
    method: 'get',
    path: '/health',
    tags: ['Operations'],
    summary: 'Liveness check; does not check external services',
    responses: {
      200: {
        description: 'Process is available',
        content: { 'application/json': { schema: z.object({ status: z.literal('ok') }) } },
      },
    },
  }), (context) => context.json({ status: 'ok' as const }, 200));

  app.openAPIRegistry.registerComponent('securitySchemes', 'BearerAuth', {
    type: 'http', scheme: 'bearer', bearerFormat: 'JWT',
  });
  const verifyToken = options.verifyToken ?? createTokenVerifier(config);
  // Every /v1 route requires a bearer token up front, except BigTable's (/v1/bigtable/*),
  // which authenticate inside their handlers because a few of them are public.
  const requireAuth = authMiddleware(verifyToken);
  app.use('/v1/*', async (context, next) => {
    if (context.req.path.startsWith('/v1/bigtable/')) return next();
    return requireAuth(context, next);
  });

  app.openapi(createRoute({
    method: 'get',
    path: '/v1/me',
    tags: ['Identity'],
    summary: 'Return the authenticated subject',
    security: [{ BearerAuth: [] }],
    responses: {
      200: {
        description: 'Verified identity',
        content: { 'application/json': { schema: z.object({ id: z.string() }).openapi('Identity') } },
      },
      401: { description: 'Invalid or missing token', content: { 'application/json': { schema: errorSchema } } },
      503: { description: 'Authentication unavailable', content: { 'application/json': { schema: errorSchema } } },
    },
  }), (context) => context.json({ id: context.get('userId') }, 200));

  const reserveQuota = options.reserveQuota ?? createQuota(config);
  registerBrands(app, config, reserveQuota);
  registerFoods(app, config, reserveQuota, options.fetcher ?? fetch);
  const cache = options.cache ?? createCache(config);
  const fatSecret = createFatSecret(config, cache, options.fetcher ?? fetch);
  registerRestaurants(app, fatSecret && createRestaurantService(fatSecret, cache, config.RESTAURANT_CACHE_HOURS), reserveQuota);
  registerBanking(app, config, reserveQuota, {
    linkClient: options.plaidLinkClient ?? createPlaidLinkClient(config),
    dataClient: options.plaidDataClient ?? createPlaidDataClient(config),
    store: options.connectionStore ?? createConnectionStore(config, options.fetcher ?? fetch),
    seal: options.tokenSeal ?? (config.PLAID_TOKEN_KEY ? createTokenSeal(config.PLAID_TOKEN_KEY) : undefined),
  });

  registerBigTable(app, verifyToken);
  registerAppLinks(app, config);

  app.doc('/openapi.json', {
    openapi: '3.0.0',
    info: { title: 'Hearth API', version: '1.0.0' },
  });

  return app;
}