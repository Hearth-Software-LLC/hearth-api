import { describe, expect, it, vi } from 'vitest';
import type { AscClient } from '../../src/affiliates/asc.js';
import { createMonetization, revenueCatReader } from '../../src/studio/monetization.js';

// App Store Connect and RevenueCat as their APIs answer, cut down to what the tab reads.
const asc: Record<string, unknown> = {
  '/v1/apps?limit=200&fields[apps]=name,bundleId': [
    { id: '111', attributes: { name: 'BigTable', bundleId: 'com.stephenwarren.bigtable' } },
    { id: '999', attributes: { name: 'Hearth Studio', bundleId: 'com.stephenwarren.hearthstudio' } },
  ],
  '/v1/apps/111/subscriptionGroups?include=subscriptions&limit=50&limit[subscriptions]=50': {
    data: [{ id: 'g1', attributes: { referenceName: 'BigTable' }, relationships: { subscriptions: { data: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] } } }],
    included: [
      { id: 's1', type: 'subscriptions', attributes: { name: 'BigTable Plus Annual', productId: 'com.stephenwarren.bigtable.plus.annual', state: 'APPROVED', subscriptionPeriod: 'ONE_YEAR', familySharable: true } },
      { id: 's2', type: 'subscriptions', attributes: { name: 'BigTable Plus Monthly', productId: 'com.stephenwarren.bigtable.plus.monthly', state: 'READY_TO_SUBMIT', subscriptionPeriod: 'ONE_MONTH', familySharable: true } },
      { id: 's3', type: 'subscriptions', attributes: { name: 'Hearth+ Monthly', productId: 'com.stephenwarren.bigtable.hearth.monthly', state: 'APPROVED', subscriptionPeriod: 'ONE_MONTH', familySharable: true } },
    ],
  },
  '/v1/subscriptions/s1/prices?filter[territory]=USA&include=subscriptionPricePoint,territory&limit=50': {
    data: [
      { id: 'p1', attributes: { startDate: null, preserved: false }, relationships: { subscriptionPricePoint: { data: { id: 'pp1' } }, territory: { data: { id: 'USA' } } } },
      { id: 'p2', attributes: { startDate: '2026-12-01', preserved: false }, relationships: { subscriptionPricePoint: { data: { id: 'pp2' } }, territory: { data: { id: 'USA' } } } },
    ],
    included: [
      { id: 'pp1', type: 'subscriptionPricePoints', attributes: { customerPrice: '39.99' } },
      { id: 'pp2', type: 'subscriptionPricePoints', attributes: { customerPrice: '44.99' } },
      { id: 'USA', type: 'territories', attributes: { currency: 'USD' } },
    ],
  },
  '/v1/subscriptions/s1/introductoryOffers?include=territory&limit=200': {
    data: [
      { id: 'o1', attributes: { offerMode: 'FREE_TRIAL', duration: 'TWO_WEEKS', numberOfPeriods: 1, startDate: null, endDate: null }, relationships: { territory: { data: { id: 'USA' } } } },
      { id: 'o2', attributes: { offerMode: 'FREE_TRIAL', duration: 'ONE_WEEK', numberOfPeriods: 1 }, relationships: { territory: { data: { id: 'CAN' } } } },
    ],
  },
  '/v1/apps/111/inAppPurchasesV2?limit=200': [
    { id: 'i1', attributes: { name: 'Hearth+ Lifetime', productId: 'com.stephenwarren.bigtable.hearth.lifetime', inAppPurchaseType: 'NON_CONSUMABLE', state: 'APPROVED', familySharable: true } },
  ],
  '/v1/inAppPurchasePriceSchedules/i1/manualPrices?include=inAppPurchasePricePoint,territory&limit=50': {
    data: [{ id: 'm1', attributes: { startDate: null }, relationships: { inAppPurchasePricePoint: { data: { id: 'ip1' } }, territory: { data: { id: 'USA' } } } }],
    included: [{ id: 'ip1', type: 'inAppPurchasePricePoints', attributes: { customerPrice: '249.0' } }],
  },
};

function fakeAsc(): AscClient {
  const answer = (path: string) => {
    if (!(path in asc)) return Promise.reject(new Error(`App Store Connect GET ${path.split('?')[0]} answered 404`));
    return Promise.resolve(asc[path]);
  };
  return {
    get: vi.fn((path: string) => answer(path)),
    all: vi.fn((path: string) => answer(path)),
  } as unknown as AscClient;
}

const rc: Record<string, unknown> = {
  '/apps?limit=100': { items: [{ id: 'app1', app_store: { bundle_id: 'com.stephenwarren.bigtable' } }, { id: 'app2', app_store: { bundle_id: 'com.stephenwarren.sated' } }] },
  '/products?limit=200': { items: [
    { id: 'prod1', store_identifier: 'com.stephenwarren.bigtable.plus.annual', app_id: 'app1' },
    { id: 'prod2', store_identifier: 'com.stephenwarren.bigtable.hearth.lifetime', app_id: 'app1' },
    { id: 'prod3', store_identifier: 'com.stephenwarren.bigtable.plus.weekly', app_id: 'app1' },
    { id: 'prod4', store_identifier: 'com.stephenwarren.sated.plus.annual', app_id: 'app2' },
  ] },
  '/offerings?limit=100': { items: [{ id: 'ofrng1', lookup_key: 'default', is_current: true }] },
  '/offerings/ofrng1/packages?limit=100&expand=items.product': { items: [
    { id: 'pkge1', lookup_key: '$rc_annual', products: { items: [{ product: { id: 'prod1' } }, { product: { id: 'prod4' } }] } },
    { id: 'pkge2', lookup_key: 'hearth_lifetime', products: { items: [{ product: { id: 'prod2', store_identifier: 'com.stephenwarren.bigtable.hearth.lifetime', app_id: 'app1' } }] } },
    { id: 'pkge3', lookup_key: '$rc_weekly', products: { items: [{ product_id: 'prod3' }] } },
  ] },
  '/entitlements?limit=100': { items: [{ id: 'entl1', lookup_key: 'bigtable_plus' }, { id: 'entl2', lookup_key: 'hearth_plus' }] },
  '/entitlements/entl1/products?limit=100': { items: [{ store_identifier: 'com.stephenwarren.bigtable.plus.annual', app_id: 'app1' }] },
  '/entitlements/entl2/products?limit=100': { items: [{ store_identifier: 'com.stephenwarren.bigtable.hearth.lifetime', app_id: 'app1' }, { store_identifier: 'com.stephenwarren.bigtable.hearth.monthly', app_id: 'app1' }] },
};
const fakeRc = vi.fn(async (path: string) => {
  if (!(path in rc)) throw new Error(`GET ${path} answered 404`);
  return rc[path];
});

const now = () => new Date('2026-10-29T12:00:00Z');

describe('Monetization overview', () => {
  it('joins App Store Connect products with RevenueCat packages and entitlements', async () => {
    const backend = createMonetization({ asc: fakeAsc(), revenueCat: fakeRc, now });
    const overview = await backend.overview();
    expect(overview.sources).toEqual({ appStoreConnect: 'ok', revenueCat: 'ok' });
    // Hearth Studio itself isn't one of the apps.
    expect(overview.apps.map((app) => app.key)).toEqual(['bigtable']);
    const [bigtable] = overview.apps;
    // The app's own plans first (shortest period first), then Hearth+.
    expect(bigtable!.products.map((product) => product.productId)).toEqual([
      'com.stephenwarren.bigtable.plus.weekly', 'com.stephenwarren.bigtable.plus.monthly', 'com.stephenwarren.bigtable.plus.annual',
      'com.stephenwarren.bigtable.hearth.monthly', 'com.stephenwarren.bigtable.hearth.lifetime',
    ]);

    const annual = bigtable!.products.find((product) => product.productId.endsWith('plus.annual'))!;
    expect(annual).toMatchObject({
      kind: 'subscription', group: 'BigTable', period: 'ONE_YEAR', state: 'APPROVED', familySharable: true,
      price: { amount: '39.99', currency: 'USD', territory: 'USA' },
      nextPrice: { amount: '44.99', startDate: '2026-12-01' },
      trial: { mode: 'FREE_TRIAL', duration: 'TWO_WEEKS', periods: 1 },
      packages: [{ offering: 'default', package: '$rc_annual', current: true }],
      entitlements: ['bigtable_plus'], inAppStoreConnect: true, inRevenueCat: true,
    });
    const lifetime = bigtable!.products.find((product) => product.productId.endsWith('hearth.lifetime'))!;
    expect(lifetime).toMatchObject({ kind: 'non_consumable', price: { amount: '249.0' }, packages: [{ package: 'hearth_lifetime' }], entitlements: ['hearth_plus'] });

    // Mismatches are reported, not fatal: a product with no price data, one RevenueCat sells that App Store Connect doesn't have.
    expect(bigtable!.problems).toEqual(expect.arrayContaining([
      expect.stringContaining('com.stephenwarren.bigtable.plus.monthly price'),
      'com.stephenwarren.bigtable.plus.weekly is in RevenueCat but not App Store Connect.',
    ]));
    // Sated's product (another RevenueCat app) never lands on BigTable.
    expect(bigtable!.products.some((product) => product.productId.includes('sated'))).toBe(false);
  });

  it('works with only one source, caches, and refreshes on request', async () => {
    fakeRc.mockClear();
    const backend = createMonetization({ revenueCat: fakeRc, now, apps: async () => [{ key: 'bigtable', name: 'BigTable', bundleId: 'com.stephenwarren.bigtable', repo: 'x/y', defaultBranch: 'main', icon: null } as never] });
    const first = await backend.overview();
    expect(first.sources).toEqual({ appStoreConnect: 'not_configured', revenueCat: 'ok' });
    // Without App Store Connect, what RevenueCat sells still shows (no prices).
    expect(first.apps.map((app) => app.key)).toEqual(['bigtable']);
    expect(first.apps[0]!.products.map((product) => [product.productId, product.inAppStoreConnect, product.price])).toEqual([
      ['com.stephenwarren.bigtable.plus.annual', false, null],
      ['com.stephenwarren.bigtable.plus.weekly', false, null],
      ['com.stephenwarren.bigtable.hearth.lifetime', false, null],
    ]);
    const calls = fakeRc.mock.calls.length;
    await backend.overview();
    expect(fakeRc.mock.calls.length).toBe(calls);
    await backend.overview(true);
    expect(fakeRc.mock.calls.length).toBe(calls * 2);
  });

  it('reports a source that fails instead of failing the page', async () => {
    const broken = vi.fn(async () => { throw new Error('GET /apps answered 403: Forbidden'); });
    const overview = await createMonetization({ asc: fakeAsc(), revenueCat: broken, now }).overview();
    expect(overview.sources.revenueCat).toBe('failed');
    expect(overview.problems).toEqual(['RevenueCat: GET /apps answered 403: Forbidden']);
    expect(overview.apps[0]!.products.length).toBe(4);
  });

  it('reads RevenueCat with the project key, following next_page links', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 }));
    const get = revenueCatReader({ REVENUECAT_SECRET_API_KEY: 'sk_test', REVENUECAT_PROJECT_ID: 'abcd1234' }, fetcher as unknown as typeof fetch)!;
    await get('/apps?limit=100');
    await get('/v2/projects/projabcd1234/apps?starting_after=x');
    expect(fetcher.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      'https://api.revenuecat.com/v2/projects/projabcd1234/apps?limit=100',
      'https://api.revenuecat.com/v2/projects/projabcd1234/apps?starting_after=x',
    ]);
    expect(revenueCatReader({})).toBeUndefined();
  });
});
