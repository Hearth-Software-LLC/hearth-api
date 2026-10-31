import { createHash } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono, RouteConfig } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { errorSchema } from '../contracts/common.js';
import type { ApiEnvironment } from '../contracts/common.js';
import { verifyResendWebhook } from '../email/resend.js';
import { ApiError } from '../errors.js';
import { need, teamOf } from '../studio/gate.js';
import type { WaitlistService } from './service.js';

/**
 * The beta funnel's routes. Public: the website's waitlist form (/v1/waitlist), the confirm link,
 * the beta pages' details (/v1/beta) and TestFlight button counter (/go/tf/<app>), and Resend's
 * webhook. Hearth Connect's (/v1/studio/…): the Beta card, "what's new" lines and the launch email.
 */

/** Paths under /v1 that skip sign-in (checked by the /v1 auth middleware). */
export const PUBLIC_BETA = /^\/v1\/(waitlist(\/confirm)?|beta(\/[a-z0-9-]{1,40})?)$/;

export const WEBSITE_ORIGINS = ['https://hearthapps.com', 'https://www.hearthapps.com', 'http://localhost:3000'];

export type WaitlistDependencies = {
  service: () => WaitlistService | undefined;
  /** True when this caller may sign up again now (5 an hour per address, through Upstash). */
  allow?: (key: string) => Promise<boolean>;
  webhookSecret?: string | undefined;
};

const appKey = z.string().regex(/^[a-z0-9-]{1,40}$/);
const failure = (description: string) => ({ description, content: { 'application/json': { schema: errorSchema } } });
const errors = {
  400: failure('Invalid request'), 401: failure('Invalid or missing token'), 403: failure('Not allowed'),
  404: failure('Not found'), 409: failure('Conflicts with something'), 503: failure('Not configured'),
} as const;
const anyJson = (description: string) => ({ description, content: { 'application/json': { schema: z.any() } } });
const body = <T extends z.ZodType>(schema: T) => ({ body: { required: true, content: { 'application/json': { schema } } } });
const route = <R extends Omit<RouteConfig, 'tags' | 'security'>>(config: R) =>
  createRoute({ ...config, tags: ['Studio beta'], security: [{ BearerAuth: [] }] } as R & { tags: string[] });

const signup = z.object({
  email: z.string().trim().min(3).max(254),
  apps: z.array(appKey).min(1).max(6),
  via: z.string().max(60).optional(),
  page: z.string().max(200).optional(),
  company: z.string().max(200).optional(),
});

export function registerWaitlist(app: OpenAPIHono<ApiEnvironment>, dependencies: WaitlistDependencies) {
  const service = () => {
    const value = dependencies.service();
    if (!value) throw new ApiError(503, 'STORAGE_NOT_CONFIGURED', 'The waitlist is not configured (DATABASE_URL, SOCIAL_TOKEN_KEY)');
    return value;
  };
  const website = cors({ origin: WEBSITE_ORIGINS, allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type'], maxAge: 86_400 });
  app.use('/v1/waitlist', website);
  app.use('/v1/beta', website);
  app.use('/v1/beta/*', website);

  // MARK: Public

  app.post('/v1/waitlist', async (context) => {
    const type = context.req.header('content-type') ?? '';
    const isForm = type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data');
    let input: z.infer<typeof signup>;
    if (isForm) {
      const form = await context.req.parseBody({ all: true });
      const many = (value: unknown) => (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(String);
      const parsed = signup.safeParse({
        email: String(form.email ?? ''),
        apps: many(form.apps).flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean),
        via: form.via ? String(form.via) : undefined,
        page: form.page ? String(form.page) : undefined,
        company: form.company ? String(form.company) : undefined,
      });
      if (!parsed.success) return context.redirect(service().thanksPage(undefined), 303);
      input = parsed.data;
    } else {
      const parsed = signup.safeParse(await context.req.json().catch(() => undefined));
      if (!parsed.success) throw new ApiError(400, 'INVALID_REQUEST', 'Send an email address and at least one app');
      input = parsed.data;
    }
    const done = () => (isForm ? context.redirect(service().thanksPage(input.apps), 303) : context.json({ ok: true as const }, 202));
    // A filled honeypot is a bot: answer like a success, do nothing.
    if (input.company) return done();
    const forwarded = context.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const key = createHash('sha256').update(`${forwarded}|${input.email.trim().toLowerCase()}`).digest('hex').slice(0, 32);
    if (dependencies.allow && !(await dependencies.allow(key))) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many sign-ups from here. Try again in a little while.', 3600);
    }
    try {
      await service().join({ email: input.email, apps: input.apps, via: input.via, page: input.page });
    } catch (error) {
      if (isForm && error instanceof ApiError && error.status === 400) return context.redirect(service().thanksPage(undefined), 303);
      throw error;
    }
    return done();
  });

  app.get('/v1/waitlist/confirm', async (context) => {
    const token = context.req.query('t') ?? '';
    const confirmed = token.length > 0 && token.length < 600 ? await service().confirm(token) : undefined;
    context.header('referrer-policy', 'no-referrer');
    return context.redirect(service().confirmedPage(confirmed?.apps), 302);
  });

  app.get('/v1/beta', async (context) => {
    context.header('Cache-Control', 'public, max-age=300');
    return context.json({ apps: await service().betaApps() }, 200);
  });

  app.get('/v1/beta/:app', async (context) => {
    const key = context.req.param('app');
    if (!/^[a-z0-9-]{1,40}$/.test(key)) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'No beta page for that app');
    const found = await service().betaApp(key);
    context.header('Cache-Control', 'public, max-age=300');
    return context.json(found, 200);
  });

  app.get('/go/tf/:app', async (context) => {
    const key = context.req.param('app').toLowerCase();
    const target = /^[a-z0-9-]{1,40}$/.test(key)
      ? await service().testflight(key, context.req.query('via')?.toLowerCase(), context.req.header('user-agent'))
      : undefined;
    if (!target) return context.text('This link isn’t available.', 404);
    context.header('cache-control', 'no-store');
    context.header('referrer-policy', 'no-referrer');
    return context.redirect(target, 302);
  });

  app.post('/webhooks/resend', async (context) => {
    if (!dependencies.webhookSecret) throw new ApiError(503, 'EMAIL_NOT_CONFIGURED', 'The Resend webhook is not configured (RESEND_WEBHOOK_SECRET)');
    const raw = await context.req.text();
    const valid = verifyResendWebhook(dependencies.webhookSecret, {
      id: context.req.header('svix-id'), timestamp: context.req.header('svix-timestamp'), signature: context.req.header('svix-signature'),
    }, raw);
    if (!valid) throw new ApiError(401, 'INVALID_SIGNATURE', 'The webhook signature doesn’t match');
    let event: { type?: unknown; data?: Record<string, unknown> };
    try { event = JSON.parse(raw) as typeof event; } catch { throw new ApiError(400, 'INVALID_REQUEST', 'Request body is invalid'); }
    return context.json(await service().webhook(event), 200);
  });

  // MARK: Hearth Connect

  app.openapi(route({
    method: 'get', path: '/v1/studio/beta/summary', summary: 'Beta sign-ups and taps per app (the Beta card)',
    request: { query: z.object({ days: z.coerce.number().int().min(1).max(365).default(7) }) },
    responses: { 200: anyJson('Summary'), ...errors },
  }), async (context) => {
    teamOf(context);
    return context.json(await service().summary(context.req.valid('query').days), 200);
  });

  app.openapi(route({
    method: 'get', path: '/v1/studio/beta', summary: 'Every beta app’s page details',
    responses: { 200: anyJson('Beta apps'), ...errors },
  }), async (context) => {
    teamOf(context);
    return context.json({ apps: await service().betaApps() }, 200);
  });

  app.openapi(route({
    method: 'put', path: '/v1/studio/beta/{app}', summary: 'Change a beta page’s “what’s new this week” lines',
    request: {
      params: z.object({ app: appKey.openapi({ param: { name: 'app', in: 'path' } }) }),
      ...body(z.object({ whatsNew: z.array(z.string().trim().min(1).max(120)).max(6) }).strict()),
    },
    responses: { 200: anyJson('Beta app'), ...errors },
  }), async (context) => {
    const member = need(context, 'post');
    return context.json(await service().setWhatsNew(context.req.valid('param').app, context.req.valid('json').whatsNew, member.userId), 200);
  });

  app.openapi(route({
    method: 'post', path: '/v1/studio/waitlist/launch',
    summary: 'The launch email for an app: a preview, or (send: true) a broadcast to everyone confirmed for it. Owners and admins.',
    request: body(z.object({ app: appKey, appStoreUrl: z.string().url().max(300), send: z.boolean().default(false) }).strict()),
    responses: { 200: anyJson('Preview or sent'), ...errors },
  }), async (context) => {
    const member = need(context, 'monetization');
    const input = context.req.valid('json');
    return context.json(await service().launch({ ...input, by: member.userId }), 200);
  });

  app.openapi(route({
    method: 'delete', path: '/v1/studio/waitlist', summary: 'Take someone off the waitlist and out of Resend (when they ask)',
    request: { query: z.object({ email: z.string().trim().min(3).max(254) }) },
    responses: { 200: anyJson('Removed'), ...errors },
  }), async (context) => {
    need(context, 'post');
    await service().remove(context.req.valid('query').email);
    return context.json({ ok: true as const }, 200);
  });
}
