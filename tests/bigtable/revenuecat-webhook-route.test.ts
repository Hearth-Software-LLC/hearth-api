import { beforeEach, describe, expect, it, vi } from "vitest";

import { assertErrorResponse, assertWebhookDuplicateResponse } from "./contracts/response-contracts.js";
import { revenueCatEventFixture } from "./helpers/fixtures.js";
import { buildAuthHeader, buildJsonRequest } from "./helpers/session.js";
import { createFromTableMap } from "./helpers/supabase.js";

const verifyRevenueCatAuthorizationHeader = vi.fn();
const extractRevenueCatEvent = vi.fn();
const deriveTierFromRevenueCat = vi.fn();
const fetchRevenueCatEntitlements = vi.fn();

const fromMock = vi.fn();
const supabaseAdmin = {
  from: fromMock,
};

vi.mock("../../src/services/revenuecat.js", () => ({
  verifyRevenueCatAuthorizationHeader,
  extractRevenueCatEvent,
  deriveTierFromRevenueCat,
}));

vi.mock("../../src/services/revenuecat-entitlements.js", () => ({
  fetchRevenueCatEntitlements,
}));

vi.mock("../../src/services/supabase.js", () => ({
  supabaseAdmin,
}));

function requestOf(body: Record<string, unknown>) {
  return buildJsonRequest("http://localhost/api/webhooks/revenuecat", body, {
    authorization: buildAuthHeader("secret"),
  });
}

describe("POST /api/webhooks/revenuecat", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.REVENUECAT_WEBHOOK_SECRET = "secret";
  });

  it("returns 401 for invalid webhook auth", async () => {
    verifyRevenueCatAuthorizationHeader.mockReturnValue(false);

    const { POST } = await import("../../src/bigtable/routes/webhooks.revenuecat.js");
    const response = await POST(requestOf({ event: { id: "evt_1" } }) as never);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    assertErrorResponse(payload);
    expect(payload.error).toBe("Unauthorized");
  });

  it("returns duplicate=true for already processed event", async () => {
    verifyRevenueCatAuthorizationHeader.mockReturnValue(true);
    extractRevenueCatEvent.mockReturnValue(
      revenueCatEventFixture({ id: "evt_1", type: "RENEWAL", expires_at: null })
    );

    const duplicateInsert = vi.fn(async () => ({ error: null }));

    fromMock.mockImplementation(
      createFromTableMap({
        revenuecat_webhook_events: () => ({
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({ data: { event_id: "evt_1" }, error: null })),
            })),
          })),
          insert: duplicateInsert,
        }),
      })
    );

    const { POST } = await import("../../src/bigtable/routes/webhooks.revenuecat.js");
    const response = await POST(requestOf({ event: { id: "evt_1" } }) as never);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    assertWebhookDuplicateResponse(payload);
    expect(fetchRevenueCatEntitlements).not.toHaveBeenCalled();
    expect(duplicateInsert).not.toHaveBeenCalled();
  });

  it("refreshes entitlements, projects tier and logs event", async () => {
    verifyRevenueCatAuthorizationHeader.mockReturnValue(true);
    extractRevenueCatEvent.mockReturnValue(
      revenueCatEventFixture({ id: "evt_2", app_user_id: "user-2" })
    );
    fetchRevenueCatEntitlements.mockResolvedValue({ "bigtable_plus": "2099-06-01T00:00:00.000Z" });
    const upsert = vi.fn(async (_row: Record<string, unknown>) => ({ error: null }));

    fromMock.mockImplementation((table: string) => {
      if (table === "revenuecat_webhook_events") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({ data: null, error: null })),
            })),
          })),
          insert: vi.fn(async () => ({ error: null })),
        };
      }

      if (table === "profiles") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({ data: { id: "user-2" }, error: null })),
            })),
          })),
        };
      }

      if (table === "subscriptions") {
        return {
          upsert,
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const { POST } = await import("../../src/bigtable/routes/webhooks.revenuecat.js");
    const response = await POST(requestOf({ event: { id: "evt_2" } }) as never);

    expect(response.status).toBe(200);
    expect(fetchRevenueCatEntitlements).toHaveBeenCalledWith("user-2");
    expect(upsert.mock.calls[0]?.[0]).toMatchObject({
      profile_id: "user-2",
      tier: "pro",
      entitlements: { "bigtable_plus": "2099-06-01T00:00:00.000Z" },
    });
  });
});
