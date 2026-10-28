import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import type { CreateLinkToken, PlaidDataClient } from '../src/integrations/plaid.js';
import { createConnectionStore } from '../src/services/connections.js';
import type { ConnectionStore, StoredConnection } from '../src/services/connections.js';
import { createTokenSeal } from '../src/services/token-seal.js';

const tokenKey = randomBytes(32).toString('base64');
const environment = {
  PLAID_CLIENT_ID: 'test-client-id',
  PLAID_SECRET: 'test-plaid-secret',
  PLAID_PRODUCTS: 'transactions',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_test-key-0000000000',
  PLAID_TOKEN_KEY: tokenKey,
};
const config = readConfig(environment);
const seal = createTokenSeal(tokenKey);
const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function memoryStore(initial: Record<string, StoredConnection & { ownerId: string }> = {}) {
  const rows = new Map(Object.entries(initial));
  const store: ConnectionStore = {
    save: vi.fn(async (ownerId, connection) => { rows.set(connection.itemId, { ...connection, products: connection.products ?? ['transactions'], ownerId, createdAt: '2026-10-13T00:00:00Z' }); }),
    get: vi.fn(async (ownerId, itemId) => {
      const row = rows.get(itemId);
      return row && row.ownerId === ownerId ? row : undefined;
    }),
    list: vi.fn(async (ownerId) => [...rows.values()].filter((row) => row.ownerId === ownerId)
      .map(({ itemId, institution, createdAt, products }) => ({ itemId, institution, createdAt, products }))),
    remove: vi.fn(async (_ownerId, itemId) => { rows.delete(itemId); }),
  };
  return { store, rows };
}

const plaidTransaction = (overrides: Record<string, unknown> = {}) => ({
  transaction_id: 'tx-1', account_id: 'acct-1', amount: 12.34, date: '2026-10-12', authorized_date: '2026-10-11',
  name: 'TARGET 1234', merchant_name: 'Target', pending: false, logo_url: 'https://plaid-merchant-logos.plaid.com/target.png',
  website: 'www.target.com', personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_SUPERSTORES' },
  location: { address: '3401 N Thanksgiving Way', city: 'Lehi', region: 'UT', postal_code: '84043', lat: 40.39, lon: -111.85 }, ...overrides,
});
const plaidAccounts = {
  item: { institution_id: 'ins_1' },
  accounts: [
    { account_id: 'acct-1', name: 'Checking', official_name: 'Everyday Checking', mask: '0293', type: 'depository', subtype: 'checking', balances: { current: 1234.5, available: 1200 } },
    { account_id: 'acct-2', name: 'Card', mask: '4410', type: 'credit', subtype: 'credit card', balances: { current: 87.1 } },
  ],
};

const plaidSecurities = [
  { security_id: 'sec-vti', name: 'Vanguard Total Stock Market ETF', ticker_symbol: 'VTI', type: 'etf', is_cash_equivalent: false, close_price: 280, close_price_as_of: '2026-10-26' },
  { security_id: 'sec-cash', name: 'U S Dollar', ticker_symbol: 'CUR:USD', type: 'cash', is_cash_equivalent: true, close_price: 1, close_price_as_of: null },
];
const plaidInvestmentAccounts = [
  { account_id: 'inv-1', name: 'Brokerage', official_name: 'Individual Brokerage', mask: '2093', type: 'investment', subtype: 'brokerage', balances: { current: 36650 } },
  { account_id: 'inv-2', name: 'Roth', mask: '7720', type: 'investment', subtype: 'roth', balances: { current: 22512 } },
  { account_id: 'acct-1', name: 'Checking', mask: '0293', type: 'depository', subtype: 'checking', balances: { current: 1234.5 } },
];
const plaidHoldings = {
  accounts: plaidInvestmentAccounts,
  holdings: [
    { account_id: 'inv-1', security_id: 'sec-vti', quantity: 130, institution_price: 280, institution_price_as_of: '2026-10-26', institution_value: 36400, cost_basis: 27561.4 },
    { account_id: 'inv-1', security_id: 'sec-cash', quantity: 250, institution_price: 1, institution_price_as_of: null, institution_value: 250, cost_basis: null },
  ],
  securities: plaidSecurities,
  item: { institution_id: 'ins_schwab' },
  request_id: 'r',
};
const plaidInvestmentTransactions = {
  accounts: plaidInvestmentAccounts,
  investment_transactions: [
    { investment_transaction_id: 'itx-1', account_id: 'inv-1', security_id: 'sec-vti', date: '2026-09-26', name: 'VTI dividend', quantity: 0, amount: -148.22, price: 0, fees: 0, type: 'cash', subtype: 'dividend' },
    { investment_transaction_id: 'itx-2', account_id: 'inv-1', security_id: 'sec-vti', date: '2026-09-03', name: 'Buy VTI', quantity: 10, amount: 2742.1, price: 274.21, fees: null, type: 'buy', subtype: 'buy' },
  ],
  securities: plaidSecurities,
  total_investment_transactions: 2,
  item: { institution_id: 'ins_schwab' },
  request_id: 'r',
};

function dataClient(overrides: Partial<PlaidDataClient> = {}): PlaidDataClient {
  return {
    exchangePublicToken: vi.fn(async () => ({ access_token: 'access-sandbox-secret', item_id: 'item-1', request_id: 'r' })),
    getAccounts: vi.fn(async () => plaidAccounts),
    getInstitution: vi.fn(async () => ({ institution: { name: 'Chase', url: 'https://www.chase.com' } })),
    syncTransactions: vi.fn(async () => ({
      added: [plaidTransaction(), plaidTransaction({ transaction_id: 'tx-pending', pending: true }),
        plaidTransaction({ transaction_id: 'tx-2', amount: -2500, merchant_name: null, name: 'PAYROLL', website: null, logo_url: null, location: { city: 'Provo', lat: null, lon: null } })],
      modified: [], removed: [{ transaction_id: 'tx-old' }], next_cursor: 'cursor-2', has_more: false,
    })),
    removeItem: vi.fn(async () => ({ request_id: 'r' })),
    getInvestmentHoldings: vi.fn(async () => plaidHoldings),
    getInvestmentTransactions: vi.fn(async () => plaidInvestmentTransactions),
    ...overrides,
  };
}

function setup(options: { store?: ConnectionStore; data?: PlaidDataClient; userId?: string } = {}) {
  const linkClient = vi.fn<CreateLinkToken>().mockResolvedValue({
    link_token: 'link-sandbox-test', expiration: new Date(Date.now() + 3_600_000).toISOString(), request_id: 'plaid-request-123',
  });
  const reserveQuota = vi.fn().mockResolvedValue(undefined);
  const data = options.data ?? dataClient();
  const { store } = options.store ? { store: options.store } : memoryStore();
  const app = createApp({
    config, verifyToken: async () => options.userId ?? 'user-1', reserveQuota,
    plaidLinkClient: linkClient, plaidDataClient: data, connectionStore: store, tokenSeal: seal, logger: () => {},
  });
  return { app, linkClient, reserveQuota, data, store };
}

const storedItem = (ownerId = 'user-1') => ({
  'item-1': { itemId: 'item-1', ownerId, institution: 'Chase', createdAt: '2026-10-13T00:00:00Z', products: ['transactions' as const], sealedToken: seal.seal('access-sandbox-secret', ownerId, 'item-1') },
});

describe('Link tokens', () => {
  it('leaves out the redirect URI when none is configured', async () => {
    const { app, linkClient } = setup();
    const response = await app.request('/v1/banking/link-token', json({}));
    expect(response.status).toBe(200);
    expect(linkClient.mock.calls[0]?.[0]).not.toHaveProperty('redirect_uri');
    expect(linkClient.mock.calls[0]?.[0]).toMatchObject({ products: ['transactions'] });
  });

  it('creates an update-mode token for the owner of a connection', async () => {
    const { store } = memoryStore(storedItem());
    const { app, linkClient } = setup({ store });
    const response = await app.request('/v1/banking/link-token', json({ itemId: 'item-1' }));
    expect(response.status).toBe(200);
    const request = linkClient.mock.calls[0]?.[0];
    expect(request).toMatchObject({ access_token: 'access-sandbox-secret', user: { client_user_id: 'user-1' } });
    expect(request).not.toHaveProperty('products');
  });

  it("won't create an update-mode token for someone else's connection", async () => {
    const { store } = memoryStore(storedItem('someone-else'));
    const { app, linkClient } = setup({ store });
    const response = await app.request('/v1/banking/link-token', json({ itemId: 'item-1' }));
    expect(response.status).toBe(404);
    expect(linkClient).not.toHaveBeenCalled();
  });
});

describe('Connecting a bank', () => {
  it('exchanges the public token, stores it sealed, and never returns it', async () => {
    const { app, store, data, reserveQuota } = setup();
    const response = await app.request('/v1/banking/connections', json({ publicToken: 'public-sandbox-1' }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({
      itemId: 'item-1', institution: 'Chase', institutionDomain: 'chase.com', products: ['transactions'],
      accounts: [
        { id: 'acct-1', name: 'Everyday Checking', mask: '0293', kind: 'checking', balanceCents: 123450 },
        { id: 'acct-2', name: 'Card', mask: '4410', kind: 'credit', balanceCents: 8710 },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('access-sandbox-secret');
    expect(data.exchangePublicToken).toHaveBeenCalledWith('public-sandbox-1', expect.any(AbortSignal));
    expect(reserveQuota).toHaveBeenCalledWith('user-1', 'banking');
    const saved = vi.mocked(store.save).mock.calls[0]!;
    expect(saved[0]).toBe('user-1');
    expect(saved[1].sealedToken).not.toContain('access-sandbox-secret');
    expect(seal.open(saved[1].sealedToken, 'user-1', 'item-1')).toBe('access-sandbox-secret');
  });

  it('still connects when the institution name is unavailable', async () => {
    const data = dataClient({ getInstitution: vi.fn(async () => { throw new Error('nope'); }) });
    const { app } = setup({ data });
    const response = await app.request('/v1/banking/connections', json({ publicToken: 'public-sandbox-1' }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ institution: 'Bank', institutionDomain: null });
  });

  it.each([{}, { publicToken: '' }, { publicToken: 'p', userId: 'attacker' }])('rejects invalid bodies: %j', async (body) => {
    const { app, data } = setup();
    expect((await app.request('/v1/banking/connections', json(body))).status).toBe(400);
    expect(data.exchangePublicToken).not.toHaveBeenCalled();
  });

  it('maps an expired public token to a clear 400', async () => {
    const data = dataClient({ exchangePublicToken: vi.fn(async () => { throw { response: { status: 400, data: { error_code: 'INVALID_PUBLIC_TOKEN' } } }; }) });
    const { app } = setup({ data });
    const response = await app.request('/v1/banking/connections', json({ publicToken: 'expired' }));
    expect(response.status).toBe(400);
  });

  it('fails closed when storage is not configured', async () => {
    const app = createApp({
      config: readConfig({ PLAID_CLIENT_ID: 'id', PLAID_SECRET: 'secret', PLAID_PRODUCTS: 'transactions' }),
      verifyToken: async () => 'user-1', reserveQuota: vi.fn(), plaidDataClient: dataClient(),
    });
    const response = await app.request('/v1/banking/connections', json({ publicToken: 'public-sandbox-1' }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'STORAGE_NOT_CONFIGURED' } });
  });

  it('rejects anonymous users', async () => {
    const reserveQuota = vi.fn();
    const app = createApp({ config, verifyToken: async () => ({ userId: 'anon', isAnonymous: true }), reserveQuota, plaidDataClient: dataClient(), connectionStore: memoryStore().store, tokenSeal: seal });
    expect((await app.request('/v1/banking/connections', json({ publicToken: 'p' }))).status).toBe(403);
    expect(reserveQuota).not.toHaveBeenCalled();
  });

  it('lists only the caller\'s connections', async () => {
    const { store } = memoryStore({ ...storedItem(), 'item-2': { ...storedItem('other')['item-1'], itemId: 'item-2' } });
    const { app } = setup({ store });
    const response = await app.request('/v1/banking/connections', { headers: { Authorization: 'Bearer t' } });
    expect(await response.json()).toEqual({ connections: [{ itemId: 'item-1', institution: 'Chase', createdAt: '2026-10-13T00:00:00Z', products: ['transactions'] }] });
  });
});

describe('Syncing transactions', () => {
  it('returns posted changes in cents with the money direction, plus balances', async () => {
    const { store } = memoryStore(storedItem());
    const { app, data } = setup({ store });
    const response = await app.request('/v1/banking/connections/item-1/sync', json({ cursor: 'cursor-1' }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(data.syncTransactions).toHaveBeenCalledWith('access-sandbox-secret', 'cursor-1', expect.any(AbortSignal));
    expect(body.added).toEqual([
      { id: 'tx-1', accountId: 'acct-1', date: '2026-10-11', payee: 'Target', amountCents: 1234, isIncome: false,
        category: 'GENERAL_MERCHANDISE', categoryDetail: 'GENERAL_MERCHANDISE_SUPERSTORES', logoUrl: 'https://plaid-merchant-logos.plaid.com/target.png', merchantDomain: 'target.com',
        city: 'Lehi', address: '3401 N Thanksgiving Way, Lehi, UT 84043', latitude: 40.39, longitude: -111.85 },
      expect.objectContaining({ id: 'tx-2', payee: 'PAYROLL', amountCents: 250000, isIncome: true, logoUrl: null, merchantDomain: null,
        city: 'Provo', address: null, latitude: null }),
    ]);
    expect(body).toMatchObject({ removed: ['tx-old'], nextCursor: 'cursor-2', hasMore: false });
    expect(body.accounts).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain('access-sandbox-secret');
  });

  it('pages through more results and reports when there are still more', async () => {
    const page = { added: [plaidTransaction()], modified: [], removed: [], next_cursor: 'next', has_more: true };
    const data = dataClient({ syncTransactions: vi.fn(async () => page) });
    const { store } = memoryStore(storedItem());
    const { app } = setup({ store, data });
    const body = await (await app.request('/v1/banking/connections/item-1/sync', json({}))).json();
    expect(data.syncTransactions).toHaveBeenCalledTimes(5);
    expect(body.hasMore).toBe(true);
    expect(data.syncTransactions).toHaveBeenNthCalledWith(1, 'access-sandbox-secret', undefined, expect.any(AbortSignal));
  });

  it('restarts pagination when Plaid reports a mutation', async () => {
    const sync = vi.fn()
      .mockRejectedValueOnce({ response: { status: 400, data: { error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' } } })
      .mockResolvedValue({ added: [], modified: [], removed: [], next_cursor: 'c', has_more: false });
    const { store } = memoryStore(storedItem());
    const { app } = setup({ store, data: dataClient({ syncTransactions: sync }) });
    expect((await app.request('/v1/banking/connections/item-1/sync', json({ cursor: 'c0' }))).status).toBe(200);
    expect(sync).toHaveBeenNthCalledWith(2, 'access-sandbox-secret', 'c0', expect.any(AbortSignal));
  });

  it('says when the bank needs the person to sign in again', async () => {
    const data = dataClient({ syncTransactions: vi.fn(async () => { throw { response: { status: 400, data: { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED' } } }; }) });
    const { store } = memoryStore(storedItem());
    const { app } = setup({ store, data });
    const response = await app.request('/v1/banking/connections/item-1/sync', json({}));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'CONNECTION_NEEDS_REAUTH' } });
  });

  it("won't sync someone else's connection", async () => {
    const { store } = memoryStore(storedItem('someone-else'));
    const { app, data } = setup({ store });
    expect((await app.request('/v1/banking/connections/item-1/sync', json({}))).status).toBe(404);
    expect(data.syncTransactions).not.toHaveBeenCalled();
  });

  it('rejects item IDs that are not plain identifiers', async () => {
    const { app } = setup();
    expect((await app.request('/v1/banking/connections/item%2F..%2Fx/sync', json({}))).status).toBe(400);
  });
});

describe('Disconnecting', () => {
  it('removes the item at Plaid and forgets it', async () => {
    const { store, rows } = memoryStore(storedItem());
    const { app, data } = setup({ store });
    const response = await app.request('/v1/banking/connections/item-1', { method: 'DELETE', headers: { Authorization: 'Bearer t' } });
    expect(response.status).toBe(200);
    expect(data.removeItem).toHaveBeenCalledWith('access-sandbox-secret', expect.any(AbortSignal));
    expect(rows.has('item-1')).toBe(false);
  });

  it('still forgets an item Plaid already removed', async () => {
    const { store, rows } = memoryStore(storedItem());
    const data = dataClient({ removeItem: vi.fn(async () => { throw { response: { status: 400, data: { error_code: 'ITEM_NOT_FOUND' } } }; }) });
    const { app } = setup({ store, data });
    expect((await app.request('/v1/banking/connections/item-1', { method: 'DELETE', headers: { Authorization: 'Bearer t' } })).status).toBe(200);
    expect(rows.has('item-1')).toBe(false);
  });
});

describe('Token sealing', () => {
  it('round-trips and binds the token to its owner and item', () => {
    const sealed = seal.seal('access-1', 'user-1', 'item-1');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(seal.open(sealed, 'user-1', 'item-1')).toBe('access-1');
    expect(() => seal.open(sealed, 'user-2', 'item-1')).toThrow();
    expect(() => seal.open(sealed, 'user-1', 'item-2')).toThrow();
    expect(() => createTokenSeal(tokenKey).open(sealed, 'user-1', 'item-1')).not.toThrow();
    expect(() => createTokenSeal(randomBytes(32).toString('base64')).open(sealed, 'user-1', 'item-1')).toThrow();
  });
});

describe('Supabase connection store', () => {
  it('talks to the REST API with the secret key and encoded filters', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify([
      { item_id: 'item-1', institution: 'Chase', access_token_sealed: 'v1.abc', created_at: '2026-10-13T00:00:00Z' },
    ])));
    const store = createConnectionStore(config, fetcher)!;
    expect(await store.get('user 1&x', 'item-1')).toMatchObject({ itemId: 'item-1', sealedToken: 'v1.abc' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://project.supabase.co/rest/v1/plaid_connections?select=item_id,institution,access_token_sealed,created_at,products&owner_id=eq.user%201%26x&item_id=eq.item-1&limit=1');
    expect(init?.headers).toMatchObject({ apikey: 'sb_secret_test-key-0000000000' });
    expect(init?.headers).not.toHaveProperty('Authorization');
  });

  it('upserts on save and maps failures to a sanitized 503', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 201 }));
    const store = createConnectionStore(config, fetcher)!;
    await store.save('user-1', { itemId: 'item-1', institution: 'Chase', sealedToken: 'v1.abc' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain('on_conflict=item_id');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toMatchObject({ item_id: 'item-1', owner_id: 'user-1', access_token_sealed: 'v1.abc' });

    const failing = createConnectionStore(config, vi.fn<typeof fetch>(async () => new Response('secret details', { status: 500 })))!;
    await expect(failing.list('user-1')).rejects.toMatchObject({ status: 503, code: 'STORAGE_UNAVAILABLE' });
  });

  it('is off until fully configured', () => {
    expect(createConnectionStore(readConfig({}))).toBeUndefined();
  });
});

describe('Storage configuration', () => {
  it.each([
    { SUPABASE_URL: 'https://project.supabase.co' },
    { ...environment, PLAID_TOKEN_KEY: Buffer.alloc(16).toString('base64') },
    { ...environment, SUPABASE_URL: 'http://project.supabase.co' },
  ])('rejects partial or invalid storage settings: %j', (values) => {
    expect(() => readConfig(values)).toThrow('Invalid configuration fields');
  });

  it('no longer requires a redirect URI for Plaid', () => {
    expect(() => readConfig({ PLAID_CLIENT_ID: 'id', PLAID_SECRET: 'secret', PLAID_PRODUCTS: 'transactions' })).not.toThrow();
  });
});

describe('Investments', () => {
  const plaidError = (code: string) => Object.assign(new Error(code), { response: { status: 400, data: { error_type: 'ITEM_ERROR', error_code: code } } });

  it('asks Link for investments only when the purpose is investments', async () => {
    const { app, linkClient } = setup();
    const response = await app.request('/v1/banking/link-token', json({ purpose: 'investments' }));
    expect(response.status).toBe(200);
    expect(linkClient.mock.calls[0]![0]).toMatchObject({ products: ['investments'] });
    await app.request('/v1/banking/link-token', json({}));
    expect(linkClient.mock.calls[1]![0]).toMatchObject({ products: ['transactions'] });
  });

  it('records the purpose on a new connection', async () => {
    const { app, store } = setup();
    const response = await app.request('/v1/banking/connections', json({ publicToken: 'public-sandbox-1', purpose: 'investments' }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ products: ['investments'] });
    expect(vi.mocked(store.save).mock.calls[0]![1].products).toEqual(['investments']);
  });

  it('returns holdings for investment accounts only, in cents, without the token', async () => {
    const { store } = memoryStore(storedItem());
    const { app, data, reserveQuota } = setup({ store });
    const response = await app.request('/v1/banking/connections/item-1/holdings', json({}));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      accounts: [
        { id: 'inv-1', name: 'Individual Brokerage', mask: '2093', kind: 'brokerage', balanceCents: 3665000 },
        { id: 'inv-2', name: 'Roth', mask: '7720', kind: 'roth', balanceCents: 2251200 },
      ],
      holdings: [
        { accountId: 'inv-1', securityId: 'sec-vti', quantity: 130, price: 280, priceDate: '2026-10-26', valueCents: 3640000, costBasisCents: 2756140 },
        { accountId: 'inv-1', securityId: 'sec-cash', quantity: 250, price: 1, priceDate: null, valueCents: 25000, costBasisCents: null },
      ],
      securities: [
        { id: 'sec-vti', ticker: 'VTI', name: 'Vanguard Total Stock Market ETF', type: 'etf', isCash: false, closePrice: 280, closePriceDate: '2026-10-26' },
        { id: 'sec-cash', ticker: 'CUR:USD', name: 'U S Dollar', type: 'cash', isCash: true, closePrice: 1, closePriceDate: null },
      ],
    });
    expect(data.getInvestmentHoldings).toHaveBeenCalledWith('access-sandbox-secret', expect.any(AbortSignal));
    expect(JSON.stringify(body)).not.toContain('access-sandbox-secret');
    expect(reserveQuota).toHaveBeenCalledWith('user-1', 'banking');
  });

  it('pages investment transactions with signed cash direction', async () => {
    const { store } = memoryStore(storedItem());
    const { app, data } = setup({ store });
    const response = await app.request('/v1/banking/connections/item-1/investment-transactions',
      json({ startDate: '2024-10-27', endDate: '2026-10-27' }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ nextOffset: 2, hasMore: false });
    expect(body.transactions).toEqual([
      { id: 'itx-1', accountId: 'inv-1', securityId: 'sec-vti', date: '2026-09-26', name: 'VTI dividend', kind: 'cash', subtype: 'dividend', quantity: 0, price: 0, amountCents: 14822, cashIn: true, feesCents: 0 },
      { id: 'itx-2', accountId: 'inv-1', securityId: 'sec-vti', date: '2026-09-03', name: 'Buy VTI', kind: 'buy', subtype: 'buy', quantity: 10, price: 274.21, amountCents: 274210, cashIn: false, feesCents: 0 },
    ]);
    expect(data.getInvestmentTransactions).toHaveBeenCalledWith(
      'access-sandbox-secret', { startDate: '2024-10-27', endDate: '2026-10-27', offset: 0, count: 500 }, expect.any(AbortSignal),
    );
  });

  it('reports more pages until the total is reached', async () => {
    const { store } = memoryStore(storedItem());
    const data = dataClient({ getInvestmentTransactions: vi.fn(async () => ({ ...plaidInvestmentTransactions, total_investment_transactions: 7 })) });
    const { app } = setup({ store, data });
    const response = await app.request('/v1/banking/connections/item-1/investment-transactions',
      json({ startDate: '2026-01-01', endDate: '2026-10-27', offset: 3 }));
    expect(await response.json()).toMatchObject({ nextOffset: 5, hasMore: true });
  });

  it.each([
    [{ startDate: '2026-10-27', endDate: '2026-01-01' }],
    [{ startDate: '10/01/2026', endDate: '2026-10-27' }],
    [{ startDate: '2026-01-01' }],
    [{ startDate: '2026-01-01', endDate: '2026-10-27', offset: -1 }],
  ])('rejects bad date ranges: %j', async (body) => {
    const { store } = memoryStore(storedItem());
    const { app, data } = setup({ store });
    const response = await app.request('/v1/banking/connections/item-1/investment-transactions', json(body));
    expect(response.status).toBe(400);
    expect(data.getInvestmentTransactions).not.toHaveBeenCalled();
  });

  it('answers empty lists when the connection has no investment accounts', async () => {
    const { store } = memoryStore(storedItem());
    const data = dataClient({ getInvestmentHoldings: vi.fn(async () => { throw plaidError('NO_INVESTMENT_ACCOUNTS'); }) });
    const { app } = setup({ store, data });
    const response = await app.request('/v1/banking/connections/item-1/holdings', json({}));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accounts: [], holdings: [], securities: [] });
  });

  it.each([
    ['PRODUCTS_NOT_SUPPORTED', 409, 'PRODUCT_NOT_SUPPORTED'],
    ['PRODUCT_NOT_READY', 409, 'PRODUCT_NOT_READY'],
    ['ITEM_LOGIN_REQUIRED', 409, 'CONNECTION_NEEDS_REAUTH'],
  ])('maps Plaid %s to %i %s', async (plaidCode, status, code) => {
    const { store } = memoryStore(storedItem());
    const data = dataClient({ getInvestmentHoldings: vi.fn(async () => { throw plaidError(plaidCode); }) });
    const { app } = setup({ store, data });
    const response = await app.request('/v1/banking/connections/item-1/holdings', json({}));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
  });

  it('never reads another person\'s connection', async () => {
    const { store } = memoryStore(storedItem('someone-else'));
    const { app, data } = setup({ store });
    const response = await app.request('/v1/banking/connections/item-1/holdings', json({}));
    expect(response.status).toBe(404);
    expect(data.getInvestmentHoldings).not.toHaveBeenCalled();
  });
});
