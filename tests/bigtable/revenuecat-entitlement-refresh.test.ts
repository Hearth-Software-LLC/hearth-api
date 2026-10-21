import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSupabase, type QueryCall, type QueryResult } from "./helpers/fake-supabase.js";
import { buildAuthHeader, buildJsonRequest } from "./helpers/session.js";

// The webhook with the real RevenueCat helpers: only fetch and Supabase are faked.

let fake: ReturnType<typeof createFakeSupabase>;
// Hoisted with vi.mock, ahead of the imports below; `fake` is read only when a query runs.
const supabaseAdmin = vi.hoisted(() => ({
  from: (table: string) => fake.client.from(table),
  rpc: (fn: string, args: Record<string, unknown>) => fake.client.rpc(fn, args),
}));
vi.mock("../../src/services/supabase.js", () => ({ supabaseAdmin }));

import { POST } from "../../src/bigtable/routes/webhooks.revenuecat.js";
import { resetRevenueCatEntitlementCache } from "../../src/services/revenuecat-entitlements.js";

let stored: Record<string, unknown> | null = null;

function respond(call: QueryCall): QueryResult | undefined {
  switch (call.table) {
    case "revenuecat_webhook_events":
      return { data: null };
    case "profiles":
      return { data: { id: "user-9" } };
    case "subscriptions":
      return call.op === "select" ? { data: stored } : { data: null };
    default:
      return { data: null };
  }
}

const future = Date.parse("2099-03-01T00:00:00Z");

function webhook(event: Record<string, unknown>) {
  return buildJsonRequest(
    "http://localhost/api/webhooks/revenuecat",
    { event: { id: `evt_${Math.random()}`, app_user_id: "user-9", ...event } },
    { authorization: buildAuthHeader("secret") }
  );
}

function upserted() {
  const calls = fake.callsTo("subscriptions", "upsert");
  expect(calls).toHaveLength(1);
  return calls[0]!.payload as Record<string, unknown>;
}

describe("RevenueCat webhook entitlement refresh", () => {
  beforeEach(() => {
    fake = createFakeSupabase(respond);
    stored = null;
    resetRevenueCatEntitlementCache();
    process.env.REVENUECAT_WEBHOOK_SECRET = "secret";
    process.env.REVENUECAT_SECRET_API_KEY = "sk_test";
    process.env.REVENUECAT_PROJECT_ID = "proj1";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stores the customer's active entitlements from RevenueCat's API", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/customers/user-9/active_entitlements")) {
        return Response.json({
          items: [
            { object: "customer.active_entitlement", entitlement_id: "entl_hp", expires_at: null },
            { object: "customer.active_entitlement", entitlement_id: "entl_sf", expires_at: future },
          ],
          next_page: null,
        });
      }
      if (url.includes("/projects/proj1/entitlements")) {
        return Response.json({
          items: [
            { id: "entl_hp", lookup_key: "hearth_plus" },
            { id: "entl_sf", lookup_key: "suffice_plus" },
            { id: "entl_bt", lookup_key: "bigtable_plus" },
          ],
          next_page: null,
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    // The event only names Suffice; the API's answer (with Hearth+) wins.
    const response = await POST(webhook({ type: "RENEWAL", entitlement_ids: ["suffice_plus"], expiration_at_ms: future }) as never);
    expect(response.status).toBe(200);
    expect(upserted()).toMatchObject({
      profile_id: "user-9",
      tier: "pro",
      entitlements: { hearth_plus: null, suffice_plus: new Date(future).toISOString() },
    });
    const [firstUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(firstUrl).toBe("https://api.revenuecat.com/v2/projects/proj1/customers/user-9/active_entitlements?limit=100");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk_test");
    expect(fake.callsTo("subscriptions", "select")).toHaveLength(0);

    // The id -> lookup key map is cached between events.
    fake = createFakeSupabase(respond);
    await POST(webhook({ type: "RENEWAL" }) as never);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/projects/proj1/entitlements"))).toHaveLength(1);
  });

  it("falls back to the event when RevenueCat's API fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    stored = { entitlements: { caloma_plus: "2099-01-01T00:00:00.000Z" } };

    const response = await POST(webhook({
      type: "INITIAL_PURCHASE", entitlement_ids: ["sated_plus"], expiration_at_ms: future,
    }) as never);
    expect(response.status).toBe(200);
    expect(upserted()).toMatchObject({
      tier: "free",
      entitlements: { caloma_plus: "2099-01-01T00:00:00.000Z", sated_plus: new Date(future).toISOString() },
    });
  });

  it("removes expired entitlements in the fallback and drops tier to free", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    stored = { entitlements: { "bigtable_plus": "2099-01-01T00:00:00.000Z" } };

    const response = await POST(webhook({ type: "EXPIRATION", entitlement_ids: ["bigtable_plus"] }) as never);
    expect(response.status).toBe(200);
    expect(upserted()).toMatchObject({ tier: "free", entitlements: {} });
  });

  it("keeps legacy entitlement names as BigTable Pro in the fallback", async () => {
    delete process.env.REVENUECAT_SECRET_API_KEY;
    const response = await POST(webhook({ type: "RENEWAL", entitlement_ids: ["pantry"], expiration_at_ms: future }) as never);
    expect(response.status).toBe(200);
    expect(upserted()).toMatchObject({ tier: "pro", entitlements: { "bigtable_plus": new Date(future).toISOString() } });
  });
});
