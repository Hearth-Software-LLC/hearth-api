import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { OpenAPIHono, RouteConfig } from '@hono/zod-openapi';
import { errorSchema } from '../contracts/common.js';
import type { ApiEnvironment } from '../contracts/common.js';
import { ApiError } from '../errors.js';
import { VersionConflict } from '../studio/documents.js';
import type { GitHubApps } from '../studio/github.js';
import type { LibraryService } from '../studio/library.js';
import { atLeast, contentLevel, hasContentAccess, hasStudioAccess } from '../studio/team.js';
import type { ContentLevel, Member, TeamService } from '../studio/team.js';
import { BLOCK_KINDS, BLOCK_LIBRARY, bodySchema, definitionSchema } from './model.js';
import { MEDIA_TYPES } from './service.js';
import type { ContentService, MediaType } from './service.js';

/**
 * Hearth Content's API (content.hearthapps.com): content types, items, review, media and
 * publishing for the Hearth Software team, plus the public catalog each app reads.
 *
 * Access comes from the team (studio/team.ts): owners do everything, admins publish everywhere,
 * members have the content role and apps set on them. Every item check is per app.
 */

export type ContentDependencies = {
  team: () => TeamService | undefined;
  content: () => ContentService | undefined;
  apps: () => GitHubApps | undefined;
  library: () => LibraryService | undefined;
};

/** Publishing and rolling back need a sign-in from the last 12 hours. */
export const RECENT_SIGN_IN_SECONDS = 12 * 3600;

const appKey = z.string().regex(/^[a-z0-9-]{1,40}$/);
const uuid = z.uuid();
const failure = (description: string) => ({ description, content: { 'application/json': { schema: errorSchema } } });
const errors = {
  400: failure('Invalid request'), 401: failure('Invalid or missing token'), 403: failure('Not allowed'), 404: failure('Not found'),
  409: failure('Conflicts with a newer version or the item’s state'), 422: failure('Not possible yet'), 429: failure('Too many attempts'),
  503: failure('Not configured'),
} as const;
const anyJson = (description: string) => ({ description, content: { 'application/json': { schema: z.any() } } });
const body = <T extends z.ZodType>(schema: T) => ({ body: { required: true, content: { 'application/json': { schema } } } });
const route = <R extends Omit<RouteConfig, 'tags' | 'security'>>(config: R) =>
  createRoute({ ...config, tags: ['Content'], security: [{ BearerAuth: [] }] } as R & { tags: string[] });
const idParam = z.object({ id: uuid.openapi({ param: { name: 'id', in: 'path' } }) });
const ok = { ok: true as const };

type AnyContext = Pick<Context<ApiEnvironment>, 'get'>;

function member(context: AnyContext): Member {
  const found = context.get('studioMember');
  if (!found) throw new ApiError(403, 'NOT_ON_TEAM', 'This account isn’t on the Hearth Software team');
  return found;
}

/** The caller's level for an app's content, or a 403 when it's below `needed`. */
function need(context: AnyContext, app: string, needed: ContentLevel): Member {
  const caller = member(context);
  const level = contentLevel(caller, app);
  if (!atLeast(level, needed)) {
    const what: Record<ContentLevel, string> = { author: 'write', reviewer: 'review', publisher: 'publish', owner: 'manage' };
    throw new ApiError(403, 'PERMISSION_REQUIRED', level
      ? `Your role doesn’t let you ${what[needed]} ${app === 'shared' ? 'shared content' : `${app} content`}. Ask Steve.`
      : `You don’t have access to ${app === 'shared' ? 'shared content' : `${app} content`}.`);
  }
  return caller;
}

function needRecentSignIn(context: AnyContext) {
  const signedInAt = context.get('signedInAt');
  if (signedInAt === undefined || Date.now() / 1000 - signedInAt > RECENT_SIGN_IN_SECONDS) {
    throw new ApiError(401, 'REAUTHENTICATE', 'Sign in again to publish: publishing needs a sign-in from the last 12 hours.');
  }
}

const memberView = (caller: Member) => ({
  userId: caller.userId, displayName: caller.displayName, teamRole: caller.role,
  content: { role: caller.role === 'owner' ? 'owner' : caller.role === 'admin' ? 'publisher' : caller.contentRole, apps: caller.role === 'member' ? caller.contentApps : null },
  canManageTypes: caller.role === 'owner',
  studioAccess: hasStudioAccess(caller),
});

/** A catalog path: /v1/content/<app>/catalog. Public, so the /v1 token check skips it. */
export const PUBLIC_CATALOG = /^\/v1\/content\/[a-z0-9-]{1,40}\/catalog$/;

export function registerContent(app: OpenAPIHono<ApiEnvironment>, dependencies: ContentDependencies) {
  const required = <T>(get: () => T | undefined, what: string): T => {
    const value = get();
    if (!value) throw new ApiError(503, 'STORAGE_NOT_CONFIGURED', `${what} is not configured`);
    return value;
  };
  const content = () => required(dependencies.content, 'Hearth Content');
  const team = () => required(dependencies.team, 'Hearth Studio');
  const teamId = (context: AnyContext) => member(context).teamId;

  /** Loads an item and checks the caller's level for its app. */
  const itemFor = async (context: AnyContext, id: string, needed: ContentLevel) => {
    const found = await content().entry(teamId(context), id);
    const caller = need(context, found.entry.app, needed);
    return { ...found, caller };
  };
  const visible = (caller: Member, items: { app: string }[]) => items.filter((item) => contentLevel(caller, item.app) !== null);

  // MARK: Public catalog (before the team check)

  app.openapi(createRoute({
    method: 'get', path: '/v1/content/{app}/catalog', tags: ['Content'],
    summary: 'An app’s content catalog: its own published items plus every shared one (public)',
    request: { params: z.object({ app: appKey.openapi({ param: { name: 'app', in: 'path' } }) }) },
    responses: { 200: anyJson('Catalog'), 304: { description: 'Unchanged' }, ...errors },
  }), async (context) => {
    const catalog = await content().catalog(context.req.valid('param').app);
    const etag = `"${catalog.app}-${catalog.version}-${catalog.sharedVersion}-${catalog.minAppVersion}"`;
    context.header('Cache-Control', 'public, max-age=60');
    context.header('ETag', etag);
    if (context.req.header('If-None-Match') === etag) return context.body(null, 304);
    return context.json(catalog, 200);
  });

  // Everything else: the caller must be on the team with content access.
  app.use('/v1/content/*', async (context, next) => {
    if (PUBLIC_CATALOG.test(context.req.path)) return next();
    if (context.get('isAnonymous')) throw new ApiError(403, 'REGISTERED_IDENTITY_REQUIRED', 'Sign in with Apple to use Hearth Content');
    const caller = await team().memberOf(context.get('userId'));
    if (!caller) throw new ApiError(403, 'NOT_ON_TEAM', 'This account isn’t on the content team yet. Enter your invite code.');
    if (!hasContentAccess(caller)) throw new ApiError(403, 'NO_CONTENT_ACCESS', 'Your account doesn’t have Hearth Content access. Ask Steve.');
    context.set('studioMember', caller);
    await next();
  });

  // MARK: You and the apps

  app.openapi(route({
    method: 'get', path: '/v1/content/me', summary: 'The caller: team role, content role and apps',
    responses: { 200: anyJson('You'), ...errors },
  }), async (context) => context.json(memberView(member(context)), 200));

  app.openapi(route({
    method: 'get', path: '/v1/content/apps',
    summary: 'The Hearth apps you can work on, from each repo’s hearth-app.json (name, accent, icon)',
    responses: { 200: anyJson('Apps'), ...errors },
  }), async (context) => {
    const caller = member(context);
    const list = await required(dependencies.apps, 'Apps from GitHub (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY)').list();
    const lib = dependencies.library();
    const result = [];
    for (const entry of list) {
      const level = contentLevel(caller, entry.key);
      if (!level) continue;
      let iconUrl: string | null = null;
      if (entry.icon && lib) {
        const icon = await lib.ensureIcon(caller.teamId, entry.key, entry.icon.bytes, entry.icon.sha256, entry.icon.contentType).catch(() => undefined);
        if (icon) iconUrl = (await lib.url(caller.teamId, icon.id, false).catch(() => undefined))?.url ?? null;
      }
      result.push({ key: entry.key, name: entry.name, accent: entry.accent ?? null, bundleId: entry.bundleId ?? null, iconUrl, level });
    }
    return context.json({ apps: result, shared: contentLevel(caller, 'shared') }, 200);
  });

  app.openapi(route({
    method: 'get', path: '/v1/content/blocks', summary: 'The block library',
    responses: { 200: anyJson('Blocks'), ...errors },
  }), async (context) => context.json({ blocks: BLOCK_KINDS.map((kind) => ({ kind, ...BLOCK_LIBRARY[kind], app: BLOCK_LIBRARY[kind].app ?? null })) }, 200));

  // MARK: Content types

  app.openapi(route({
    method: 'get', path: '/v1/content/types', summary: 'Content types',
    responses: { 200: anyJson('Types'), ...errors },
  }), async (context) => context.json({ types: await content().types(teamId(context)) }, 200));

  const typeInput = z.object({
    slug: z.string().regex(/^[a-z0-9-]{1,40}$/), app: appKey.nullable(), name: z.string().trim().min(1).max(60),
    description: z.string().trim().max(300).default(''), definition: definitionSchema,
  }).strict();

  app.openapi(route({
    method: 'post', path: '/v1/content/types', summary: 'A new content type (owners)',
    request: body(typeInput), responses: { 200: anyJson('Type'), ...errors },
  }), async (context) => {
    const caller = member(context);
    if (caller.role !== 'owner') throw new ApiError(403, 'PERMISSION_REQUIRED', 'Only an owner changes content types');
    return context.json(await content().createType(caller.teamId, caller.userId, context.req.valid('json')), 200);
  });

  app.openapi(route({
    method: 'put', path: '/v1/content/types/{id}', summary: 'Change a content type; a new shape bumps its schema version (owners)',
    request: { params: idParam, ...body(z.object({ name: z.string().trim().min(1).max(60).optional(), description: z.string().trim().max(300).optional(), definition: definitionSchema.optional() }).strict()) },
    responses: { 200: anyJson('Type'), ...errors },
  }), async (context) => {
    const caller = member(context);
    if (caller.role !== 'owner') throw new ApiError(403, 'PERMISSION_REQUIRED', 'Only an owner changes content types');
    const input = context.req.valid('json');
    return context.json(await content().updateType(caller.teamId, caller.userId, context.req.valid('param').id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.definition !== undefined ? { definition: input.definition } : {}),
    }), 200);
  });

  // MARK: Items

  app.openapi(route({
    method: 'get', path: '/v1/content/entries', summary: 'Items you can see, newest first',
    request: { query: z.object({ app: appKey.optional(), type: uuid.optional() }) },
    responses: { 200: anyJson('Items'), ...errors },
  }), async (context) => {
    const caller = member(context);
    const query = context.req.valid('query');
    const items = await content().entries(caller.teamId, { ...(query.app ? { app: query.app } : {}), ...(query.type ? { typeId: query.type } : {}) });
    return context.json({ entries: visible(caller, items) }, 200);
  });

  app.openapi(route({
    method: 'post', path: '/v1/content/entries', summary: 'A new item (authors and up)',
    request: body(z.object({ app: appKey, typeId: uuid, title: z.string().trim().min(1).max(120), slug: z.string().regex(/^[a-z0-9-]{1,80}$/).optional() }).strict()),
    responses: { 200: anyJson('Item'), ...errors },
  }), async (context) => {
    const input = context.req.valid('json');
    const caller = need(context, input.app, 'author');
    return context.json(await content().createEntry(caller.teamId, caller.userId, input), 200);
  });

  app.openapi(route({
    method: 'get', path: '/v1/content/entries/{id}', summary: 'An item: its latest version, type and reviews',
    request: { params: idParam }, responses: { 200: anyJson('Item'), ...errors },
  }), async (context) => {
    const { caller: _caller, ...found } = await itemFor(context, context.req.valid('param').id, 'author');
    return context.json(found, 200);
  });

  app.openapi(route({
    method: 'put', path: '/v1/content/entries/{id}/draft',
    summary: 'Save the draft (autosave). Send the revision you started from; a newer one answers 409 with the current item',
    request: { params: idParam, ...body(z.object({ title: z.string().trim().min(1).max(120).optional(), body: bodySchema, revision: z.number().int().min(1) }).strict()) },
    responses: { 200: anyJson('Item'), ...errors, 409: anyJson('Someone saved since: the current item') },
  }), async (context) => {
    const { caller } = await itemFor(context, context.req.valid('param').id, 'author');
    try {
      return context.json(await content().saveDraft(caller.teamId, caller.userId, context.req.valid('param').id, context.req.valid('json')), 200);
    } catch (error) {
      if (error instanceof VersionConflict) {
        return context.json({ error: { code: error.code, message: error.message, requestId: context.get('requestId') }, current: error.current }, 409);
      }
      throw error;
    }
  });

  app.openapi(route({
    method: 'delete', path: '/v1/content/entries/{id}', summary: 'Delete an unpublished item',
    request: { params: idParam }, responses: { 200: anyJson('Deleted'), ...errors },
  }), async (context) => {
    const { caller, entry } = await itemFor(context, context.req.valid('param').id, 'author');
    if (entry.ownerId !== caller.userId) need(context, entry.app, 'publisher');
    await content().remove(caller.teamId, caller.userId, entry.id);
    return context.json(ok, 200);
  });

  // MARK: Review

  app.openapi(route({
    method: 'post', path: '/v1/content/entries/{id}/submit', summary: 'Send the draft for review',
    request: { params: idParam }, responses: { 200: anyJson('Item'), ...errors },
  }), async (context) => {
    const { caller, entry } = await itemFor(context, context.req.valid('param').id, 'author');
    return context.json(await content().submit(caller.teamId, caller.userId, entry.id), 200);
  });

  app.openapi(route({
    method: 'post', path: '/v1/content/entries/{id}/reviews', summary: 'Approve a review step or ask for changes (reviewers and up)',
    request: { params: idParam, ...body(z.object({ step: z.string().trim().min(1).max(60), decision: z.enum(['approve', 'changes']), note: z.string().trim().max(2000).optional() }).strict()) },
    responses: { 200: anyJson('Item'), ...errors },
  }), async (context) => {
    const { caller, entry } = await itemFor(context, context.req.valid('param').id, 'reviewer');
    return context.json(await content().decide(caller.teamId, caller.userId, entry.id, context.req.valid('json')), 200);
  });

  app.openapi(route({
    method: 'get', path: '/v1/content/entries/{id}/checks', summary: 'The pre-publish checks on the latest version',
    request: { params: idParam }, responses: { 200: anyJson('Checks'), ...errors },
  }), async (context) => {
    const { caller, entry } = await itemFor(context, context.req.valid('param').id, 'author');
    return context.json({ checks: await content().checks(caller.teamId, entry.id) }, 200);
  });

  app.openapi(route({
    method: 'get', path: '/v1/content/entries/{id}/diff', summary: 'What the latest version changes from the live one',
    request: { params: idParam }, responses: { 200: anyJson('Diff'), ...errors },
  }), async (context) => {
    const { caller, entry } = await itemFor(context, context.req.valid('param').id, 'author');
    return context.json(await content().diff(caller.teamId, entry.id), 200);
  });

  app.openapi(route({
    method: 'get', path: '/v1/content/entries/{id}/comments', summary: 'Comments on an item',
    request: { params: idParam }, responses: { 200: anyJson('Comments'), ...errors },
  }), async (context) => {
    const { caller, entry } = await itemFor(context, context.req.valid('param').id, 'author');
    return context.json({ comments: await content().comments(caller.teamId, entry.id) }, 200);
  });

  app.openapi(route({
    method: 'post', path: '/v1/content/entries/{id}/comments', summary: 'Comment on an item, or on one block',
    request: { params: idParam, ...body(z.object({ body: z.string().trim().min(1).max(4000), blockId: z.string().max(80).nullable().optional() }).strict()) },
    responses: { 200: anyJson('Comments'), ...errors },
  }), async (context) => {
    const { caller, entry } = await itemFor(context, context.req.valid('param').id, 'author');
    return context.json({ comments: await content().addComment(caller.teamId, caller.userId, entry.id, context.req.valid('json')) }, 200);
  });

  app.openapi(route({
    method: 'patch', path: '/v1/content/comments/{id}', summary: 'Resolve or reopen a comment',
    request: { params: idParam, ...body(z.object({ resolved: z.boolean() }).strict()) },
    responses: { 200: anyJson('Comments'), ...errors },
  }), async (context) => {
    const caller = member(context);
    const entryId = await content().resolveComment(caller.teamId, context.req.valid('param').id, context.req.valid('json').resolved);
    await itemFor(context, entryId, 'author');
    return context.json({ comments: await content().comments(caller.teamId, entryId) }, 200);
  });

  // MARK: Media

  app.openapi(route({
    method: 'post', path: '/v1/content/media/uploads',
    summary: 'Where to PUT an image (then POST /v1/content/media/{id}/commit); one already uploaded answers with no upload',
    request: body(z.object({
      app: appKey, sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().min(1).max(20 * 1024 * 1024),
      contentType: z.enum(Object.keys(MEDIA_TYPES) as [MediaType, ...MediaType[]]),
      width: z.number().int().min(1).max(20000).optional(), height: z.number().int().min(1).max(20000).optional(),
    }).strict()),
    responses: { 200: anyJson('Upload'), ...errors },
  }), async (context) => {
    const input = context.req.valid('json');
    const caller = need(context, input.app, 'author');
    return context.json(await content().startUpload(caller.teamId, caller.userId, input), 200);
  });

  app.openapi(route({
    method: 'post', path: '/v1/content/media/{id}/commit', summary: 'Mark an upload finished',
    request: { params: idParam }, responses: { 200: anyJson('Image'), ...errors },
  }), async (context) => {
    const caller = member(context);
    need(context, await content().mediaApp(caller.teamId, context.req.valid('param').id), 'author');
    return context.json(await content().commitUpload(caller.teamId, context.req.valid('param').id), 200);
  });

  app.openapi(route({
    method: 'get', path: '/v1/content/media', summary: 'An app’s uploaded images',
    request: { query: z.object({ app: appKey }) }, responses: { 200: anyJson('Images'), ...errors },
  }), async (context) => {
    const app = context.req.valid('query').app;
    const caller = need(context, app, 'author');
    return context.json({ media: await content().media(caller.teamId, app) }, 200);
  });

  app.openapi(route({
    method: 'patch', path: '/v1/content/media/{id}', summary: 'An image’s alt text',
    request: { params: idParam, ...body(z.object({ alt: z.string().trim().max(500) }).strict()) },
    responses: { 200: anyJson('Image'), ...errors },
  }), async (context) => {
    const caller = member(context);
    need(context, await content().mediaApp(caller.teamId, context.req.valid('param').id), 'author');
    return context.json(await content().setAlt(caller.teamId, context.req.valid('param').id, context.req.valid('json').alt), 200);
  });

  // MARK: Publishing

  app.openapi(route({
    method: 'post', path: '/v1/content/entries/{id}/publish',
    summary: 'Publish the latest version now or at a time (publishers; owners may override missing approvals)',
    request: { params: idParam, ...body(z.object({ override: z.boolean().default(false), at: z.iso.datetime({ offset: true }).optional() }).strict()) },
    responses: { 200: anyJson('Release'), ...errors },
  }), async (context) => {
    const { caller, entry } = await itemFor(context, context.req.valid('param').id, 'publisher');
    needRecentSignIn(context);
    const input = context.req.valid('json');
    return context.json(await content().publish(caller.teamId, caller.userId, entry.id, {
      override: input.override, canOverride: caller.role === 'owner', ...(input.at ? { at: new Date(input.at) } : {}),
    }), 200);
  });

  app.openapi(route({
    method: 'post', path: '/v1/content/entries/{id}/rollback', summary: 'Point the app back at an earlier release (publishers)',
    request: { params: idParam, ...body(z.object({ releaseId: uuid }).strict()) },
    responses: { 200: anyJson('Release'), ...errors },
  }), async (context) => {
    const { caller, entry } = await itemFor(context, context.req.valid('param').id, 'publisher');
    needRecentSignIn(context);
    return context.json(await content().rollback(caller.teamId, caller.userId, entry.id, context.req.valid('json').releaseId), 200);
  });

  app.openapi(route({
    method: 'post', path: '/v1/content/entries/{id}/unpublish', summary: 'Take an item out of its app (publishers)',
    request: { params: idParam }, responses: { 200: anyJson('Unpublished'), ...errors },
  }), async (context) => {
    const { caller, entry } = await itemFor(context, context.req.valid('param').id, 'publisher');
    needRecentSignIn(context);
    return context.json(await content().unpublish(caller.teamId, caller.userId, entry.id), 200);
  });

  app.openapi(route({
    method: 'delete', path: '/v1/content/releases/{id}', summary: 'Cancel a scheduled publish',
    request: { params: idParam }, responses: { 200: anyJson('Canceled'), ...errors },
  }), async (context) => {
    const caller = member(context);
    const releases = await content().releases(caller.teamId);
    const release = releases.find((entry) => entry.id === context.req.valid('param').id);
    if (!release) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Nothing is scheduled there');
    need(context, release.app, 'publisher');
    await content().cancelScheduled(caller.teamId, caller.userId, release.id);
    return context.json(ok, 200);
  });

  app.openapi(route({
    method: 'get', path: '/v1/content/releases', summary: 'Publishes, rollbacks and schedules, newest first',
    request: { query: z.object({ app: appKey.optional(), entry: uuid.optional() }) },
    responses: { 200: anyJson('Releases'), ...errors },
  }), async (context) => {
    const caller = member(context);
    await content().runDue().catch(() => 0);
    const query = context.req.valid('query');
    const releases = await content().releases(caller.teamId, { app: query.app, entryId: query.entry });
    return context.json({ releases: visible(caller, releases) }, 200);
  });

  app.openapi(route({
    method: 'get', path: '/v1/content/catalogs', summary: 'Each app’s catalog: version, items, minimum app version',
    responses: { 200: anyJson('Catalogs'), ...errors },
  }), async (context) => {
    const caller = member(context);
    return context.json({ catalogs: visible(caller, await content().catalogs(caller.teamId)) }, 200);
  });

  app.openapi(route({
    method: 'put', path: '/v1/content/catalogs/{app}', summary: 'The oldest app version that can read this catalog (owners)',
    request: { params: z.object({ app: appKey.openapi({ param: { name: 'app', in: 'path' } }) }), ...body(z.object({ minAppVersion: z.string().regex(/^\d+(\.\d+){0,2}$/) }).strict()) },
    responses: { 200: anyJson('Catalog'), ...errors },
  }), async (context) => {
    const caller = need(context, context.req.valid('param').app, 'owner');
    await content().setMinAppVersion(caller.teamId, caller.userId, context.req.valid('param').app, context.req.valid('json').minAppVersion);
    return context.json(ok, 200);
  });
}
