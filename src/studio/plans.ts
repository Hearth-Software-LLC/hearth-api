import { ApiError } from '../errors.js';
import { ENTITLEMENT_KEYS, normalizeEntitlementKey, subscriptionEntitlements, tierFromEntitlements } from '../services/subscriptions.js';
import type { EntitlementKey, EntitlementMap } from '../services/subscriptions.js';
import { fetchRevenueCatEntitlements, resetRevenueCatEntitlementCache } from '../services/revenuecat-entitlements.js';
import { supabaseAdmin } from '../services/supabase.js';

/**
 * Granting plans from Hearth Studio: the same thing Test Plans does with
 * scripts/set-entitlements.ts, on the server. RevenueCat is the source of truth (a promotional
 * entitlement is what the apps read); the account's `subscriptions` row is then rewritten from
 * RevenueCat the way the webhook does, so the server and household sharing see it at once.
 */

export type PlanState = {
  key: EntitlementKey;
  state: 'off' | 'granted' | 'bought';
  expiresAt: string | null;
  store: string | null;
  willRenew: boolean;
};

export type AccountSummary = {
  id: string;
  name: string;
  email: string | null;
  apple: boolean;
  role: 'organizer' | 'member' | 'solo';
  organizerName: string | null;
  householdSize: number;
  /** Active plans as the server has them: key → expiry (null: never). */
  plans: Record<string, string | null>;
};

export type AccountDetail = AccountSummary & {
  planStates: PlanState[];
  household: { organizerName: string; plans: Record<string, string | null> } | null;
};

export type PlansBackend = {
  search: (find: string) => Promise<AccountSummary[]>;
  detail: (accountId: string) => Promise<AccountDetail | undefined>;
  grant: (accountId: string, key: EntitlementKey, expiresAt: string | null) => Promise<void>;
  revoke: (accountId: string, key: EntitlementKey) => Promise<void>;
};

export function planKey(raw: string): EntitlementKey {
  const word = raw.trim().toLowerCase();
  const key = normalizeEntitlementKey(word.endsWith('_plus') ? word : `${word}_plus`);
  if (!key || !(ENTITLEMENT_KEYS as readonly string[]).includes(key)) {
    throw new ApiError(400, 'INVALID_PLAN', 'Use one of: hearth, bigtable, suffice, sated, caloma, hearken');
  }
  return key;
}

const NO_EXPIRY_MS = 253402300799000; // RevenueCat's "never"
const NEVER_YEAR = 9000;

function cleanExpiry(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).getUTCFullYear() >= NEVER_YEAR) return null;
  return new Date(ms).toISOString();
}

type AuthUser = {
  id: string; email?: string | null; is_anonymous?: boolean;
  user_metadata?: Record<string, unknown>; app_metadata?: Record<string, unknown>; identities?: Array<{ provider?: string }> | null;
};

const unavailable = (what: string) => new ApiError(503, 'PLANS_UNAVAILABLE', `Plans are unavailable right now (${what})`);

/** RevenueCat (v2 secret key) and Supabase (secret key), as the API's environment has them. */
export function createRevenueCatPlans(env: Record<string, string | undefined> = process.env, fetcher: typeof fetch = fetch): PlansBackend | undefined {
  const key = env.REVENUECAT_SECRET_API_KEY?.trim();
  let project = env.REVENUECAT_PROJECT_ID?.trim();
  if (!key || !project || !env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) return undefined;
  if (/^[0-9a-f]{8}$/i.test(project)) project = `proj${project}`;
  const base = (env.REVENUECAT_API_BASE_URL?.trim() || 'https://api.revenuecat.com').replace(/\/$/, '');

  async function rc(method: 'GET' | 'POST', path: string, body?: unknown) {
    try {
      return await fetcher(`${base}/v2/projects/${encodeURIComponent(project!)}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw unavailable('RevenueCat unreachable');
    }
  }

  async function failed(what: string, response: Response): Promise<never> {
    const text = await response.text().catch(() => '');
    let message = text.slice(0, 200);
    try { const parsed = JSON.parse(text) as { message?: string }; if (parsed.message) message = parsed.message; } catch { /* raw */ }
    throw new ApiError(502, 'UPSTREAM_FAILED', `RevenueCat ${what} failed (${response.status}): ${message}`);
  }

  type RcEntitlement = { id: string; lookupKey: string; key: EntitlementKey | null };
  let entitlementCache: { at: number; list: RcEntitlement[] } | undefined;
  async function entitlements(): Promise<RcEntitlement[]> {
    if (entitlementCache && Date.now() - entitlementCache.at < 10 * 60_000) return entitlementCache.list;
    const response = await rc('GET', '/entitlements?limit=100');
    if (!response.ok) await failed('listing entitlements', response);
    const body = await response.json() as { items?: Array<{ id?: string; lookup_key?: string }> };
    const list = (body.items ?? []).filter((item): item is { id: string; lookup_key: string } => !!item.id && !!item.lookup_key)
      .map((item) => ({ id: item.id, lookupKey: item.lookup_key, key: normalizeEntitlementKey(item.lookup_key) }));
    entitlementCache = { at: Date.now(), list };
    return list;
  }

  async function customerExists(id: string) {
    const response = await rc('GET', `/customers/${encodeURIComponent(id)}`);
    if (response.ok) return true;
    if (response.status !== 404) await failed('customer lookup', response);
    return false;
  }

  async function purchases(id: string) {
    const keyById = new Map((await entitlements()).map((entry) => [entry.id, entry.key]));
    const found: { key: EntitlementKey; store: string | null; willRenew: boolean }[] = [];
    for (const path of ['subscriptions', 'purchases']) {
      const response = await rc('GET', `/customers/${encodeURIComponent(id)}/${path}?limit=100`);
      if (response.status === 404) continue;
      if (!response.ok) await failed(`listing ${path}`, response);
      const body = await response.json() as { items?: Array<Record<string, unknown>> };
      for (const item of body.items ?? []) {
        const active = path === 'subscriptions' ? item.gives_access === true : item.status !== 'refunded';
        if (!active || item.store === 'promotional') continue;
        const list = item.entitlements as { items?: Array<{ id?: unknown }> } | Array<{ id?: unknown }> | undefined;
        for (const entry of Array.isArray(list) ? list : list?.items ?? []) {
          const entryKey = typeof entry.id === 'string' ? keyById.get(entry.id) : undefined;
          if (!entryKey || found.some((p) => p.key === entryKey)) continue;
          found.push({ key: entryKey, store: typeof item.store === 'string' ? item.store : null, willRenew: item.auto_renewal_status === 'will_renew' });
        }
      }
    }
    return found;
  }

  let usersCache: { at: number; users: AuthUser[] } | undefined;
  async function users(): Promise<AuthUser[]> {
    if (usersCache && Date.now() - usersCache.at < 60_000) return usersCache.users;
    const all: AuthUser[] = [];
    for (let page = 1; page < 50; page += 1) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw unavailable('accounts');
      all.push(...data.users as AuthUser[]);
      if (data.users.length < 200) break;
    }
    usersCache = { at: Date.now(), users: all.filter((user) => !user.is_anonymous) };
    return usersCache.users;
  }

  const apple = (user: AuthUser) => (user.identities ?? []).some((i) => i.provider === 'apple') || user.app_metadata?.provider === 'apple';
  const nameOf = (user: AuthUser, display: string | null | undefined) => {
    const meta = user.user_metadata ?? {};
    const found = [display, meta.full_name, meta.name, user.email].find((c): c is string => typeof c === 'string' && c.trim().length > 0);
    return found?.trim() ?? 'Unnamed account';
  };
  const stored = (row: unknown) => {
    const plans: Record<string, string | null> = {};
    for (const entry of subscriptionEntitlements(row as Parameters<typeof subscriptionEntitlements>[0])) plans[entry.id] = cleanExpiry(entry.expiresAt);
    return plans;
  };

  async function summaries(): Promise<AccountSummary[]> {
    const [all, profiles, subs, memberships] = await Promise.all([
      users(),
      supabaseAdmin.from('profiles').select('id, display_name'),
      supabaseAdmin.from('subscriptions').select('profile_id, tier, entitlements, expires_at'),
      supabaseAdmin.from('household_memberships').select('member_id, organizer_id'),
    ]);
    if (profiles.error || subs.error || memberships.error) throw unavailable('accounts');
    const profileById = new Map(((profiles.data ?? []) as Array<{ id: string; display_name: string | null }>).map((p) => [p.id, p]));
    const subById = new Map(((subs.data ?? []) as Array<{ profile_id: string }>).map((row) => [row.profile_id, row]));
    const links = ((memberships.data ?? []) as Array<{ member_id: string; organizer_id: string }>).filter((m) => m.member_id !== m.organizer_id);
    const organizerOf = new Map(links.map((m) => [m.member_id, m.organizer_id]));
    const count = new Map<string, number>();
    for (const m of links) count.set(m.organizer_id, (count.get(m.organizer_id) ?? 0) + 1);
    const names = new Map(all.map((user) => [user.id, nameOf(user, profileById.get(user.id)?.display_name)]));
    return all.map((user) => {
      const organizerId = organizerOf.get(user.id) ?? null;
      const members = count.get(user.id) ?? 0;
      const role: AccountSummary['role'] = organizerId ? 'member' : members > 0 ? 'organizer' : 'solo';
      return {
        id: user.id, name: names.get(user.id) ?? 'Unnamed account', email: user.email ?? null, apple: apple(user), role,
        organizerName: organizerId ? names.get(organizerId) ?? null : null,
        householdSize: role === 'organizer' ? members + 1 : role === 'member' ? (count.get(organizerId!) ?? 0) + 1 : 1,
        plans: stored(subById.get(user.id) ?? null),
      };
    });
  }

  /** The same write the RevenueCat webhook makes. */
  async function record(profileId: string, map: EntitlementMap) {
    const expiries = Object.values(map);
    const expiresAt = expiries.length === 0 || expiries.includes(null)
      ? null : expiries.reduce((a, b) => (Date.parse(b as string) > Date.parse(a as string) ? b : a));
    const { error } = await supabaseAdmin.from('subscriptions').upsert({
      profile_id: profileId, tier: tierFromEntitlements(map), entitlements: map, revenuecat_user_id: profileId,
      expires_at: expiresAt, updated_at: new Date().toISOString(),
    }, { onConflict: 'profile_id' });
    if (error) throw unavailable('saving the plan');
    usersCache = undefined;
  }

  async function refreshServer(profileId: string) {
    resetRevenueCatEntitlementCache();
    await record(profileId, await fetchRevenueCatEntitlements(profileId));
  }

  return {
    async search(find) {
      const needle = find.trim().toLowerCase();
      return (await summaries())
        .filter((a) => !needle || [a.name, a.email ?? '', a.id].some((field) => field.toLowerCase().includes(needle)))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 100);
    },

    async detail(accountId) {
      const summary = (await summaries()).find((a) => a.id === accountId);
      if (!summary) return undefined;
      const exists = await customerExists(accountId);
      const active = exists ? await fetchRevenueCatEntitlements(accountId) : {};
      const bought = exists ? await purchases(accountId) : [];
      const planStates: PlanState[] = ENTITLEMENT_KEYS.map((key) => {
        if (!(key in active)) return { key, state: 'off', expiresAt: null, store: null, willRenew: false };
        const purchase = bought.find((p) => p.key === key);
        return { key, state: purchase ? 'bought' : 'granted', expiresAt: cleanExpiry(active[key]), store: purchase?.store ?? null, willRenew: purchase?.willRenew ?? false };
      });
      let household: AccountDetail['household'] = null;
      if (summary.role === 'member' && summary.organizerName) {
        const all = await summaries();
        const organizer = all.find((a) => a.name === summary.organizerName && a.role === 'organizer');
        if (organizer) household = { organizerName: organizer.name, plans: organizer.plans };
      }
      return { ...summary, planStates, household };
    },

    async grant(accountId, planKeyValue, expiresAt) {
      if (!await customerExists(accountId)) {
        const create = await rc('POST', '/customers', { id: accountId });
        if (!create.ok && create.status !== 409) await failed('customer create', create);
      }
      const list = await entitlements();
      const target = list.find((e) => e.lookupKey === planKeyValue) ?? list.find((e) => e.key === planKeyValue);
      if (!target) throw new ApiError(502, 'UPSTREAM_FAILED', `RevenueCat has no entitlement for ${planKeyValue}`);
      const response = await rc('POST', `/customers/${encodeURIComponent(accountId)}/actions/grant_entitlement`, {
        entitlement_id: target.id, expires_at: expiresAt ? Date.parse(expiresAt) : NO_EXPIRY_MS,
      });
      if (!response.ok && response.status !== 409) await failed(`granting ${planKeyValue}`, response);
      await refreshServer(accountId);
    },

    async revoke(accountId, planKeyValue) {
      const bought = await purchases(accountId).catch(() => []);
      if (bought.some((p) => p.key === planKeyValue)) {
        throw new ApiError(409, 'PLAN_BOUGHT', 'This plan was bought, so it can’t be removed here. The buyer cancels it in their App Store subscriptions.');
      }
      for (const target of (await entitlements()).filter((e) => e.key === planKeyValue)) {
        const response = await rc('POST', `/customers/${encodeURIComponent(accountId)}/actions/revoke_granted_entitlement`, { entitlement_id: target.id });
        if (!response.ok && ![400, 404, 409, 422].includes(response.status)) await failed(`removing ${planKeyValue}`, response);
      }
      await refreshServer(accountId);
    },
  };
}
