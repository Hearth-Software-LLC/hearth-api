import { normalizeEntitlementKey } from '../services/subscriptions.js';
import type { AscClient } from '../affiliates/asc.js';
import type { StudioApp } from './github.js';

/**
 * Store › Monetization in Hearth Studio, read-only: every app's subscriptions and in-app
 * purchases as App Store Connect has them (US price, trial, review state) joined with how
 * RevenueCat sells them (offering packages, entitlements).
 *
 * Nothing here is shown to customers. The apps always take prices from StoreKit.
 * Each source is optional, and a failed call is reported in `problems` rather than failing the page.
 */

export type Money = { amount: string; currency: string; territory: string };

export type MonetizedProduct = {
  productId: string;
  name: string;
  kind: 'subscription' | 'non_consumable' | 'consumable' | 'non_renewing';
  /** The subscription group's name. */
  group: string | null;
  /** App Store Connect's period: ONE_WEEK, ONE_MONTH, TWO_MONTHS, THREE_MONTHS, SIX_MONTHS, ONE_YEAR. */
  period: string | null;
  /** App Store Connect's state, e.g. APPROVED, READY_TO_SUBMIT, WAITING_FOR_REVIEW, MISSING_METADATA. */
  state: string | null;
  familySharable: boolean | null;
  /** The US price today (the base territory's when there's no US price). */
  price: Money | null;
  /** A scheduled price change. */
  nextPrice: (Money & { startDate: string }) | null;
  /** The current US introductory offer: FREE_TRIAL, PAY_AS_YOU_GO or PAY_UP_FRONT. */
  trial: { mode: string; duration: string; periods: number } | null;
  packages: { offering: string; package: string; current: boolean }[];
  entitlements: string[];
  inAppStoreConnect: boolean;
  inRevenueCat: boolean;
};

export type MonetizedApp = {
  key: string;
  name: string;
  bundleId: string;
  appStoreId: string | null;
  products: MonetizedProduct[];
  problems: string[];
};

export type MonetizationOverview = {
  apps: MonetizedApp[];
  sources: { appStoreConnect: SourceState; revenueCat: SourceState };
  problems: string[];
  fetchedAt: string;
};

type SourceState = 'ok' | 'not_configured' | 'failed';

export type MonetizationBackend = { overview: (refresh?: boolean) => Promise<MonetizationOverview> };

type Item = { id: string; type?: string; attributes?: Record<string, unknown>; relationships?: Record<string, { data?: { id: string; type?: string } | { id: string; type?: string }[] | null }> };
type Doc = { data: Item[] | Item; included?: Item[]; links?: { next?: string } };

export type RevenueCatGet = (path: string) => Promise<unknown>;

const text = (value: unknown) => (typeof value === 'string' ? value : null);
const relation = (item: Item, name: string) => {
  const data = item.relationships?.[name]?.data;
  return Array.isArray(data) ? data.map((entry) => entry.id) : data ? [data.id] : [];
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function pool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  }));
  return results;
}

const IAP_KINDS: Record<string, MonetizedProduct['kind']> = {
  NON_CONSUMABLE: 'non_consumable', CONSUMABLE: 'consumable', NON_RENEWING_SUBSCRIPTION: 'non_renewing',
};

/** Today's price and any scheduled change, from price records with their price points. */
function pickPrices(doc: Doc, territoryOf: (item: Item) => string | null, today: string) {
  const points = new Map((doc.included ?? []).filter((item) => item.type?.endsWith('PricePoints')).map((item) => [item.id, item]));
  const currencies = new Map((doc.included ?? []).filter((item) => item.type === 'territories').map((item) => [item.id, text(item.attributes?.currency)]));
  const rows = (Array.isArray(doc.data) ? doc.data : [doc.data]).map((item) => {
    const point = points.get(relation(item, 'subscriptionPricePoint')[0] ?? relation(item, 'inAppPurchasePricePoint')[0] ?? '');
    const territory = territoryOf(item);
    return {
      start: text(item.attributes?.startDate),
      preserved: item.attributes?.preserved === true,
      amount: text(point?.attributes?.customerPrice),
      territory,
      currency: (territory && currencies.get(territory)) || (territory === 'USA' ? 'USD' : null),
    };
  }).filter((row) => row.amount && !row.preserved);
  const us = rows.filter((row) => row.territory === 'USA' || row.territory === null);
  const pool = us.length ? us : rows;
  const money = (row: (typeof rows)[number]): Money => ({ amount: row.amount!, currency: row.currency ?? 'USD', territory: row.territory ?? 'USA' });
  const current = pool.filter((row) => !row.start || row.start <= today).sort((a, b) => (a.start ?? '').localeCompare(b.start ?? '')).at(-1);
  const upcoming = pool.filter((row) => row.start && row.start > today).sort((a, b) => a.start!.localeCompare(b.start!))[0];
  return {
    price: current ? money(current) : null,
    nextPrice: upcoming ? { ...money(upcoming), startDate: upcoming.start! } : null,
  };
}

type AscApp = { id: string; name: string; bundleId: string };

async function readAppStoreConnect(client: AscClient, app: AscApp, problems: string[], today: string) {
  const products: MonetizedProduct[] = [];
  const blank = (productId: string, name: string, kind: MonetizedProduct['kind']): MonetizedProduct => ({
    productId, name, kind, group: null, period: null, state: null, familySharable: null, price: null, nextPrice: null, trial: null,
    packages: [], entitlements: [], inAppStoreConnect: true, inRevenueCat: false,
  });

  // Subscriptions, by group.
  const subscriptions: { item: Item; group: string }[] = [];
  try {
    let next: string | undefined = `/v1/apps/${app.id}/subscriptionGroups?include=subscriptions&limit=50&limit[subscriptions]=50`;
    while (next) {
      const page: Doc = await client.get<Doc>(next);
      const included = new Map((page.included ?? []).filter((item) => item.type === 'subscriptions').map((item) => [item.id, item]));
      for (const group of Array.isArray(page.data) ? page.data : [page.data]) {
        const name = text(group.attributes?.referenceName) ?? 'Subscriptions';
        for (const id of relation(group, 'subscriptions')) {
          const item = included.get(id);
          if (item) subscriptions.push({ item, group: name });
        }
      }
      next = page.links?.next;
    }
  } catch (error) {
    problems.push(`Subscriptions: ${message(error)}`);
  }

  await pool(subscriptions, 4, async ({ item, group }) => {
    const product = blank(text(item.attributes?.productId) ?? item.id, text(item.attributes?.name) ?? '', 'subscription');
    product.group = group;
    product.period = text(item.attributes?.subscriptionPeriod);
    product.state = text(item.attributes?.state);
    product.familySharable = typeof item.attributes?.familySharable === 'boolean' ? item.attributes.familySharable : null;
    try {
      const prices = await client.get<Doc>(`/v1/subscriptions/${item.id}/prices?filter[territory]=USA&include=subscriptionPricePoint,territory&limit=50`);
      Object.assign(product, pickPrices(prices, (row) => relation(row, 'territory')[0] ?? 'USA', today));
    } catch (error) {
      problems.push(`${product.productId} price: ${message(error)}`);
    }
    try {
      const offers = await client.get<Doc>(`/v1/subscriptions/${item.id}/introductoryOffers?include=territory&limit=200`);
      const live = (Array.isArray(offers.data) ? offers.data : [offers.data]).filter((offer) => {
        const territory = relation(offer, 'territory')[0];
        const start = text(offer.attributes?.startDate);
        const end = text(offer.attributes?.endDate);
        return (!territory || territory === 'USA') && (!start || start <= today) && (!end || end >= today);
      })[0];
      if (live) {
        product.trial = {
          mode: text(live.attributes?.offerMode) ?? 'FREE_TRIAL',
          duration: text(live.attributes?.duration) ?? '',
          periods: typeof live.attributes?.numberOfPeriods === 'number' ? live.attributes.numberOfPeriods : 1,
        };
      }
    } catch (error) {
      problems.push(`${product.productId} trial: ${message(error)}`);
    }
    products.push(product);
  });

  // One-time purchases (Hearth+ Lifetime, Hearken's tips).
  let purchases: Item[] = [];
  try {
    purchases = await client.all(`/v1/apps/${app.id}/inAppPurchasesV2?limit=200`);
  } catch (error) {
    problems.push(`In-app purchases: ${message(error)}`);
  }
  await pool(purchases, 4, async (item) => {
    const product = blank(text(item.attributes?.productId) ?? item.id, text(item.attributes?.name) ?? '', IAP_KINDS[text(item.attributes?.inAppPurchaseType) ?? ''] ?? 'non_consumable');
    product.state = text(item.attributes?.state);
    product.familySharable = typeof item.attributes?.familySharable === 'boolean' ? item.attributes.familySharable : null;
    try {
      const prices = await client.get<Doc>(`/v1/inAppPurchasePriceSchedules/${item.id}/manualPrices?include=inAppPurchasePricePoint,territory&limit=50`);
      Object.assign(product, pickPrices(prices, (row) => relation(row, 'territory')[0] ?? null, today));
    } catch (error) {
      problems.push(`${product.productId} price: ${message(error)}`);
    }
    products.push(product);
  });

  return products;
}

type RcPackageRow = { offering: string; package: string; current: boolean; storeId: string; appId: string | null };
type RevenueCatData = {
  apps: { id: string; bundleId: string | null }[];
  packages: RcPackageRow[];
  /** store id → entitlement keys (and the RevenueCat app the product belongs to). */
  entitlements: { storeId: string; appId: string | null; key: string }[];
};

type RcList = { items?: Record<string, unknown>[]; next_page?: string | null };

async function readRevenueCat(get: RevenueCatGet): Promise<RevenueCatData> {
  const list = async (path: string) => {
    const items: Record<string, unknown>[] = [];
    let next: string | null | undefined = path;
    let guard = 0;
    while (next && guard++ < 20) {
      const page = (await get(next)) as RcList;
      items.push(...(page.items ?? []));
      next = page.next_page;
    }
    return items;
  };
  const record = (value: unknown) => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});

  const apps = (await list('/apps?limit=100')).map((app) => ({
    id: String(app.id), bundleId: text(record(app.app_store).bundle_id),
  }));
  const products = new Map((await list('/products?limit=200')).map((product) => [String(product.id), {
    storeId: text(product.store_identifier) ?? '', appId: text(product.app_id),
  }]));
  const productOf = (entry: Record<string, unknown>) => {
    const inline = record(entry.product);
    const id = text(inline.id) ?? text(entry.product_id) ?? text(entry.id);
    const known = id ? products.get(id) : undefined;
    return {
      storeId: text(inline.store_identifier) ?? known?.storeId ?? '',
      appId: text(inline.app_id) ?? known?.appId ?? null,
    };
  };

  const packages: RcPackageRow[] = [];
  for (const offering of await list('/offerings?limit=100')) {
    const lookup = text(offering.lookup_key) ?? String(offering.id);
    for (const pack of await list(`/offerings/${encodeURIComponent(String(offering.id))}/packages?limit=100&expand=items.product`)) {
      const rows = (record(pack.products).items as Record<string, unknown>[] | undefined) ?? [];
      for (const row of rows) {
        const product = productOf(row);
        if (product.storeId) {
          packages.push({ offering: lookup, package: text(pack.lookup_key) ?? String(pack.id), current: offering.is_current === true, ...product });
        }
      }
    }
  }

  const entitlements: RevenueCatData['entitlements'] = [];
  for (const entitlement of await list('/entitlements?limit=100')) {
    const key = text(entitlement.lookup_key) ?? '';
    const normalized = normalizeEntitlementKey(key) ?? key;
    for (const product of await list(`/entitlements/${encodeURIComponent(String(entitlement.id))}/products?limit=100`)) {
      const storeId = text(product.store_identifier);
      if (storeId) entitlements.push({ storeId, appId: text(product.app_id), key: normalized });
    }
  }
  return { apps, packages, entitlements };
}

const ORDER: Record<string, number> = { subscription: 0, non_consumable: 1, non_renewing: 2, consumable: 3 };
const PERIOD_ORDER = ['ONE_WEEK', 'ONE_MONTH', 'TWO_MONTHS', 'THREE_MONTHS', 'SIX_MONTHS', 'ONE_YEAR'];

export function createMonetization(options: {
  asc?: AscClient;
  revenueCat?: RevenueCatGet;
  /** Hearth Studio's apps (from GitHub), to name and pick the apps; without them, every App Store app but Studio itself. */
  apps?: () => Promise<StudioApp[]>;
  now?: () => Date;
  cacheMs?: number;
}): MonetizationBackend {
  const now = options.now ?? (() => new Date());
  const cacheMs = options.cacheMs ?? 10 * 60_000;
  let cache: { at: number; value: MonetizationOverview } | undefined;
  let running: Promise<MonetizationOverview> | undefined;

  async function build(): Promise<MonetizationOverview> {
    const today = now().toISOString().slice(0, 10);
    const problems: string[] = [];
    const sources: MonetizationOverview['sources'] = {
      appStoreConnect: options.asc ? 'ok' : 'not_configured',
      revenueCat: options.revenueCat ? 'ok' : 'not_configured',
    };

    let studioApps: StudioApp[] = [];
    if (options.apps) {
      try { studioApps = await options.apps(); } catch (error) { problems.push(`Apps from GitHub: ${message(error)}`); }
    }

    let rc: RevenueCatData | undefined;
    const rcRead = options.revenueCat
      ? readRevenueCat(options.revenueCat).then((data) => { rc = data; }, (error) => { sources.revenueCat = 'failed'; problems.push(`RevenueCat: ${message(error)}`); })
      : Promise.resolve();

    let ascApps: AscApp[] = [];
    if (options.asc) {
      try {
        ascApps = (await options.asc.all('/v1/apps?limit=200&fields[apps]=name,bundleId')).map((item) => ({
          id: item.id, name: text(item.attributes?.name) ?? item.id, bundleId: text(item.attributes?.bundleId) ?? '',
        }));
      } catch (error) {
        sources.appStoreConnect = 'failed';
        problems.push(`App Store Connect: ${message(error)}`);
      }
    }

    // Which apps: Studio's (matched by bundle id or App Store id), else every App Store app but Studio.
    const byBundle = new Map(studioApps.filter((app) => app.bundleId).map((app) => [app.bundleId!, app]));
    const byStoreId = new Map(studioApps.filter((app) => app.appStoreId).map((app) => [app.appStoreId!, app]));
    const picked = ascApps.filter((app) => (studioApps.length ? byBundle.has(app.bundleId) || byStoreId.has(app.id) : !app.bundleId.includes('hearthstudio')));
    const keyFor = (app: AscApp) => (byBundle.get(app.bundleId) ?? byStoreId.get(app.id))?.key
      ?? app.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

    const apps: MonetizedApp[] = await pool(picked, 3, async (app) => {
      const appProblems: string[] = [];
      const products = await readAppStoreConnect(options.asc!, app, appProblems, today);
      return { key: keyFor(app), name: (byBundle.get(app.bundleId) ?? byStoreId.get(app.id))?.name ?? app.name, bundleId: app.bundleId, appStoreId: app.id, products, problems: appProblems };
    });

    // Studio apps App Store Connect didn't list (not configured, or not on the App Store yet).
    if (!options.asc || sources.appStoreConnect === 'failed') {
      for (const app of studioApps) {
        if (app.bundleId && !apps.some((entry) => entry.bundleId === app.bundleId)) {
          apps.push({ key: app.key, name: app.name, bundleId: app.bundleId, appStoreId: app.appStoreId ?? null, products: [], problems: [] });
        }
      }
    }

    await rcRead;
    if (rc) {
      const data = rc;
      for (const app of apps) {
        const rcApp = data.apps.find((entry) => entry.bundleId === app.bundleId);
        const mine = <T extends { appId: string | null }>(rows: T[]) => rows.filter((row) => !rcApp || !row.appId || row.appId === rcApp.id);
        const packages = mine(data.packages);
        const entitlements = mine(data.entitlements);
        if (!rcApp) app.problems.push('Not set up in RevenueCat.');
        for (const product of app.products) {
          product.packages = packages.filter((row) => row.storeId === product.productId).map(({ offering, package: name, current }) => ({ offering, package: name, current }));
          product.entitlements = [...new Set(entitlements.filter((row) => row.storeId === product.productId).map((row) => row.key))].sort();
          product.inRevenueCat = product.packages.length > 0 || product.entitlements.length > 0;
          if (product.kind === 'subscription' && !product.inRevenueCat && rcApp) app.problems.push(`${product.productId} isn’t in any RevenueCat offering or entitlement.`);
        }
        if (rcApp) {
          const onlyInRc = new Set(packages.filter((row) => row.appId === rcApp.id && !app.products.some((product) => product.productId === row.storeId)).map((row) => row.storeId));
          for (const storeId of onlyInRc) {
            app.problems.push(`${storeId} is in RevenueCat but not App Store Connect.`);
            app.products.push({
              productId: storeId, name: '', kind: 'subscription', group: null, period: null, state: null, familySharable: null,
              price: null, nextPrice: null, trial: null,
              packages: packages.filter((row) => row.storeId === storeId).map(({ offering, package: name, current }) => ({ offering, package: name, current })),
              entitlements: [...new Set(entitlements.filter((row) => row.storeId === storeId).map((row) => row.key))].sort(),
              inAppStoreConnect: false, inRevenueCat: true,
            });
          }
        }
      }
    }

    for (const app of apps) {
      app.products.sort((a, b) => {
        const hearth = Number(a.productId.includes('.hearth') || a.entitlements.includes('hearth_plus')) - Number(b.productId.includes('.hearth') || b.entitlements.includes('hearth_plus'));
        return hearth || (ORDER[a.kind]! - ORDER[b.kind]!) || (PERIOD_ORDER.indexOf(a.period ?? '') - PERIOD_ORDER.indexOf(b.period ?? '')) || a.productId.localeCompare(b.productId);
      });
    }
    apps.sort((a, b) => a.name.localeCompare(b.name));
    return { apps, sources, problems, fetchedAt: now().toISOString() };
  }

  return {
    async overview(refresh = false) {
      if (!refresh && cache && now().getTime() - cache.at < cacheMs) return cache.value;
      running ??= build().finally(() => { running = undefined; });
      const value = await running;
      cache = { at: now().getTime(), value };
      return value;
    },
  };
}

/** A GET against RevenueCat's v2 API for the project (paths start at /apps, /offerings…; `next_page` links work too). */
export function revenueCatReader(env: Record<string, string | undefined>, fetcher: typeof fetch = fetch): RevenueCatGet | undefined {
  const key = env.REVENUECAT_SECRET_API_KEY?.trim();
  let project = env.REVENUECAT_PROJECT_ID?.trim();
  if (!key || !project) return undefined;
  if (/^[0-9a-f]{8}$/i.test(project)) project = `proj${project}`;
  const base = (env.REVENUECAT_API_BASE_URL?.trim() || 'https://api.revenuecat.com').replace(/\/$/, '');
  const prefix = `/v2/projects/${encodeURIComponent(project)}`;
  return async (path) => {
    const url = path.startsWith('http') ? path : path.startsWith('/v2/') ? `${base}${path}` : `${base}${prefix}${path}`;
    const response = await fetcher(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      let detail = body.slice(0, 160);
      try { const parsed = JSON.parse(body) as { message?: string }; if (parsed.message) detail = parsed.message; } catch { /* raw */ }
      throw new Error(`GET ${path.split('?')[0]} answered ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return response.json();
  };
}
