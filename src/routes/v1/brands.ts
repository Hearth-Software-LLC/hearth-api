import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Config } from '../../config.js';
import { errorSchema } from '../../contracts/common.js';
import type { ApiEnvironment } from '../../contracts/common.js';
import { ApiError } from '../../errors.js';
import { logoNameUrl, logoUrl } from '../../integrations/logo-dev.js';
import type { ReserveQuota } from '../../services/quota.js';

const domainSchema = z.string().trim().toLowerCase().max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/);

const querySchema = z.object({
  domain: domainSchema
    .openapi({ example: 'apple.com', description: 'DNS domain only, not a URL; use punycode for international domains' }),
  size: z.coerce.number().int().min(16).max(512).default(128),
  format: z.enum(['png', 'webp']).default('png'),
});

// A brand name as a catalog spells it: printable text, no control characters.
const brandName = z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/);

const batchSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1).max(200).openapi({ description: 'The caller\'s key for this item, echoed back' }),
    domain: domainSchema.optional().openapi({ example: 'chipotle.com', description: 'Preferred: the place\'s own website domain' }),
    name: brandName.optional().openapi({ example: 'Chipotle', description: 'A known brand name, used only when there is no domain' }),
  }).refine((item) => item.domain !== undefined || item.name !== undefined, { message: 'Each item needs a domain or a name' }))
    .min(1).max(24),
  size: z.number().int().min(16).max(512).default(128),
  format: z.enum(['png', 'webp']).default('png'),
});

const errors = {
  400: { description: 'Invalid parameters', content: { 'application/json': { schema: errorSchema } } },
  401: { description: 'Invalid or missing token', content: { 'application/json': { schema: errorSchema } } },
  429: { description: 'User quota exceeded', content: { 'application/json': { schema: errorSchema } } },
  503: { description: 'Authentication, provider configuration, or quota service unavailable', content: { 'application/json': { schema: errorSchema } } },
};

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
      ...errors,
    },
  }), async (context) => {
    const { domain, size, format } = context.req.valid('query');
    const key = config.LOGO_DEV_PUBLISHABLE_KEY;
    if (!key) throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'Logo provider is not configured');
    await reserveQuota(context.get('userId'), 'logos');
    return context.json({ domain, url: logoUrl(key, domain, size, format), provider: 'logo.dev' as const }, 200);
  });

  app.openapi(createRoute({
    method: 'post',
    path: '/v1/brands/logos',
    summary: 'Resolve Logo.dev CDN URLs for up to 24 brands at once, by domain or known brand name',
    description: 'No provider call is made: each URL points at the Logo.dev CDN and may 404 when there is no logo. '
      + 'A domain is used when given; a name only otherwise, so pass names only for known brands.',
    tags: ['Brands'],
    security: [{ BearerAuth: [] }],
    request: { body: { required: true, content: { 'application/json': { schema: batchSchema } } } },
    responses: {
      200: {
        description: 'One result per item, in order',
        content: { 'application/json': { schema: z.object({
          items: z.array(z.object({ id: z.string(), url: z.url(), source: z.enum(['domain', 'name']) })),
          provider: z.literal('logo.dev'),
          attribution: z.string(),
        }).openapi('BrandLogos') } },
      },
      ...errors,
    },
  }), async (context) => {
    const { items, size, format } = context.req.valid('json');
    const key = config.LOGO_DEV_PUBLISHABLE_KEY;
    if (!key) throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'Logo provider is not configured');
    await reserveQuota(context.get('userId'), 'logos');
    return context.json({
      items: items.map((item) => item.domain
        ? { id: item.id, url: logoUrl(key, item.domain, size, format), source: 'domain' as const }
        : { id: item.id, url: logoNameUrl(key, item.name!, size, format), source: 'name' as const }),
      provider: 'logo.dev' as const,
      attribution: 'Logos provided by Logo.dev',
    }, 200);
  });
}
