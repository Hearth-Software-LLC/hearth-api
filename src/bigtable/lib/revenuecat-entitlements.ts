import { laterExpiry, normalizeEntitlementKey } from "./entitlements.js";
import type { EntitlementMap } from "./entitlements.js";

// Reads a customer's active entitlements from RevenueCat's REST API v2, so the webhook can store
// the whole picture rather than replaying one event. Needs REVENUECAT_SECRET_API_KEY (a v2
// secret key with read access to customers and entitlements) and REVENUECAT_PROJECT_ID.

const REQUEST_TIMEOUT_MS = 3000;
const ENTITLEMENT_CACHE_MS = 10 * 60 * 1000;
const MAX_PAGES = 5;

let lookupKeyCache: { byId: Map<string, string>; expiresAt: number } | null = null;

/** For tests: forget the cached entitlement id -> lookup key map. */
export function resetRevenueCatEntitlementCache(): void {
  lookupKeyCache = null;
}

function settings() {
  const secretApiKey = process.env.REVENUECAT_SECRET_API_KEY?.trim();
  const projectId = process.env.REVENUECAT_PROJECT_ID?.trim();
  if (!secretApiKey) throw new Error("REVENUECAT_SECRET_API_KEY is not configured");
  if (!projectId) throw new Error("REVENUECAT_PROJECT_ID is not configured");
  const base = (process.env.REVENUECAT_API_BASE_URL?.trim() || "https://api.revenuecat.com").replace(/\/$/, "");
  return { secretApiKey, projectId, base };
}

type Page = { items?: unknown; next_page?: unknown };

/** GETs a v2 list, following `next_page` a few times. Returns null for a 404 when allowed. */
async function getList(path: string, allowNotFound = false): Promise<Record<string, unknown>[] | null> {
  const { secretApiKey, base } = settings();
  const items: Record<string, unknown>[] = [];
  let next: string | null = path;
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const url: string = next.startsWith("http") ? next : `${base}${next}`;
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${secretApiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404 && allowNotFound && page === 0) return null;
    if (!response.ok) {
      throw new Error(`RevenueCat GET ${path.split("?")[0]} failed with HTTP ${response.status}`);
    }
    const body = (await response.json()) as Page;
    if (!Array.isArray(body.items)) {
      throw new Error(`RevenueCat GET ${path.split("?")[0]} returned no items`);
    }
    items.push(...body.items.filter((item): item is Record<string, unknown> => !!item && typeof item === "object"));
    next = typeof body.next_page === "string" && body.next_page ? body.next_page : null;
  }
  return items;
}

/** RevenueCat entitlement id (entl...) -> lookup key, cached for ten minutes. */
async function entitlementLookupKeys(forceRefresh = false): Promise<Map<string, string>> {
  if (!forceRefresh && lookupKeyCache && lookupKeyCache.expiresAt > Date.now()) {
    return lookupKeyCache.byId;
  }
  const { projectId } = settings();
  const items = (await getList(`/v2/projects/${encodeURIComponent(projectId)}/entitlements?limit=100`)) ?? [];
  const byId = new Map<string, string>();
  for (const item of items) {
    if (typeof item.id === "string" && typeof item.lookup_key === "string") {
      byId.set(item.id, item.lookup_key);
    }
  }
  lookupKeyCache = { byId, expiresAt: Date.now() + ENTITLEMENT_CACHE_MS };
  return byId;
}

function expiryOf(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return undefined;
}

/**
 * The customer's active entitlements as lookup key -> ISO expiry (null = never). A customer
 * RevenueCat doesn't know has none. Throws when RevenueCat can't be reached or answers badly,
 * so the caller can fall back to the webhook event.
 */
export async function fetchRevenueCatEntitlements(appUserId: string): Promise<EntitlementMap> {
  const { projectId } = settings();
  const active = await getList(
    `/v2/projects/${encodeURIComponent(projectId)}/customers/${encodeURIComponent(appUserId)}/active_entitlements?limit=100`,
    true
  );
  if (!active) return {};

  let lookupKeys = await entitlementLookupKeys();
  if (active.some((item) => typeof item.entitlement_id === "string" && !lookupKeys.has(item.entitlement_id))) {
    // A new entitlement since the map was cached.
    lookupKeys = await entitlementLookupKeys(true);
  }

  const map: EntitlementMap = {};
  for (const item of active) {
    if (typeof item.entitlement_id !== "string") continue;
    const lookupKey = lookupKeys.get(item.entitlement_id);
    const key = lookupKey ? normalizeEntitlementKey(lookupKey) : null;
    const expiry = expiryOf(item.expires_at);
    if (!key || expiry === undefined) continue;
    map[key] = laterExpiry(map[key], expiry);
  }
  return map;
}
