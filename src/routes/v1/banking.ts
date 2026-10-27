import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';
import type { Config } from '../../config.js';
import { errorSchema } from '../../contracts/common.js';
import type { ApiEnvironment } from '../../contracts/common.js';
import { ApiError } from '../../errors.js';
import { createLinkToken, isPlaidCode, plaidFailure } from '../../integrations/plaid.js';
import type { CreateLinkToken, PlaidDataClient } from '../../integrations/plaid.js';
import {
  accountsSchema, domain, exchangeSchema, holdingsSchema, institutionSchema, investmentTransactionsSchema, parsePlaid,
  syncSchema, toAccount, toHolding, toInvestmentAccount, toInvestmentTransaction, toSecurity, toTransaction,
} from '../../integrations/plaid-shape.js';
import type { ConnectionStore } from '../../services/connections.js';
import type { TokenSeal } from '../../services/token-seal.js';
import type { ReserveQuota } from '../../services/quota.js';
import { allowAll } from '../../services/entitlements.js';
import type { EntitlementGate } from '../../services/entitlements.js';

export type BankingDependencies = {
  linkClient: CreateLinkToken | undefined;
  dataClient: PlaidDataClient | undefined;
  store: ConnectionStore | undefined;
  seal: TokenSeal | undefined;
  /** Checks Suffice access before linking a bank. Lets everyone through when not given. */
  requireAccess?: EntitlementGate;
};

/** Pages of /transactions/sync per request. The app calls again while `hasMore` is true. */
const SYNC_PAGES_PER_REQUEST = 5;
/** Investment transactions per page (Plaid's maximum). The app calls again while `hasMore` is true. */
const INVESTMENT_PAGE = 500;

const itemIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const itemParams = z.object({ itemId: itemIdSchema.openapi({ param: { name: 'itemId', in: 'path' } }) });

const accountSchema = z.object({
  id: z.string(), name: z.string(), mask: z.string(), kind: z.enum(['checking', 'savings', 'credit', 'other']), balanceCents: z.number().int(),
}).openapi('BankAccount');
const transactionSchema = z.object({
  id: z.string(), accountId: z.string(), date: z.string(), payee: z.string(),
  amountCents: z.number().int(), isIncome: z.boolean(), category: z.string().nullable(), categoryDetail: z.string().nullable(),
  logoUrl: z.string().nullable(), merchantDomain: z.string().nullable(),
  city: z.string().nullable(), address: z.string().nullable(), latitude: z.number().nullable(), longitude: z.number().nullable(),
  cardLabel: z.string().nullable().openapi({ description: "The bank's label for the card used (Plaid account_owner), on accounts with several cards. Usually null." }),
  cardLast4: z.string().nullable().openapi({ description: 'Last four digits of the card used, from the label or the bank description.' }),
  paymentChannel: z.string().nullable().openapi({ description: "Plaid's payment_channel: 'in store', 'online' or 'other'." }),
}).openapi('BankTransaction');
const productSchema = z.enum(['transactions', 'investments']);
const connectionSchema = z.object({
  itemId: z.string(), institution: z.string(), createdAt: z.string(), products: z.array(productSchema),
}).openapi('BankConnection');

const investmentAccountSchema = z.object({
  id: z.string(), name: z.string(), mask: z.string(),
  kind: z.enum(['401k', 'ira', 'roth', 'brokerage', 'education', 'hsa', 'other']), balanceCents: z.number().int(),
}).openapi('InvestmentAccount');
const securitySchema = z.object({
  id: z.string(), ticker: z.string().nullable(), name: z.string(), type: z.string(), isCash: z.boolean(),
  closePrice: z.number().nullable(), closePriceDate: z.string().nullable(),
}).openapi('Security');
const holdingSchema = z.object({
  accountId: z.string(), securityId: z.string(), quantity: z.number(), price: z.number(), priceDate: z.string().nullable(),
  valueCents: z.number().int(), costBasisCents: z.number().int().nullable(),
}).openapi('Holding');
const investmentTransactionSchema = z.object({
  id: z.string(), accountId: z.string(), securityId: z.string().nullable(), date: z.string(), name: z.string(),
  kind: z.string(), subtype: z.string().nullable(), quantity: z.number(), price: z.number(),
  amountCents: z.number().int(), cashIn: z.boolean(), feesCents: z.number().int(),
}).openapi('InvestmentTransaction');
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const errors = (...codes: (400 | 401 | 402 | 403 | 404 | 409 | 429 | 502 | 503 | 504)[]) => Object.fromEntries(codes.map((code) => [
  code, { description: {
    400: 'Invalid request', 401: 'Invalid or missing token', 402: 'Needs Suffice Plus or Hearth+ (only when ENFORCE_ENTITLEMENTS is on)', 403: 'A durable signed-in identity is required',
    404: 'Connection not found', 409: 'The bank needs the person to sign in again (use update mode), or the institution doesn\'t share investments',
    429: 'User quota exceeded', 502: 'Plaid failed or returned invalid data',
    503: 'Required service unavailable or provider quota exhausted', 504: 'Plaid timed out',
  }[code], content: { 'application/json': { schema: errorSchema } } },
]));

const jsonOnly: MiddlewareHandler<ApiEnvironment> = async (context, next) => {
  if (context.req.method === 'POST'
    && context.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new ApiError(400, 'INVALID_REQUEST', 'An application/json body is required');
  }
  await next();
};
const smallBody = (maxSize: number) => bodyLimit({
  maxSize,
  onError: () => { throw new ApiError(400, 'INVALID_REQUEST', 'Request body is too large'); },
});

export function registerBanking(
  app: OpenAPIHono<ApiEnvironment>,
  config: Config,
  reserveQuota: ReserveQuota,
  dependencies: BankingDependencies,
) {
  const { linkClient, dataClient, store, seal } = dependencies;
  const requireAccess = dependencies.requireAccess ?? allowAll;

  app.use('/v1/banking/*', async (context, next) => {
    if (context.get('isAnonymous')) {
      throw new ApiError(403, 'REGISTERED_IDENTITY_REQUIRED', 'Sign in with Apple before connecting a bank');
    }
    await next();
  });
  app.use('/v1/banking/link-token', jsonOnly, smallBody(1024));
  app.use('/v1/banking/connections', jsonOnly, smallBody(2048));
  app.use('/v1/banking/connections/:itemId/sync', jsonOnly, smallBody(8192));
  app.use('/v1/banking/connections/:itemId/holdings', jsonOnly, smallBody(1024));
  app.use('/v1/banking/connections/:itemId/investment-transactions', jsonOnly, smallBody(1024));

  /** Everything a connection route needs, or a 503 naming what's missing. */
  function connected() {
    if (!dataClient || !config.PLAID_PRODUCTS) throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'Plaid is not configured');
    if (!store || !seal) throw new ApiError(503, 'STORAGE_NOT_CONFIGURED', 'Bank connection storage is not configured');
    return { dataClient, store, seal };
  }

  async function accessToken(userId: string, itemId: string) {
    const { store, seal } = connected();
    const stored = await store.get(userId, itemId);
    if (!stored) throw new ApiError(404, 'CONNECTION_NOT_FOUND', 'That bank connection no longer exists');
    return { stored, token: seal.open(stored.sealedToken, userId, itemId) };
  }

  // MARK: Link token

  app.openapi(createRoute({
    method: 'post',
    path: '/v1/banking/link-token',
    summary: 'Create a fresh Plaid Link token for the authenticated user',
    description: 'With `itemId`, a token for update mode: the person signs in again to a bank that needs it. `purpose` "investments" lists brokerages and retirement providers instead of banks.',
    tags: ['Banking'],
    security: [{ BearerAuth: [] }],
    request: {
      body: { required: true, content: { 'application/json': { schema: z.object({
        itemId: itemIdSchema.optional(), purpose: productSchema.optional(),
      }).strict().openapi('CreatePlaidLinkToken') } } },
    },
    responses: {
      200: {
        description: 'Short-lived token for the iOS Plaid Link SDK, not a bank access token',
        content: { 'application/json': { schema: z.object({
          linkToken: z.string(), expiresAt: z.iso.datetime({ offset: true }), plaidRequestId: z.string(),
        }).openapi('PlaidLinkToken') } },
      },
      ...errors(400, 401, 402, 403, 404, 429, 502, 503, 504),
    },
  }), async (context) => {
    await requireAccess(context.get('userId'), 'suffice');
    if (!linkClient || !config.PLAID_CLIENT_ID || !config.PLAID_SECRET || !config.PLAID_PRODUCTS) {
      throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'Plaid is not configured');
    }
    const { itemId, purpose } = context.req.valid('json');
    const userId = context.get('userId');
    await reserveQuota(userId, 'plaid-link');
    const updateToken = itemId ? (await accessToken(userId, itemId)).token : undefined;
    return context.json(await createLinkToken(config, userId, linkClient, updateToken, purpose), 200);
  });

  // MARK: Connections

  app.openapi(createRoute({
    method: 'post',
    path: '/v1/banking/connections',
    summary: 'Finish connecting a bank with the public token from Plaid Link',
    description: 'Exchanges the public token, stores the sealed access token with its owner, and returns the bank\'s accounts. The access token is never returned.',
    tags: ['Banking'],
    security: [{ BearerAuth: [] }],
    request: {
      body: { required: true, content: { 'application/json': { schema: z.object({
        publicToken: z.string().min(1).max(512),
        /** The Link token's purpose, so the connection is listed in the right place. */
        purpose: productSchema.optional(),
      }).strict().openapi('CreateBankConnection') } } },
    },
    responses: {
      201: {
        description: 'Connected',
        content: { 'application/json': { schema: z.object({
          itemId: z.string(), institution: z.string(), institutionDomain: z.string().nullable(),
          products: z.array(productSchema), accounts: z.array(accountSchema),
        }).openapi('NewBankConnection') } },
      },
      ...errors(400, 401, 402, 403, 429, 502, 503, 504),
    },
  }), async (context) => {
    await requireAccess(context.get('userId'), 'suffice');
    const { dataClient, store, seal } = connected();
    const { publicToken, purpose } = context.req.valid('json');
    const userId = context.get('userId');
    await reserveQuota(userId, 'banking');
    const products = [purpose ?? 'transactions'] as const;

    const signal = AbortSignal.timeout(20_000);
    try {
      const exchange = parsePlaid(exchangeSchema, await dataClient.exchangePublicToken(publicToken, signal));
      const accounts = parsePlaid(accountsSchema, await dataClient.getAccounts(exchange.access_token, signal));
      let institution = 'Bank';
      let institutionDomain: string | null = null;
      if (accounts.item.institution_id) {
        try {
          const found = parsePlaid(institutionSchema,
            await dataClient.getInstitution(accounts.item.institution_id, config.PLAID_COUNTRY_CODES, signal)).institution;
          institution = found.name;
          institutionDomain = domain(found.url);
        } catch {
          // The name and website are niceties; the connection still works without them.
        }
      }
      await store.save(userId, {
        itemId: exchange.item_id,
        institution,
        sealedToken: seal.seal(exchange.access_token, userId, exchange.item_id),
        products: [...products],
      });
      return context.json({
        itemId: exchange.item_id, institution, institutionDomain, products: [...products], accounts: accounts.accounts.map(toAccount),
      }, 201);
    } catch (error) {
      throw plaidFailure(error, signal);
    }
  });

  app.openapi(createRoute({
    method: 'get',
    path: '/v1/banking/connections',
    summary: 'List the banks the authenticated user has connected',
    tags: ['Banking'],
    security: [{ BearerAuth: [] }],
    responses: {
      200: {
        description: 'Connections, oldest first',
        content: { 'application/json': { schema: z.object({ connections: z.array(connectionSchema) }).openapi('BankConnections') } },
      },
      ...errors(401, 403, 429, 503),
    },
  }), async (context) => {
    const { store } = connected();
    const userId = context.get('userId');
    await reserveQuota(userId, 'banking');
    return context.json({ connections: await store.list(userId) }, 200);
  });

  app.openapi(createRoute({
    method: 'post',
    path: '/v1/banking/connections/{itemId}/sync',
    summary: 'New, changed and removed transactions since a cursor, plus balances',
    description: 'Wraps Plaid /transactions/sync. The cursor is kept by the app, so the API stores nothing about sync progress. Pending transactions are left out until they post. Call again with `nextCursor` while `hasMore` is true.',
    tags: ['Banking'],
    security: [{ BearerAuth: [] }],
    request: {
      params: itemParams,
      body: { required: true, content: { 'application/json': { schema: z.object({
        cursor: z.string().max(4096).optional(),
      }).strict().openapi('SyncBankConnection') } } },
    },
    responses: {
      200: {
        description: 'Changes since the cursor',
        content: { 'application/json': { schema: z.object({
          added: z.array(transactionSchema), modified: z.array(transactionSchema), removed: z.array(z.string()),
          accounts: z.array(accountSchema), nextCursor: z.string(), hasMore: z.boolean(),
        }).openapi('BankSync') } },
      },
      ...errors(400, 401, 403, 404, 409, 429, 502, 503, 504),
    },
  }), async (context) => {
    const { dataClient } = connected();
    const { itemId } = context.req.valid('param');
    const { cursor } = context.req.valid('json');
    const userId = context.get('userId');
    await reserveQuota(userId, 'banking');
    const { token } = await accessToken(userId, itemId);

    const signal = AbortSignal.timeout(45_000);
    const run = async (start: string | undefined) => {
      const added = []; const modified = []; const removed: string[] = [];
      let next = start; let hasMore = false;
      for (let page = 0; page < SYNC_PAGES_PER_REQUEST; page++) {
        const result = parsePlaid(syncSchema, await dataClient.syncTransactions(token, next, signal));
        added.push(...result.added); modified.push(...result.modified);
        removed.push(...result.removed.map((entry) => entry.transaction_id));
        next = result.next_cursor; hasMore = result.has_more;
        if (!hasMore) break;
      }
      return { added, modified, removed, next: next ?? '', hasMore };
    };

    try {
      let result;
      try {
        result = await run(cursor);
      } catch (error) {
        // Plaid asks to restart the whole pagination from the original cursor.
        if (!isPlaidCode(error, ['TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION'])) throw error;
        result = await run(cursor);
      }
      const accounts = parsePlaid(accountsSchema, await dataClient.getAccounts(token, signal));
      return context.json({
        added: result.added.filter((entry) => !entry.pending).map(toTransaction),
        modified: result.modified.filter((entry) => !entry.pending).map(toTransaction),
        removed: result.removed,
        accounts: accounts.accounts.map(toAccount),
        nextCursor: result.next,
        hasMore: result.hasMore,
      }, 200);
    } catch (error) {
      throw plaidFailure(error, signal);
    }
  });

  // MARK: Investments

  app.openapi(createRoute({
    method: 'post',
    path: '/v1/banking/connections/{itemId}/holdings',
    summary: 'What a brokerage connection holds today, with its accounts and securities',
    description: 'Wraps Plaid /investments/holdings/get. Prices are the institution\'s, usually as of the last market close. Nothing is stored server-side. A connection with no investment accounts returns empty lists.',
    tags: ['Investments'],
    security: [{ BearerAuth: [] }],
    request: {
      params: itemParams,
      body: { required: true, content: { 'application/json': { schema: z.object({}).strict().openapi('GetHoldings') } } },
    },
    responses: {
      200: {
        description: 'Holdings',
        content: { 'application/json': { schema: z.object({
          accounts: z.array(investmentAccountSchema), holdings: z.array(holdingSchema), securities: z.array(securitySchema),
        }).openapi('InvestmentHoldings') } },
      },
      ...errors(400, 401, 402, 403, 404, 409, 429, 502, 503, 504),
    },
  }), async (context) => {
    await requireAccess(context.get('userId'), 'suffice');
    const { dataClient } = connected();
    const { itemId } = context.req.valid('param');
    const userId = context.get('userId');
    await reserveQuota(userId, 'banking');
    const { token } = await accessToken(userId, itemId);

    const signal = AbortSignal.timeout(20_000);
    try {
      const result = parsePlaid(holdingsSchema, await dataClient.getInvestmentHoldings(token, signal));
      const investing = result.accounts.filter((account) => account.type === 'investment' || account.type === 'brokerage');
      return context.json({
        accounts: investing.map(toInvestmentAccount),
        holdings: result.holdings.map(toHolding),
        securities: result.securities.map(toSecurity),
      }, 200);
    } catch (error) {
      if (isPlaidCode(error, ['NO_INVESTMENT_ACCOUNTS'])) return context.json({ accounts: [], holdings: [], securities: [] }, 200);
      throw plaidFailure(error, signal);
    }
  });

  app.openapi(createRoute({
    method: 'post',
    path: '/v1/banking/connections/{itemId}/investment-transactions',
    summary: 'Buys, sells, dividends, fees and transfers between two dates',
    description: 'Wraps Plaid /investments/transactions/get, up to 500 a page. Call again with `offset` = `nextOffset` while `hasMore` is true. Plaid keeps up to 24 months.',
    tags: ['Investments'],
    security: [{ BearerAuth: [] }],
    request: {
      params: itemParams,
      body: { required: true, content: { 'application/json': { schema: z.object({
        startDate: isoDay, endDate: isoDay, offset: z.number().int().min(0).max(100_000).optional(),
      }).strict().openapi('GetInvestmentTransactions') } } },
    },
    responses: {
      200: {
        description: 'A page of investment transactions, newest first',
        content: { 'application/json': { schema: z.object({
          transactions: z.array(investmentTransactionSchema), securities: z.array(securitySchema),
          nextOffset: z.number().int(), hasMore: z.boolean(),
        }).openapi('InvestmentTransactions') } },
      },
      ...errors(400, 401, 402, 403, 404, 409, 429, 502, 503, 504),
    },
  }), async (context) => {
    await requireAccess(context.get('userId'), 'suffice');
    const { dataClient } = connected();
    const { itemId } = context.req.valid('param');
    const { startDate, endDate, offset = 0 } = context.req.valid('json');
    if (startDate > endDate) throw new ApiError(400, 'INVALID_REQUEST', 'startDate must not be after endDate');
    const userId = context.get('userId');
    await reserveQuota(userId, 'banking');
    const { token } = await accessToken(userId, itemId);

    const signal = AbortSignal.timeout(30_000);
    try {
      const result = parsePlaid(investmentTransactionsSchema, await dataClient.getInvestmentTransactions(
        token, { startDate, endDate, offset, count: INVESTMENT_PAGE }, signal,
      ));
      const nextOffset = offset + result.investment_transactions.length;
      return context.json({
        transactions: result.investment_transactions.map(toInvestmentTransaction),
        securities: result.securities.map(toSecurity),
        nextOffset,
        hasMore: result.investment_transactions.length > 0 && nextOffset < result.total_investment_transactions,
      }, 200);
    } catch (error) {
      if (isPlaidCode(error, ['NO_INVESTMENT_ACCOUNTS'])) {
        return context.json({ transactions: [], securities: [], nextOffset: offset, hasMore: false }, 200);
      }
      throw plaidFailure(error, signal);
    }
  });

  app.openapi(createRoute({
    method: 'delete',
    path: '/v1/banking/connections/{itemId}',
    summary: 'Disconnect a bank: Plaid forgets the item and the API deletes its token',
    tags: ['Banking'],
    security: [{ BearerAuth: [] }],
    request: { params: itemParams },
    responses: {
      200: {
        description: 'Disconnected',
        content: { 'application/json': { schema: z.object({ removed: z.literal(true) }).openapi('BankDisconnected') } },
      },
      ...errors(400, 401, 403, 404, 429, 502, 503, 504),
    },
  }), async (context) => {
    const { dataClient, store } = connected();
    const { itemId } = context.req.valid('param');
    const userId = context.get('userId');
    await reserveQuota(userId, 'banking');
    const { token } = await accessToken(userId, itemId);
    const signal = AbortSignal.timeout(8000);
    try {
      await dataClient.removeItem(token, signal);
    } catch (error) {
      // Already gone at Plaid: still forget it here.
      if (!isPlaidCode(error, ['ITEM_NOT_FOUND', 'INVALID_ACCESS_TOKEN'])) throw plaidFailure(error, signal);
    }
    await store.remove(userId, itemId);
    return context.json({ removed: true as const }, 200);
  });
}
