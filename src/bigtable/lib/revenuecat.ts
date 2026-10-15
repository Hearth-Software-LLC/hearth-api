import { timingSafeEqual } from "node:crypto";

import type { SubscriptionTier } from "./rate-limit.js";

type RevenueCatEventPayload = {
  id?: string;
  event_id?: string;
  type?: string;
  app_user_id?: string;
  original_app_user_id?: string;
  entitlement_ids?: string[];
  product_id?: string;
  expiration_at_ms?: number | null;
  expires_date_ms?: number | null;
};

type RevenueCatWebhookBody = {
  event?: RevenueCatEventPayload;
} & RevenueCatEventPayload;

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

export function verifyRevenueCatAuthorizationHeader(headerValue: string | null, expectedSecret: string): boolean {
  if (!headerValue || !expectedSecret) {
    return false;
  }

  const trimmed = headerValue.trim();
  const bearerPrefix = "Bearer ";
  const token = trimmed.startsWith(bearerPrefix) ? trimmed.slice(bearerPrefix.length).trim() : trimmed;

  return safeEqual(token, expectedSecret);
}

export function extractRevenueCatEvent(body: RevenueCatWebhookBody): Required<Pick<RevenueCatEventPayload, "id" | "type" | "app_user_id">> & {
  entitlement_ids: string[];
  product_id: string | null;
  expires_at: string | null;
} {
  const event = body.event ?? body;

  const id = event.id ?? event.event_id;
  const type = event.type;
  const appUserId = event.app_user_id ?? event.original_app_user_id;

  if (!id || !type || !appUserId) {
    throw new Error("RevenueCat event is missing id, type, or app_user_id");
  }

  const expiryMs = event.expiration_at_ms ?? event.expires_date_ms ?? null;

  return {
    id,
    type,
    app_user_id: appUserId,
    entitlement_ids: Array.isArray(event.entitlement_ids)
      ? event.entitlement_ids.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [],
    product_id: typeof event.product_id === "string" ? event.product_id : null,
    expires_at: typeof expiryMs === "number" && Number.isFinite(expiryMs) ? new Date(expiryMs).toISOString() : null,
  };
}

export function deriveTierFromRevenueCat(event: {
  type: string;
  entitlement_ids: string[];
  product_id: string | null;
}): SubscriptionTier {
  const haystack = [...event.entitlement_ids, event.product_id ?? ""].join("|").toLowerCase();

  if (["EXPIRATION", "BILLING_ISSUE"].includes(event.type.toUpperCase())) {
    return "free";
  }

  // Legacy SKU names map to Pro to preserve existing paid subscribers.
  if (haystack.includes("pro") || haystack.includes("pantry") || haystack.includes("family") || haystack.includes("basic")) {
    return "pro";
  }

  return "free";
}

function revenueCatV2Endpoint(path: string): string {
  const projectId = process.env.REVENUECAT_PROJECT_ID?.trim();
  if (!projectId) {
    throw new Error("REVENUECAT_PROJECT_ID is not configured");
  }
  const base = (process.env.REVENUECAT_API_BASE_URL?.trim() || "https://api.revenuecat.com").replace(/\/$/, "");
  return `${base}/v2/projects/${encodeURIComponent(projectId)}${path}`;
}

export async function deleteRevenueCatSubscriber(appUserId: string): Promise<void> {
  const secretApiKey = process.env.REVENUECAT_SECRET_API_KEY?.trim();
  if (!secretApiKey) {
    throw new Error("REVENUECAT_SECRET_API_KEY is not configured");
  }

  const endpoint = revenueCatV2Endpoint(`/customers/${encodeURIComponent(appUserId)}`);

  const response = await fetch(endpoint, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${secretApiKey}`,
      "Content-Type": "application/json",
    },
  });

  if (response.ok || response.status === 404) {
    return;
  }

  let details = "";
  try {
    details = await response.text();
  } catch {
    details = "";
  }

  throw new Error(
    `RevenueCat subscriber deletion failed with HTTP ${response.status}${details ? `: ${details}` : ""}`
  );
}

export async function ensureRevenueCatSubscriber(appUserId: string): Promise<void> {
  const secretApiKey = process.env.REVENUECAT_SECRET_API_KEY?.trim();
  if (!secretApiKey) {
    throw new Error("REVENUECAT_SECRET_API_KEY is not configured");
  }

  const endpoint = revenueCatV2Endpoint(`/customers/${encodeURIComponent(appUserId)}`);

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, 1500);

  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${secretApiKey}`,
        "Content-Type": "application/json",
      },
      signal: abortController.signal,
    });

    // 200 = found, 404 = not yet a customer (RC creates them on first purchase — acceptable)
    if (response.ok || response.status === 404) {
      return;
    }

    let details = "";
    try {
      details = await response.text();
    } catch {
      details = "";
    }

    throw new Error(
      `RevenueCat get-or-create subscriber failed with HTTP ${response.status}${details ? `: ${details}` : ""}`
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
