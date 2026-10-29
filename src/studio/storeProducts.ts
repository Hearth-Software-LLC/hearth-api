import { AscError } from '../affiliates/asc.js';
import type { AscClient } from '../affiliates/asc.js';
import { ApiError } from '../errors.js';
import type { RevenueCatGet } from './monetization.js';

/**
 * Store › Monetization's product editor (admins): everything App Store Connect needs before a
 * subscription or one-time purchase can go on sale, and RevenueCat's package and entitlement, so
 * a plan can be finished in one place.
 *
 * App Store Connect API notes (4.4 / 4.4.1):
 * - Display names and descriptions live on a product *version* (subscriptionVersions,
 *   subscriptionGroupVersions, inAppPurchaseVersions) with v2 localizations. The old v1
 *   localization endpoints are deprecated but still answer, and are used when versions aren't there.
 * - Subscription availability is per plan type (UPFRONT is the usual pay-per-period plan).
 * - Subscription prices are set per territory: the US price point and its equalizations.
 * - Review screenshots belong to the product; the Mac uploads the bytes straight to Apple.
 * Only the en-US localization is managed here.
 */

const LOCALE = 'en-US';
export const DISPLAY_NAME_LIMIT = 30;
export const DESCRIPTION_LIMIT = 45;
export const PERIODS = ['ONE_WEEK', 'ONE_MONTH', 'TWO_MONTHS', 'THREE_MONTHS', 'SIX_MONTHS', 'ONE_YEAR'] as const;
export const TRIALS = ['THREE_DAYS', 'ONE_WEEK', 'TWO_WEEKS', 'ONE_MONTH', 'TWO_MONTHS', 'THREE_MONTHS', 'SIX_MONTHS', 'ONE_YEAR'] as const;

export type ProductChanges = {
  referenceName?: string;
  displayName?: string;
  description?: string;
  /** The subscription group's display name (subscriptions). */
  groupDisplayName?: string;
  familySharable?: boolean;
  reviewNote?: string;
  /** The US price, e.g. "4.99". Other countries get Apple's equalized prices. */
  priceUSD?: string;
  /** Where it's sold: the US only, or every country (and new ones as Apple adds them). */
  soldIn?: 'us' | 'everywhere';
  /** A free trial's length; "" removes it (subscriptions). */
  trial?: string;
  /** A package in RevenueCat's current offering, e.g. $rc_monthly (made when missing). */
  package?: string;
  /** Replace the app's product already in that package (what the paywall shows changes at once). */
  replaceInPackage?: boolean;
  /** An entitlement's lookup key, e.g. bigtable_plus. */
  entitlement?: string;
};

export type NewProduct = {
  kind: 'subscription' | 'non_consumable';
  productId: string;
  referenceName: string;
  period?: string;
  changes: ProductChanges;
};

export type ProductEditor = {
  product: {
    kind: 'subscription' | 'non_consumable';
    productId: string;
    referenceName: string;
    period: string | null;
    state: string | null;
    groupReferenceName: string | null;
    groupDisplayName: string | null;
    displayName: string | null;
    description: string | null;
    familySharable: boolean;
    reviewNote: string | null;
    priceUSD: string | null;
    availableEverywhere: boolean;
    /** us (the US only), everywhere, some (another set, chosen in App Store Connect) or none. */
    soldIn: 'us' | 'everywhere' | 'some' | 'none';
    territoryCount: number;
    trial: string | null;
    reviewScreenshot: { fileName: string | null; state: string | null; url: string | null } | null;
    revenueCat: { productId: string | null; packages: string[]; entitlements: string[] };
  };
  checklist: { key: string; label: string; done: boolean }[];
  options: { packages: string[]; entitlements: string[] };
  notes: string[];
};

export type RevenueCatClient = { get: RevenueCatGet; post: (path: string, body: unknown) => Promise<unknown> };

type Item = {
  id: string; type?: string; attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id: string; type?: string } | { id: string; type?: string }[] | null; meta?: { paging?: { total?: number } } }>;
};
type Doc = { data: Item[] | Item | null; included?: Item[]; links?: { next?: string }; meta?: { paging?: { total?: number } } };

const text = (value: unknown) => (typeof value === 'string' ? value : null);
const list = (doc: Doc | undefined) => (!doc?.data ? [] : Array.isArray(doc.data) ? doc.data : [doc.data]);
const relation = (item: Item, name: string) => {
  const data = item.relationships?.[name]?.data;
  return Array.isArray(data) ? data.map((entry) => entry.id) : data ? [data.id] : [];
};
const missingEndpoint = (error: unknown) => error instanceof AscError && (error.status === 404 || error.status === 405);
const upstream = (step: string, error: unknown, done: string[]) => new ApiError(502, 'UPSTREAM_FAILED',
  `${step} failed: ${error instanceof Error ? error.message : String(error)}${done.length ? ` (already saved: ${done.join(', ')})` : ''}`);

async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const failures: unknown[] = [];
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      try { await work(item); } catch (error) { failures.push(error); }
    }
  }));
  return failures;
}

type Located =
  | { kind: 'subscription'; id: string; item: Item; groupId: string; groupName: string | null }
  | { kind: 'non_consumable'; id: string; item: Item };

/** The localization kinds: where the versions and localizations are, and the v1 fallback. */
const LOCALIZED = {
  subscription: {
    versions: (id: string) => `/v1/subscriptions/${id}/versions`,
    versionType: 'subscriptionVersions', parent: 'subscription', parentType: 'subscriptions',
    versionLocalizations: (id: string) => `/v1/subscriptionVersions/${id}/localizations`,
    v2: '/v2/subscriptionLocalizations', type: 'subscriptionLocalizations',
    v1List: (id: string) => `/v1/subscriptions/${id}/subscriptionLocalizations`, v1: '/v1/subscriptionLocalizations', v1Parent: 'subscription',
  },
  group: {
    versions: (id: string) => `/v1/subscriptionGroups/${id}/versions`,
    versionType: 'subscriptionGroupVersions', parent: 'subscriptionGroup', parentType: 'subscriptionGroups',
    versionLocalizations: (id: string) => `/v1/subscriptionGroupVersions/${id}/localizations`,
    v2: '/v2/subscriptionGroupLocalizations', type: 'subscriptionGroupLocalizations',
    v1List: (id: string) => `/v1/subscriptionGroups/${id}/subscriptionGroupLocalizations`, v1: '/v1/subscriptionGroupLocalizations', v1Parent: 'subscriptionGroup',
  },
  purchase: {
    versions: (id: string) => `/v2/inAppPurchases/${id}/versions`,
    versionType: 'inAppPurchaseVersions', parent: 'inAppPurchase', parentType: 'inAppPurchases',
    versionLocalizations: (id: string) => `/v1/inAppPurchaseVersions/${id}/localizations`,
    v2: '/v2/inAppPurchaseLocalizations', type: 'inAppPurchaseLocalizations',
    v1List: (id: string) => `/v2/inAppPurchases/${id}/inAppPurchaseLocalizations`, v1: '/v1/inAppPurchaseLocalizations', v1Parent: 'inAppPurchaseV2',
  },
} as const;
type LocalizedKind = keyof typeof LOCALIZED;

export function createStoreProducts(options: { asc: AscClient; revenueCat?: RevenueCatClient | undefined }) {
  const { asc } = options;
  const rc = options.revenueCat;
  let territoryCache: string[] | undefined;

  const territories = async () => (territoryCache ??= (await asc.all('/v1/territories?limit=200')).map((item) => item.id));

  async function locate(appStoreId: string, productId: string): Promise<Located | undefined> {
    let next: string | undefined = `/v1/apps/${appStoreId}/subscriptionGroups?include=subscriptions&limit=50&limit[subscriptions]=50`;
    while (next) {
      const page: Doc = await asc.get<Doc>(next);
      const included = new Map((page.included ?? []).filter((item) => item.type === 'subscriptions').map((item) => [item.id, item]));
      for (const group of list(page)) {
        for (const id of relation(group, 'subscriptions')) {
          const item = included.get(id);
          if (item && item.attributes?.productId === productId) {
            return { kind: 'subscription', id, item, groupId: group.id, groupName: text(group.attributes?.referenceName) };
          }
        }
      }
      next = page.links?.next;
    }
    for (const item of await asc.all(`/v1/apps/${appStoreId}/inAppPurchasesV2?limit=200`)) {
      if (item.attributes?.productId === productId) return { kind: 'non_consumable', id: item.id, item };
    }
    return undefined;
  }

  async function mustLocate(appStoreId: string, productId: string) {
    const found = await locate(appStoreId, productId);
    if (!found) throw new ApiError(404, 'RESOURCE_NOT_FOUND', `${productId} isn’t in App Store Connect for this app`);
    return found;
  }

  // MARK: Localizations

  /** The newest version still being prepared, else the newest; undefined when the product has none (or versions aren't available). */
  async function versions(kind: LocalizedKind, parentId: string) {
    const doc = await asc.get<Doc>(`${LOCALIZED[kind].versions(parentId)}?limit=50`);
    return list(doc);
  }

  async function readLocalization(kind: LocalizedKind, parentId: string): Promise<{ name: string | null; description: string | null }> {
    const spec = LOCALIZED[kind];
    const pick = (items: Item[]) => {
      const found = items.find((item) => item.attributes?.locale === LOCALE) ?? items[0];
      return { name: text(found?.attributes?.name), description: text(found?.attributes?.description) };
    };
    try {
      const all = await versions(kind, parentId);
      const ordered = [...all.filter((item) => item.attributes?.state === 'PREPARE_FOR_SUBMISSION'), ...all];
      for (const version of ordered) {
        const found = pick(list(await asc.get<Doc>(`${spec.versionLocalizations(version.id)}?limit=50`)));
        if (found.name || found.description) return found;
      }
      if (all.length) return { name: null, description: null };
    } catch (error) {
      if (!missingEndpoint(error)) throw error;
    }
    try {
      return pick(list(await asc.get<Doc>(`${spec.v1List(parentId)}?limit=50`)));
    } catch (error) {
      if (missingEndpoint(error)) return { name: null, description: null };
      throw error;
    }
  }

  async function writeLocalization(kind: LocalizedKind, parentId: string, name: string, description: string | undefined) {
    const spec = LOCALIZED[kind];
    const attributes = description === undefined ? { name } : { name, description };
    let all: Item[] | undefined;
    try {
      all = await versions(kind, parentId);
    } catch (error) {
      if (!missingEndpoint(error)) throw error;
    }
    if (all) {
      let version = all.find((item) => item.attributes?.state === 'PREPARE_FOR_SUBMISSION' || !item.attributes?.state);
      if (!version) {
        const created = await asc.send<Doc>('POST', `/v1/${spec.versionType}`, {
          data: { type: spec.versionType, relationships: { [spec.parent]: { data: { type: spec.parentType, id: parentId } } } },
        });
        version = list(created)[0];
      }
      if (version) {
        const existing = list(await asc.get<Doc>(`${spec.versionLocalizations(version.id)}?limit=50`)).find((item) => item.attributes?.locale === LOCALE);
        if (existing) {
          await asc.send('PATCH', `${spec.v2}/${existing.id}`, { data: { type: spec.type, id: existing.id, attributes } });
        } else {
          await asc.send('POST', spec.v2, {
            data: { type: spec.type, attributes: { ...attributes, locale: LOCALE }, relationships: { version: { data: { type: spec.versionType, id: version.id } } } },
          });
        }
        return;
      }
    }
    // The deprecated v1 path.
    const existing = list(await asc.get<Doc>(`${spec.v1List(parentId)}?limit=50`)).find((item) => item.attributes?.locale === LOCALE);
    if (existing) {
      await asc.send('PATCH', `${spec.v1}/${existing.id}`, { data: { type: spec.type, id: existing.id, attributes } });
    } else {
      await asc.send('POST', spec.v1, {
        data: { type: spec.type, attributes: { ...attributes, locale: LOCALE }, relationships: { [spec.v1Parent]: { data: { type: spec.parentType, id: parentId } } } },
      });
    }
  }

  // MARK: Prices, availability, trials

  async function readPrice(found: Located): Promise<string | null> {
    const doc = found.kind === 'subscription'
      ? await asc.get<Doc>(`/v1/subscriptions/${found.id}/prices?filter[territory]=USA&include=subscriptionPricePoint&limit=50`)
      : await asc.get<Doc>(`/v1/inAppPurchasePriceSchedules/${found.id}/manualPrices?include=inAppPurchasePricePoint,territory&limit=50`)
        .catch((error) => { if (missingEndpoint(error)) return { data: [] } as Doc; throw error; });
    const points = new Map((doc.included ?? []).filter((item) => item.type?.endsWith('PricePoints')).map((item) => [item.id, text(item.attributes?.customerPrice)]));
    const today = new Date().toISOString().slice(0, 10);
    const rows = list(doc)
      .filter((row) => (relation(row, 'territory')[0] ?? 'USA') === 'USA')
      .filter((row) => !text(row.attributes?.startDate) || text(row.attributes?.startDate)! <= today)
      .sort((a, b) => (text(a.attributes?.startDate) ?? '').localeCompare(text(b.attributes?.startDate) ?? ''));
    const row = rows.at(-1);
    if (!row) return null;
    return points.get(relation(row, 'subscriptionPricePoint')[0] ?? relation(row, 'inAppPurchasePricePoint')[0] ?? '') ?? null;
  }

  async function findPricePoint(found: Located, priceUSD: string) {
    const path = found.kind === 'subscription'
      ? `/v1/subscriptions/${found.id}/pricePoints?filter[territory]=USA&limit=8000`
      : `/v2/inAppPurchases/${found.id}/pricePoints?filter[territory]=USA&limit=8000`;
    const points = await asc.all(path);
    const wanted = Number(priceUSD);
    const match = points.find((point) => Number(point.attributes?.customerPrice) === wanted);
    if (!match) {
      const near = points.map((point) => Number(point.attributes?.customerPrice)).filter(Number.isFinite)
        .sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted)).slice(0, 3).sort((a, b) => a - b);
      throw new ApiError(422, 'INVALID_PRICE', `Apple has no $${priceUSD} price. The nearest are ${near.map((value) => `$${value.toFixed(2)}`).join(', ')}.`);
    }
    return match.id;
  }

  async function writePrice(found: Located, priceUSD: string) {
    const pointId = await findPricePoint(found, priceUSD);
    if (found.kind === 'non_consumable') {
      await asc.send('POST', '/v1/inAppPurchasePriceSchedules', {
        data: {
          type: 'inAppPurchasePriceSchedules',
          relationships: {
            inAppPurchase: { data: { type: 'inAppPurchases', id: found.id } },
            baseTerritory: { data: { type: 'territories', id: 'USA' } },
            manualPrices: { data: [{ type: 'inAppPurchasePrices', id: '${price-usa}' }] },
          },
        },
        included: [{
          type: 'inAppPurchasePrices', id: '${price-usa}', attributes: { startDate: null },
          relationships: {
            inAppPurchaseV2: { data: { type: 'inAppPurchases', id: found.id } },
            inAppPurchasePricePoint: { data: { type: 'inAppPurchasePricePoints', id: pointId } },
          },
        }],
      });
      return;
    }
    // Subscriptions: the US price point and Apple's equivalent in every other territory, one call each.
    // Only the countries it's sold in (the US to start).
    const sold = new Set(await availableTerritories(found.id));
    const equalized = sold.size > 1
      ? (await asc.all(`/v1/subscriptionPricePoints/${pointId}/equalizations?include=territory&limit=8000`))
        .filter((point) => sold.has(relation(point as Item, 'territory')[0] ?? ''))
      : [];
    const today = new Date().toISOString().slice(0, 10);
    const current = new Set((await asc.all(`/v1/subscriptions/${found.id}/prices?limit=200`).catch((): { id: string; attributes?: Record<string, unknown> }[] => []))
      .filter((row) => !text(row.attributes?.startDate) || text(row.attributes?.startDate)! <= today)
      .flatMap((row) => relation(row as Item, 'subscriptionPricePoint')));
    const ids = [pointId, ...equalized.map((point) => point.id)].filter((id) => !current.has(id));
    const failures = await pool(ids, 8, async (id) => {
      try {
        await asc.send('POST', '/v1/subscriptionPrices', {
          data: {
            type: 'subscriptionPrices', attributes: { startDate: null, preserveCurrentPrice: true },
            relationships: {
              subscription: { data: { type: 'subscriptions', id: found.id } },
              subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id } },
            },
          },
        });
      } catch (error) {
        // Already at that price.
        if (error instanceof AscError && error.status === 409 && /already/i.test(error.message)) return;
        throw error;
      }
    });
    if (failures.length) {
      throw new Error(`${failures.length} of ${ids.length} countries’ prices weren’t saved (first: ${failures[0] instanceof Error ? failures[0].message : 'failed'})`);
    }
  }

  type Availability = { everywhere: boolean; count: number; soldIn: 'us' | 'everywhere' | 'some' | 'none'; territories: string[] };

  async function readAvailability(found: Located): Promise<Availability> {
    const total = (await territories()).length;
    const none: Availability = { everywhere: false, count: 0, soldIn: 'none', territories: [] };
    const shape = async (item: Item | undefined, path: (id: string) => string): Promise<Availability> => {
      if (!item) return none;
      const ids = (await asc.all(`${path(item.id)}?limit=200`)).map((entry) => entry.id);
      const everywhere = item.attributes?.availableInNewTerritories === true && ids.length >= total;
      const soldIn = ids.length === 0 ? 'none' : everywhere ? 'everywhere' : ids.length === 1 && ids[0] === 'USA' ? 'us' : 'some';
      return { everywhere, count: ids.length, soldIn, territories: ids };
    };
    if (found.kind === 'non_consumable') {
      try {
        const item = list(await asc.get<Doc>(`/v2/inAppPurchases/${found.id}/inAppPurchaseAvailability`))[0];
        return await shape(item, (id) => `/v1/inAppPurchaseAvailabilities/${id}/availableTerritories`);
      } catch (error) {
        if (missingEndpoint(error)) return none;
        throw error;
      }
    }
    try {
      const plans = list(await asc.get<Doc>(`/v1/subscriptions/${found.id}/planAvailabilities?limit=200`));
      const plan = plans.find((item) => item.attributes?.planType === 'UPFRONT') ?? plans[0];
      if (plan) return await shape(plan, (id) => `/v1/subscriptionPlanAvailabilities/${id}/availableTerritories`);
    } catch (error) {
      if (!missingEndpoint(error)) throw error;
    }
    try {
      const item = list(await asc.get<Doc>(`/v1/subscriptions/${found.id}/subscriptionAvailability`))[0];
      return await shape(item, (id) => `/v1/subscriptionAvailabilities/${id}/availableTerritories`);
    } catch (error) {
      if (missingEndpoint(error)) return none;
      throw error;
    }
  }

  async function sellIn(found: Located, where: 'us' | 'everywhere') {
    const everywhere = where === 'everywhere';
    const all = (everywhere ? await territories() : ['USA']).map((id) => ({ type: 'territories', id }));
    if (found.kind === 'non_consumable') {
      await asc.send('POST', '/v1/inAppPurchaseAvailabilities', {
        data: {
          type: 'inAppPurchaseAvailabilities', attributes: { availableInNewTerritories: everywhere },
          relationships: { inAppPurchase: { data: { type: 'inAppPurchases', id: found.id } }, availableTerritories: { data: all } },
        },
      });
      return;
    }
    let plans: Item[] | undefined;
    try {
      plans = list(await asc.get<Doc>(`/v1/subscriptions/${found.id}/planAvailabilities?limit=200`));
    } catch (error) {
      if (!missingEndpoint(error)) throw error;
    }
    if (plans) {
      const plan = plans.find((item) => item.attributes?.planType === 'UPFRONT');
      if (plan) {
        await asc.send('PATCH', `/v1/subscriptionPlanAvailabilities/${plan.id}`, {
          data: { type: 'subscriptionPlanAvailabilities', id: plan.id, attributes: { availableInNewTerritories: everywhere } },
        });
        await asc.send('PATCH', `/v1/subscriptionPlanAvailabilities/${plan.id}/relationships/availableTerritories`, { data: all });
      } else {
        await asc.send('POST', '/v1/subscriptionPlanAvailabilities', {
          data: {
            type: 'subscriptionPlanAvailabilities', attributes: { planType: 'UPFRONT', availableInNewTerritories: everywhere },
            relationships: { subscription: { data: { type: 'subscriptions', id: found.id } }, availableTerritories: { data: all } },
          },
        });
      }
      return;
    }
    await asc.send('POST', '/v1/subscriptionAvailabilities', {
      data: {
        type: 'subscriptionAvailabilities', attributes: { availableInNewTerritories: everywhere },
        relationships: { subscription: { data: { type: 'subscriptions', id: found.id } }, availableTerritories: { data: all } },
      },
    });
  }

  /** Where a subscription is sold (its plan availability's territories). */
  async function availableTerritories(subscriptionId: string): Promise<string[]> {
    try {
      const plans = list(await asc.get<Doc>(`/v1/subscriptions/${subscriptionId}/planAvailabilities?limit=200`));
      const plan = plans.find((item) => item.attributes?.planType === 'UPFRONT') ?? plans[0];
      if (plan) return (await asc.all(`/v1/subscriptionPlanAvailabilities/${plan.id}/availableTerritories?limit=200`)).map((item) => item.id);
      return [];
    } catch (error) {
      if (!missingEndpoint(error)) throw error;
    }
    const item = list(await asc.get<Doc>(`/v1/subscriptions/${subscriptionId}/subscriptionAvailability`).catch((error) => {
      if (missingEndpoint(error)) return { data: null } as Doc;
      throw error;
    }))[0];
    return item ? (await asc.all(`/v1/subscriptionAvailabilities/${item.id}/availableTerritories?limit=200`)).map((entry) => entry.id) : [];
  }

  async function introOffers(subscriptionId: string) {
    return asc.all(`/v1/subscriptions/${subscriptionId}/introductoryOffers?include=territory&limit=200`);
  }

  async function readTrial(subscriptionId: string) {
    const today = new Date().toISOString().slice(0, 10);
    const offer = (await introOffers(subscriptionId)).find((item) =>
      item.attributes?.offerMode === 'FREE_TRIAL'
      && ['USA', undefined].includes(relation(item, 'territory')[0])
      && (!text(item.attributes?.endDate) || text(item.attributes?.endDate)! >= today));
    return text(offer?.attributes?.duration);
  }

  /**
   * The free trial in every country the subscription is sold in (or none). Country by country, so
   * a failure touches one country: that country's old free trial is removed, then the new one made.
   * Paid introductory offers are left alone (a country that has one is reported, not changed).
   */
  async function writeTrial(subscriptionId: string, trial: string): Promise<string | undefined> {
    const countries = await availableTerritories(subscriptionId);
    if (!countries.length) throw new ApiError(422, 'NOT_AVAILABLE', 'Choose where it’s sold before setting a free trial');
    const offers = await introOffers(subscriptionId);
    const byCountry = new Map<string, Item[]>();
    for (const offer of offers) {
      const territory = relation(offer, 'territory')[0];
      if (!territory) continue;
      byCountry.set(territory, [...(byCountry.get(territory) ?? []), offer]);
    }
    const paid: string[] = [];
    const failures = await pool(countries, 6, async (territory) => {
      const mine = byCountry.get(territory) ?? [];
      if (mine.some((offer) => offer.attributes?.offerMode !== 'FREE_TRIAL')) { paid.push(territory); return; }
      const same = mine.length === 1 && mine[0]!.attributes?.duration === trial && trial !== '';
      if (same) return;
      for (const offer of mine) await asc.send('DELETE', `/v1/subscriptionIntroductoryOffers/${offer.id}`);
      if (!trial) return;
      await asc.send('POST', '/v1/subscriptionIntroductoryOffers', {
        data: {
          type: 'subscriptionIntroductoryOffers', attributes: { duration: trial, offerMode: 'FREE_TRIAL', numberOfPeriods: 1 },
          relationships: {
            subscription: { data: { type: 'subscriptions', id: subscriptionId } },
            territory: { data: { type: 'territories', id: territory } },
          },
        },
      });
    });
    if (failures.length) {
      throw new Error(`the trial wasn’t saved in ${failures.length} of ${countries.length} countries (first: ${failures[0] instanceof Error ? failures[0].message : 'failed'}). Save again to finish.`);
    }
    if (paid.length) {
      return `The free trial wasn’t set in ${paid.length} countr${paid.length === 1 ? 'y' : 'ies'} that have a paid introductory offer (${paid.slice(0, 5).join(', ')}${paid.length > 5 ? '…' : ''}). Change those in App Store Connect.`;
    }
    return undefined;
  }

  // MARK: Review screenshot

  const screenshotPaths = (found: Located) => found.kind === 'subscription'
    ? { read: `/v1/subscriptions/${found.id}/appStoreReviewScreenshot`, type: 'subscriptionAppStoreReviewScreenshots', base: '/v1/subscriptionAppStoreReviewScreenshots', parent: 'subscription', parentType: 'subscriptions' }
    : { read: `/v2/inAppPurchases/${found.id}/appStoreReviewScreenshot`, type: 'inAppPurchaseAppStoreReviewScreenshots', base: '/v1/inAppPurchaseAppStoreReviewScreenshots', parent: 'inAppPurchaseV2', parentType: 'inAppPurchases' };

  async function readScreenshot(found: Located) {
    try {
      const item = list(await asc.get<Doc>(screenshotPaths(found).read))[0];
      if (!item) return null;
      const delivery = item.attributes?.assetDeliveryState as { state?: string } | undefined;
      const image = item.attributes?.imageAsset as { templateUrl?: string; width?: number; height?: number } | undefined;
      const url = image?.templateUrl
        ? image.templateUrl.replace('{w}', String(Math.min(image.width ?? 600, 600))).replace('{h}', String(Math.min(image.height ?? 1300, 1300))).replace('{f}', 'png')
        : null;
      return { id: item.id, fileName: text(item.attributes?.fileName), state: delivery?.state ?? null, url };
    } catch (error) {
      if (missingEndpoint(error)) return null;
      throw error;
    }
  }

  // MARK: RevenueCat

  type RcItem = Record<string, unknown>;
  async function rcList(path: string): Promise<RcItem[]> {
    if (!rc) return [];
    const items: RcItem[] = [];
    let next: string | null | undefined = path;
    let guard = 0;
    while (next && guard++ < 20) {
      const page = (await rc.get(next)) as { items?: RcItem[]; next_page?: string | null };
      items.push(...(page.items ?? []));
      next = page.next_page;
    }
    return items;
  }

  async function revenueCat(bundleId: string, productId: string) {
    if (!rc) return { app: undefined, product: undefined, appProducts: new Map<string, RcItem>(), offering: undefined, packages: [] as RcItem[], entitlements: [] as RcItem[] };
    const app = (await rcList('/apps?limit=100')).find((item) => (item.app_store as { bundle_id?: string } | undefined)?.bundle_id === bundleId);
    const appProducts = new Map((app ? await rcList(`/products?app_id=${encodeURIComponent(String(app.id))}&limit=100`) : []).map((item) => [String(item.id), item]));
    const product = [...appProducts.values()].find((item) => item.store_identifier === productId);
    const offering = (await rcList('/offerings?limit=100')).find((item) => item.is_current === true);
    const packages = offering ? await rcList(`/offerings/${encodeURIComponent(String(offering.id))}/packages?limit=100&expand=items.product`) : [];
    const entitlements = await rcList('/entitlements?limit=100&expand=items.product');
    return { app, product, appProducts, offering, packages, entitlements };
  }

  /** A package's or entitlement's products, expanded or not ({ product } or { product_id }). */
  const productsOf = (holder: RcItem) => ((holder.products as { items?: RcItem[] } | undefined)?.items ?? [])
    .map((entry): RcItem => (entry.product as RcItem | undefined) ?? (typeof entry.product_id === 'string' ? { id: entry.product_id } : entry));

  async function entitlementProductIds(entitlement: RcItem) {
    const inline = productsOf(entitlement).map((product) => String(product.id));
    if (inline.length) return inline;
    return (await rcList(`/entitlements/${encodeURIComponent(String(entitlement.id))}/products?limit=100`)).map((product) => String(product.id));
  }

  /** What a package already sells in this app instead of this product (empty: nothing in the way). */
  function packageHolders(state: Awaited<ReturnType<typeof revenueCat>>, packageKey: string, productId: string) {
    const pack = state.packages.find((item) => item.lookup_key === packageKey);
    if (!pack) return { pack, others: [] as RcItem[] };
    const others = productsOf(pack)
      .map((item) => state.appProducts.get(String(item.id)))
      .filter((item): item is RcItem => !!item && item.store_identifier !== productId);
    return { pack, others };
  }

  /** Checked before anything is written, so a package conflict never leaves a half-saved product. */
  async function checkPackage(bundleId: string, productId: string, changes: ProductChanges) {
    if (!changes.package || changes.replaceInPackage || !rc) return;
    const { others } = packageHolders(await revenueCat(bundleId, productId), changes.package, productId);
    if (others.length) {
      throw new ApiError(409, 'PACKAGE_TAKEN', `${changes.package} already sells ${others.map((item) => String(item.store_identifier ?? item.id)).join(', ')} in this app.`);
    }
  }

  async function writeRevenueCat(bundleId: string, found: Located, productId: string, referenceName: string, changes: ProductChanges) {
    if (!rc) throw new ApiError(503, 'STORAGE_NOT_CONFIGURED', 'RevenueCat isn’t set up on the server (REVENUECAT_SECRET_API_KEY)');
    const state = await revenueCat(bundleId, productId);
    if (!state.app) throw new ApiError(422, 'NOT_IN_REVENUECAT', 'This app isn’t set up in RevenueCat yet');
    let product = state.product;
    if (!product) {
      product = (await rc.post('/products', {
        store_identifier: productId, app_id: state.app.id,
        type: found.kind === 'subscription' ? 'subscription' : 'non_consumable', display_name: referenceName,
      })) as RcItem;
    }
    const rcProductId = String(product.id);

    if (changes.entitlement) {
      const entitlement = state.entitlements.find((item) => item.lookup_key === changes.entitlement);
      if (!entitlement) throw new ApiError(422, 'INVALID_ENTITLEMENT', `RevenueCat has no ${changes.entitlement} entitlement`);
      if (!(await entitlementProductIds(entitlement)).includes(rcProductId)) {
        await rc.post(`/entitlements/${encodeURIComponent(String(entitlement.id))}/actions/attach_products`, { product_ids: [rcProductId] });
      }
    }

    if (changes.package) {
      if (!state.offering) throw new ApiError(422, 'NO_OFFERING', 'RevenueCat has no current offering');
      let { pack, others } = packageHolders(state, changes.package, productId);
      if (!pack) {
        pack = (await rc.post(`/offerings/${encodeURIComponent(String(state.offering.id))}/packages`, {
          lookup_key: changes.package, display_name: changes.package,
        })) as RcItem;
      }
      const packId = encodeURIComponent(String(pack.id));
      if (!productsOf(pack).some((item) => String(item.id) === rcProductId)) {
        if (others.length) {
          if (!changes.replaceInPackage) {
            throw new ApiError(409, 'PACKAGE_TAKEN', `${changes.package} already sells ${others.map((item) => String(item.store_identifier ?? item.id)).join(', ')} in this app.`);
          }
          await rc.post(`/packages/${packId}/actions/detach_products`, { product_ids: others.map((item) => String(item.id)) });
        }
        try {
          await rc.post(`/packages/${packId}/actions/attach_products`, { products: [{ product_id: rcProductId, eligibility_criteria: 'all' }] });
        } catch (error) {
          // Never leave the paywall's package empty: put back what it sold.
          if (others.length) {
            await rc.post(`/packages/${packId}/actions/attach_products`, {
              products: others.map((item) => ({ product_id: String(item.id), eligibility_criteria: 'all' })),
            }).catch(() => undefined);
          }
          throw error;
        }
      }
    }
  }

  // MARK: The editor

  async function editor(appStoreId: string, bundleId: string, productId: string): Promise<ProductEditor> {
    const found = await mustLocate(appStoreId, productId);
    const attributes = found.item.attributes ?? {};
    const subscription = found.kind === 'subscription';
    const [localization, group, price, availability, trial, screenshot, rcState, approvedElsewhere] = await Promise.all([
      readLocalization(subscription ? 'subscription' : 'purchase', found.id),
      found.kind === 'subscription' ? readLocalization('group', found.groupId) : Promise.resolve(null),
      readPrice(found),
      readAvailability(found),
      found.kind === 'subscription' ? readTrial(found.id) : Promise.resolve(null),
      readScreenshot(found),
      revenueCat(bundleId, productId).catch(() => undefined),
      anyApproved(appStoreId),
    ]);
    const rcProductId = rcState?.product ? String(rcState.product.id) : null;
    const packages = rcProductId ? (rcState?.packages ?? []).filter((pack) => productsOf(pack).some((item) => String(item.id) === rcProductId)).map((pack) => String(pack.lookup_key)) : [];
    const entitlements: string[] = [];
    if (rcProductId) {
      for (const entitlement of rcState?.entitlements ?? []) {
        if ((await entitlementProductIds(entitlement).catch((): string[] => [])).includes(rcProductId)) entitlements.push(String(entitlement.lookup_key));
      }
    }
    const screenshotDone = !!screenshot && ['COMPLETE', 'UPLOAD_COMPLETE'].includes(screenshot.state ?? '');

    const checklist = [
      ...(subscription ? [{ key: 'group_name', label: 'Subscription group display name', done: !!group?.name }] : []),
      { key: 'display_name', label: 'Display name', done: !!localization.name },
      { key: 'description', label: 'Description', done: !!localization.description },
      { key: 'price', label: 'Price', done: !!price },
      { key: 'availability', label: 'Sold in at least one country', done: availability.count > 0 },
      { key: 'review_screenshot', label: 'App Review screenshot', done: screenshotDone },
      { key: 'revenuecat_package', label: 'On the paywall (a RevenueCat package)', done: packages.length > 0 },
      { key: 'revenuecat_entitlement', label: 'Unlocks a plan (a RevenueCat entitlement)', done: entitlements.length > 0 },
    ];
    const notes: string[] = [];
    if (!approvedElsewhere) notes.push('This app has no approved in-app purchases yet, so its first ones go to App Review with the next app version: choose them on that version’s page in App Store Connect.');
    if (attributes.state === 'APPROVED') notes.push('It’s approved: changing its display name or description makes a new version that goes to App Review.');
    if (screenshot?.state === 'FAILED') notes.push('Apple couldn’t process the review screenshot. Upload it again.');
    if (!rc) notes.push('RevenueCat isn’t set up on the server, so its package and entitlement can’t be shown or changed here.');

    return {
      product: {
        kind: found.kind,
        productId,
        referenceName: text(attributes.name) ?? '',
        period: text(attributes.subscriptionPeriod),
        state: text(attributes.state),
        groupReferenceName: found.kind === 'subscription' ? found.groupName : null,
        groupDisplayName: group?.name ?? null,
        displayName: localization.name,
        description: localization.description,
        familySharable: attributes.familySharable === true,
        reviewNote: text(attributes.reviewNote),
        priceUSD: price,
        availableEverywhere: availability.everywhere,
        soldIn: availability.soldIn,
        territoryCount: availability.count,
        trial,
        reviewScreenshot: screenshot ? { fileName: screenshot.fileName, state: screenshot.state, url: screenshot.url } : null,
        revenueCat: { productId: rcProductId, packages, entitlements },
      },
      checklist,
      options: {
        packages: (rcState?.packages ?? []).map((pack) => String(pack.lookup_key)),
        entitlements: (rcState?.entitlements ?? []).map((entitlement) => String(entitlement.lookup_key)),
      },
      notes,
    };
  }

  async function anyApproved(appStoreId: string) {
    try {
      const groups = await asc.get<Doc>(`/v1/apps/${appStoreId}/subscriptionGroups?include=subscriptions&limit=50&limit[subscriptions]=50`);
      if ((groups.included ?? []).some((item) => item.type === 'subscriptions' && item.attributes?.state === 'APPROVED')) return true;
      return (await asc.all(`/v1/apps/${appStoreId}/inAppPurchasesV2?limit=200`)).some((item) => item.attributes?.state === 'APPROVED');
    } catch {
      return true;
    }
  }

  async function save(appStoreId: string, bundleId: string, productId: string, changes: ProductChanges, found?: Located) {
    found ??= await mustLocate(appStoreId, productId);
    const done: string[] = [];
    const warnings: string[] = [];
    // A package conflict is found before anything is written.
    await checkPackage(bundleId, productId, changes);
    const step = async (name: string, work: () => Promise<void>) => {
      try {
        await work();
        done.push(name);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw upstream(name, error, done);
      }
    };
    const subscription = found.kind === 'subscription';
    const attributes = found.item.attributes ?? {};

    if (changes.familySharable === false && attributes.familySharable === true) {
      throw new ApiError(422, 'FAMILY_SHARING_ON', 'Family Sharing can’t be turned off once it’s on (Apple’s rule)');
    }
    if (changes.trial !== undefined && !subscription) throw new ApiError(400, 'INVALID_REQUEST', 'Only subscriptions have free trials');
    if (changes.groupDisplayName !== undefined && !subscription) throw new ApiError(400, 'INVALID_REQUEST', 'Only subscriptions have a group');

    const basics: Record<string, unknown> = {};
    if (changes.referenceName !== undefined) basics.name = changes.referenceName;
    if (changes.reviewNote !== undefined) basics.reviewNote = changes.reviewNote;
    if (changes.familySharable === true && attributes.familySharable !== true) basics.familySharable = true;
    if (Object.keys(basics).length) {
      await step('name and review notes', () => asc.send('PATCH', subscription ? `/v1/subscriptions/${found.id}` : `/v2/inAppPurchases/${found.id}`, {
        data: { type: subscription ? 'subscriptions' : 'inAppPurchases', id: found.id, attributes: basics },
      }).then(() => undefined));
    }
    if (found.kind === 'subscription' && changes.groupDisplayName !== undefined) {
      const groupId = found.groupId;
      await step('group display name', () => writeLocalization('group', groupId, changes.groupDisplayName!, undefined));
    }
    if (changes.displayName !== undefined || changes.description !== undefined) {
      await step('display name and description', async () => {
        const current = await readLocalization(subscription ? 'subscription' : 'purchase', found.id);
        const name = changes.displayName ?? current.name;
        if (!name) throw new ApiError(400, 'INVALID_REQUEST', 'A display name is needed with the description');
        await writeLocalization(subscription ? 'subscription' : 'purchase', found.id, name, changes.description ?? current.description ?? undefined);
      });
    }
    let price = changes.priceUSD;
    let trial = changes.trial;
    if (changes.soldIn) {
      await step('where it’s sold', () => sellIn(found, changes.soldIn!));
      // New countries need the price (and trial) too.
      if (subscription) {
        price ??= (await readPrice(found)) ?? undefined;
        trial ??= (await readTrial(found.id)) ?? undefined;
      }
    }
    if (price !== undefined) await step('price', () => writePrice(found, price!));
    if (trial !== undefined) {
      await step('free trial', async () => { const warning = await writeTrial(found.id, trial!); if (warning) warnings.push(warning); });
    }
    if (changes.package !== undefined || changes.entitlement !== undefined) {
      await step('RevenueCat', () => writeRevenueCat(bundleId, found, productId, text(attributes.name) ?? productId, changes));
    }
    try {
      const result = await editor(appStoreId, bundleId, productId);
      return { ...result, notes: [...warnings, ...result.notes] };
    } catch {
      throw new ApiError(502, 'SAVED_BUT_UNREADABLE', 'Saved. Reading it back from App Store Connect failed; reopen it to see the result.');
    }
  }

  async function create(appStoreId: string, appName: string, bundleId: string, input: NewProduct) {
    if (await locate(appStoreId, input.productId)) {
      throw new ApiError(409, 'PRODUCT_EXISTS', `${input.productId} already exists in this app`);
    }
    await checkPackage(bundleId, input.productId, input.changes);
    let created: Item | undefined;
    try {
      if (input.kind === 'subscription') {
        if (!input.period) throw new ApiError(400, 'INVALID_REQUEST', 'A subscription needs its period');
        // One subscription group per app (its own plan and Hearth+).
        let group = list(await asc.get<Doc>(`/v1/apps/${appStoreId}/subscriptionGroups?limit=50`))[0];
        if (!group) {
          group = list(await asc.send<Doc>('POST', '/v1/subscriptionGroups', {
            data: { type: 'subscriptionGroups', attributes: { referenceName: appName }, relationships: { app: { data: { type: 'apps', id: appStoreId } } } },
          }))[0];
        }
        created = list(await asc.send<Doc>('POST', '/v1/subscriptions', {
          data: {
            type: 'subscriptions',
            attributes: { name: input.referenceName, productId: input.productId, subscriptionPeriod: input.period, ...(input.changes.familySharable ? { familySharable: true } : {}) },
            relationships: { group: { data: { type: 'subscriptionGroups', id: group!.id } } },
          },
        }))[0];
        if (created) {
          const found: Located = { kind: 'subscription', id: created.id, item: created, groupId: group!.id, groupName: text(group!.attributes?.referenceName) ?? appName };
          const { familySharable: _family, ...rest } = input.changes;
          // The group is shared with the app's other plans: an existing display name is kept.
          if (rest.groupDisplayName && (await readLocalization('group', group!.id).catch(() => ({ name: null }))).name) delete rest.groupDisplayName;
          return save(appStoreId, bundleId, input.productId, rest, found);
        }
      } else {
        created = list(await asc.send<Doc>('POST', '/v2/inAppPurchases', {
          data: {
            type: 'inAppPurchases',
            attributes: { name: input.referenceName, productId: input.productId, inAppPurchaseType: 'NON_CONSUMABLE', ...(input.changes.familySharable ? { familySharable: true } : {}) },
            relationships: { app: { data: { type: 'apps', id: appStoreId } } },
          },
        }))[0];
        if (created) {
          const { familySharable: _family, ...rest } = input.changes;
          return save(appStoreId, bundleId, input.productId, rest, { kind: 'non_consumable', id: created.id, item: created });
        }
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw upstream('Creating the product', error, []);
    }
    throw new ApiError(502, 'UPSTREAM_FAILED', 'App Store Connect didn’t return the new product');
  }

  async function reserveScreenshot(appStoreId: string, productId: string, fileName: string, fileSize: number) {
    const found = await mustLocate(appStoreId, productId);
    const paths = screenshotPaths(found);
    try {
      const existing = await readScreenshot(found);
      if (existing) await asc.send('DELETE', `${paths.base}/${existing.id}`);
      const reserved = list(await asc.send<Doc>('POST', paths.base, {
        data: { type: paths.type, attributes: { fileName, fileSize }, relationships: { [paths.parent]: { data: { type: paths.parentType, id: found.id } } } },
      }))[0];
      if (!reserved) throw new Error('no reservation came back');
      return { id: reserved.id, uploadOperations: (reserved.attributes?.uploadOperations as unknown[] | undefined) ?? [] };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw upstream('Reserving the screenshot (Apple allows one, so the old one is removed first; upload again)', error, []);
    }
  }

  async function commitScreenshot(appStoreId: string, bundleId: string, productId: string, id: string, checksum: string) {
    const found = await mustLocate(appStoreId, productId);
    const paths = screenshotPaths(found);
    try {
      await asc.send('PATCH', `${paths.base}/${id}`, { data: { type: paths.type, id, attributes: { uploaded: true, sourceFileChecksum: checksum } } });
    } catch (error) {
      throw upstream('Finishing the screenshot upload', error, []);
    }
    return editor(appStoreId, bundleId, productId);
  }

  return { editor, save, create, reserveScreenshot, commitScreenshot };
}

export type StoreProducts = ReturnType<typeof createStoreProducts>;

/** RevenueCat v2 GETs and POSTs for the project (the secret key needs project configuration read & write to change anything). */
export function revenueCatClient(get: RevenueCatGet | undefined, env: Record<string, string | undefined>, fetcher: typeof fetch = fetch): RevenueCatClient | undefined {
  const key = env.REVENUECAT_SECRET_API_KEY?.trim();
  let project = env.REVENUECAT_PROJECT_ID?.trim();
  if (!get || !key || !project) return undefined;
  if (/^[0-9a-f]{8}$/i.test(project)) project = `proj${project}`;
  const base = `${(env.REVENUECAT_API_BASE_URL?.trim() || 'https://api.revenuecat.com').replace(/\/$/, '')}/v2/projects/${encodeURIComponent(project)}`;
  return {
    get,
    async post(path, body) {
      const response = await fetcher(`${base}${path}`, {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const raw = await response.text();
      if (!response.ok) {
        let detail = raw.slice(0, 200);
        try { const parsed = JSON.parse(raw) as { message?: string }; if (parsed.message) detail = parsed.message; } catch { /* raw */ }
        const hint = response.status === 403 ? ' (the RevenueCat key needs Project configuration: Read & write)' : '';
        throw new Error(`RevenueCat POST ${path.split('?')[0]} answered ${response.status}: ${detail}${hint}`);
      }
      return raw ? JSON.parse(raw) : {};
    },
  };
}
