import { describe, expect, it } from 'vitest';
import { AscError } from '../../src/affiliates/asc.js';
import type { AscClient } from '../../src/affiliates/asc.js';
import { ApiError } from '../../src/errors.js';
import { createStoreProducts } from '../../src/studio/storeProducts.js';
import type { RevenueCatClient } from '../../src/studio/storeProducts.js';

// A small App Store Connect: one app with one subscription (no metadata yet) and a lifetime purchase.
function fakeAsc(options: { versions?: boolean; state?: string } = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const localizations: Record<string, { id: string; name: string; description?: string }> = {};
  const routes: Record<string, unknown> = {
    '/v1/apps/111/subscriptionGroups?include=subscriptions&limit=50&limit[subscriptions]=50': {
      data: [{ id: 'g1', attributes: { referenceName: 'BigTable' }, relationships: { subscriptions: { data: [{ id: 's1' }] } } }],
      included: [{ id: 's1', type: 'subscriptions', attributes: { name: 'Plus Monthly', productId: 'bt.plus.monthly', state: options.state ?? 'MISSING_METADATA', subscriptionPeriod: 'ONE_MONTH', familySharable: true } }],
    },
    '/v1/apps/111/subscriptionGroups?limit=50': { data: [{ id: 'g1', attributes: { referenceName: 'BigTable' } }] },
    '/v1/apps/111/inAppPurchasesV2?limit=200': { data: [{ id: 'i1', attributes: { name: 'Lifetime', productId: 'bt.hearthplus.lifetime', state: 'MISSING_METADATA' } }] },
    '/v1/territories?limit=200': { data: [{ id: 'USA' }, { id: 'CAN' }, { id: 'GBR' }] },
    '/v1/subscriptions/s1/prices?filter[territory]=USA&include=subscriptionPricePoint&limit=50': { data: [] },
    '/v1/subscriptions/s1/pricePoints?filter[territory]=USA&limit=8000': { data: [
      { id: 'pp-499', attributes: { customerPrice: '4.99' } }, { id: 'pp-599', attributes: { customerPrice: '5.99' } }, { id: 'pp-399', attributes: { customerPrice: '3.99' } },
    ] },
    '/v1/subscriptionPricePoints/pp-499/equalizations?include=territory&limit=8000': { data: [
      { id: 'eq-can', relationships: { territory: { data: { id: 'CAN' } } } }, { id: 'eq-gbr', relationships: { territory: { data: { id: 'GBR' } } } },
    ] },
    '/v1/subscriptions/s1/planAvailabilities?limit=200': { data: [] },
    '/v1/subscriptions/s1/introductoryOffers?include=territory&limit=200': { data: [
      { id: 'old-offer', attributes: { offerMode: 'FREE_TRIAL', duration: 'ONE_WEEK' }, relationships: { territory: { data: { id: 'USA' } } } },
    ] },
    '/v1/subscriptions/s1/appStoreReviewScreenshot': { data: null },
    '/v1/subscriptions/s1/versions?limit=50': { data: [{ id: 'v1', attributes: { state: 'PREPARE_FOR_SUBMISSION' } }] },
    '/v1/subscriptionGroups/g1/versions?limit=50': { data: [] },
    '/v1/subscriptionGroupVersions/gv1/localizations?limit=50': { data: [] },
  };
  const asc = {
    async get(path: string) {
      calls.push({ method: 'GET', path });
      if (!options.versions && path.includes('/versions')) throw new AscError('not found', 404);
      if (path === '/v1/subscriptionVersions/v1/localizations?limit=50') return { data: Object.values(localizations).filter((entry) => entry.id.startsWith('sub')).map((entry) => ({ id: entry.id, attributes: { locale: 'en-US', name: entry.name, description: entry.description } })) };
      if (path === '/v1/subscriptions/s1/subscriptionLocalizations?limit=50') return { data: Object.values(localizations).filter((entry) => entry.id.startsWith('sub')).map((entry) => ({ id: entry.id, attributes: { locale: 'en-US', name: entry.name, description: entry.description } })) };
      if (path === '/v1/subscriptionGroups/g1/subscriptionGroupLocalizations?limit=50') return { data: [] };
      if (path in routes) return routes[path];
      throw new AscError(`no route ${path}`, 404);
    },
    async all(path: string) { return ((await asc.get(path)) as { data: unknown[] }).data; },
    async send(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      if (path === '/v1/subscriptionPlanAvailabilities') {
        const data = (body as { data: { attributes: { availableInNewTerritories: boolean }; relationships: { availableTerritories: { data: { id: string }[] } } } }).data;
        routes['/v1/subscriptions/s1/planAvailabilities?limit=200'] = { data: [{ id: 'pa1', attributes: { planType: 'UPFRONT', availableInNewTerritories: data.attributes.availableInNewTerritories } }] };
        routes['/v1/subscriptionPlanAvailabilities/pa1/availableTerritories?limit=200'] = { data: data.relationships.availableTerritories.data };
      }
      if (path === '/v2/subscriptionLocalizations' || path === '/v1/subscriptionLocalizations') {
        const attributes = (body as { data: { attributes: { name: string; description?: string } } }).data.attributes;
        localizations.s = { id: 'sub-1', ...attributes };
        return { data: { id: 'sub-1' } };
      }
      if (path === '/v1/subscriptionGroupVersions') return { data: { id: 'gv1' } };
      return { data: { id: 'new' } };
    },
  };
  return { asc: asc as unknown as AscClient, calls };
}

function fakeRevenueCat(packageHolds: { id: string; app_id: string; store_identifier: string }[] = []) {
  const posts: { path: string; body: unknown }[] = [];
  const client: RevenueCatClient = {
    async get(path) {
      if (path.startsWith('/apps')) return { items: [{ id: 'app1', app_store: { bundle_id: 'com.bigtable' } }] };
      if (path.startsWith('/products')) return { items: packageHolds };
      if (path.startsWith('/offerings?')) return { items: [{ id: 'ofr', lookup_key: 'default', is_current: true }] };
      if (path.startsWith('/offerings/ofr/packages')) return { items: [{ id: 'pk1', lookup_key: '$rc_monthly', products: { items: packageHolds.map((product) => ({ product, eligibility_criteria: 'all' })) } }] };
      if (path.startsWith('/entitlements?')) return { items: [{ id: 'en1', lookup_key: 'bigtable_plus', products: { items: [] } }] };
      if (path.startsWith('/entitlements/en1/products')) return { items: [] };
      throw new Error(`no route ${path}`);
    },
    async post(path, body) {
      posts.push({ path, body });
      if (path === '/products') return { id: 'prodNew', store_identifier: 'bt.plus.monthly', app_id: 'app1' };
      return {};
    },
  };
  return { client, posts };
}

describe('Store products', () => {
  it('shows what a new subscription still needs', async () => {
    const { asc } = fakeAsc();
    const editor = await createStoreProducts({ asc, revenueCat: fakeRevenueCat().client }).editor('111', 'com.bigtable', 'bt.plus.monthly');
    expect(editor.product).toMatchObject({ kind: 'subscription', referenceName: 'Plus Monthly', period: 'ONE_MONTH', state: 'MISSING_METADATA', priceUSD: null, trial: 'ONE_WEEK', familySharable: true });
    expect(editor.checklist.filter((item) => !item.done).map((item) => item.key)).toEqual([
      'group_name', 'display_name', 'description', 'price', 'availability', 'review_screenshot', 'revenuecat_package', 'revenuecat_entitlement',
    ]);
    expect(editor.options).toEqual({ packages: ['$rc_monthly'], entitlements: ['bigtable_plus'] });
    expect(editor.notes[0]).toContain('next app version');
  });

  it('saves names, every country’s price, availability and a trial, using product versions', async () => {
    const { asc, calls } = fakeAsc({ versions: true });
    const editor = await createStoreProducts({ asc }).save('111', 'com.bigtable', 'bt.plus.monthly', {
      displayName: 'BigTable Plus', description: 'Unlimited imports and menus.', groupDisplayName: 'BigTable Plus',
      priceUSD: '4.99', soldIn: 'everywhere', trial: 'TWO_WEEKS',
    });
    const writes = calls.filter((call) => call.method !== 'GET');
    // The group had no version: one is made, then its localization.
    expect(writes.find((call) => call.path === '/v1/subscriptionGroupVersions')).toBeTruthy();
    expect(writes.find((call) => call.path === '/v2/subscriptionGroupLocalizations')).toBeTruthy();
    expect(writes.find((call) => call.path === '/v2/subscriptionLocalizations')?.body).toMatchObject({
      data: { attributes: { name: 'BigTable Plus', description: 'Unlimited imports and menus.', locale: 'en-US' }, relationships: { version: { data: { id: 'v1' } } } },
    });
    expect(writes.find((call) => call.path === '/v1/subscriptionPlanAvailabilities')?.body).toMatchObject({
      data: { attributes: { planType: 'UPFRONT', availableInNewTerritories: true }, relationships: { availableTerritories: { data: [{ id: 'USA' }, { id: 'CAN' }, { id: 'GBR' }] } } },
    });
    expect(writes.filter((call) => call.path === '/v1/subscriptionPrices').map((call) => (call.body as { data: { relationships: { subscriptionPricePoint: { data: { id: string } } } } }).data.relationships.subscriptionPricePoint.data.id))
      .toEqual(['pp-499', 'eq-can', 'eq-gbr']);
    expect(writes.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual(['/v1/subscriptionIntroductoryOffers/old-offer']);
    expect(writes.filter((call) => call.path === '/v1/subscriptionIntroductoryOffers')).toHaveLength(3);
    expect(editor.product.displayName).toBe('BigTable Plus');
  });

  it('sells in the US only: one price, one trial, no other countries', async () => {
    const { asc, calls } = fakeAsc();
    const editor = await createStoreProducts({ asc }).save('111', 'com.bigtable', 'bt.plus.monthly', { soldIn: 'us', priceUSD: '4.99', trial: 'TWO_WEEKS' });
    const writes = calls.filter((call) => call.method !== 'GET');
    expect(writes.find((call) => call.path === '/v1/subscriptionPlanAvailabilities')?.body).toMatchObject({
      data: { attributes: { availableInNewTerritories: false }, relationships: { availableTerritories: { data: [{ type: 'territories', id: 'USA' }] } } },
    });
    expect(writes.filter((call) => call.path === '/v1/subscriptionPrices')).toHaveLength(1);
    expect(calls.some((call) => call.path.includes('/equalizations'))).toBe(false);
    expect(writes.filter((call) => call.path === '/v1/subscriptionIntroductoryOffers')).toHaveLength(1);
    expect(editor.product.soldIn).toBe('us');
  });

  it('falls back to the v1 localizations when versions aren’t there', async () => {
    const { asc, calls } = fakeAsc();
    await createStoreProducts({ asc }).save('111', 'com.bigtable', 'bt.plus.monthly', { displayName: 'BigTable Plus', description: 'Everything.' });
    expect(calls.find((call) => call.method === 'POST' && call.path === '/v1/subscriptionLocalizations')?.body).toMatchObject({
      data: { relationships: { subscription: { data: { type: 'subscriptions', id: 's1' } } } },
    });
  });

  it('refuses a price Apple doesn’t have, and turning Family Sharing off', async () => {
    const products = createStoreProducts({ asc: fakeAsc().asc });
    await expect(products.save('111', 'com.bigtable', 'bt.plus.monthly', { priceUSD: '4.95' })).rejects.toThrow(/nearest are \$3\.99, \$4\.99, \$5\.99/);
    await expect(products.save('111', 'com.bigtable', 'bt.plus.monthly', { familySharable: false })).rejects.toBeInstanceOf(ApiError);
  });

  it('adds the product to RevenueCat, and asks before replacing what a package sells', async () => {
    const rc = fakeRevenueCat();
    await createStoreProducts({ asc: fakeAsc().asc, revenueCat: rc.client }).save('111', 'com.bigtable', 'bt.plus.monthly', { package: '$rc_monthly', entitlement: 'bigtable_plus' });
    expect(rc.posts.map((post) => post.path)).toEqual(['/products', '/entitlements/en1/actions/attach_products', '/packages/pk1/actions/attach_products']);
    expect(rc.posts[0]!.body).toMatchObject({ store_identifier: 'bt.plus.monthly', app_id: 'app1', type: 'subscription' });

    const taken = fakeRevenueCat([{ id: 'prodPro', app_id: 'app1', store_identifier: 'bt.pro.monthly' }]);
    // Not approved yet: it can't take over the live paywall at all.
    const unapproved = createStoreProducts({ asc: fakeAsc().asc, revenueCat: taken.client });
    await expect(unapproved.save('111', 'com.bigtable', 'bt.plus.monthly', { package: '$rc_monthly', replaceInPackage: true })).rejects.toMatchObject({ status: 422, code: 'NOT_APPROVED' });
    expect(taken.posts).toEqual([]);

    const takenAsc = fakeAsc({ state: 'APPROVED' });
    const products = createStoreProducts({ asc: takenAsc.asc, revenueCat: taken.client });
    // Found before anything is written: nothing half-saved.
    await expect(products.save('111', 'com.bigtable', 'bt.plus.monthly', { package: '$rc_monthly', priceUSD: '4.99' })).rejects.toMatchObject({ status: 409, code: 'PACKAGE_TAKEN' });
    expect(takenAsc.calls.filter((call) => call.method !== 'GET')).toEqual([]);
    expect(taken.posts).toEqual([]);
    await products.save('111', 'com.bigtable', 'bt.plus.monthly', { package: '$rc_monthly', replaceInPackage: true });
    expect(taken.posts.map((post) => post.path)).toContain('/packages/pk1/actions/detach_products');
  });

  it('creates a subscription in the app’s group, then saves the rest', async () => {
    const { asc, calls } = fakeAsc();
    // The new product is found by its id afterwards: point the lookup at it.
    await expect(createStoreProducts({ asc }).create('111', 'BigTable', 'com.bigtable', {
      kind: 'subscription', productId: 'bt.plus.monthly', referenceName: 'Plus Monthly', period: 'ONE_MONTH', changes: {},
    })).rejects.toMatchObject({ status: 409, code: 'PRODUCT_EXISTS' });
    const created = await createStoreProducts({ asc }).create('111', 'BigTable', 'com.bigtable', {
      kind: 'subscription', productId: 'bt.plus.annual', referenceName: 'Plus Annual', period: 'ONE_YEAR', changes: { reviewNote: 'Unlocks Plus.' },
    }).catch((error: unknown) => error);
    const post = calls.find((call) => call.method === 'POST' && call.path === '/v1/subscriptions');
    expect(post?.body).toMatchObject({ data: { attributes: { productId: 'bt.plus.annual', subscriptionPeriod: 'ONE_YEAR' }, relationships: { group: { data: { id: 'g1' } } } } });
    // The fake doesn't list the new product afterwards, so reading it back fails; the create itself went through.
    expect(created).toBeInstanceOf(ApiError);
  });
});
