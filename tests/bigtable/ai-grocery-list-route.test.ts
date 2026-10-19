import { beforeEach, describe, expect, it, vi } from "vitest";

import { assertErrorResponse, assertLimitReachedResponse } from "./contracts/response-contracts.js";
import { householdFixture, usageFixture } from "./helpers/fixtures.js";
import { buildAuthenticatedJsonRequest, buildUnauthenticatedJsonRequest } from "./helpers/session.js";

const getUserIdFromAuthHeader = vi.fn();
const getUsageStatus = vi.fn();
const incrementUsageBy = vi.fn();
const canConsumeCredits = vi.fn();
const buildGroceryList = vi.fn();
const GroceryListGenerationError = class extends Error {
  code: string;
  status: number;

  constructor(message: string, code = "UNKNOWN", status = 500) {
    super(message);
    this.code = code;
    this.status = status;
  }
};

const fromMock = vi.fn();
let membershipOrganizerId: string | null = null;
const supabaseAdmin = {
  from: fromMock,
};

vi.mock("../../src/bigtable/lib/auth.js", () => ({
  getUserIdFromAuthHeader,
}));

vi.mock("../../src/bigtable/lib/rate-limit.js", () => ({
  getUsageStatus,
  incrementUsageBy,
  canConsumeCredits,
}));

vi.mock("../../src/bigtable/lib/ai-grocery-list.js", () => ({
  buildGroceryList,
  GroceryListGenerationError,
}));

vi.mock("../../src/bigtable/lib/supabase.js", () => ({
  supabaseAdmin,
}));

function createTableMock(table: string, withMeals: boolean) {
  const household = householdFixture();

  if (table === "weekly_plans") {
    return {
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          gte: vi.fn(() => ({
            lte: vi.fn(async () => ({ data: [{ id: "plan-1", week_start: "2026-05-24" }], error: null })),
          })),
        })),
      })),
    };
  }

  if (table === "meal_slots") {
    return {
      select: vi.fn(() => ({
        in: vi.fn(() => ({
          or: vi.fn(async () => ({
            data: withMeals
              ? [
                  { plan_id: "plan-1", day: "monday", slot: "dinner", custom_meal: "Big Batch Bolognese" },
                  { plan_id: "plan-1", day: "tuesday", slot: "lunch", custom_meal: "Chicken Caesar Wraps" },
                ]
              : [],
            error: null,
          })),
        })),
      })),
    };
  }

  if (table === "profiles") {
    return {
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({ data: { household_name: household.householdName }, error: null })),
        })),
      })),
    };
  }

  if (table === "dietary_restrictions") {
    return {
      select: vi.fn(() => ({
        eq: vi.fn(async () => ({ data: household.restrictions.map((value) => ({ value })), error: null })),
      })),
    };
  }

  if (table === "household_members") {
    return {
      select: vi.fn(() => ({
        eq: vi.fn(async () => ({ data: household.memberNames.map((name) => ({ name })), error: null })),
      })),
    };
  }

  if (table === "recipes") {
    const selectBuilder = {
      in: vi.fn(() => selectBuilder),
      or: vi.fn(() => selectBuilder),
      then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
    };

    return {
      select: vi.fn(() => selectBuilder),
    };
  }

  if (table === "recipe_ingredients") {
    const selectBuilder = {
      in: vi.fn(() => selectBuilder),
      then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
    };

    return {
      select: vi.fn(() => selectBuilder),
    };
  }

  if (table === "household_memberships") {
    return {
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({
            data: membershipOrganizerId ? { organizer_id: membershipOrganizerId } : null,
            error: null,
          })),
        })),
      })),
    };
  }

  if (table === "household_member_permissions") {
    // Members start with no AI permissions until their organizer grants them.
    return {
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({ data: null, error: null })),
        })),
      })),
    };
  }

  throw new Error(`Unexpected table ${table}`);
}

describe("POST /api/ai/grocery-list", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    membershipOrganizerId = null;
    canConsumeCredits.mockImplementation((usage: { requestsUsed: number; requestsLimit: number }, credits: number) => {
      return usage.requestsUsed + credits <= usage.requestsLimit;
    });
  });

  it("returns 403 when usage limit is reached", async () => {
    fromMock.mockImplementation((table: string) => createTableMock(table, true));
    getUserIdFromAuthHeader.mockResolvedValue("user-1");
    getUsageStatus.mockResolvedValue(
      usageFixture({ tier: "free", requestsUsed: 0, requestsLimit: 0, canMakeRequest: false })
    );

    const { POST } = await import("../../src/bigtable/routes/ai.grocery-list.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/grocery-list", { weekStart: "2026-05-24" }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(403);
    assertLimitReachedResponse(body);
    expect(buildGroceryList).not.toHaveBeenCalled();
  });

  it("returns 400 when weekly plan has no meals", async () => {
    fromMock.mockImplementation((table: string) => createTableMock(table, false));
    getUserIdFromAuthHeader.mockResolvedValue("user-1");
    getUsageStatus.mockResolvedValue(usageFixture({ requestsUsed: 2, requestsLimit: 120 }));

    const { POST } = await import("../../src/bigtable/routes/ai.grocery-list.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/grocery-list", { weekStart: "2026-05-24" }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    assertErrorResponse(body);
    expect(body.code).toBe("PLAN_EMPTY");
    expect(buildGroceryList).not.toHaveBeenCalled();
    expect(incrementUsageBy).not.toHaveBeenCalled();
  });

  it("still returns a grocery list when usage bookkeeping fails after generation", async () => {
    fromMock.mockImplementation((table: string) => createTableMock(table, true));
    getUserIdFromAuthHeader.mockResolvedValue("user-1");
    getUsageStatus
      .mockResolvedValueOnce({
        tier: "pro",
        requestsUsed: 2,
        requestsLimit: 1000000,
        resetsAt: "2026-06-01T00:00:00.000Z",
        canMakeRequest: true,
      })
      .mockResolvedValueOnce({
        tier: "pro",
        requestsUsed: 2,
        requestsLimit: 1000000,
        resetsAt: "2026-06-01T00:00:00.000Z",
        canMakeRequest: true,
      });

    incrementUsageBy.mockRejectedValueOnce(new Error("Usage sync unavailable"));
    buildGroceryList.mockResolvedValue({
      source: "fallback",
      groceryList: [
        {
          section: "Produce",
          items: [{ id: "item-1", name: "Spinach", quantity: "2 bags" }],
        },
      ],
    });

    const { POST } = await import("../../src/bigtable/routes/ai.grocery-list.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/grocery-list", { weekStart: "2026-05-24" }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toHaveProperty("groceryList");
    expect(body.generatedBy).toBe("fallback");
  });

  it("uses the Hearth household from the request, with allergies as hard rules", async () => {
    fromMock.mockImplementation((table: string) => createTableMock(table, true));
    getUserIdFromAuthHeader.mockResolvedValue("user-1");
    getUsageStatus.mockResolvedValue(usageFixture({ requestsUsed: 2, requestsLimit: 120 }));
    buildGroceryList.mockResolvedValue({
      source: "fallback",
      groceryList: [{ section: "Produce", items: [{ id: "item-1", name: "Spinach", quantity: "2 bags" }] }],
    });

    const { POST } = await import("../../src/bigtable/routes/ai.grocery-list.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/grocery-list", {
        weekStart: "2026-05-24",
        household: { people: [{ age: 38, role: "parent" }, { age: 6, role: "kid" }], allergies: ["Sesame"], restrictions: [], likes: [], dislikes: [] },
      }) as never
    );

    expect(response.status).toBe(200);
    const args = buildGroceryList.mock.calls[0]?.[0] as { householdMembers: string[]; restrictions: string[]; householdName: string | null };
    expect(args.householdMembers).toEqual(["Parent, 38", "Kid, 6"]);
    expect(args.restrictions).toEqual(["Allergy (never include): Sesame"]);
    expect(args.householdName).toBeNull();
  });

  it("rejects a malformed Hearth household", async () => {
    fromMock.mockImplementation((table: string) => createTableMock(table, true));
    getUserIdFromAuthHeader.mockResolvedValue("user-1");
    const { POST } = await import("../../src/bigtable/routes/ai.grocery-list.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/grocery-list", { weekStart: "2026-05-24", household: [] }) as never
    );
    expect(response.status).toBe(400);
    expect(buildGroceryList).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is a household member", async () => {
    fromMock.mockImplementation((table: string) => createTableMock(table, true));
    getUserIdFromAuthHeader.mockResolvedValue("member-1");
    membershipOrganizerId = "organizer-1";

    const { POST } = await import("../../src/bigtable/routes/ai.grocery-list.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/grocery-list", { weekStart: "2026-05-24" }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(403);
    expect(body.error).toBe("Your organizer hasn't granted you access to AI grocery lists");
    expect(buildGroceryList).not.toHaveBeenCalled();
  });

  it("returns 401 for an unauthenticated request", async () => {
    getUserIdFromAuthHeader.mockResolvedValue(null);

    const { POST } = await import("../../src/bigtable/routes/ai.grocery-list.js");
    const response = await POST(buildUnauthenticatedJsonRequest("http://localhost/api/ai/grocery-list", {}) as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    assertErrorResponse(body);
    expect(body.error).toBe("Unauthorized");
  });
});
