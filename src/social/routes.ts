import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono, RouteConfig } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import type { Config } from '../config.js';
import { errorSchema } from '../contracts/common.js';
import type { ApiEnvironment } from '../contracts/common.js';
import { ApiError } from '../errors.js';
import { requireCronSecret } from '../middleware/cron.js';
import type { ReserveQuota } from '../services/quota.js';
import { MetaError } from './meta.js';
import type { MetricName } from './meta.js';
import { isApiPlatform } from './service.js';
import type { SocialService } from './service.js';
import { publicConnection, SOCIAL_PLATFORMS } from './store.js';
import type { MetricRow, PostView, SocialStore, TargetView } from './store.js';
import { suggestReplies } from './suggest-reply.js';
import { need, studioMiddleware, teamOf } from '../studio/gate.js';
import type { TeamService } from '../studio/team.js';
import type { StudioNotifier } from '../studio/notify.js';

// MARK: Schemas

const uuid = z.uuid();
const appKey = z.string().regex(/^[a-z0-9-]{1,40}$/);
const platform = z.enum(SOCIAL_PLATFORMS);
const format = z.enum(['feed', 'reel', 'story']);
const instant = z.iso.datetime({ offset: true });
const httpsLink = z.url().max(2000).refine((value) => /^https?:\/\//i.test(value), 'An http(s) link');
const metric = z.enum(['followers', 'reach', 'impressions', 'views', 'likes', 'comments', 'shares', 'saves', 'clicks', 'engagements']);

const connectionSchema = z.object({
  id: z.string(), platform: z.enum(['facebook', 'instagram']), externalId: z.string(), name: z.string(), handle: z.string().nullable(),
  avatarUrl: z.string().nullable(), app: z.string().nullable(), status: z.enum(['active', 'needs_reconnect']), lastError: z.string().nullable(),
  postsSyncedAt: z.string().nullable(), metricsSyncedAt: z.string().nullable(), createdAt: z.string(),
}).openapi('SocialConnection');
const targetSchema = z.object({
  id: z.string(), postId: z.string().nullable(), app: z.string(), platform, connectionId: z.string().nullable(),
  delivery: z.enum(['api', 'handoff']), format, text: z.string().nullable(),
  status: z.enum(['draft', 'scheduled', 'publishing', 'processing', 'published', 'failed']), scheduledFor: z.string().nullable(),
  attempts: z.number().int(), containerId: z.string().nullable(), remoteId: z.string().nullable(), permalink: z.string().nullable(),
  publishedAt: z.string().nullable(), error: z.string().nullable(), previewText: z.string().nullable(), previewMediaUrl: z.string().nullable(),
  likeCount: z.number().nullable(), commentCount: z.number().nullable(), shareCount: z.number().nullable(), updatedAt: z.string(),
}).openapi('SocialTarget');
const mediaSchema = z.object({
  path: z.string().min(1).max(300), kind: z.enum(['image', 'video']),
  width: z.number().int().min(1).max(20000).optional(), height: z.number().int().min(1).max(20000).optional(),
});
const postSchema = z.object({
  id: z.string(), app: z.string(), about: z.string().nullable(), text: z.string(), link: z.string().nullable(), firstComment: z.string().nullable(),
  media: z.array(mediaSchema.extend({ previewUrl: z.string().nullable() })), draft: z.boolean(), scheduledFor: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string(), targets: z.array(targetSchema),
}).openapi('SocialPost');
const commentSchema = z.object({
  id: z.string(), connectionId: z.string(), app: z.string(), platform: z.enum(['facebook', 'instagram']), remoteId: z.string(),
  remotePostId: z.string(), parentRemoteId: z.string().nullable(), author: z.string(), text: z.string(), likeCount: z.number().int(),
  fromAccount: z.boolean(), status: z.enum(['open', 'done', 'hidden']), commentedAt: z.string(),
}).openapi('SocialComment');

const postBody = z.object({
  /** The brand whose accounts it goes to ("hearth"). */
  app: appKey,
  /** The Hearth app it's about, if one. */
  about: appKey.nullable().optional(),
  text: z.string().max(5000),
  link: httpsLink.nullable().optional(),
  firstComment: z.string().trim().max(2200).nullable().optional(),
  media: z.array(mediaSchema).max(10),
  draft: z.boolean(),
  /** null with draft false: post now. */
  scheduledFor: instant.nullable().optional(),
  targets: z.array(z.object({
    platform, connectionId: uuid.nullable().optional(), format: format.optional(), text: z.string().max(5000).nullable().optional(),
  }).strict()).max(16),
}).strict().openapi('SocialPostInput');

const importBody = z.object({
  app: appKey,
  platform,
  /** Account-wide numbers by day, and posts' totals (postKey: the post's link or id). */
  rows: z.array(z.object({ postKey: z.string().max(500).optional(), day: z.iso.date(), metric, value: z.number().finite().min(0).max(1e12) }).strict()).max(20000),
  posts: z.array(z.object({
    key: z.string().min(1).max(500), text: z.string().max(5000).optional(), permalink: httpsLink.nullable().optional(), publishedAt: instant,
  }).strict()).max(2000).optional(),
}).strict().openapi('SocialMetricsImport');

const idParams = z.object({ id: uuid.openapi({ param: { name: 'id', in: 'path' } }) });
const appQuery = z.object({ app: appKey });

// MARK: Route helpers

const errorCodes = {
  400: 'Invalid request', 401: 'Invalid or missing token', 403: 'Not one of the accounts allowed to manage the Hearth apps’ pages',
  404: 'Not found', 422: 'Not possible for this post or account', 502: 'Meta or Claude failed', 503: 'Not configured or storage unavailable',
} as const;
const errors = Object.fromEntries(Object.entries(errorCodes).map(([code, description]) => [
  code, { description, content: { 'application/json': { schema: errorSchema } } },
]));
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { 'application/json': { schema } } });
const body = <T extends z.ZodType>(schema: T) => ({ body: { required: true, content: { 'application/json': { schema } } } });
const route = <R extends Omit<RouteConfig, 'tags' | 'security'>>(config: R) =>
  createRoute({ ...config, tags: ['Social pages'], security: [{ BearerAuth: [] }] } as R & { tags: string[] });
const ok = z.object({ ok: z.literal(true) });

export type SocialRouteDependencies = {
  config: Config;
  service: SocialService | undefined;
  store: SocialStore | undefined;
  /** The Hearth Software team: who can use /v1/social, and with which permissions. */
  team: () => TeamService | undefined;
  /** Hearth Studio's pushes, run by the cron. */
  notifier?: () => StudioNotifier | undefined;
  reserveQuota: ReserveQuota;
  requireHearthPlus: (userId: string) => Promise<void>;
  anthropicApiKey?: string | undefined;
  model?: string | undefined;
  fetcher?: typeof fetch;
};

const prefix = '/v1/social';
const APP_NAMES: Record<string, string> = { hearth: 'Hearth Software', bigtable: 'BigTable', suffice: 'Suffice', sated: 'Sated', caloma: 'Caloma', hearken: 'Hearken' };

export function registerSocial(app: OpenAPIHono<ApiEnvironment>, dependencies: SocialRouteDependencies) {
  const service = () => {
    if (!dependencies.service || !dependencies.store) throw new ApiError(503, 'STORAGE_NOT_CONFIGURED', 'Social pages are not configured (DATABASE_URL, SOCIAL_TOKEN_KEY)');
    return { service: dependencies.service, store: dependencies.store };
  };

  app.use(`${prefix}/*`, studioMiddleware(dependencies.team));
  app.use(`${prefix}/*`, async (context, next) => bodyLimit({
    maxSize: context.req.path === `${prefix}/metrics/import` ? 4_000_000 : 128_000,
    onError: () => { throw new ApiError(400, 'INVALID_REQUEST', 'Request body is too large'); },
  })(context, next));

  /** The caller's team: everything in /v1/social is the team's. */
  const me = (context: Parameters<typeof teamOf>[0]) => teamOf(context);

  async function withPreviews(post: PostView) {
    const { service: social } = service();
    return { ...post, media: await Promise.all(post.media.map(async (item) => ({ ...item, previewUrl: await social.previewUrl(item.path) }))) };
  }

  // MARK: Accounts

  app.openapi(route({
    method: 'get', path: `${prefix}/connections`, summary: 'The Facebook Pages and Instagram accounts connected, and which app each is for',
    responses: { 200: json(z.object({ connections: z.array(connectionSchema), metaConfigured: z.boolean() }), 'Connections'), ...errors },
  }), async (context) => {
    const { service: social, store } = service();
    const connections = (await store.connections(me(context))).map(publicConnection);
    return context.json({ connections, metaConfigured: social.metaConfigured() }, 200);
  });

  app.openapi(route({
    method: 'post', path: `${prefix}/connections/meta/start`,
    summary: 'A Facebook login link. It returns to hearthship://social/connected after saving every Page (and linked Instagram account) the login manages',
    request: body(z.object({ app: appKey.nullable().optional() }).strict()),
    responses: { 200: json(z.object({ url: z.string() }), 'Open this in a web authentication session'), ...errors },
  }), async (context) => {
    const { service: social } = service();
    const member = need(context, 'accounts');
    return context.json({ url: social.startMetaLogin(member.teamId, member.userId, context.req.valid('json').app ?? null) }, 200);
  });

  app.openapi(route({
    method: 'patch', path: `${prefix}/connections/{id}`, summary: 'Which app an account is for (null: none)',
    request: { params: idParams, ...body(z.object({ app: appKey.nullable() }).strict()) },
    responses: { 200: json(connectionSchema, 'The connection'), ...errors },
  }), async (context) => {
    const { store } = service();
    need(context, 'accounts');
    const updated = await store.setConnectionApp(me(context), context.req.valid('param').id, context.req.valid('json').app);
    if (!updated) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Connection not found');
    return context.json(publicConnection(updated), 200);
  });

  app.openapi(route({
    method: 'delete', path: `${prefix}/connections/{id}`, summary: 'Disconnect an account (its posts and numbers stay; its comments go)',
    request: { params: idParams },
    responses: { 200: json(ok, 'Disconnected'), ...errors },
  }), async (context) => {
    const { store } = service();
    need(context, 'accounts');
    if (!await store.removeConnection(me(context), context.req.valid('param').id)) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Connection not found');
    return context.json({ ok: true as const }, 200);
  });

  // MARK: Media

  app.openapi(route({
    method: 'post', path: `${prefix}/media`, summary: 'Where to upload a photo or video for a post (PUT the file to uploadUrl)',
    request: body(z.object({ extension: z.enum(['jpg', 'jpeg', 'png', 'mp4', 'mov']) }).strict()),
    responses: { 200: json(z.object({ path: z.string(), uploadUrl: z.string(), token: z.string() }), 'Upload target'), ...errors },
  }), async (context) => {
    const { service: social } = service();
    need(context, 'post');
    return context.json(await social.uploadUrl(me(context), context.req.valid('json').extension), 200);
  });

  // MARK: Posts

  app.openapi(route({
    method: 'get', path: `${prefix}/posts`, summary: 'An app’s posts made in Hearth Ship (drafts, scheduled, published) and posts found on its accounts',
    request: { query: appQuery },
    responses: { 200: json(z.object({ posts: z.array(postSchema), found: z.array(targetSchema) }), 'Posts'), ...errors },
  }), async (context) => {
    const { store } = service();
    const { app: appId } = context.req.valid('query');
    const [posts, found] = await Promise.all([store.posts(me(context), appId), store.foundPosts(me(context), appId)]);
    return context.json({ posts: await Promise.all(posts.map(withPreviews)), found }, 200);
  });

  async function savePost(owner: string, input: z.infer<typeof postBody>, id?: string) {
    const { service: social, store } = service();
    for (const item of input.media) {
      // Uploaded for the post, or a Library item (library/<team>/...).
      if (!item.path.startsWith(`${owner}/`) && !item.path.startsWith(`library/${owner}/`)) {
        throw new ApiError(422, 'INVALID_MEDIA', 'Upload media with POST /v1/social/media first, or pick it from the Library');
      }
    }
    // Post now is a schedule of now, so the cron picks up anything the request doesn't finish.
    const scheduledFor = input.draft ? (input.scheduledFor ?? null) : (input.scheduledFor ?? new Date().toISOString());
    const targets = await social.resolveTargets(owner, input.app, input.draft, scheduledFor, input.targets);
    const post = {
      app: input.app, about: input.about ?? null, text: input.text, link: input.link ?? null, firstComment: input.firstComment || null,
      media: input.media, draft: input.draft, scheduledFor,
    };
    const postId = id ?? await store.createPost(owner, post, targets);
    if (id) await store.updatePost(owner, id, post, targets);
    if (!input.draft && Date.parse(scheduledFor!) <= Date.now() + 60_000) await social.publishPostNow(owner, postId);
    return (await store.post(owner, postId))!;
  }

  app.openapi(route({
    method: 'post', path: `${prefix}/posts`,
    summary: 'A new post: a draft, scheduled, or (draft false, no scheduledFor) posted now to its Facebook and Instagram targets',
    request: body(postBody),
    responses: { 201: json(postSchema, 'The post, with each target’s status'), ...errors },
  }), async (context) => {
    need(context, 'post');
    return context.json(await withPreviews(await savePost(me(context), context.req.valid('json'))), 201);
  });

  app.openapi(route({
    method: 'put', path: `${prefix}/posts/{id}`, summary: 'Replace a post (targets already published stay as they are)',
    request: { params: idParams, ...body(postBody) },
    responses: { 200: json(postSchema, 'The post'), ...errors },
  }), async (context) => {
    const { store } = service();
    const { id } = context.req.valid('param');
    need(context, 'post');
    const existing = await store.post(me(context), id);
    if (!existing) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Post not found');
    if (existing.app !== context.req.valid('json').app) throw new ApiError(422, 'INVALID_REQUEST', 'A post can’t move to another app');
    return context.json(await withPreviews(await savePost(me(context), context.req.valid('json'), id)), 200);
  });

  app.openapi(route({
    method: 'delete', path: `${prefix}/posts/{id}`, summary: 'Delete a post here (anything already published stays on the platform)',
    request: { params: idParams },
    responses: { 200: json(ok, 'Deleted'), ...errors },
  }), async (context) => {
    const { store } = service();
    need(context, 'post');
    if (!await store.removePost(me(context), context.req.valid('param').id)) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Post not found');
    return context.json({ ok: true as const }, 200);
  });

  app.openapi(route({
    method: 'post', path: `${prefix}/targets/{id}/publish`, summary: 'Publish a Facebook or Instagram target now (or try a failed one again)',
    request: { params: idParams },
    responses: { 200: json(targetSchema, 'The target'), ...errors },
  }), async (context) => {
    const { service: social, store } = service();
    const { id } = context.req.valid('param');
    need(context, 'post');
    await social.retryTarget(me(context), id);
    const { ownerId: _owner, ...view } = (await store.target(me(context), id))!;
    return context.json(view, 200);
  });

  app.openapi(route({
    method: 'post', path: `${prefix}/targets/{id}/posted`, summary: 'Mark a hand-off target posted (you posted it yourself), with its link',
    request: { params: idParams, ...body(z.object({ permalink: httpsLink.nullable().optional(), publishedAt: instant.nullable().optional(), posted: z.boolean().optional() }).strict()) },
    responses: { 200: json(targetSchema, 'The target'), ...errors },
  }), async (context) => {
    const { service: social, store } = service();
    const { id } = context.req.valid('param');
    const input = context.req.valid('json');
    need(context, 'post');
    if (input.posted === false) await social.markNotPosted(me(context), id);
    else await social.markPosted(me(context), id, input.permalink ?? null, input.publishedAt ?? null);
    const { ownerId: _owner, ...view } = (await store.target(me(context), id))!;
    return context.json(view, 200);
  });

  app.openapi(route({
    method: 'post', path: `${prefix}/sync`, summary: 'Publish anything due and sync posts, comments and numbers now',
    request: body(z.object({ app: appKey.nullable().optional() }).strict()),
    responses: { 200: json(z.object({ published: z.number().int(), posts: z.number().int(), comments: z.number().int() }), 'What happened'), ...errors },
  }), async (context) => {
    const { service: social } = service();
    return context.json(await social.syncNow(me(context), context.req.valid('json').app ?? null), 200);
  });

  // MARK: Inbox

  app.openapi(route({
    method: 'get', path: `${prefix}/comments`, summary: 'Comments on the app’s Facebook and Instagram posts',
    request: { query: appQuery.extend({ status: z.enum(['open', 'done', 'hidden', 'all']).default('all') }) },
    responses: { 200: json(z.object({ comments: z.array(commentSchema) }), 'Newest first'), ...errors },
  }), async (context) => {
    const { store } = service();
    const query = context.req.valid('query');
    return context.json({ comments: await store.comments(me(context), query.app, query.status) }, 200);
  });

  app.openapi(route({
    method: 'post', path: `${prefix}/comments/{id}/reply`, summary: 'Reply as the account',
    request: { params: idParams, ...body(z.object({ text: z.string().trim().min(1).max(2200) }).strict()) },
    responses: { 200: json(ok, 'Replied'), ...errors },
  }), async (context) => {
    const { service: social } = service();
    need(context, 'post');
    await social.reply(me(context), context.req.valid('param').id, context.req.valid('json').text);
    return context.json({ ok: true as const }, 200);
  });

  app.openapi(route({
    method: 'patch', path: `${prefix}/comments/{id}`, summary: 'Mark a comment done or open; hidden hides it on the platform too',
    request: { params: idParams, ...body(z.object({ status: z.enum(['open', 'done', 'hidden']) }).strict()) },
    responses: { 200: json(ok, 'Updated'), ...errors },
  }), async (context) => {
    const { service: social, store } = service();
    const { id } = context.req.valid('param');
    const { status } = context.req.valid('json');
    need(context, 'post');
    const existing = await store.comment(me(context), id);
    if (!existing) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Comment not found');
    if (status === 'hidden' || existing.status === 'hidden') await social.hide(me(context), id, status === 'hidden');
    if (status !== 'hidden') await store.setCommentStatus(me(context), id, status);
    return context.json({ ok: true as const }, 200);
  });

  app.openapi(route({
    method: 'post', path: `${prefix}/comments/{id}/suggest`, summary: 'Three reply suggestions from Claude (Hearth+)',
    request: { params: idParams },
    responses: { 200: json(z.object({ replies: z.array(z.string()) }), 'Suggestions'), 402: json(errorSchema, 'Needs Hearth+'), 429: json(errorSchema, 'Too many requests'), ...errors },
  }), async (context) => {
    const { store } = service();
    const owner = need(context, 'post').teamId;
    const userId = context.get('userId');
    await dependencies.requireHearthPlus(userId);
    if (!dependencies.anthropicApiKey) throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'Reply suggestions are not configured');
    const comment = await store.comment(owner, context.req.valid('param').id);
    if (!comment) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Comment not found');
    await dependencies.reserveQuota(userId, 'marketing');
    const thread = (await store.comments(owner, comment.app, 'all', 500))
      .filter((item) => item.id !== comment.id && (item.remoteId === comment.parentRemoteId || (comment.parentRemoteId && item.parentRemoteId === comment.parentRemoteId)))
      .reverse().slice(-6).map((item) => `${item.fromAccount ? 'You' : item.author}: ${item.text}`);
    const posts = await store.publishedTargets(owner, comment.app, '1970-01-01T00:00:00Z');
    const post = posts.find((item) => item.remoteId === comment.remotePostId);
    const about = post?.postId ? (await store.post(owner, post.postId))?.about ?? null : null;
    const replies = await suggestReplies({
      appName: APP_NAMES[comment.app] ?? comment.app, aboutApp: about ? APP_NAMES[about] ?? about : null, platform: comment.platform === 'instagram' ? 'Instagram' : 'Facebook',
      postText: (post?.text ?? post?.previewText ?? '').slice(0, 1500), comment: comment.text.slice(0, 1500), author: comment.author, thread,
    }, { apiKey: dependencies.anthropicApiKey, model: dependencies.model, ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}) });
    return context.json({ replies }, 200);
  });

  // MARK: Analytics

  const seriesSchema = z.object({ platform: z.string(), metric, points: z.array(z.object({ day: z.string(), value: z.number() })) });
  app.openapi(route({
    method: 'get', path: `${prefix}/analytics`, summary: 'An app’s numbers over the last 7, 28 or 90 days, with the period before for comparison',
    request: { query: appQuery.extend({
      days: z.coerce.number().int().refine((value) => [7, 28, 90].includes(value)).default(28),
      platform: platform.optional().openapi({ description: 'Only this platform’s numbers (all of them when left out)' }),
    }) },
    responses: { 200: json(z.object({
      days: z.number().int(),
      platforms: z.array(platform).openapi({ description: 'The platforms with numbers or posts in this period or the one before, whatever `platform` is' }),
      totals: z.array(z.object({ metric, value: z.number(), previous: z.number().nullable() })),
      series: z.array(seriesSchema),
      posts: z.array(z.object({ target: targetSchema, metrics: z.record(z.string(), z.number()) })),
    }).openapi('SocialAnalytics'), 'Numbers'), ...errors },
  }), async (context) => {
    const { store } = service();
    const { app: appId, days, platform: only } = context.req.valid('query');
    const owner = me(context);
    const end = Date.now();
    const start = new Date(end - days * 86_400_000).toISOString();
    const before = new Date(end - 2 * days * 86_400_000).toISOString();
    const [rows, posts] = await Promise.all([store.metrics(owner, appId, before.slice(0, 10)), store.publishedTargets(owner, appId, before)]);
    const platforms = SOCIAL_PLATFORMS.filter((id) => rows.some((row) => row.platform === id) || posts.some((post) => post.platform === id));
    const numbers = only
      ? analytics(rows.filter((row) => row.platform === only), posts.filter((post) => post.platform === only), days, start.slice(0, 10))
      : analytics(rows, posts, days, start.slice(0, 10));
    return context.json({ ...numbers, platforms }, 200);
  });

  app.openapi(route({
    method: 'post', path: `${prefix}/metrics/import`,
    summary: 'Numbers from a platform’s CSV export (Hearth Ship reads the file; this saves the rows and the posts they belong to)',
    request: body(importBody),
    responses: { 200: json(z.object({ rows: z.number().int(), posts: z.number().int() }), 'Saved'), ...errors },
  }), async (context) => {
    const { store } = service();
    const input = context.req.valid('json');
    const owner = need(context, 'post').teamId;
    if (isApiPlatform(input.platform) && input.posts?.length) {
      // Facebook and Instagram posts come from the API; imported rows only add numbers to them.
    } else if (input.posts?.length) {
      await store.upsertRemotePosts(owner, input.app, input.platform, null, 'handoff', input.posts.map((post) => ({
        remoteId: post.key, text: post.text ?? '', permalink: post.permalink ?? null, mediaUrl: null, publishedAt: post.publishedAt,
        likes: null, comments: null, shares: null,
      })));
    }
    const rows: MetricRow[] = input.rows.map((row) => ({ platform: input.platform, postKey: row.postKey ?? '', day: row.day, metric: row.metric, value: row.value, source: 'import' }));
    await store.saveMetrics(owner, input.app, rows);
    return context.json({ rows: rows.length, posts: input.posts?.length ?? 0 }, 200);
  });

  // MARK: Outside /v1: the login's return and the cron

  /** Meta sends the browser here; it goes on to Hearth Ship's URL scheme. */
  app.get('/oauth/meta/callback', async (context) => {
    const back = (query: Record<string, string>) => context.redirect(`hearthship://social/connected?${new URLSearchParams(query)}`, 302);
    const code = context.req.query('code');
    const state = context.req.query('state');
    if (!code || !state) return back({ error: context.req.query('error_description') ?? context.req.query('error') ?? 'The login was cancelled' });
    try {
      const { service: social } = service();
      const { count } = await social.finishMetaLogin(code, state);
      return back({ count: String(count) });
    } catch (error) {
      const message = error instanceof ApiError || error instanceof MetaError ? error.message : 'The login couldn’t be finished';
      return back({ error: message.slice(0, 300) });
    }
  });

  app.get('/internal/social/cron', async (context) => {
    requireCronSecret(dependencies.config, context.req.header('Authorization'));
    const { service: social } = service();
    const result = await social.cron();
    // Hearth Studio's pushes (due hand-offs, failures, new comments) ride the same five minutes.
    const notifier = dependencies.notifier?.();
    const pushed = notifier ? await notifier.run().catch((error: unknown) => {
      console.error('Studio notifications failed', { message: error instanceof Error ? error.message : String(error) });
      return 0;
    }) : 0;
    return context.json({ ...result, pushed }, 200);
  });
}

// MARK: Analytics math

const DAILY: MetricName[] = ['reach', 'impressions', 'views', 'engagements', 'clicks'];
const POST_METRICS: MetricName[] = ['likes', 'comments', 'shares', 'saves', 'views', 'reach', 'clicks'];

/** Exported for tests. */
export function analytics(rows: MetricRow[], posts: TargetView[], days: number, start: string) {
  const account = rows.filter((row) => row.postKey === '');
  // A day's account number may come from both the API and an import; the latest write wins in
  // the table, so each (platform, day, metric) is one row here.
  const series = new Map<string, { platform: string; metric: MetricName; points: { day: string; value: number }[] }>();
  for (const row of account) {
    if (row.day < start) continue;
    const key = `${row.platform}/${row.metric}`;
    const entry = series.get(key) ?? { platform: row.platform, metric: row.metric, points: [] };
    entry.points.push({ day: row.day, value: row.value });
    series.set(key, entry);
  }
  const sum = (metric: MetricName, from: string, to: string) => account
    .filter((row) => row.metric === metric && row.day >= from && row.day < to)
    .reduce((total, row) => total + row.value, 0);
  const has = (metric: MetricName, from: string, to: string) => account.some((row) => row.metric === metric && row.day >= from && row.day < to);
  const previousStart = new Date(Date.parse(start) - days * 86_400_000).toISOString().slice(0, 10);
  const far = '9999-12-31';
  const totals: { metric: MetricName; value: number; previous: number | null }[] = [];

  // Followers: the latest count per platform, against the last count before the period.
  const platforms = [...new Set(account.filter((row) => row.metric === 'followers').map((row) => row.platform))];
  if (platforms.length) {
    const latest = (platform: string, to: string) => account.filter((row) => row.platform === platform && row.metric === 'followers' && row.day < to).at(-1)?.value;
    const now = platforms.reduce((total, platform) => total + (latest(platform, far) ?? 0), 0);
    const then = platforms.map((platform) => latest(platform, start));
    totals.push({ metric: 'followers', value: now, previous: then.every((value) => value === undefined) ? null : then.reduce<number>((total, value) => total + (value ?? 0), 0) });
  }
  for (const metric of DAILY) {
    if (!has(metric, start, far)) continue;
    totals.push({ metric, value: sum(metric, start, far), previous: has(metric, previousStart, start) ? sum(metric, previousStart, start) : null });
  }

  // Each post's latest totals.
  const latestByPost = new Map<string, Record<string, number>>();
  const dayOf = new Map<string, string>();
  for (const row of rows) {
    if (row.postKey === '') continue;
    const key = `${row.platform}/${row.postKey}/${row.metric}`;
    if ((dayOf.get(key) ?? '') > row.day) continue;
    dayOf.set(key, row.day);
    const metrics = latestByPost.get(`${row.platform}/${row.postKey}`) ?? {};
    metrics[row.metric] = row.value;
    latestByPost.set(`${row.platform}/${row.postKey}`, metrics);
  }
  const metricsOf = (post: TargetView) => {
    const found = post.remoteId ? latestByPost.get(`${post.platform}/${post.remoteId}`) ?? {} : {};
    const merged: Record<string, number> = { ...found };
    if (merged.likes === undefined && post.likeCount != null) merged.likes = post.likeCount;
    if (merged.comments === undefined && post.commentCount != null) merged.comments = post.commentCount;
    if (merged.shares === undefined && post.shareCount != null) merged.shares = post.shareCount;
    return merged;
  };
  const engagement = (metrics: Record<string, number>) => (metrics.likes ?? 0) + (metrics.comments ?? 0) + (metrics.shares ?? 0) + (metrics.saves ?? 0);
  const inPeriod = posts.filter((post) => post.publishedAt && post.publishedAt.slice(0, 10) >= start);
  const previousPosts = posts.filter((post) => post.publishedAt && post.publishedAt.slice(0, 10) >= previousStart && post.publishedAt.slice(0, 10) < start);
  for (const metric of POST_METRICS) {
    if (DAILY.includes(metric) && totals.some((total) => total.metric === metric)) continue;
    const value = inPeriod.reduce((total, post) => total + (metricsOf(post)[metric] ?? 0), 0);
    const counted = inPeriod.some((post) => metricsOf(post)[metric] !== undefined);
    if (!counted) continue;
    const previous = previousPosts.some((post) => metricsOf(post)[metric] !== undefined)
      ? previousPosts.reduce((total, post) => total + (metricsOf(post)[metric] ?? 0), 0) : null;
    totals.push({ metric, value, previous });
  }

  return {
    days,
    totals,
    series: [...series.values()].map((entry) => ({ ...entry, points: entry.points.sort((a, b) => a.day.localeCompare(b.day)) })),
    posts: inPeriod.map((post) => ({ target: post, metrics: metricsOf(post) }))
      .sort((a, b) => engagement(b.metrics) - engagement(a.metrics)).slice(0, 50),
  };
}
