import { supabaseAdmin } from "./supabase.js";

/**
 * Hearth entitlements (RevenueCat lookup keys). One RevenueCat project sells every app's own plan
 * plus Hearth+, which unlocks all of them. `subscriptions.entitlements` keeps the map
 * lookup key -> ISO expiry (null = never expires), refreshed by the RevenueCat webhook.
 */
export const ENTITLEMENT_KEYS = [
  "hearth_plus",
  "bigtable_plus",
  "suffice_plus",
  "sated_plus",
  "caloma_plus",
  "hearken_plus",
] as const;
export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];

export const HEARTH_APPS = ["bigtable", "suffice", "sated", "caloma", "hearken"] as const;
export type HearthApp = (typeof HEARTH_APPS)[number];

/** Each app's own plan. `hearth_plus` unlocks every app as well. */
export const APP_ENTITLEMENT: Record<HearthApp, EntitlementKey> = {
  bigtable: "bigtable_plus",
  suffice: "suffice_plus",
  sated: "sated_plus",
  caloma: "caloma_plus",
  hearken: "hearken_plus",
};

/** What each app's plan is called, for error messages. */
export const APP_PLAN_NAME: Record<HearthApp, string> = {
  bigtable: "BigTable Plus",
  suffice: "Suffice Plus",
  sated: "Sated Plus",
  caloma: "Caloma Plus",
  hearken: "Hearken Plus",
};

/** Lookup key -> ISO expiry, or null for never. */
export type EntitlementMap = Record<string, string | null>;
export type ActiveEntitlement = { id: EntitlementKey; expiresAt: string | null };
export type EntitlementSourceKind = "own" | "household";
export type EffectiveEntitlement = ActiveEntitlement & { source: EntitlementSourceKind };

const KEY_BY_LOWER = new Map<string, EntitlementKey>(ENTITLEMENT_KEYS.map((key) => [key.toLowerCase(), key]));

/** Old SKU and entitlement names from earlier BigTable pricing, kept so those subscribers stay Pro. */
export function isLegacyBigTableName(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes("pro") || lower.includes("pantry") || lower.includes("family") || lower.includes("basic");
}

/**
 * A RevenueCat entitlement identifier as one of ours. Known keys match case-insensitively;
 * legacy BigTable names (`bigtable_plus`, pro, pantry, family, basic) count as `bigtable_plus`; anything else is
 * not ours and is ignored.
 */
export function normalizeEntitlementKey(raw: string): EntitlementKey | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const known = KEY_BY_LOWER.get(trimmed.toLowerCase()) ?? KEY_BY_LOWER.get(trimmed.toLowerCase().replace(/[_-]+/g, " "));
  if (known) return known;
  return isLegacyBigTableName(trimmed) ? "bigtable_plus" : null;
}

function validExpiry(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

/** The stored jsonb, cleaned: known keys only, with valid expiries. */
export function parseEntitlementMap(value: unknown): EntitlementMap {
  const map: EntitlementMap = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return map;
  for (const [raw, expiry] of Object.entries(value as Record<string, unknown>)) {
    const key = normalizeEntitlementKey(raw);
    if (!key || !validExpiry(expiry)) continue;
    map[key] = laterExpiry(map[key], expiry);
  }
  return map;
}

/** The later of two expiries; null (never) beats any date. `undefined` means not set. */
export function laterExpiry(current: string | null | undefined, next: string | null): string | null {
  if (current === undefined) return next;
  if (current === null || next === null) return null;
  return Date.parse(next) > Date.parse(current) ? next : current;
}

/** Entitlements in the map that haven't expired, in ENTITLEMENT_KEYS order. */
export function activeEntitlements(map: EntitlementMap, now: Date = new Date()): ActiveEntitlement[] {
  const cleaned = parseEntitlementMap(map);
  return ENTITLEMENT_KEYS.flatMap((id) => {
    if (!(id in cleaned)) return [];
    const expiresAt = cleaned[id] ?? null;
    if (expiresAt !== null && Date.parse(expiresAt) <= now.getTime()) return [];
    return [{ id, expiresAt }];
  });
}

/** `tier` as BigTable's AI limits read it: pro while BigTable Plus or Hearth+ is active. */
export function tierFromEntitlements(map: EntitlementMap, now: Date = new Date()): "free" | "pro" {
  return activeEntitlements(map, now).some((entry) => entry.id === "bigtable_plus" || entry.id === "hearth_plus")
    ? "pro"
    : "free";
}

/** True when the app's own entitlement or Hearth+ is among these. */
export function hasAppAccess(entitlements: ReadonlyArray<{ id: string }>, app: HearthApp): boolean {
  const own = APP_ENTITLEMENT[app];
  return entitlements.some((entry) => entry.id === own || entry.id === "hearth_plus");
}

export function appAccess(entitlements: ReadonlyArray<{ id: string }>): Record<HearthApp, boolean> {
  return Object.fromEntries(HEARTH_APPS.map((app) => [app, hasAppAccess(entitlements, app)])) as Record<HearthApp, boolean>;
}

// MARK: Webhook fallback

/** Event types after which the event's entitlements are active until the event's expiry. */
const GRANTING_EVENTS = new Set([
  "INITIAL_PURCHASE",
  "NON_RENEWING_PURCHASE",
  "RENEWAL",
  "UNCANCELLATION",
  "PRODUCT_CHANGE",
]);

/** The entitlements a webhook event names, as our keys. Legacy product IDs count when it names none. */
export function eventEntitlementKeys(event: { entitlement_ids: string[]; product_id: string | null }): EntitlementKey[] {
  const keys = new Set<EntitlementKey>();
  for (const raw of event.entitlement_ids) {
    const key = normalizeEntitlementKey(raw);
    if (key) keys.add(key);
  }
  if (keys.size === 0 && event.product_id && isLegacyBigTableName(event.product_id)) {
    keys.add("bigtable_plus");
  }
  return [...keys];
}

/**
 * Used when RevenueCat's API can't be reached: apply one webhook event to the stored map.
 * Purchases, renewals, uncancellations and product changes set each of the event's entitlements
 * to the event's expiry; EXPIRATION removes them; other events (cancellation, billing issue,
 * transfer...) leave the map alone, since RevenueCat keeps the entitlement until it expires.
 */
export function applyEventToEntitlements(
  map: EntitlementMap,
  event: { type: string; entitlement_ids: string[]; product_id: string | null; expires_at: string | null }
): EntitlementMap {
  const next: EntitlementMap = { ...parseEntitlementMap(map) };
  const type = event.type.toUpperCase();
  const keys = eventEntitlementKeys(event);
  if (GRANTING_EVENTS.has(type)) {
    for (const key of keys) next[key] = event.expires_at;
  } else if (type === "EXPIRATION") {
    for (const key of keys) delete next[key];
  }
  return next;
}

// MARK: Effective entitlements

type SubscriptionRow = { tier?: unknown; entitlements?: unknown; expires_at?: unknown };

function legacyTierIsPro(tier: unknown): boolean {
  return tier === "pro" || tier === "basic" || tier === "family" || tier === "pantry";
}

/**
 * A subscription row's active entitlements. Rows from before `entitlements` existed (or not yet
 * refreshed by a webhook) still carry a paid `tier`; that counts as BigTable Plus.
 */
export function subscriptionEntitlements(row: SubscriptionRow | null | undefined, now: Date = new Date()): ActiveEntitlement[] {
  if (!row) return [];
  const active = activeEntitlements(parseEntitlementMap(row.entitlements), now);
  if (legacyTierIsPro(row.tier) && !active.some((entry) => entry.id === "bigtable_plus" || entry.id === "hearth_plus")) {
    const expiry = typeof row.expires_at === "string" && Date.parse(row.expires_at) > now.getTime() ? row.expires_at : null;
    active.unshift({ id: "bigtable_plus", expiresAt: expiry });
    active.sort((a, b) => ENTITLEMENT_KEYS.indexOf(a.id) - ENTITLEMENT_KEYS.indexOf(b.id));
  }
  return active;
}

/** True when the row grants BigTable's Pro tier: a paid tier, BigTable Plus or Hearth+. */
export function subscriptionGrantsPro(row: SubscriptionRow | null | undefined, now: Date = new Date()): boolean {
  return subscriptionEntitlements(row, now).some((entry) => entry.id === "bigtable_plus" || entry.id === "hearth_plus");
}

/** The household organizer someone shares a subscription with, or null. Lookup failures count as none. */
export async function householdOrganizerOf(profileId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("household_memberships")
    .select("organizer_id")
    .eq("member_id", profileId)
    .maybeSingle();
  const organizerId = !error && typeof data?.organizer_id === "string" ? data.organizer_id : null;
  return organizerId && organizerId !== profileId ? organizerId : null;
}

/**
 * Someone's active entitlements: their own, plus their household organizer's (families share the
 * organizer's plans). When both have the same entitlement, their own is listed.
 */
export async function effectiveEntitlements(profileId: string, now: Date = new Date()): Promise<EffectiveEntitlement[]> {
  const own = await supabaseAdmin
    .from("subscriptions")
    .select("tier, entitlements, expires_at")
    .eq("profile_id", profileId)
    .maybeSingle();
  if (own.error) {
    throw new Error(own.error.message);
  }
  const result: EffectiveEntitlement[] = subscriptionEntitlements(own.data as SubscriptionRow | null, now)
    .map((entry) => ({ ...entry, source: "own" as const }));

  const organizerId = await householdOrganizerOf(profileId);
  if (organizerId) {
    const organizer = await supabaseAdmin
      .from("subscriptions")
      .select("tier, entitlements, expires_at")
      .eq("profile_id", organizerId)
      .maybeSingle();
    if (!organizer.error) {
      for (const entry of subscriptionEntitlements(organizer.data as SubscriptionRow | null, now)) {
        if (!result.some((existing) => existing.id === entry.id)) {
          result.push({ ...entry, source: "household" });
        }
      }
    }
  }

  return result.sort((a, b) => ENTITLEMENT_KEYS.indexOf(a.id) - ENTITLEMENT_KEYS.indexOf(b.id));
}
