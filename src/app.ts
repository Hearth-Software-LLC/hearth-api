import { hkdfSync, randomUUID } from 'node:crypto';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { secureHeaders } from 'hono/secure-headers';
import { HTTPException } from 'hono/http-exception';
import { readConfig } from './config.js';
import type { Config } from './config.js';
import { errorSchema } from './contracts/common.js';
import type { ApiEnvironment } from './contracts/common.js';
import { ApiError } from './errors.js';
import { authMiddleware, createTokenVerifier } from './middleware/auth.js';
import { withProfiles } from './services/profiles.js';
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
import { createCloudflareTurn, createIntercomStore, registerCalomaIntercom } from './intercom/caloma.js';
import type { CalomaIntercomDependencies } from './intercom/caloma.js';
import type { ApnsSender } from './integrations/apns.js';
import { registerHearken } from './hearken/routes.js';
import { createHearkenService } from './hearken/service.js';
import type { HearkenService } from './hearken/service.js';
import { createDatabase } from './hearken/db.js';
import { registerBudgetGroups } from './budget-groups/routes.js';
import { createBudgetGroupsService } from './budget-groups/service.js';
import type { BudgetGroupsService } from './budget-groups/service.js';
import { createApnsSender } from './integrations/apns.js';
import { appAccess, effectiveEntitlements } from './services/subscriptions.js';
import { createCollectionAccess, createEntitlementGate, createHearthPlusGate, loadEntitlements } from './services/entitlements.js';
import type { EntitlementSource } from './services/entitlements.js';
import type { Sql } from 'postgres';
import { createReportStore } from './services/reports.js';
import type { ReportStore } from './services/reports.js';
import { registerReports } from './routes/v1/reports.js';
import { registerAccount } from './routes/v1/account.js';
import { registerEmber } from './ember/routes.js';
import { registerAdCopy } from './marketing/ad-copy.js';
import type { AdCopyDependencies } from './marketing/ad-copy.js';
import type { EmberDependencies } from './ember/routes.js';
import { registerEmberSpeech } from './ember/speech.js';
import { registerEmberUnderstand } from './ember/understand.js';
import { registerEmberTranscribe } from './ember/transcribe.js';
import type { EmberTranscribeDependencies } from './ember/transcribe.js';
import type { EmberUnderstandDependencies } from './ember/understand.js';
import type { EmberSpeechDependencies } from './ember/speech.js';
import { setAccountDeletionDependencies } from './services/account-deletion.js';
import { requireCronSecret } from './middleware/cron.js';
import { supabaseAdmin } from './services/supabase.js';
import { registerSocial } from './social/routes.js';
import { createSocialService } from './social/service.js';
import type { SocialMedia, SocialService } from './social/service.js';
import { createSocialStore } from './social/store.js';
import type { SocialStore } from './social/store.js';
import { createMetaClient } from './social/meta.js';
import type { MetaClient } from './social/meta.js';
import { registerStudio } from './studio/routes.js';
import { registerAffiliates } from './affiliates/routes.js';
import { createAffiliateService } from './affiliates/service.js';
import type { AffiliateService } from './affiliates/service.js';
import { createLinkService } from './affiliates/links.js';
import type { LinkService } from './affiliates/links.js';
import { createAscClient, importCampaignStats } from './affiliates/asc.js';
import { setAffiliateCredit } from './affiliates/hook.js';
import { createTeamService } from './studio/team.js';
import type { TeamService } from './studio/team.js';
import { createLibraryService } from './studio/library.js';
import type { LibraryService, StudioStorage } from './studio/library.js';
import { createDocumentsService } from './studio/documents.js';
import type { DocumentsService } from './studio/documents.js';
import { createRevenueCatPlans } from './studio/plans.js';
import type { PlansBackend } from './studio/plans.js';
import { createMonetization, revenueCatReader } from './studio/monetization.js';
import type { MonetizationBackend } from './studio/monetization.js';
import { createStoreProducts, revenueCatClient } from './studio/storeProducts.js';
import type { StoreProducts } from './studio/storeProducts.js';
import { createPlanStore } from './studio/monetizationPlans.js';
import type { PlanStore } from './studio/monetizationPlans.js';
import { createGitHubApps } from './studio/github.js';
import type { GitHubApps } from './studio/github.js';
import { createStudioNotifier } from './studio/notify.js';
import type { StudioNotifier } from './studio/notify.js';
import { PUBLIC_CATALOG, registerContent } from './content/routes.js';
import { createContentService } from './content/service.js';
import type { ContentService, ContentStorage } from './content/service.js';

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
  /** Hearken study groups. Built from DATABASE_URL and the APNS_* settings when not given. */
  hearken?: HearkenService;
  /** Suffice group budgets. Built from DATABASE_URL when not given. */
  budgetGroups?: BudgetGroupsService;
  /** The caller's active entitlements (own plus household organizer's). Read from Supabase when not given. */
  entitlements?: EntitlementSource;
  /** Content reports (POST /v1/reports). Built from DATABASE_URL when not given. */
  reports?: ReportStore;
  /**
   * Runs BigTable's 30-day purge of kitchens moved to iCloud and returns how many were purged.
   * Calls `bigtable_purge_moved_kitchens()` with the Supabase secret key when not given.
   */
  purgeMovedKitchens?: () => Promise<number>;
  /** Ember's cloud turn (POST /v1/ember/turn). Reads ANTHROPIC_API_KEY when not given. */
  ember?: Partial<EmberDependencies>;
  emberSpeech?: Partial<EmberSpeechDependencies>;
  /** Ember's cloud understanding (POST /v1/ember/understand). Reads ANTHROPIC_API_KEY when not given. */
  emberUnderstand?: Partial<EmberUnderstandDependencies>;
  /** Caloma's intercom wake-up relay. Built from DATABASE_URL and the APNS_* settings when not given. */
  calomaIntercom?: Partial<CalomaIntercomDependencies>;
  /** Ad copy for Hearth Ship's Social tab (POST /v1/marketing/ad-copy). Reads ANTHROPIC_API_KEY when not given. */
  adCopy?: Partial<AdCopyDependencies>;
  /** Speech-to-text for Ember on Apple Watch (POST /v1/ember/transcribe). Reads GOOGLE_TTS_API_KEY when not given. */
  emberTranscribe?: Partial<EmberTranscribeDependencies>;
  /** Hearth Ship's social pages (/v1/social). Built from DATABASE_URL, SOCIAL_TOKEN_KEY and META_* when not given. */
  social?: { store?: SocialStore; service?: SocialService; meta?: MetaClient; media?: SocialMedia };
  /** Hearth Studio (/v1/studio, /v1/library). Built from DATABASE_URL, Supabase storage, REVENUECAT_*, GITHUB_APP_* and APNS_* when not given. */
  studio?: {
    team?: TeamService; library?: LibraryService; storage?: StudioStorage; documents?: DocumentsService;
    plans?: PlansBackend; apps?: GitHubApps; notifier?: StudioNotifier; sql?: Sql; monetization?: MonetizationBackend; storeProducts?: StoreProducts; planDefinitions?: PlanStore;
  };
  /** Hearth Content (/v1/content). Built from DATABASE_URL and Supabase storage when not given. */
  content?: { service?: ContentService; storage?: ContentStorage };
  /** Affiliates and campaign links. Built from DATABASE_URL, SOCIAL_TOKEN_KEY and ASC_* when not given. */
  affiliates?: { service?: AffiliateService; links?: LinkService; importStats?: (team: string) => Promise<unknown> };
};

type RequestLog = {
  requestId: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  /** The `error.code` a 4xx/5xx answered with (never its message or details). */
  errorCode?: string;
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
    const errorCode = context.get('errorCode');
    logger({
      requestId,
      method: context.req.method,
      route: context.req.routePath ?? 'unmatched',
      status: context.res.status,
      durationMs: Math.round(performance.now() - startedAt),
      ...(errorCode ? { errorCode } : {}),
    });
  });
  app.use('*', secureHeaders());

  app.onError((error, context) => {
    if (error instanceof HTTPException && error.status === 400) {
      error = new ApiError(400, 'INVALID_REQUEST', 'Request body is invalid');
    }
    if (error instanceof ApiError) {
      context.set('errorCode', error.code);
      if (error.status === 401) context.header('WWW-Authenticate', 'Bearer');
      if (error.retryAfter !== undefined) context.header('Retry-After', String(error.retryAfter));
      return context.json({
        error: { code: error.code, message: error.message, requestId: context.get('requestId') },
      }, error.status);
    }
    context.set('errorCode', 'INTERNAL_ERROR');
    return context.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        requestId: context.get('requestId'),
      },
    }, 500);
  });
  app.notFound((context) => (context.set('errorCode', 'RESOURCE_NOT_FOUND'), context.json({
    error: {
      code: 'RESOURCE_NOT_FOUND',
      message: 'Route not found',
      requestId: context.get('requestId'),
    },
  }, 404)));

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
  // The real verifier also gives every signed-in account a profile row (tests pass their own).
  const verifyToken = options.verifyToken ?? withProfiles(createTokenVerifier(config));
  // Every /v1 route requires a bearer token up front, except BigTable's (/v1/bigtable/*),
  // which authenticate inside their handlers because a few of them are public.
  const requireAuth = authMiddleware(verifyToken);
  app.use('/v1/*', async (context, next) => {
    if (context.req.path.startsWith('/v1/bigtable/')) return next();
    // Each Hearth app reads its content catalog without signing in (Collections' rating, report
    // and download routes under /v1/content/<app>/items/ still need a token).
    if (context.req.method === 'GET' && PUBLIC_CATALOG.test(context.req.path)) return next();
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

  const entitlementSource = options.entitlements
    ?? (config.SUPABASE_URL && config.SUPABASE_SECRET_KEY ? (userId: string) => effectiveEntitlements(userId) : undefined);
  const entitlementGate = createEntitlementGate(config.ENFORCE_ENTITLEMENTS, entitlementSource);

  app.openapi(createRoute({
    method: 'get',
    path: '/v1/me/entitlements',
    tags: ['Identity'],
    summary: 'The caller\'s active plans: their own and their household organizer\'s',
    description: 'Each entitlement is a RevenueCat lookup key (`hearth_plus`, `bigtable_plus`, `suffice_plus`, `sated_plus`, `caloma_plus`, `hearken_plus`) with its expiry (null = never). `apps` says which apps are unlocked: the app\'s own entitlement or Hearth+.',
    security: [{ BearerAuth: [] }],
    responses: {
      200: {
        description: 'Active entitlements',
        content: { 'application/json': { schema: z.object({
          entitlements: z.array(z.object({
            id: z.string(),
            expiresAt: z.string().nullable(),
            source: z.enum(['own', 'household']),
          }).openapi('Entitlement')),
          hearthPlus: z.boolean(),
          apps: z.object({
            bigtable: z.boolean(), suffice: z.boolean(), sated: z.boolean(), caloma: z.boolean(), hearken: z.boolean(),
          }),
        }).openapi('Entitlements') } },
      },
      401: { description: 'Invalid or missing token', content: { 'application/json': { schema: errorSchema } } },
      503: { description: 'Subscriptions unavailable', content: { 'application/json': { schema: errorSchema } } },
    },
  }), async (context) => {
    const entitlements = await loadEntitlements(entitlementSource, context.get('userId'));
    return context.json({
      entitlements: entitlements.map(({ id, expiresAt, source }) => ({ id, expiresAt, source })),
      hearthPlus: entitlements.some((entry) => entry.id === 'hearth_plus'),
      apps: appAccess(entitlements),
    }, 200);
  });

  const reserveQuota = options.reserveQuota ?? createQuota(config);
  registerBrands(app, config, reserveQuota);
  registerFoods(app, config, reserveQuota, options.fetcher ?? fetch);
  const cache = options.cache ?? createCache(config);
  const fatSecret = createFatSecret(config, cache, options.fetcher ?? fetch);
  registerRestaurants(app, fatSecret && createRestaurantService(fatSecret, cache, config.RESTAURANT_CACHE_HOURS), reserveQuota, entitlementGate);
  const plaidDataClient = options.plaidDataClient ?? createPlaidDataClient(config);
  const connectionStore = options.connectionStore ?? createConnectionStore(config, options.fetcher ?? fetch);
  const tokenSeal = options.tokenSeal ?? (config.PLAID_TOKEN_KEY ? createTokenSeal(config.PLAID_TOKEN_KEY) : undefined);
  registerBanking(app, config, reserveQuota, {
    linkClient: options.plaidLinkClient ?? createPlaidLinkClient(config),
    dataClient: plaidDataClient,
    store: connectionStore,
    seal: tokenSeal,
    requireAccess: entitlementGate,
  });

  const hearken = options.hearken ?? createHearkenFromConfig(config);
  registerHearken(app, config, { service: hearken, requireAccess: entitlementGate });

  const database = databaseFromConfig(config);
  // Suffice group budgets: creating one needs Suffice Plus or Hearth+; joining is free.
  const budgetGroups = options.budgetGroups
    ?? (database ? createBudgetGroupsService({ sql: database, publicBaseUrl: config.PUBLIC_BASE_URL }) : undefined);
  registerBudgetGroups(app, { service: budgetGroups, requireAccess: entitlementGate });

  const reports = options.reports ?? (database ? createReportStore(database) : undefined);
  registerReports(app, reports);

  // Ember's cloud turn: a stateless, de-identified relay to Claude (src/ember).
  registerEmber(app, {
    reserveQuota,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
    fetcher: options.fetcher ?? fetch,
    ...(process.env.EMBER_MODEL_QUICK && process.env.EMBER_MODEL_PLAN
      ? { models: { quick: process.env.EMBER_MODEL_QUICK.trim(), plan: process.env.EMBER_MODEL_PLAN.trim() } }
      : {}),
    ...options.ember,
  });
  // What an Ember question asks for, as a typed request (Claude, forced tool call; no household data).
  registerEmberUnderstand(app, {
    reserveQuota,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
    fetcher: options.fetcher ?? fetch,
    ...(process.env.EMBER_MODEL_QUICK ? { model: process.env.EMBER_MODEL_QUICK.trim() } : {}),
    ...options.emberUnderstand,
  });
  // Ad copy for Hearth Ship's Social tab (Claude, forced tool call; Hearth+ only).
  registerAdCopy(app, {
    reserveQuota,
    requireHearthPlus: createHearthPlusGate(config.ENFORCE_ENTITLEMENTS, entitlementSource),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
    fetcher: options.fetcher ?? fetch,
    ...(process.env.MARKETING_MODEL ? { model: process.env.MARKETING_MODEL.trim() } : {}),
    ...options.adCopy,
  });
  // What was said to Ember on Apple Watch (Google Cloud Speech-to-Text; watchOS has no speech recognition).
  registerEmberTranscribe(app, {
    reserveQuota,
    googleApiKey: process.env.GOOGLE_TTS_API_KEY?.trim() || undefined,
    fetcher: options.fetcher ?? fetch,
    ...options.emberTranscribe,
  });
  // Ember's cloud voice for Apple Watch (Google Text-to-Speech, Chirp 3: HD).
  registerEmberSpeech(app, {
    reserveQuota,
    googleApiKey: process.env.GOOGLE_TTS_API_KEY?.trim() || undefined,
    fetcher: options.fetcher ?? fetch,
    ...options.emberSpeech,
  });

  // Hearth Ship's social pages: Facebook and Instagram through Meta, everything else hand-off.
  const socialStore = options.social?.store ?? (database ? createSocialStore(database) : undefined);
  const socialMeta = options.social?.meta ?? (config.META_APP_ID && config.META_APP_SECRET
    ? createMetaClient({
      appId: config.META_APP_ID, appSecret: config.META_APP_SECRET, version: config.META_GRAPH_VERSION,
      redirectUri: `${config.PUBLIC_BASE_URL.replace(/\/$/, '')}/oauth/meta/callback`, loginConfigId: config.META_LOGIN_CONFIG_ID,
    }, options.fetcher ?? fetch)
    : undefined);
  const socialService = options.social?.service ?? (socialStore && config.SOCIAL_TOKEN_KEY
    ? createSocialService({
      store: socialStore,
      seal: createTokenSeal(config.SOCIAL_TOKEN_KEY, 'social-access-token', 'Social accounts are temporarily unavailable'),
      stateKey: Buffer.from(config.SOCIAL_TOKEN_KEY, 'base64'),
      meta: socialMeta,
      media: options.social?.media ?? (config.SUPABASE_URL && config.SUPABASE_SECRET_KEY ? supabaseSocialMedia : undefined),
    })
    : undefined);
  // Hearth Studio's team: who can use /v1/social, /v1/studio and /v1/library.
  const studioOwners = config.STUDIO_OWNER_IDS.length > 0 ? config.STUDIO_OWNER_IDS : config.SOCIAL_OWNER_IDS;
  const studioTeam = options.studio?.team ?? (database ? createTeamService(database, { ownerIds: studioOwners }) : undefined);
  const studioStorage = options.studio?.storage ?? (config.SUPABASE_URL && config.SUPABASE_SECRET_KEY ? supabaseLibraryStorage : undefined);
  const studioLibrary = options.studio?.library ?? (database
    ? createLibraryService(database, { storage: studioStorage, limitBytes: config.STUDIO_STORAGE_LIMIT_MB * 1024 * 1024 })
    : undefined);
  const studioNotifier = options.studio?.notifier ?? (database && studioTeam ? createStudioNotifier(database, studioTeam, apnsFromConfig(config)) : undefined);
  registerSocial(app, {
    config,
    store: socialStore,
    service: socialService,
    team: () => studioTeam,
    notifier: () => studioNotifier,
    reserveQuota,
    requireHearthPlus: createHearthPlusGate(config.ENFORCE_ENTITLEMENTS, entitlementSource),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
    model: process.env.MARKETING_MODEL?.trim() || undefined,
    fetcher: options.fetcher ?? fetch,
  });

  registerStudio(app, {
    team: () => studioTeam,
    library: () => studioLibrary,
    documents: () => options.studio?.documents ?? (database ? (sharedDocuments ??= createDocumentsService(database)) : undefined),
    plans: () => options.studio?.plans ?? (sharedPlans ??= createRevenueCatPlans(process.env, options.fetcher ?? fetch)),
    apps: () => options.studio?.apps ?? githubAppsFromConfig(config, options.fetcher ?? fetch),
    monetization: () => options.studio?.monetization ?? (sharedMonetization ??= monetizationFromConfig(config, options.studio?.apps ?? githubAppsFromConfig(config, options.fetcher ?? fetch), options.fetcher ?? fetch)),
    storeProducts: () => options.studio?.storeProducts ?? (sharedStoreProducts ??= storeProductsFromConfig(config, options.fetcher ?? fetch)),
    planDefinitions: () => {
      if (options.studio?.planDefinitions) return options.studio.planDefinitions;
      const sql = options.studio?.sql ?? database;
      return sql ? createPlanStore(sql) : undefined;
    },
    sql: () => options.studio?.sql ?? database,
  });

  // Hearth Content: content for the apps, from content.hearthapps.com (and each app's public catalog).
  const contentStorage = options.content?.storage ?? (config.SUPABASE_URL && config.SUPABASE_SECRET_KEY ? supabaseContentStorage(config.SUPABASE_URL) : undefined);
  const contentService = options.content?.service ?? (database ? createContentService(database, { storage: contentStorage }) : undefined);
  registerContent(app, {
    team: () => studioTeam,
    content: () => contentService,
    apps: () => options.studio?.apps ?? githubAppsFromConfig(config, options.fetcher ?? fetch),
    library: () => studioLibrary,
    reserveQuota,
    // Plus Collections: hearth_plus or the app's own plan (own or the household organizer's).
    plusAccess: createCollectionAccess(config.ENFORCE_ENTITLEMENTS, entitlementSource),
  });
  // Scheduled publishes also go out whenever an app reads its catalog; this catches quiet periods.
  app.get('/internal/content/cron', async (context) => {
    requireCronSecret(config, context.req.header('Authorization'));
    if (!contentService) return context.json({ skipped: 'Hearth Content is not configured' }, 200);
    return context.json({ published: await contentService.runDue() }, 200);
  });

  // Affiliates: credit keyed on an HMAC of store transaction ids, with a key derived from SOCIAL_TOKEN_KEY.
  const affiliateService = options.affiliates?.service ?? (database && config.SOCIAL_TOKEN_KEY
    ? createAffiliateService(database, {
      secret: Buffer.from(hkdfSync('sha256', Buffer.from(config.SOCIAL_TOKEN_KEY, 'base64'), Buffer.alloc(0), 'hearth-affiliate-transactions', 32)),
      acceptSandbox: config.AFFILIATES_ACCEPT_SANDBOX,
    })
    : undefined);
  setAffiliateCredit(affiliateService);
  const linkService = options.affiliates?.links ?? (database
    ? createLinkService(database, { providerId: config.ASC_PROVIDER_ID, shortBase: config.SHORT_LINK_BASE })
    : undefined);
  const importStats = options.affiliates?.importStats ?? (database && linkService && config.ASC_KEY_ID && config.ASC_ISSUER_ID && config.ASC_PRIVATE_KEY
    ? ((client) => (team: string) => importCampaignStats(database, client, linkService, team))(
      createAscClient({ keyId: config.ASC_KEY_ID, issuerId: config.ASC_ISSUER_ID, privateKey: config.ASC_PRIVATE_KEY }, options.fetcher ?? fetch))
    : undefined);
  registerAffiliates(app, {
    affiliates: () => affiliateService,
    links: () => linkService,
    events: () => (database
      ? async (start: Date, end: Date) => (await database`
          select payload from revenuecat_webhook_events where processed_at >= ${start} and processed_at < ${end} order by processed_at`)
        .map((row) => row.payload as unknown)
      : undefined),
    importStats: () => importStats,
  });
  // App Store Connect's campaign numbers, daily (they arrive a day or two late).
  app.get('/internal/affiliates/cron', async (context) => {
    requireCronSecret(config, context.req.header('Authorization'));
    if (!database || !importStats) return context.json({ skipped: 'App Store Connect is not configured' }, 200);
    const teams = await database`select distinct team_id from campaign_links where deleted_at is null`;
    const results = [];
    for (const row of teams) results.push({ team: String(row.team_id), apps: await importStats(String(row.team_id)) });
    return context.json({ teams: results }, 200);
  });

  // DELETE /v1/me and DELETE /v1/bigtable/me share one deletion, which needs these.
  setAccountDeletionDependencies({
    plaidClient: plaidDataClient, connections: connectionStore, seal: tokenSeal, hearken, budgetGroups, reports, affiliates: affiliateService,
    collections: contentService,
  });
  registerAccount(app);

  // BigTable's daily purge of kitchens moved to iCloud more than 30 days ago (Vercel Cron, like Hearken's).
  const purgeMovedKitchens = options.purgeMovedKitchens
    ?? (config.SUPABASE_URL && config.SUPABASE_SECRET_KEY ? purgeMovedKitchensWithServiceRole : undefined);
  app.get('/internal/bigtable/cron', async (context) => {
    requireCronSecret(config, context.req.header('Authorization'));
    if (!purgeMovedKitchens) throw new ApiError(503, 'STORAGE_NOT_CONFIGURED', 'BigTable storage is not configured');
    return context.json({ purgedKitchens: await purgeMovedKitchens() }, 200);
  });

  registerBigTable(app, verifyToken);
  registerAppLinks(app, config);
  registerCalomaIntercom(app, {
    store: options.calomaIntercom?.store ?? (databaseFromConfig(config) ? createIntercomStore(databaseFromConfig(config)!) : undefined),
    apns: options.calomaIntercom?.apns ?? apnsFromConfig(config),
    topic: options.calomaIntercom?.topic ?? config.CALOMA_VOIP_TOPIC,
    alertTopic: options.calomaIntercom?.alertTopic ?? config.CALOMA_APNS_TOPIC,
    turn: options.calomaIntercom?.turn
      ?? (config.CLOUDFLARE_TURN_KEY_ID && config.CLOUDFLARE_TURN_API_TOKEN
        ? createCloudflareTurn(config.CLOUDFLARE_TURN_KEY_ID, config.CLOUDFLARE_TURN_API_TOKEN, options.fetcher ?? fetch)
        : undefined),
    verifyToken: options.calomaIntercom?.verifyToken ?? verifyToken,
    entitlements: options.calomaIntercom?.entitlements ?? entitlementSource,
  });

  app.doc('/openapi.json', {
    openapi: '3.0.0',
    info: { title: 'Hearth API', version: '1.0.0' },
  });

  return app;
}

let sharedDatabase: Sql | undefined;
let sharedHearken: HearkenService | undefined;

/** One database pool per process, however many times the app is built. */
function databaseFromConfig(config: Config): Sql | undefined {
  if (!config.DATABASE_URL) return undefined;
  sharedDatabase ??= createDatabase(config.DATABASE_URL);
  return sharedDatabase;
}

let sharedApns: ApnsSender | undefined;

/** One APNs sender per process (it caches its provider token). */
function apnsFromConfig(config: Config): ApnsSender | undefined {
  if (!config.APNS_KEY_ID || !config.APNS_TEAM_ID || !config.APNS_PRIVATE_KEY) return undefined;
  sharedApns ??= createApnsSender({ keyId: config.APNS_KEY_ID, teamId: config.APNS_TEAM_ID, privateKey: config.APNS_PRIVATE_KEY });
  return sharedApns;
}

function createHearkenFromConfig(config: Config): HearkenService | undefined {
  const sql = databaseFromConfig(config);
  if (!sql) return undefined;
  sharedHearken ??= createHearkenService({
    sql,
    apns: apnsFromConfig(config),
    apnsTopic: config.HEARKEN_APNS_TOPIC,
    publicBaseUrl: config.PUBLIC_BASE_URL,
  });
  return sharedHearken;
}

/** `bigtable_purge_moved_kitchens()` (supabase/migrations/20261019200000_bigtable_kitchen_moves_to_icloud.sql), run with the secret key. */
async function purgeMovedKitchensWithServiceRole(): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc('bigtable_purge_moved_kitchens');
  if (error) {
    console.error('BigTable kitchen purge failed', { code: error.code });
    throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'The kitchen purge could not run');
  }
  return typeof data === 'number' ? data : 0;
}

/** Post media in the private social-media bucket (supabase/migrations/20261029000100_social_pages_media_and_cron.sql). */
const supabaseSocialMedia: SocialMedia = {
  async uploadUrl(path) {
    const { data, error } = await supabaseAdmin.storage.from('social-media').createSignedUploadUrl(path);
    if (error || !data) throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Media uploads are temporarily unavailable');
    return { url: data.signedUrl, token: data.token };
  },
  async signedUrl(path, seconds) {
    // A Library item picked for a post: library/<team>/... lives in the library bucket.
    const [bucket, key] = path.startsWith('library/') ? ['library', path.slice('library/'.length)] : ['social-media', path];
    const { data, error } = await supabaseAdmin.storage.from(bucket).createSignedUrl(key, seconds);
    if (error || !data) throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Post media is temporarily unavailable');
    return data.signedUrl;
  },
};

/** The Library's files in the private library bucket (supabase/migrations/20261029100100_studio_library.sql). */
const supabaseLibraryStorage: StudioStorage = {
  async uploadUrl(path) {
    const { data, error } = await supabaseAdmin.storage.from('library').createSignedUploadUrl(path, { upsert: true });
    if (error || !data) throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Library uploads are temporarily unavailable');
    return { url: data.signedUrl, token: data.token };
  },
  async signedUrl(path, seconds) {
    const { data, error } = await supabaseAdmin.storage.from('library').createSignedUrl(path, seconds);
    if (error || !data) throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'The Library is temporarily unavailable');
    return data.signedUrl;
  },
  async remove(paths) {
    if (paths.length === 0) return;
    for (let index = 0; index < paths.length; index += 100) {
      const { error } = await supabaseAdmin.storage.from('library').remove(paths.slice(index, index + 100));
      if (error) throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Library files could not be removed');
    }
  },
  async put(path, bytes, contentType) {
    const { error } = await supabaseAdmin.storage.from('library').upload(path, bytes, { contentType, upsert: true });
    if (error) throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'The Library could not store the file');
  },
};

/**
 * Hearth Content's bundles and images in the public hearth-content bucket (supabase/migrations/20261030120000_hearth_content.sql),
 * and Plus Collections' bundles in the private hearth-content-plus bucket (20261031090000_content_collections.sql).
 */
function supabaseContentStorage(supabaseUrl: string): ContentStorage {
  const base = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/hearth-content/`;
  return {
    async put(path, bytes, contentType) {
      const { error } = await supabaseAdmin.storage.from('hearth-content').upload(path, bytes, { contentType, upsert: true, cacheControl: '31536000' });
      if (error) throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Content storage could not save the file');
    },
    async uploadUrl(path) {
      const { data, error } = await supabaseAdmin.storage.from('hearth-content').createSignedUploadUrl(path, { upsert: true });
      if (error || !data) throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Image uploads are temporarily unavailable');
      return { url: data.signedUrl, token: data.token };
    },
    publicUrl: (path) => base + path.split('/').map(encodeURIComponent).join('/'),
    async putPlus(path, bytes, contentType) {
      const { error } = await supabaseAdmin.storage.from('hearth-content-plus').upload(path, bytes, { contentType, upsert: true });
      if (error) throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Content storage could not save the file');
    },
    async plusUrl(path, seconds) {
      const { data, error } = await supabaseAdmin.storage.from('hearth-content-plus').createSignedUrl(path, seconds);
      if (error || !data) throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Downloads are temporarily unavailable');
      return data.signedUrl;
    },
  };
}

let sharedDocuments: DocumentsService | undefined;
let sharedPlans: PlansBackend | undefined;
let sharedMonetization: MonetizationBackend | undefined;
let sharedStoreProducts: StoreProducts | undefined;

function storeProductsFromConfig(config: Config, fetcher: typeof fetch): StoreProducts | undefined {
  if (!config.ASC_KEY_ID || !config.ASC_ISSUER_ID || !config.ASC_PRIVATE_KEY) return undefined;
  const asc = createAscClient({ keyId: config.ASC_KEY_ID, issuerId: config.ASC_ISSUER_ID, privateKey: config.ASC_PRIVATE_KEY }, fetcher);
  return createStoreProducts({ asc, revenueCat: revenueCatClient(revenueCatReader(process.env, fetcher), process.env, fetcher) });
}

/** App Store Connect (ASC_*) and RevenueCat (REVENUECAT_*), either or both; neither: not configured. */
function monetizationFromConfig(config: Config, apps: GitHubApps | undefined, fetcher: typeof fetch): MonetizationBackend | undefined {
  const asc = config.ASC_KEY_ID && config.ASC_ISSUER_ID && config.ASC_PRIVATE_KEY
    ? createAscClient({ keyId: config.ASC_KEY_ID, issuerId: config.ASC_ISSUER_ID, privateKey: config.ASC_PRIVATE_KEY }, fetcher)
    : undefined;
  const revenueCat = revenueCatReader(process.env, fetcher);
  if (!asc && !revenueCat) return undefined;
  return createMonetization({ ...(asc ? { asc } : {}), ...(revenueCat ? { revenueCat } : {}), ...(apps ? { apps: () => apps.list() } : {}) });
}
let sharedGitHubApps: GitHubApps | undefined;

/** One GitHub App client per process (it caches its token and the app list). */
function githubAppsFromConfig(config: Config, fetcher: typeof fetch): GitHubApps | undefined {
  if (!config.GITHUB_APP_ID || !config.GITHUB_APP_PRIVATE_KEY) return undefined;
  sharedGitHubApps ??= createGitHubApps({ appId: config.GITHUB_APP_ID, privateKey: config.GITHUB_APP_PRIVATE_KEY, org: config.GITHUB_ORG }, fetcher);
  return sharedGitHubApps;
}
