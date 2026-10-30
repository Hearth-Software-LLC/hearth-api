import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono, RouteConfig } from '@hono/zod-openapi';
import type { Sql } from 'postgres';
import { errorSchema } from '../contracts/common.js';
import type { ApiEnvironment } from '../contracts/common.js';
import { ApiError } from '../errors.js';
import { ENTITLEMENT_KEYS } from '../services/subscriptions.js';
import { VersionConflict } from './documents.js';
import type { DocumentsService } from './documents.js';
import { memberOf, need, studioMiddleware, teamOf } from './gate.js';
import type { GitHubApps } from './github.js';
import { LIBRARY_KINDS, LIBRARY_TYPES } from './library.js';
import type { LibraryService } from './library.js';
import { planKey } from './plans.js';
import type { PlansBackend } from './plans.js';
import type { MonetizationBackend } from './monetization.js';
import { DESCRIPTION_LIMIT, DISPLAY_NAME_LIMIT, PERIODS, TRIALS } from './storeProducts.js';
import type { StoreProducts } from './storeProducts.js';
import { HEARTH_SCOPE, desiredProducts, setUpProduct } from './monetizationPlans.js';
import type { PlanStore } from './monetizationPlans.js';
import { can } from './team.js';
import type { ContentAccess, Member, TeamService } from './team.js';

/**
 * Hearth Studio's API (Mac, iPhone, iPad): the team, plans, the Library, ad campaigns, Store
 * Studio designs and the apps. Everything is the caller's team's; see gate.ts.
 */

export type StudioDependencies = {
  team: () => TeamService | undefined;
  library: () => LibraryService | undefined;
  documents: () => DocumentsService | undefined;
  plans: () => PlansBackend | undefined;
  apps: () => GitHubApps | undefined;
  /** Store › Monetization: App Store Connect and RevenueCat, read-only. */
  monetization: () => MonetizationBackend | undefined;
  /** Creating and finishing products in App Store Connect and RevenueCat (admins). */
  storeProducts: () => StoreProducts | undefined;
  /** The plans each app sells, as the team defines them. */
  planDefinitions: () => PlanStore | undefined;
  /** For the grant log. */
  sql: () => Sql | undefined;
};

const appKey = z.string().regex(/^[a-z0-9-]{1,40}$/);
const uuid = z.uuid();
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const contentType = z.enum(Object.keys(LIBRARY_TYPES) as [keyof typeof LIBRARY_TYPES, ...(keyof typeof LIBRARY_TYPES)[]]);
const kind = z.enum(LIBRARY_KINDS);
const cursor = z.coerce.number().int().min(0).default(0);

const failure = (description: string) => ({ description, content: { 'application/json': { schema: errorSchema } } });
const errors = {
  400: failure('Invalid request'), 401: failure('Invalid or missing token'), 403: failure('Not on the team, or not allowed'),
  404: failure('Not found'), 409: failure('Conflicts with a newer version or a limit'), 422: failure('Not possible'),
  502: failure('A provider failed'), 503: failure('Not configured or unavailable'),
} as const;
/** Drops undefined fields (exactOptionalPropertyTypes). */
const defined = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };
const anyJson = (description: string) => ({ description, content: { 'application/json': { schema: z.any() } } });
const body = <T extends z.ZodType>(schema: T) => ({ body: { required: true, content: { 'application/json': { schema } } } });
const route = <R extends Omit<RouteConfig, 'tags' | 'security'>>(tag: string, config: R) =>
  createRoute({ ...config, tags: [tag], security: [{ BearerAuth: [] }] } as R & { tags: string[] });
const ok = { ok: true as const };

const memberView = (member: Member) => ({
  userId: member.userId, role: member.role, displayName: member.displayName,
  permissions: {
    post: can(member, 'post'), plans: can(member, 'plans'), accounts: can(member, 'accounts'), affiliates: can(member, 'affiliates'),
    monetization: can(member, 'monetization'), team: can(member, 'owner'),
  },
  notifications: { due: member.notifyDue, comments: member.notifyComments, failed: member.notifyFailed },
  addedAt: member.addedAt,
  /** Hearth Content: the role set on them (owners and admins get theirs from their team role). */
  content: { role: member.contentRole, apps: member.contentApps },
});

/** A content role and its apps (null apps: every app); role null takes content access away. */
const contentAccess = z.object({
  role: z.enum(['author', 'reviewer', 'publisher']).nullable(),
  apps: z.array(appKey).min(1).max(40).nullable(),
}).strict();

export function registerStudio(app: OpenAPIHono<ApiEnvironment>, dependencies: StudioDependencies) {
  const required = <T>(get: () => T | undefined, what: string): T => {
    const value = get();
    if (!value) throw new ApiError(503, 'STORAGE_NOT_CONFIGURED', `${what} is not configured`);
    return value;
  };
  const team = () => required(dependencies.team, 'Hearth Studio');
  const library = () => required(dependencies.library, 'The Library');
  const documents = () => required(dependencies.documents, 'Campaigns and designs');
  const plans = () => required(dependencies.plans, 'Plans (REVENUECAT_SECRET_API_KEY, REVENUECAT_PROJECT_ID)');
  const apps = () => required(dependencies.apps, 'Apps from GitHub (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY)');

  /** A member with a signed link to their profile photo (null without one, or without storage). */
  const view = async (member: Member) => {
    const lib = dependencies.library();
    const avatarUrl = member.avatarPath && lib ? await lib.avatarUrl(member.avatarPath).catch(() => null) : null;
    return { ...memberView(member), avatarUrl };
  };

  const gate = studioMiddleware(dependencies.team);
  // Joining is the one Studio call for someone not on the team yet.
  app.use('/v1/studio/*', async (context, next) => (/^\/v1\/studio\/invites\/[^/]+\/join$/.test(context.req.path) ? next() : gate(context, next)));
  app.use('/v1/library/*', gate);

  // MARK: Team

  app.openapi(route('Studio team', {
    method: 'get', path: '/v1/studio/me', summary: 'The caller on the team: role, permissions, notifications',
    responses: { 200: anyJson('Membership'), ...errors },
  }), async (context) => {
    const member = memberOf(context);
    return context.json({ team: { id: member.teamId, name: member.teamName }, ...(await view(member)) }, 200);
  });

  app.openapi(route('Studio team', {
    method: 'patch', path: '/v1/studio/me', summary: 'Your display name and which notifications you get',
    request: body(z.object({
      displayName: z.string().trim().min(1).max(80).nullable().optional(),
      notifications: z.object({ due: z.boolean().optional(), comments: z.boolean().optional(), failed: z.boolean().optional() }).strict().optional(),
    }).strict()),
    responses: { 200: anyJson('Membership'), ...errors },
  }), async (context) => {
    const member = memberOf(context);
    const input = context.req.valid('json');
    if (input.notifications) await team().setNotifications(member.teamId, member.userId, defined(input.notifications));
    const updated = input.displayName !== undefined
      ? await team().updateMember(member.teamId, member.userId, { displayName: input.displayName })
      : (await team().members(member.teamId)).find((entry) => entry.userId === member.userId)!;
    return context.json({ team: { id: updated.teamId, name: updated.teamName }, ...(await view(updated)) }, 200);
  });

  app.openapi(route('Studio team', {
    method: 'get', path: '/v1/studio/members', summary: 'Everyone on the team',
    responses: { 200: anyJson('Members'), ...errors },
  }), async (context) => context.json({ members: await Promise.all((await team().members(teamOf(context))).map(view)) }, 200));

  const avatarType = z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);

  app.openapi(route('Studio team', {
    method: 'post', path: '/v1/studio/me/avatar/upload',
    summary: 'Where to PUT your new profile photo (then PUT /v1/studio/me/avatar with its path)',
    request: body(z.object({ sha256: sha, bytes: z.number().int().min(1), contentType: avatarType }).strict()),
    responses: { 200: anyJson('Upload target'), ...errors },
  }), async (context) => {
    const member = memberOf(context);
    return context.json(await library().startAvatarUpload(member.teamId, member.userId, context.req.valid('json')), 200);
  });

  app.openapi(route('Studio team', {
    method: 'put', path: '/v1/studio/me/avatar', summary: 'Use an uploaded profile photo (path from the upload), or null to remove it',
    request: body(z.object({ path: z.string().min(10).max(300).nullable() }).strict()),
    responses: { 200: anyJson('Membership'), ...errors },
  }), async (context) => {
    const member = memberOf(context);
    const { path } = context.req.valid('json');
    // Only a photo this member uploaded for this team.
    if (path !== null && !path.startsWith(`${member.teamId}/avatars/${member.userId}/`)) {
      throw new ApiError(400, 'INVALID_REQUEST', 'That isn’t your uploaded photo');
    }
    const previous = await team().setAvatar(member.teamId, member.userId, path);
    if (previous && previous !== path) await dependencies.library()?.removeAvatar(previous);
    const updated = (await team().members(member.teamId)).find((entry) => entry.userId === member.userId)!;
    return context.json({ team: { id: updated.teamId, name: updated.teamName }, ...(await view(updated)) }, 200);
  });

  app.openapi(route('Studio team', {
    method: 'patch', path: '/v1/studio/members/{userId}', summary: 'A member’s role (admin or member) and what they can do (owners only)',
    request: {
      params: z.object({ userId: uuid.openapi({ param: { name: 'userId', in: 'path' } }) }),
      ...body(z.object({ role: z.enum(['admin', 'member']).optional(), post: z.boolean().optional(), plans: z.boolean().optional(), accounts: z.boolean().optional(), affiliates: z.boolean().optional(), content: contentAccess.optional() }).strict()),
    },
    responses: { 200: anyJson('Member'), ...errors },
  }), async (context) => {
    const owner = need(context, 'owner');
    const input = context.req.valid('json');
    const updated = await team().updateMember(owner.teamId, context.req.valid('param').userId, defined({ role: input.role, canPost: input.post, canPlans: input.plans, canAccounts: input.accounts, canAffiliates: input.affiliates, content: input.content as ContentAccess | undefined }));
    return context.json(await view(updated), 200);
  });

  app.openapi(route('Studio team', {
    method: 'delete', path: '/v1/studio/members/{userId}', summary: 'Take someone off the team (owners only)',
    request: { params: z.object({ userId: uuid.openapi({ param: { name: 'userId', in: 'path' } }) }) },
    responses: { 200: anyJson('Removed'), ...errors },
  }), async (context) => {
    const owner = need(context, 'owner');
    await team().removeMember(owner.teamId, context.req.valid('param').userId);
    return context.json(ok, 200);
  });

  app.openapi(route('Studio team', {
    method: 'post', path: '/v1/studio/invites', summary: 'An invite code for someone to join the team (owners only; a week, one use)',
    request: body(z.object({ post: z.boolean().default(true), plans: z.boolean().default(false), accounts: z.boolean().default(false), affiliates: z.boolean().default(false), content: contentAccess.optional() }).strict()),
    responses: { 200: anyJson('Invite'), ...errors },
  }), async (context) => {
    const owner = need(context, 'owner');
    const input = context.req.valid('json');
    return context.json(await team().createInvite(owner.teamId, owner.userId, { canPost: input.post, canPlans: input.plans, canAccounts: input.accounts, canAffiliates: input.affiliates, ...(input.content ? { content: input.content as ContentAccess } : {}) }), 200);
  });

  app.openapi(route('Studio team', {
    method: 'post', path: '/v1/studio/invites/{code}/join', summary: 'Join the team with an invite code',
    request: {
      params: z.object({ code: z.string().regex(/^[A-Za-z2-9]{8}$/).openapi({ param: { name: 'code', in: 'path' } }) }),
      ...body(z.object({ displayName: z.string().trim().min(1).max(80).nullable().optional() }).strict()),
    },
    responses: { 200: anyJson('Membership'), ...errors },
  }), async (context) => {
    if (context.get('isAnonymous')) throw new ApiError(403, 'REGISTERED_IDENTITY_REQUIRED', 'Sign in with Apple to join');
    const userId = context.get('userId');
    await team().join(context.req.valid('param').code, userId, context.req.valid('json').displayName ?? null);
    const member = (await team().memberOf(userId))!;
    return context.json({ team: { id: member.teamId, name: member.teamName }, ...(await view(member)) }, 200);
  });

  app.openapi(route('Studio team', {
    method: 'post', path: '/v1/studio/devices', summary: 'Register this device for Hearth Studio pushes',
    request: body(z.object({
      token: z.string().regex(/^[0-9a-fA-F]{32,200}$/), topic: z.string().regex(/^[A-Za-z0-9.-]{3,155}$/), environment: z.enum(['sandbox', 'production']),
    }).strict()),
    responses: { 200: anyJson('Registered'), ...errors },
  }), async (context) => {
    const member = memberOf(context);
    await team().registerDevice(member.teamId, member.userId, context.req.valid('json'));
    return context.json(ok, 200);
  });

  app.openapi(route('Studio team', {
    method: 'delete', path: '/v1/studio/devices/{token}', summary: 'Stop pushes to this device (signing out)',
    request: { params: z.object({ token: z.string().regex(/^[0-9a-fA-F]{32,200}$/).openapi({ param: { name: 'token', in: 'path' } }) }) },
    responses: { 200: anyJson('Removed'), ...errors },
  }), async (context) => {
    await team().removeDevice(context.get('userId'), context.req.valid('param').token);
    return context.json(ok, 200);
  });

  // MARK: Apps (GitHub)

  app.openapi(route('Studio apps', {
    method: 'get', path: '/v1/studio/apps', summary: 'The Hearth apps: repos in the organization with a hearth-app.json',
    responses: { 200: anyJson('Apps'), ...errors },
  }), async (context) => {
    const teamId = teamOf(context);
    const list = await apps().list();
    const lib = dependencies.library();
    const result = [];
    for (const entry of list) {
      let iconAssetId: string | null = null;
      let iconUrl: string | null = null;
      if (entry.icon && lib) {
        const icon = await lib.ensureIcon(teamId, entry.key, entry.icon.bytes, entry.icon.sha256, entry.icon.contentType).catch(() => undefined);
        if (icon) {
          iconAssetId = icon.id;
          iconUrl = (await lib.url(teamId, icon.id, false).catch(() => undefined))?.url ?? null;
        }
      }
      const { icon: _icon, ...rest } = entry;
      result.push({ ...rest, iconAssetId, iconUrl });
    }
    return context.json({ apps: result }, 200);
  });

  // MARK: Monetization

  app.openapi(route('Studio monetization', {
    method: 'get', path: '/v1/studio/monetization',
    summary: 'Every app’s plans: App Store Connect products (US price, trial, review state) and how RevenueCat sells them',
    request: { query: z.object({ refresh: z.enum(['true', 'false']).default('false') }) },
    responses: { 200: anyJson('Apps and their products'), ...errors },
  }), async (context) => {
    need(context, 'plans');
    const backend = required(dependencies.monetization, 'Monetization (ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY or REVENUECAT_SECRET_API_KEY)');
    return context.json(await backend.overview(context.req.valid('query').refresh === 'true'), 200);
  });

  // Products (admins): everything App Store Connect and RevenueCat need before a plan is on sale.
  const productChanges = z.object({
    referenceName: z.string().trim().min(1).max(64).optional(),
    displayName: z.string().trim().min(1).max(DISPLAY_NAME_LIMIT).optional(),
    description: z.string().trim().min(1).max(DESCRIPTION_LIMIT).optional(),
    groupDisplayName: z.string().trim().min(1).max(DISPLAY_NAME_LIMIT).optional(),
    familySharable: z.boolean().optional(),
    reviewNote: z.string().trim().max(4000).optional(),
    priceUSD: z.string().regex(/^\d{1,5}(\.\d{1,2})?$/).optional(),
    soldIn: z.enum(['us', 'everywhere']).optional(),
    trial: z.union([z.enum(TRIALS), z.literal('')]).optional(),
    package: z.string().regex(/^[$A-Za-z0-9_.-]{1,200}$/).optional(),
    replaceInPackage: z.boolean().optional(),
    entitlement: z.string().regex(/^[A-Za-z0-9_.-]{1,200}$/).optional(),
  }).strict();
  const productParams = z.object({
    app: appKey.openapi({ param: { name: 'app', in: 'path' } }),
    productId: z.string().regex(/^[A-Za-z0-9._]{2,100}$/).openapi({ param: { name: 'productId', in: 'path' } }),
  });
  const products = () => required(dependencies.storeProducts, 'Store products (ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY)');
  const storeApp = async (key: string) => {
    const overview = await required(dependencies.monetization, 'Monetization').overview();
    const found = overview.apps.find((entry) => entry.key === key);
    if (!found?.appStoreId) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'That app isn’t in App Store Connect');
    return { appStoreId: found.appStoreId, bundleId: found.bundleId, name: found.name };
  };

  app.openapi(route('Studio monetization', {
    method: 'get', path: '/v1/studio/monetization/{app}/products/{productId}', summary: 'A product as the editor shows it, with what’s still missing',
    request: { params: productParams },
    responses: { 200: anyJson('Product editor'), ...errors },
  }), async (context) => {
    need(context, 'monetization');
    const { app: key, productId } = context.req.valid('param');
    const target = await storeApp(key);
    return context.json(await products().editor(target.appStoreId, target.bundleId, productId), 200);
  });

  app.openapi(route('Studio monetization', {
    method: 'put', path: '/v1/studio/monetization/{app}/products/{productId}', summary: 'Save a product’s App Store Connect details and RevenueCat package and entitlement',
    request: { params: productParams, ...body(productChanges) },
    responses: { 200: anyJson('Product editor'), ...errors },
  }), async (context) => {
    need(context, 'monetization');
    const { app: key, productId } = context.req.valid('param');
    const target = await storeApp(key);
    // The overview isn't invalidated here: Hearth+ saves go app by app, and the client refreshes it once at the end.
    return context.json(await products().save(target.appStoreId, target.bundleId, productId, defined(context.req.valid('json'))), 200);
  });

  app.openapi(route('Studio monetization', {
    method: 'post', path: '/v1/studio/monetization/{app}/products', summary: 'Create a subscription or one-time purchase, then save its details',
    request: {
      params: z.object({ app: appKey.openapi({ param: { name: 'app', in: 'path' } }) }),
      ...body(z.object({
        kind: z.enum(['subscription', 'non_consumable']),
        productId: z.string().regex(/^[A-Za-z0-9._]{2,100}$/),
        referenceName: z.string().trim().min(1).max(64),
        period: z.enum(PERIODS).optional(),
        changes: productChanges.default({}),
      }).strict()),
    },
    responses: { 200: anyJson('Product editor'), ...errors },
  }), async (context) => {
    need(context, 'monetization');
    const target = await storeApp(context.req.valid('param').app);
    const input = context.req.valid('json');
    return context.json(await products().create(target.appStoreId, target.name, target.bundleId, {
      kind: input.kind, productId: input.productId, referenceName: input.referenceName,
      ...(input.period ? { period: input.period } : {}), changes: defined(input.changes),
    }), 200);
  });

  app.openapi(route('Studio monetization', {
    method: 'post', path: '/v1/studio/monetization/{app}/products/{productId}/screenshot', summary: 'Reserve the App Review screenshot upload (the client PUTs the bytes to Apple)',
    request: { params: productParams, ...body(z.object({ fileName: z.string().regex(/^[^/\\]{1,120}\.(png|jpe?g)$/i), fileSize: z.number().int().min(1).max(30_000_000) }).strict()) },
    responses: { 200: anyJson('Upload operations'), ...errors },
  }), async (context) => {
    need(context, 'monetization');
    const { app: key, productId } = context.req.valid('param');
    const target = await storeApp(key);
    const input = context.req.valid('json');
    return context.json(await products().reserveScreenshot(target.appStoreId, productId, input.fileName, input.fileSize), 200);
  });

  app.openapi(route('Studio monetization', {
    method: 'post', path: '/v1/studio/monetization/{app}/products/{productId}/screenshot/{id}/commit', summary: 'Finish the App Review screenshot upload',
    request: {
      params: productParams.extend({ id: z.string().regex(/^[A-Za-z0-9-]{1,100}$/).openapi({ param: { name: 'id', in: 'path' } }) }),
      ...body(z.object({ checksum: z.string().regex(/^[0-9a-f]{32}$/) }).strict()),
    },
    responses: { 200: anyJson('Product editor'), ...errors },
  }), async (context) => {
    need(context, 'monetization');
    const { app: key, productId, id } = context.req.valid('param');
    const target = await storeApp(key);
    return context.json(await products().commitScreenshot(target.appStoreId, target.bundleId, productId, id, context.req.valid('json').checksum), 200);
  });

  // Plan definitions (billing, price, trial, what it unlocks) and Set Up Plans.
  const definitions = () => required(dependencies.planDefinitions, 'Plan definitions (DATABASE_URL)');
  const planTerm = z.object({
    price: z.string().regex(/^\d{1,5}(\.\d{1,2})?$/),
    trial: z.union([z.enum(TRIALS), z.literal('')]).optional(),
  }).strict();
  const planDefinition = z.object({
    monthly: planTerm.optional(), annual: planTerm.optional(), lifetime: planTerm.omit({ trial: true }).optional(),
    unlocks: z.string().trim().max(DESCRIPTION_LIMIT).optional(),
    soldIn: z.enum(['us', 'everywhere']).optional(),
    reviewNote: z.string().trim().max(4000).optional(),
  }).strict();

  app.openapi(route('Studio monetization', {
    method: 'get', path: '/v1/studio/monetization/plans', summary: 'The plans each app sells (and Hearth+, scope "hearth"), as the team defines them',
    responses: { 200: anyJson('Plan definitions'), ...errors },
  }), async (context) => {
    const member = need(context, 'plans');
    return context.json({ plans: await definitions().list(member.teamId) }, 200);
  });

  app.openapi(route('Studio monetization', {
    method: 'put', path: '/v1/studio/monetization/plans/{scope}', summary: 'Save an app’s plans (or Hearth+’s, scope "hearth"); version 0 creates',
    request: {
      params: z.object({ scope: appKey.openapi({ param: { name: 'scope', in: 'path' } }) }),
      ...body(z.object({ definition: planDefinition, version: z.number().int().min(0) }).strict()),
    },
    responses: { 200: anyJson('Plan definition'), ...errors, 409: anyJson('Saved since version: the error and the current plans') },
  }), async (context) => {
    const member = need(context, 'monetization');
    const input = context.req.valid('json');
    const definition = JSON.parse(JSON.stringify(input.definition)) as Record<string, unknown>;
    try {
      return context.json(await definitions().save(member.teamId, member.userId, context.req.valid('param').scope, definition, input.version), 200);
    } catch (error) {
      if (error instanceof VersionConflict) return context.json({ error: { code: error.code, message: error.message, requestId: context.get('requestId') }, current: error.current }, 409);
      throw error;
    }
  });

  const desiredFor = async (teamId: string, key: string) => {
    const target = await storeApp(key);
    const [own, hearth] = await Promise.all([definitions().get(teamId, key), definitions().get(teamId, HEARTH_SCOPE)]);
    return { target, desired: desiredProducts({ key, name: target.name, bundleId: target.bundleId }, own?.definition, hearth?.definition) };
  };

  app.openapi(route('Studio monetization', {
    method: 'get', path: '/v1/studio/monetization/{app}/setup', summary: 'The products an app’s plans (and Hearth+) call for, by the house conventions',
    request: { params: z.object({ app: appKey.openapi({ param: { name: 'app', in: 'path' } }) }) },
    responses: { 200: anyJson('Products to set up'), ...errors },
  }), async (context) => {
    const member = need(context, 'monetization');
    const { desired } = await desiredFor(member.teamId, context.req.valid('param').app);
    return context.json({ products: desired }, 200);
  });

  app.openapi(route('Studio monetization', {
    method: 'post', path: '/v1/studio/monetization/{app}/setup/{productId}',
    summary: 'Create the product if it’s missing and fill what’s blank from the plan (force: use the plan’s values everywhere)',
    request: {
      params: productParams,
      ...body(z.object({ force: z.boolean().optional(), replaceInPackage: z.boolean().optional() }).strict()),
    },
    responses: { 200: anyJson('What was done'), ...errors },
  }), async (context) => {
    const member = need(context, 'monetization');
    const { app: key, productId } = context.req.valid('param');
    const { target, desired } = await desiredFor(member.teamId, key);
    const wanted = desired.find((entry) => entry.productId === productId);
    if (!wanted) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'No plan calls for that product');
    return context.json(await setUpProduct(products(), target, wanted, defined(context.req.valid('json'))), 200);
  });

  // MARK: Plans

  const planParams = z.object({
    id: uuid.openapi({ param: { name: 'id', in: 'path' } }),
    plan: z.string().regex(/^[a-z_]{3,20}$/).openapi({ param: { name: 'plan', in: 'path' } }),
  });

  app.openapi(route('Studio plans', {
    method: 'get', path: '/v1/studio/accounts', summary: 'Find Hearth accounts by name, email or id (Grant plans)',
    request: { query: z.object({ search: z.string().max(120).default('') }) },
    responses: { 200: anyJson('Accounts'), ...errors },
  }), async (context) => {
    need(context, 'plans');
    return context.json({ accounts: await plans().search(context.req.valid('query').search) }, 200);
  });

  app.openapi(route('Studio plans', {
    method: 'get', path: '/v1/studio/accounts/{id}', summary: 'An account’s plans (granted, bought, from the household) and their history',
    request: { params: z.object({ id: uuid.openapi({ param: { name: 'id', in: 'path' } }) }) },
    responses: { 200: anyJson('Account'), ...errors },
  }), async (context) => {
    const member = need(context, 'plans');
    const id = context.req.valid('param').id;
    const detail = await plans().detail(id);
    if (!detail) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Account not found');
    return context.json({ ...detail, history: await history(member.teamId, id) }, 200);
  });

  async function history(teamId: string, accountId: string) {
    const sql = dependencies.sql();
    if (!sql) return [];
    const rows = await sql`
      select l.entitlement, l.action, l.expires_at, l.created_at, l.actor_id, m.display_name
      from plan_grants_log l left join studio_members m on m.team_id = l.team_id and m.user_id = l.actor_id
      where l.team_id = ${teamId} and l.account_id = ${accountId} order by l.created_at desc limit 50`;
    return rows.map((row) => ({
      entitlement: String(row.entitlement), action: String(row.action),
      expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : null,
      at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      by: { userId: String(row.actor_id), name: (row.display_name as string | null) ?? null },
    }));
  }

  async function log(member: Member, accountId: string, entitlement: string, action: 'grant' | 'revoke', expiresAt: string | null) {
    const sql = dependencies.sql();
    if (!sql) return;
    await sql`
      insert into plan_grants_log (team_id, actor_id, account_id, entitlement, action, expires_at)
      values (${member.teamId}, ${member.userId}, ${accountId}, ${entitlement}, ${action}, ${expiresAt})`;
  }

  app.openapi(route('Studio plans', {
    method: 'put', path: '/v1/studio/accounts/{id}/plans/{plan}', summary: 'Grant a plan (until: null never expires)',
    request: { params: planParams, ...body(z.object({ until: z.iso.datetime({ offset: true }).nullable() }).strict()) },
    responses: { 200: anyJson('Account'), ...errors },
  }), async (context) => {
    const member = need(context, 'plans');
    const { id, plan } = context.req.valid('param');
    const { until } = context.req.valid('json');
    if (until && Date.parse(until) <= Date.now()) throw new ApiError(400, 'INVALID_REQUEST', 'The end date has to be in the future');
    const key = planKey(plan);
    if (!(await plans().detail(id))) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Account not found');
    await plans().grant(id, key, until);
    await log(member, id, key, 'grant', until);
    return context.json({ ...(await plans().detail(id))!, history: await history(member.teamId, id) }, 200);
  });

  app.openapi(route('Studio plans', {
    method: 'delete', path: '/v1/studio/accounts/{id}/plans/{plan}', summary: 'Remove a granted plan (a bought one can’t be)',
    request: { params: planParams },
    responses: { 200: anyJson('Account'), ...errors },
  }), async (context) => {
    const member = need(context, 'plans');
    const { id, plan } = context.req.valid('param');
    const key = planKey(plan);
    await plans().revoke(id, key);
    await log(member, id, key, 'revoke', null);
    return context.json({ ...(await plans().detail(id))!, history: await history(member.teamId, id) }, 200);
  });

  app.openapi(route('Studio plans', {
    method: 'get', path: '/v1/studio/plans', summary: 'The plans there are',
    responses: { 200: anyJson('Plans'), ...errors },
  }), async (context) => context.json({ plans: [...ENTITLEMENT_KEYS] }, 200));

  // MARK: Campaigns and designs

  const campaignParams = z.object({
    app: appKey.openapi({ param: { name: 'app', in: 'path' } }),
    slug: z.string().regex(/^[a-z0-9-]{1,80}$/).openapi({ param: { name: 'slug', in: 'path' } }),
  });
  const documentBody = z.record(z.string(), z.unknown()).refine((value) => JSON.stringify(value).length <= 500_000, 'Too large');

  app.openapi(route('Studio campaigns', {
    method: 'get', path: '/v1/studio/campaigns', summary: 'Ad campaigns changed after a cursor (0: all)',
    request: { query: z.object({ since: cursor, app: appKey.optional() }) },
    responses: { 200: anyJson('Campaigns'), ...errors },
  }), async (context) => {
    const query = context.req.valid('query');
    return context.json(await documents().campaigns(teamOf(context), query.since, query.app), 200);
  });

  app.openapi(route('Studio campaigns', {
    method: 'get', path: '/v1/studio/campaigns/{app}/{slug}', summary: 'One campaign',
    request: { params: campaignParams },
    responses: { 200: anyJson('Campaign'), ...errors },
  }), async (context) => {
    const { app: appId, slug } = context.req.valid('param');
    const found = await documents().campaign(teamOf(context), appId, slug);
    if (!found) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Campaign not found');
    return context.json(found, 200);
  });

  app.openapi(route('Studio campaigns', {
    method: 'put', path: '/v1/studio/campaigns/{app}/{slug}',
    summary: 'Save a campaign: baseVersion 0 creates it; otherwise the version it was based on (409 with the current one if it changed)',
    request: { params: campaignParams, ...body(z.object({ name: z.string().trim().min(1).max(120), document: documentBody, baseVersion: z.number().int().min(0) }).strict()) },
    responses: { 200: anyJson('Campaign'), ...errors, 409: anyJson('Saved since baseVersion: the error and the current campaign') },
  }), async (context) => {
    const member = need(context, 'post');
    const { app: appId, slug } = context.req.valid('param');
    try {
      return context.json(await documents().saveCampaign(member.teamId, member.userId, appId, slug, context.req.valid('json')), 200);
    } catch (error) {
      if (error instanceof VersionConflict) return context.json({ error: { code: error.code, message: error.message, requestId: context.get('requestId') }, current: error.current }, 409);
      throw error;
    }
  });

  app.openapi(route('Studio campaigns', {
    method: 'delete', path: '/v1/studio/campaigns/{app}/{slug}', summary: 'Delete a campaign',
    request: { params: campaignParams },
    responses: { 200: anyJson('Deleted'), ...errors },
  }), async (context) => {
    const member = need(context, 'post');
    const { app: appId, slug } = context.req.valid('param');
    await documents().deleteCampaign(member.teamId, appId, slug);
    return context.json(ok, 200);
  });

  app.openapi(route('Studio designs', {
    method: 'get', path: '/v1/studio/designs', summary: 'Store Studio designs changed after a cursor (0: all)',
    request: { query: z.object({ since: cursor }) },
    responses: { 200: anyJson('Designs'), ...errors },
  }), async (context) => context.json(await documents().designs(teamOf(context), context.req.valid('query').since), 200));

  app.openapi(route('Studio designs', {
    method: 'put', path: '/v1/studio/designs/{app}',
    summary: 'Save an app’s Store Studio design (baseVersion as for campaigns)',
    request: {
      params: z.object({ app: appKey.openapi({ param: { name: 'app', in: 'path' } }) }),
      ...body(z.object({ document: documentBody, baseVersion: z.number().int().min(0) }).strict()),
    },
    responses: { 200: anyJson('Design'), ...errors, 409: anyJson('Saved since baseVersion: the error and the current design') },
  }), async (context) => {
    const member = need(context, 'post');
    try {
      return context.json(await documents().saveDesign(member.teamId, member.userId, context.req.valid('param').app, context.req.valid('json')), 200);
    } catch (error) {
      if (error instanceof VersionConflict) return context.json({ error: { code: error.code, message: error.message, requestId: context.get('requestId') }, current: error.current }, 409);
      throw error;
    }
  });

  // MARK: Library

  app.openapi(route('Library', {
    method: 'post', path: '/v1/library/uploads',
    summary: 'Where to upload a file (PUT it to uploadUrl), or exists: true when the Library already has it',
    request: body(z.object({
      app: appKey, kind, sha256: sha, bytes: z.number().int().min(1), contentType, thumbnail: z.boolean().optional(),
    }).strict()),
    responses: { 200: anyJson('Upload target'), ...errors },
  }), async (context) => {
    need(context, 'post');
    return context.json(await library().startUpload(teamOf(context), context.req.valid('json')), 200);
  });

  app.openapi(route('Library', {
    method: 'post', path: '/v1/library/assets', summary: 'Record an uploaded file in the Library',
    request: body(z.object({
      app: appKey, kind, name: z.string().trim().min(1).max(200), path: z.string().min(10).max(300), thumbPath: z.string().max(300).nullable().optional(),
      contentType, width: z.number().int().min(1).max(20000).nullable().optional(), height: z.number().int().min(1).max(20000).nullable().optional(),
      bytes: z.number().int().min(1), sha256: sha, device: z.string().max(80).nullable().optional(), appearance: z.string().max(40).nullable().optional(),
      runId: uuid.nullable().optional(), position: z.number().int().min(0).max(10000).nullable().optional(),
    }).strict()),
    responses: { 201: anyJson('The asset'), ...errors },
  }), async (context) => {
    const member = need(context, 'post');
    return context.json(await library().createAsset(member.teamId, member.userId, context.req.valid('json')), 201);
  });

  app.openapi(route('Library', {
    method: 'get', path: '/v1/library/assets', summary: 'What changed after a cursor (0: everything there is), oldest first',
    request: { query: z.object({ since: cursor, app: appKey.optional(), kind: kind.optional(), limit: z.coerce.number().int().min(1).max(1000).default(500) }) },
    responses: { 200: anyJson('Changes'), ...errors },
  }), async (context) => {
    const query = context.req.valid('query');
    return context.json(await library().changes(teamOf(context), query.since, { app: query.app, kind: query.kind }, query.limit), 200);
  });

  const assetParams = z.object({ id: uuid.openapi({ param: { name: 'id', in: 'path' } }) });

  app.openapi(route('Library', {
    method: 'get', path: '/v1/library/assets/{id}/url', summary: 'A link to the file (or its thumbnail), good for an hour',
    request: { params: assetParams, query: z.object({ thumbnail: z.enum(['true', 'false']).default('false') }) },
    responses: { 200: anyJson('Link'), ...errors },
  }), async (context) => context.json(
    await library().url(teamOf(context), context.req.valid('param').id, context.req.valid('query').thumbnail === 'true'), 200,
  ));

  app.openapi(route('Library', {
    method: 'patch', path: '/v1/library/assets/{id}', summary: 'Rename an item or move it to another app',
    request: { params: assetParams, ...body(z.object({ name: z.string().trim().min(1).max(200).optional(), app: appKey.optional() }).strict()) },
    responses: { 200: anyJson('The asset'), ...errors },
  }), async (context) => {
    need(context, 'post');
    return context.json(await library().rename(teamOf(context), context.req.valid('param').id, context.req.valid('json')), 200);
  });

  app.openapi(route('Library', {
    method: 'delete', path: '/v1/library/assets/{id}', summary: 'Remove an item from the Library',
    request: { params: assetParams },
    responses: { 200: anyJson('Removed'), ...errors },
  }), async (context) => {
    need(context, 'post');
    await library().remove(teamOf(context), context.req.valid('param').id);
    return context.json(ok, 200);
  });

  app.openapi(route('Library', {
    method: 'post', path: '/v1/library/runs', summary: 'Start uploading a screenshot run (one app, device and appearance)',
    request: body(z.object({ app: appKey, device: z.string().trim().min(1).max(80), appearance: z.string().trim().min(1).max(40), source: z.string().max(120).nullable().optional() }).strict()),
    responses: { 200: anyJson('The run'), ...errors },
  }), async (context) => {
    const member = need(context, 'post');
    return context.json(await library().startRun(member.teamId, member.userId, context.req.valid('json')), 200);
  });

  app.openapi(route('Library', {
    method: 'post', path: '/v1/library/runs/{id}/complete', summary: 'Finish a run; older runs past the team’s keep count are removed (unless something uses them)',
    request: { params: assetParams },
    responses: { 200: anyJson('Done'), ...errors },
  }), async (context) => {
    need(context, 'post');
    return context.json(await library().completeRun(teamOf(context), context.req.valid('param').id), 200);
  });

  app.openapi(route('Library', {
    method: 'get', path: '/v1/library/usage', summary: 'Storage used and the plan’s limit',
    responses: { 200: anyJson('Usage'), ...errors },
  }), async (context) => context.json(await library().usage(teamOf(context)), 200));
}
