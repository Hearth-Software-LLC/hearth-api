import { beforeEach, describe, expect, it, vi } from "vitest";

import { assertErrorResponse, assertWebhookDuplicateResponse } from "./contracts/response-contracts.js";
import { revenueCatEventFixture } from "./helpers/fixtures.js";
import { buildAuthHeader, buildJsonRequest } from "./helpers/session.js";
import { createFromTableMap } from "./helpers/supabase.js";

const verifyRevenueCatAuthorizationHeader = vi.fn();
const extractRevenueCatEvent = vi.fn();
const deriveTierFromRevenueCat = vi.fn();

const fromMock = vi.fn();
const supabaseAdmin = {
  from: fromMock,
};

vi.mock("../../src/bigtable/lib/revenuecat.js", () => ({
  verifyRevenueCatAuthorizationHeader,
  extractRevenueCatEvent,
  deriveTierFromRevenueCat,
}));

vi.mock("../../src/bigtable/lib/supabase.js", () => ({
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
    expect(deriveTierFromRevenueCat).not.toHaveBeenCalled();
    expect(duplicateInsert).not.toHaveBeenCalled();
  });

  it("projects tier and logs event", async () => {
    verifyRevenueCatAuthorizationHeader.mockReturnValue(true);
    extractRevenueCatEvent.mockReturnValue(
      revenueCatEventFixture({ id: "evt_2", app_user_id: "user-2" })
    );
    deriveTierFromRevenueCat.mockReturnValue("pro");

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
          upsert: vi.fn(async () => ({ error: null })),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const { POST } = await import("../../src/bigtable/routes/webhooks.revenuecat.js");
    const response = await POST(requestOf({ event: { id: "evt_2" } }) as never);

    expect(response.status).toBe(200);
    expect(deriveTierFromRevenueCat).toHaveBeenCalledTimes(1);
  });
});
