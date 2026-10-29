import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono, RouteConfig } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { errorSchema } from '../contracts/common.js';
import type { ApiEnvironment } from '../contracts/common.js';
import { ApiError } from '../errors.js';
import { memberOf, need, teamOf } from '../studio/gate.js';
import { can } from '../studio/team.js';
import type { LinkService } from './links.js';
import type { AffiliateService, AffiliateView } from './service.js';

/**
 * Affiliates, campaign links and App Store campaign numbers in Hearth Studio (/v1/studio/…, the
 * team's), an affiliate's own view (/v1/affiliate/…, only theirs), and short links (/go/<slug>).
 */

export type AffiliateDependencies = {
  affiliates: () => AffiliateService | undefined;
  links: () => LinkService | undefined;
  /** RevenueCat webhook payloads stored between two instants, for reconciling. */
  events: () => ((start: Date, end: Date) => Promise<unknown[]>) | undefined;
  /** Runs the App Store Connect import now (also the daily cron). */
  importStats: () => ((team: string) => Promise<unknown>) | undefined;
};

const appKey = z.string().regex(/^[a-z0-9-]{1,40}$/);
const uuid = z.uuid();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const days = z.coerce.number().int().min(1).max(400).default(30);

const failure = (description: string) => ({ description, content: { 'application/json': { schema: errorSchema } } });
const errors = {
  400: failure('Invalid request'), 401: failure('Invalid or missing token'), 403: failure('Not allowed'),
  404: failure('Not found'), 409: failure('Conflicts with something'), 503: failure('Not configured'),
} as const;
const anyJson = (description: string) => ({ description, content: { 'application/json': { schema: z.any() } } });
const csv = (description: string) => ({ description, content: { 'text/csv': { schema: z.string() } } });
const body = <T extends z.ZodType>(schema: T) => ({ body: { required: true, content: { 'application/json': { schema } } } });
const route = <R extends Omit<RouteConfig, 'tags' | 'security'>>(tag: string, config: R) =>
  createRoute({ ...config, tags: [tag], security: [{ BearerAuth: [] }] } as R & { tags: string[] });
const idParam = (_name: 'id') => z.object({ id: uuid.openapi({ param: { name: 'id', in: 'path' } }) });
const ok = { ok: true as const };

const terms = {
  rateBps: z.number().int().min(0).max(10000).nullable().optional(),
  flatCents: z.number().int().min(0).max(1_000_000).nullable().optional(),
  windowMonths: z.number().int().min(1).max(120).optional(),
};

/** Without the affiliates permission, a member sees who and which apps, not money or contact details. */
function forMember(context: Pick<Context<ApiEnvironment>, 'get'>, affiliate: AffiliateView) {
  if (can(memberOf(context), 'affiliates')) return affiliate;
  const { owedCents: _owed, monthCents: _month, contact: _contact, terms: _terms, ...rest } = affiliate;
  return rest;
}

export function registerAffiliates(app: OpenAPIHono<ApiEnvironment>, dependencies: AffiliateDependencies) {
  const required = <T>(get: () => T | undefined, what: string): T => {
    const value = get();
    if (!value) throw new ApiError(503, 'STORAGE_NOT_CONFIGURED', `${what} is not configured`);
    return value;
  };
  const affiliates = () => required(dependencies.affiliates, 'Affiliates (DATABASE_URL, SOCIAL_TOKEN_KEY)');
  const links = () => required(dependencies.links, 'Campaign links (DATABASE_URL)');

  // MARK: Affiliates (the team's)

  app.openapi(route('Studio affiliates', {
    method: 'get', path: '/v1/studio/affiliates', summary: 'Every affiliate, with what is owed (amounts need the affiliates permission)',
    responses: { 200: anyJson('Affiliates'), ...errors },
  }), async (context) => {
    const team = teamOf(context);
    const list = await affiliates().list(team);
    const money = can(memberOf(context), 'affiliates');
    const flags = money ? (await affiliates().flags(team)).length : 0;
    return context.json({
      affiliates: list.map((entry) => forMember(context, entry)),
      ...(money ? { owedCents: list.reduce((sum, entry) => sum + entry.owedCents, 0), openFlags: flags } : {}),
    }, 200);
  });

  app.openapi(route('Studio affiliates', {
    method: 'post', path: '/v1/studio/affiliates', summary: 'Add an affiliate: a percentage of proceeds or a flat amount per subscriber',
    request: body(z.object({ name: z.string().trim().min(1).max(80), contact: z.string().trim().max(200).nullable().optional(), ...terms }).strict()),
    responses: { 200: anyJson('Affiliate'), ...errors },
  }), async (context) => {
    const member = need(context, 'affiliates');
    return context.json(await affiliates().create(member.teamId, context.req.valid('json')), 200);
  });

  app.openapi(route('Studio affiliates', {
    method: 'get', path: '/v1/studio/affiliates/{id}', summary: 'An affiliate with codes, links, recent credit and payouts',
    request: { params: idParam('id'), query: z.object({ month: month.optional() }) },
    responses: { 200: anyJson('Affiliate'), ...errors },
  }), async (context) => {
    const team = teamOf(context);
    const { id } = context.req.valid('param');
    const affiliate = await affiliates().get(team, id);
    const codes = await affiliates().codes(team, id);
    const theirLinks = dependencies.links() ? await links().list(team, { affiliateId: id }) : [];
    if (!can(memberOf(context), 'affiliates')) return context.json({ affiliate: forMember(context, affiliate), codes, links: theirLinks }, 200);
    const { month: wanted } = context.req.valid('query');
    return context.json({
      affiliate, codes, links: theirLinks,
      credits: await affiliates().credits(team, id, wanted),
      payouts: await affiliates().payouts(team, id),
      flags: await affiliates().flags(team, id),
    }, 200);
  });

  app.openapi(route('Studio affiliates', {
    method: 'patch', path: '/v1/studio/affiliates/{id}', summary: 'Change an affiliate (new terms apply to purchases from now on)',
    request: {
      params: idParam('id'),
      ...body(z.object({ name: z.string().trim().min(1).max(80).optional(), contact: z.string().trim().max(200).nullable().optional(), active: z.boolean().optional(), ...terms }).strict()),
    },
    responses: { 200: anyJson('Affiliate'), ...errors },
  }), async (context) => {
    const member = need(context, 'affiliates');
    return context.json(await affiliates().update(member.teamId, context.req.valid('param').id, context.req.valid('json')), 200);
  });

  app.openapi(route('Studio affiliates', {
    method: 'post', path: '/v1/studio/affiliates/{id}/codes', summary: 'Give an affiliate a code (an App Store offer code, or a referral code the app asks for)',
    request: {
      params: idParam('id'),
      ...body(z.object({
        app: appKey, code: z.string().trim().min(3).max(40), kind: z.enum(['apple_offer', 'referral']),
        offerRef: z.string().trim().min(1).max(100).nullable().optional(),
      }).strict()),
    },
    responses: { 200: anyJson('Code'), ...errors },
  }), async (context) => {
    const member = need(context, 'affiliates');
    return context.json(await affiliates().addCode(member.teamId, context.req.valid('param').id, context.req.valid('json')), 200);
  });

  app.openapi(route('Studio affiliates', {
    method: 'patch', path: '/v1/studio/affiliate-codes/{id}', summary: 'Turn a code off or on',
    request: { params: idParam('id'), ...body(z.object({ active: z.boolean().optional(), offerRef: z.string().trim().min(1).max(100).nullable().optional() }).strict()) },
    responses: { 200: anyJson('Code'), ...errors },
  }), async (context) => {
    const member = need(context, 'affiliates');
    return context.json(await affiliates().updateCode(member.teamId, context.req.valid('param').id, context.req.valid('json')), 200);
  });

  app.openapi(route('Studio affiliates', {
    method: 'get', path: '/v1/studio/affiliates/{id}/statement', summary: 'A month’s statement as CSV',
    request: { params: idParam('id'), query: z.object({ month }) },
    responses: { 200: csv('Statement'), ...errors },
  }), async (context) => {
    const member = need(context, 'affiliates');
    const statement = await affiliates().statement(member.teamId, context.req.valid('param').id, context.req.valid('query').month);
    return context.body(statement.csv, 200, {
      'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${statement.filename}"`,
    });
  });

  app.openapi(route('Studio affiliates', {
    method: 'post', path: '/v1/studio/affiliates/{id}/adjustments', summary: 'A correction by hand, on the next payout',
    request: { params: idParam('id'), ...body(z.object({ cents: z.number().int().min(-1_000_000).max(1_000_000).refine((value) => value !== 0), note: z.string().trim().min(1).max(300) }).strict()) },
    responses: { 200: anyJson('Affiliate'), ...errors },
  }), async (context) => {
    const member = need(context, 'affiliates');
    const input = context.req.valid('json');
    return context.json(await affiliates().adjust(member.teamId, context.req.valid('param').id, input.cents, input.note, member.userId), 200);
  });

  app.openapi(route('Studio affiliates', {
    method: 'post', path: '/v1/studio/affiliates/{id}/payouts', summary: 'Record a payment you made: everything owed through a date',
    request: { params: idParam('id'), ...body(z.object({ through: date, note: z.string().trim().max(300).nullable().optional() }).strict()) },
    responses: { 200: anyJson('Payout'), ...errors },
  }), async (context) => {
    const member = need(context, 'affiliates');
    const input = context.req.valid('json');
    return context.json(await affiliates().markPaid(member.teamId, context.req.valid('param').id, input.through, member.userId, input.note ?? null), 200);
  });

  app.openapi(route('Studio affiliates', {
    method: 'delete', path: '/v1/studio/affiliate-payouts/{id}', summary: 'Undo a payout recorded by mistake (owners only)',
    request: { params: idParam('id') },
    responses: { 200: anyJson('Removed'), ...errors },
  }), async (context) => {
    const owner = need(context, 'owner');
    await affiliates().voidPayout(owner.teamId, context.req.valid('param').id);
    return context.json(ok, 200);
  });

  app.openapi(route('Studio affiliates', {
    method: 'post', path: '/v1/studio/affiliates/reconcile', summary: 'Before paying: re-check a month’s purchases against RevenueCat',
    request: body(z.object({ month }).strict()),
    responses: { 200: anyJson('Reconciled'), ...errors },
  }), async (context) => {
    const member = need(context, 'affiliates');
    const events = required(dependencies.events, 'Reconciling (DATABASE_URL)');
    return context.json(await affiliates().reconcile(member.teamId, context.req.valid('json').month, events), 200);
  });

  app.openapi(route('Studio affiliates', {
    method: 'get', path: '/v1/studio/affiliate-flags', summary: 'What needs a look before paying',
    responses: { 200: anyJson('Flags'), ...errors },
  }), async (context) => {
    const member = need(context, 'affiliates');
    return context.json({ flags: await affiliates().flags(member.teamId) }, 200);
  });

  app.openapi(route('Studio affiliates', {
    method: 'post', path: '/v1/studio/affiliate-flags/{id}/resolve', summary: 'Mark a flag looked at',
    request: { params: idParam('id') },
    responses: { 200: anyJson('Resolved'), ...errors },
  }), async (context) => {
    const member = need(context, 'affiliates');
    await affiliates().resolveFlag(member.teamId, context.req.valid('param').id, member.userId);
    return context.json(ok, 200);
  });

  app.openapi(route('Studio affiliates', {
    method: 'post', path: '/v1/studio/affiliates/{id}/invite', summary: 'An invite code for the affiliate to see their own sales in Hearth Studio (two weeks, one use)',
    request: { params: idParam('id') },
    responses: { 200: anyJson('Invite'), ...errors },
  }), async (context) => {
    const member = need(context, 'affiliates');
    return context.json(await affiliates().invite(member.teamId, context.req.valid('param').id, member.userId), 200);
  });

  app.openapi(route('Studio affiliates', {
    method: 'delete', path: '/v1/studio/affiliates/{id}/access', summary: 'End the affiliate’s own sign-in (their credit and payouts stay)',
    request: { params: idParam('id') },
    responses: { 200: anyJson('Removed'), ...errors },
  }), async (context) => {
    const member = need(context, 'affiliates');
    await affiliates().unlink(member.teamId, context.req.valid('param').id);
    return context.json(ok, 200);
  });

  // MARK: Links

  app.openapi(route('Studio links', {
    method: 'get', path: '/v1/studio/links', summary: 'Campaign links with taps and App Store numbers',
    request: { query: z.object({ app: appKey.optional(), days }) },
    responses: { 200: anyJson('Links'), ...errors },
  }), async (context) => {
    const query = context.req.valid('query');
    return context.json({ links: await links().list(teamOf(context), { ...(query.app ? { app: query.app } : {}), days: query.days }) }, 200);
  });

  app.openapi(route('Studio links', {
    method: 'post', path: '/v1/studio/links', summary: 'Make a campaign link (App Store link with a ct= token, and a short link)',
    request: body(z.object({
      app: appKey, name: z.string().trim().min(1).max(80), appStoreId: z.string().regex(/^\d{5,15}$/),
      ct: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/).optional(), slug: z.string().regex(/^[a-z0-9-]{2,60}$/).nullable().optional(),
      affiliateId: uuid.nullable().optional(),
    }).strict()),
    responses: { 200: anyJson('Link'), ...errors },
  }), async (context) => {
    const member = need(context, 'post');
    return context.json(await links().create(member.teamId, member.userId, context.req.valid('json')), 200);
  });

  app.openapi(route('Studio links', {
    method: 'get', path: '/v1/studio/links/{id}', summary: 'A link’s numbers day by day',
    request: { params: idParam('id'), query: z.object({ days }) },
    responses: { 200: anyJson('Link'), ...errors },
  }), async (context) => context.json(await links().daily(teamOf(context), context.req.valid('param').id, context.req.valid('query').days), 200));

  app.openapi(route('Studio links', {
    method: 'patch', path: '/v1/studio/links/{id}', summary: 'Rename a link, change its short link, or credit it to an affiliate (for reporting)',
    request: {
      params: idParam('id'),
      ...body(z.object({ name: z.string().trim().min(1).max(80).optional(), slug: z.string().regex(/^[a-z0-9-]{2,60}$/).nullable().optional(), affiliateId: uuid.nullable().optional() }).strict()),
    },
    responses: { 200: anyJson('Link'), ...errors },
  }), async (context) => {
    const member = need(context, 'post');
    return context.json(await links().update(member.teamId, context.req.valid('param').id, context.req.valid('json')), 200);
  });

  app.openapi(route('Studio links', {
    method: 'delete', path: '/v1/studio/links/{id}', summary: 'Delete a link (its short link stops working)',
    request: { params: idParam('id') },
    responses: { 200: anyJson('Removed'), ...errors },
  }), async (context) => {
    const member = need(context, 'post');
    await links().remove(member.teamId, context.req.valid('param').id);
    return context.json(ok, 200);
  });

  app.openapi(route('Studio links', {
    method: 'get', path: '/v1/studio/appstore/{app}/campaigns', summary: 'An app’s App Store campaign numbers by token',
    request: { params: z.object({ app: appKey.openapi({ param: { name: 'app', in: 'path' } }) }), query: z.object({ days }) },
    responses: { 200: anyJson('Campaigns'), ...errors },
  }), async (context) => context.json(await links().appStore(teamOf(context), context.req.valid('param').app, context.req.valid('query').days), 200));

  app.openapi(route('Studio links', {
    method: 'post', path: '/v1/studio/appstore/import', summary: 'Import App Store Connect’s campaign numbers now',
    responses: { 200: anyJson('Imported'), ...errors },
  }), async (context) => {
    const member = need(context, 'post');
    const run = required(dependencies.importStats, 'App Store Connect (ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY)');
    return context.json({ apps: await run(member.teamId) }, 200);
  });

  // MARK: The affiliate's own

  const mine = async (context: Pick<Context<ApiEnvironment>, 'get'>) => {
    if (context.get('isAnonymous')) throw new ApiError(403, 'REGISTERED_IDENTITY_REQUIRED', 'Sign in with Apple to see your sales');
    const found = await affiliates().forUser(context.get('userId'));
    if (!found) throw new ApiError(403, 'NOT_AN_AFFILIATE', 'This account isn’t an affiliate. Ask Hearth Software for an invite.');
    return found;
  };

  app.openapi(route('Affiliate', {
    method: 'post', path: '/v1/affiliate/invites/{code}/join', summary: 'Join as an affiliate with an invite code',
    request: { params: z.object({ code: z.string().regex(/^[A-Za-z2-9]{8}$/).openapi({ param: { name: 'code', in: 'path' } }) }) },
    responses: { 200: anyJson('Joined'), ...errors },
  }), async (context) => {
    if (context.get('isAnonymous')) throw new ApiError(403, 'REGISTERED_IDENTITY_REQUIRED', 'Sign in with Apple to join');
    await affiliates().join(context.req.valid('param').code, context.get('userId'));
    return context.json(ok, 200);
  });

  app.openapi(route('Affiliate', {
    method: 'get', path: '/v1/affiliate/me', summary: 'Your sales, what you’re owed, payouts, codes and links',
    request: { query: z.object({ month: month.optional() }) },
    responses: { 200: anyJson('Overview'), ...errors },
  }), async (context) => {
    const { team, id } = await mine(context);
    const affiliate = await affiliates().get(team, id);
    const { contact: _contact, ...self } = affiliate;
    const theirLinks = dependencies.links() ? await links().list(team, { affiliateId: id }) : [];
    return context.json({
      affiliate: self,
      codes: (await affiliates().codes(team, id)).filter((entry) => entry.active),
      links: theirLinks.map(({ affiliateId: _a, affiliateName: _n, ...link }) => link),
      credits: await affiliates().credits(team, id, context.req.valid('query').month),
      payouts: await affiliates().payouts(team, id),
    }, 200);
  });

  app.openapi(route('Affiliate', {
    method: 'get', path: '/v1/affiliate/me/statement', summary: 'Your statement for a month, as CSV',
    request: { query: z.object({ month }) },
    responses: { 200: csv('Statement'), ...errors },
  }), async (context) => {
    const { team, id } = await mine(context);
    const statement = await affiliates().statement(team, id, context.req.valid('query').month);
    return context.body(statement.csv, 200, {
      'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${statement.filename}"`,
    });
  });

  // MARK: Short links (public)

  app.get('/go/:slug', async (context) => {
    const slug = context.req.param('slug').toLowerCase();
    const service = dependencies.links();
    const target = service && /^[a-z0-9-]{2,60}$/.test(slug) ? await service.follow(slug, context.req.header('user-agent')) : undefined;
    if (!target) return context.text('This link isn’t available.', 404);
    context.header('cache-control', 'no-store');
    context.header('referrer-policy', 'no-referrer');
    return context.redirect(target, 302);
  });

  // An app's referral field: is this code real for this app? (Says nothing about who owns it.)
  app.openapi(route('Affiliate', {
    method: 'get', path: '/v1/affiliate/codes/{code}', summary: 'Whether a referral code works for an app',
    request: {
      params: z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{3,40}$/).openapi({ param: { name: 'code', in: 'path' } }) }),
      query: z.object({ app: appKey }),
    },
    responses: { 200: anyJson('Valid'), ...errors },
  }), async (context) => context.json(await affiliates().checkCode(context.req.valid('param').code, context.req.valid('query').app), 200));
}
