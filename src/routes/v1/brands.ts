import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Config } from '../../config.js';
import { errorSchema } from '../../contracts/common.js';
import type { ApiEnvironment } from '../../contracts/common.js';
import { ApiError } from '../../errors.js';
import { logoUrl } from '../../integrations/logo-dev.js';
import type { ReserveQuota } from '../../services/quota.js';

const querySchema = z.object({
  domain: z.string().trim().toLowerCase().max(253)
    .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/)
    .openapi({ example: 'apple.com', description: 'DNS domain only, not a URL; use punycode for international domains' }),
  size: z.coerce.number().int().min(16).max(512).default(128),
  format: z.enum(['png', 'webp']).default('png'),
});

export function registerBrands(app: OpenAPIHono<ApiEnvironment>, config: Config, reserveQuota: ReserveQuota) {
  app.openapi(createRoute({
    method: 'get',
    path: '/v1/brands/logo',
    summary: 'Resolve a Logo.dev CDN URL; does not confirm a logo exists',
    tags: ['Brands'],
    security: [{ BearerAuth: [] }],
    request: { query: querySchema },
    responses: {
      200: {
        description: 'Direct image URL with a publishable key; image may return 404',
        content: { 'application/json': { schema: z.object({
          domain: z.string(), url: z.url(), provider: z.literal('logo.dev'),
        }).openapi('BrandLogo') } },
      },
      400: { description: 'Invalid parameters', content: { 'application/json': { schema: errorSchema } } },
      401: { description: 'Invalid or missing token', content: { 'application/json': { schema: errorSchema } } },
      429: { description: 'User quota exceeded', content: { 'application/json': { schema: errorSchema } } },
      503: { description: 'Authentication, provider configuration, or quota service unavailable', content: { 'application/json': { schema: errorSchema } } },
    },
  }), async (context) => {
    const { domain, size, format } = context.req.valid('query');
    const key = config.LOGO_DEV_PUBLISHABLE_KEY;
    if (!key) throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'Logo provider is not configured');
    await reserveQuota(context.get('userId'), 'logos');
    return context.json({ domain, url: logoUrl(key, domain, size, format), provider: 'logo.dev' as const }, 200);
  });
}