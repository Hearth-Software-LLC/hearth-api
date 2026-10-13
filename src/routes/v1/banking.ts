import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import type { Config } from '../../config.js';
import { errorSchema } from '../../contracts/common.js';
import type { ApiEnvironment } from '../../contracts/common.js';
import { ApiError } from '../../errors.js';
import { createLinkToken } from '../../integrations/plaid.js';
import type { CreateLinkToken } from '../../integrations/plaid.js';
import type { ReserveQuota } from '../../services/quota.js';

export function registerBanking(
  app: OpenAPIHono<ApiEnvironment>,
  config: Config,
  reserveQuota: ReserveQuota,
  client: CreateLinkToken | undefined,
) {
  app.use('/v1/banking/link-token', async (context, next) => {
    if (context.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      throw new ApiError(400, 'INVALID_REQUEST', 'An application/json body is required');
    }
    await next();
  });
  app.use('/v1/banking/link-token', bodyLimit({
    maxSize: 1024,
    onError: () => { throw new ApiError(400, 'INVALID_REQUEST', 'Request body is too large'); },
  }));
  app.openapi(createRoute({
    method: 'post',
    path: '/v1/banking/link-token',
    summary: 'Create a fresh Plaid Link token for the authenticated user',
    tags: ['Banking'],
    security: [{ BearerAuth: [] }],
    request: {
      body: { required: true, content: { 'application/json': { schema: z.object({}).strict().openapi('CreatePlaidLinkToken') } } },
    },
    responses: {
      200: {
        description: 'Short-lived token for the iOS Plaid Link SDK, not a bank access token',
        content: { 'application/json': { schema: z.object({
          linkToken: z.string(), expiresAt: z.iso.datetime({ offset: true }), plaidRequestId: z.string(),
        }).openapi('PlaidLinkToken') } },
      },
      400: { description: 'Invalid, missing, or oversized JSON body', content: { 'application/json': { schema: errorSchema } } },
      401: { description: 'Invalid or missing token', content: { 'application/json': { schema: errorSchema } } },
      429: { description: 'User quota exceeded', content: { 'application/json': { schema: errorSchema } } },
      502: { description: 'Plaid failed or returned invalid data', content: { 'application/json': { schema: errorSchema } } },
      503: { description: 'Required service unavailable or provider quota exhausted', content: { 'application/json': { schema: errorSchema } } },
      504: { description: 'Plaid timed out', content: { 'application/json': { schema: errorSchema } } },
    },
  }), async (context) => {
    if (!client || !config.PLAID_CLIENT_ID || !config.PLAID_SECRET || !config.PLAID_PRODUCTS || !config.PLAID_REDIRECT_URI) {
      throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'Plaid is not configured');
    }
    const userId = context.get('userId');
    await reserveQuota(userId, 'plaid-link');
    return context.json(await createLinkToken(config, userId, client), 200);
  });
}