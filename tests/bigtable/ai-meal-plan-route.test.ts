import { beforeEach, describe, expect, it, vi } from "vitest";

import { assertErrorResponse, assertLimitReachedResponse, assertUsageResponse } from "./contracts/response-contracts.js";
import { householdFixture, usageFixture } from "./helpers/fixtures.js";
import { buildAuthenticatedJsonRequest, buildUnauthenticatedJsonRequest } from "./helpers/session.js";

const getUserIdFromAuthHeader = vi.fn();
const getUsageStatus = vi.fn();
const incrementUsageBy = vi.fn();
const canConsumeCredits = vi.fn();
const buildMealPlan = vi.fn();

const fromMock = vi.fn();
let mealSlotsRows: Row[] = [];
let recipeRows: Row[] = [];
let savedRecipeRows: Row[] = [];
let membershipOrganizerId: string | null = null;
let linkedMemberIds: string[] = [];
let dietaryRestrictionRows: Array<{ value: string; profile_id: string }> = [];
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

vi.mock("../../src/bigtable/lib/ai-meal-plan.js", () => ({
  buildMealPlan,
}));

vi.mock("../../src/bigtable/lib/supabase.js", () => ({
  supabaseAdmin,
}));

type Row = Record<string, unknown>;

function createTableMock(table: string) {
  const household = householdFixture();

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
    const restrictionRows = dietaryRestrictionRows.length > 0
      ? dietaryRestrictionRows
      : household.restrictions.map((value) => ({ value, profile_id: "user-1" }));
    return {
      select: vi.fn(() => ({
        eq: vi.fn(async () => ({ data: household.restrictions.map((value) => ({ value })), error: null })),
        in: vi.fn(async (_column: string, profileIds: string[]) => ({
          data: restrictionRows.filter((row) => profileIds.includes(row.profile_id)),
          error: null,
        })),
      })),
    };
  }

  if (table === "household_memberships") {
    return {
      select: vi.fn(() => ({
        eq: vi.fn((column: string) => {
          if (column === "member_id") {
            return {
              maybeSingle: vi.fn(async () => ({
                data: membershipOrganizerId ? { organizer_id: membershipOrganizerId } : null,
                error: null,
              })),
            };
          }

          return {
            then: (resolve: (value: { data: Array<{ member_id: string }>; error: null }) => unknown) =>
              Promise.resolve({
                data: linkedMemberIds.map((member_id) => ({ member_id })),
                error: null,
              }).then(resolve),
          };
        }),
      })),
    };
  }

  if (table === "household_members") {
    return {
      select: vi.fn(() => ({
        // Rows carry names too, so the tests prove the AI context never uses them.
        eq: vi.fn(async () => ({
          data: household.memberNames.map((name, index) => ({
            name, date_of_birth: index === 0 ? "1984-01-01" : null, likes: ["Tacos"], dislikes: index === 0 ? ["Olives"] : [],
          })),
          error: null,
        })),
      })),
    };
  }

  if (table === "weekly_plans") {
    return {
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({
              data: { id: "plan-1", week_start: "2026-05-18" },
              error: null,
            })),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn(async () => ({
            data: { id: "plan-1", week_start: "2026-05-18" },
            error: null,
          })),
        })),
      })),
    };
  }

  if (table === "meal_slots") {
    const selectBuilder = {
      eq: vi.fn(() => selectBuilder),
      in: vi.fn(() => selectBuilder),
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({ data: mealSlotsRows, error: null }).then(resolve),
    };

    return {
      upsert: vi.fn(async (_rows: Row[]) => ({ error: null })),
      select: vi.fn(() => selectBuilder),
    };
  }

  if (table === "saved_recipes") {
    return {
      select: vi.fn(() => ({
        eq: vi.fn(async () => ({ data: savedRecipeRows, error: null })),
      })),
    };
  }

  if (table === "recipes") {
    const state: {
      selectedTitles: string[] | null;
      includePublished: boolean;
      includeOwnedProfileId: string | null;
    } = {
      selectedTitles: null,
      includePublished: false,
      includeOwnedProfileId: null,
    };
    const selectBuilder = {
      eq: vi.fn(() => selectBuilder),
      neq: vi.fn(() => selectBuilder),
      in: vi.fn((_column: string, values: string[]) => {
        state.selectedTitles = values;
        return selectBuilder;
      }),
      or: vi.fn((clause: string) => {
        state.includePublished = clause.includes("status.eq.published");
        const ownedMatch = clause.match(/created_by_profile_id\.eq\.([^,]+)/);
        state.includeOwnedProfileId = ownedMatch?.[1] ?? null;
        return selectBuilder;
      }),
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) => {
        const filtered = recipeRows.filter((row) => {
          const titleMatches = state.selectedTitles ? state.selectedTitles.includes(String(row.title)) : true;
          const isPublished = state.includePublished ? row.status === "published" : false;
          const isOwned = state.includeOwnedProfileId
            ? row.created_by_profile_id === state.includeOwnedProfileId
            : false;

          return titleMatches && (state.includePublished || state.includeOwnedProfileId ? isPublished || isOwned : true);
        });
        return Promise.resolve({ data: filtered, error: null }).then(resolve);
      },
    };

    return {
      select: vi.fn(() => selectBuilder),
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

  throw new Error(`Unexpected table: ${table}`);
}

describe("POST /api/ai/meal-plan", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mealSlotsRows = [];
    savedRecipeRows = [];
    membershipOrganizerId = null;
    linkedMemberIds = [];
    dietaryRestrictionRows = [];
    recipeRows = [
      { title: "Sheet Pan Pancakes", tags: ["breakfast"], prep_minutes: 10, cook_minutes: 20, image_url: "https://img/pancakes.jpg", status: "published" },
      { title: "Chicken Caesar Wraps", tags: ["lunch"], prep_minutes: 15, cook_minutes: 0, image_url: "https://img/wraps.jpg", status: "published" },
      { title: "Creamy Tuscan Chicken Pasta", tags: ["dinner"], prep_minutes: 20, cook_minutes: 25, image_url: "https://img/pasta.jpg", status: "published" },
    ];
    fromMock.mockImplementation((table: string) => createTableMock(table));
    canConsumeCredits.mockImplementation((usage: { requestsUsed: number; requestsLimit: number }, credits: number) => {
      return usage.requestsUsed + credits <= usage.requestsLimit;
    });
  });

  it("treats the prompt as optional", async () => {
    getUserIdFromAuthHeader.mockResolvedValue("user-1");
    getUsageStatus.mockResolvedValue({
      tier: "pro",
      requestsUsed: 2,
      requestsLimit: 1000000,
      resetsAt: "2026-06-01T00:00:00.000Z",
      canMakeRequest: true,
    });
    buildMealPlan.mockResolvedValue({
      source: "fallback",
      plan: {
        monday: { breakfast: "A", lunch: "B", dinner: "C" },
        tuesday: { breakfast: "A", lunch: "B", dinner: "C" },
        wednesday: { breakfast: "A", lunch: "B", dinner: "C" },
        thursday: { breakfast: "A", lunch: "B", dinner: "C" },
        friday: { breakfast: "A", lunch: "B", dinner: "C" },
        saturday: { breakfast: "A", lunch: "B", dinner: "C" },
        sunday: { breakfast: "A", lunch: "B", dinner: "C" },
      },
    });

    const { POST } = await import("../../src/bigtable/routes/ai.meal-plan.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/meal-plan", {}) as never
    );

    expect(response.status).toBe(200);
    expect(buildMealPlan).toHaveBeenCalledTimes(1);
    // A default prompt is supplied so the model still has direction.
    expect(buildMealPlan.mock.calls[0]![0].prompt.length).toBeGreaterThan(0);
  });

  it("returns 403 when usage limit is reached", async () => {
    getUserIdFromAuthHeader.mockResolvedValue("user-1");
    getUsageStatus.mockResolvedValue(
      usageFixture({ tier: "free", requestsUsed: 0, requestsLimit: 0, canMakeRequest: false })
    );

    const { POST } = await import("../../src/bigtable/routes/ai.meal-plan.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/meal-plan", { prompt: "busy week" }) as never
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(403);
    assertLimitReachedResponse(payload);
    expect(buildMealPlan).not.toHaveBeenCalled();
    expect(incrementUsageBy).not.toHaveBeenCalled();
  });

  it("returns 200 and persists planner when usage is allowed", async () => {
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
        requestsUsed: 3,
        requestsLimit: 1000000,
        resetsAt: "2026-06-01T00:00:00.000Z",
        canMakeRequest: true,
      });

    buildMealPlan.mockResolvedValue({
      source: "fallback",
      plan: {
        monday: { breakfast: "A", lunch: "B", dinner: "C" },
        tuesday: { breakfast: "A", lunch: "B", dinner: "C" },
        wednesday: { breakfast: "A", lunch: "B", dinner: "C" },
        thursday: { breakfast: "A", lunch: "B", dinner: "C" },
        friday: { breakfast: "A", lunch: "B", dinner: "C" },
        saturday: { breakfast: "A", lunch: "B", dinner: "C" },
        sunday: { breakfast: "A", lunch: "B", dinner: "C" },
      },
    });

    const { POST } = await import("../../src/bigtable/routes/ai.meal-plan.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/meal-plan", {
        prompt: "busy week",
        mealStyle: "comfort",
        quickTags: ["busy_weekdays"],
      }) as never
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.generatedBy).toBe("fallback");
    assertUsageResponse(payload);
    expect(incrementUsageBy).toHaveBeenCalledWith("user-1", "meal_plan", 7);
    expect(buildMealPlan).toHaveBeenCalledTimes(1);
  });

  it("tolerates a recipeMix that does not sum to 100", async () => {
    getUserIdFromAuthHeader.mockResolvedValue("user-1");
    getUsageStatus.mockResolvedValue({
      tier: "pro",
      requestsUsed: 2,
      requestsLimit: 1000000,
      resetsAt: "2026-06-01T00:00:00.000Z",
      canMakeRequest: true,
    });
    buildMealPlan.mockResolvedValue({
      source: "fallback",
      plan: {
        monday: { breakfast: "A", lunch: "B", dinner: "C" },
        tuesday: { breakfast: "A", lunch: "B", dinner: "C" },
        wednesday: { breakfast: "A", lunch: "B", dinner: "C" },
        thursday: { breakfast: "A", lunch: "B", dinner: "C" },
        friday: { breakfast: "A", lunch: "B", dinner: "C" },
        saturday: { breakfast: "A", lunch: "B", dinner: "C" },
        sunday: { breakfast: "A", lunch: "B", dinner: "C" },
      },
    });

    const { POST } = await import("../../src/bigtable/routes/ai.meal-plan.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/meal-plan", {
        prompt: "busy week",
        recipeMix: { mine: 1, favorites: 1, other: 1 },
      }) as never
    );

    expect(response.status).toBe(200);
    // The mix is normalized; planning still proceeds.
    expect(buildMealPlan).toHaveBeenCalledTimes(1);
  });

  it("returns 422 when there are no recipes at all to plan from", async () => {
    getUserIdFromAuthHeader.mockResolvedValue("user-1");
    getUsageStatus.mockResolvedValue({
      tier: "pro",
      requestsUsed: 2,
      requestsLimit: 1000000,
      resetsAt: "2026-06-01T00:00:00.000Z",
      canMakeRequest: true,
    });
    recipeRows = []; // user has no recipes of their own

    const { POST } = await import("../../src/bigtable/routes/ai.meal-plan.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/meal-plan", {
        prompt: "busy week",
        recipeSource: "mine",
      }) as never
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(422);
    expect(payload.code).toBe("EMPTY_RECIPE_POOL");
    expect(buildMealPlan).not.toHaveBeenCalled();
    expect(incrementUsageBy).not.toHaveBeenCalled();
  });

  it("includes linked member dietary restrictions in household context", async () => {
    getUserIdFromAuthHeader.mockResolvedValue("organizer-1");
    membershipOrganizerId = null;
    linkedMemberIds = ["member-1", "member-2"];
    dietaryRestrictionRows = [
      { value: "no pork", profile_id: "organizer-1" },
      { value: "nut allergy", profile_id: "member-1" },
      { value: "gluten free", profile_id: "member-2" },
    ];

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
        requestsUsed: 3,
        requestsLimit: 1000000,
        resetsAt: "2026-06-01T00:00:00.000Z",
        canMakeRequest: true,
      });

    buildMealPlan.mockResolvedValue({
      source: "fallback",
      plan: {
        monday: { breakfast: "A", lunch: "B", dinner: "C" },
        tuesday: { breakfast: "A", lunch: "B", dinner: "C" },
        wednesday: { breakfast: "A", lunch: "B", dinner: "C" },
        thursday: { breakfast: "A", lunch: "B", dinner: "C" },
        friday: { breakfast: "A", lunch: "B", dinner: "C" },
        saturday: { breakfast: "A", lunch: "B", dinner: "C" },
        sunday: { breakfast: "A", lunch: "B", dinner: "C" },
      },
    });

    const { POST } = await import("../../src/bigtable/routes/ai.meal-plan.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/meal-plan", { prompt: "busy week" }) as never
    );

    expect(response.status).toBe(200);
    expect(buildMealPlan).toHaveBeenCalledTimes(1);
    const mealPlanArgs = buildMealPlan.mock.calls[0]?.[0] as { restrictions?: string[] };
    expect(mealPlanArgs.restrictions).toEqual(expect.arrayContaining(["no pork", "nut allergy", "gluten free"]));
  });

  it("sends the stored household without member or household names", async () => {
    getUserIdFromAuthHeader.mockResolvedValue("organizer-1");
    membershipOrganizerId = null;
    linkedMemberIds = [];
    dietaryRestrictionRows = [{ value: "no pork", profile_id: "organizer-1" }];
    getUsageStatus.mockResolvedValue({
      tier: "pro", requestsUsed: 2, requestsLimit: 1000000, resetsAt: "2026-06-01T00:00:00.000Z", canMakeRequest: true,
    });
    buildMealPlan.mockResolvedValue({
      source: "fallback",
      plan: Object.fromEntries(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
        .map((day) => [day, { breakfast: "A", lunch: "B", dinner: "C" }])),
    });

    const { POST } = await import("../../src/bigtable/routes/ai.meal-plan.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/meal-plan", { prompt: "busy week" }) as never
    );

    expect(response.status).toBe(200);
    const args = buildMealPlan.mock.calls[0]?.[0] as {
      householdName: string | null;
      householdMembers: string[];
      householdLikes: string[];
      householdDislikes: string[];
      restrictions: string[];
    };
    expect(args.householdName).toBeNull();
    expect(args.householdMembers).toEqual([expect.stringMatching(/^Adult, \d+$/), "Adult"]);
    expect(args.householdLikes).toEqual(["Tacos"]);
    expect(args.householdDislikes).toEqual(["Olives"]);
    expect(args.restrictions).toEqual(["no pork"]);
    const sent = JSON.stringify(args);
    for (const name of householdFixture().memberNames) expect(sent).not.toContain(name);
    expect(sent).not.toContain(householdFixture().householdName);
  });

  it("uses the Hearth household from the request instead of the stored one, without names", async () => {
    getUserIdFromAuthHeader.mockResolvedValue("organizer-1");
    membershipOrganizerId = null;
    linkedMemberIds = [];
    dietaryRestrictionRows = [{ value: "no pork", profile_id: "organizer-1" }];
    getUsageStatus.mockResolvedValue({
      tier: "pro",
      requestsUsed: 2,
      requestsLimit: 1000000,
      resetsAt: "2026-06-01T00:00:00.000Z",
      canMakeRequest: true,
    });
    buildMealPlan.mockResolvedValue({
      source: "fallback",
      plan: {
        monday: { breakfast: "A", lunch: "B", dinner: "C" },
        tuesday: { breakfast: "A", lunch: "B", dinner: "C" },
        wednesday: { breakfast: "A", lunch: "B", dinner: "C" },
        thursday: { breakfast: "A", lunch: "B", dinner: "C" },
        friday: { breakfast: "A", lunch: "B", dinner: "C" },
        saturday: { breakfast: "A", lunch: "B", dinner: "C" },
        sunday: { breakfast: "A", lunch: "B", dinner: "C" },
      },
    });

    const { POST } = await import("../../src/bigtable/routes/ai.meal-plan.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/meal-plan", {
        prompt: "busy week",
        household: {
          people: [{ age: 41, role: "parent" }, { age: 9, role: "kid" }, { role: "adult" }],
          allergies: ["Peanuts", "peanuts"],
          restrictions: ["Vegetarian"],
          likes: ["Tacos"],
          dislikes: ["Olives"],
        },
      }) as never
    );

    expect(response.status).toBe(200);
    const args = buildMealPlan.mock.calls[0]?.[0] as {
      householdName: string | null;
      householdMembers: string[];
      householdLikes: string[];
      householdDislikes: string[];
      restrictions: string[];
    };
    expect(args.householdName).toBeNull();
    expect(args.householdMembers).toEqual(["Parent, 41", "Kid, 9", "Adult"]);
    expect(args.restrictions).toEqual(["Allergy (never include): Peanuts", "Vegetarian"]);
    expect(args.householdLikes).toEqual(["Tacos"]);
    expect(args.householdDislikes).toEqual(["Olives"]);
  });

  it("rejects a malformed Hearth household", async () => {
    getUserIdFromAuthHeader.mockResolvedValue("user-1");
    const { POST } = await import("../../src/bigtable/routes/ai.meal-plan.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/meal-plan", { prompt: "busy week", household: { people: "two" } }) as never
    );
    expect(response.status).toBe(400);
    expect(buildMealPlan).not.toHaveBeenCalled();
  });

  it("includes user-owned private recipes in the meal plan catalog", async () => {
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
        requestsUsed: 3,
        requestsLimit: 1000000,
        resetsAt: "2026-06-01T00:00:00.000Z",
        canMakeRequest: true,
      });

    recipeRows = [
      {
        title: "Private Chicken Tacos",
        tags: ["dinner"],
        prep_minutes: 15,
        cook_minutes: 20,
        image_url: "https://img/tacos.jpg",
        status: "draft",
        created_by_profile_id: "user-1",
      },
    ];

    buildMealPlan.mockResolvedValue({
      source: "fallback",
      plan: {
        monday: { breakfast: "Private Chicken Tacos", lunch: "Private Chicken Tacos", dinner: "Private Chicken Tacos" },
        tuesday: { breakfast: "Private Chicken Tacos", lunch: "Private Chicken Tacos", dinner: "Private Chicken Tacos" },
        wednesday: { breakfast: "Private Chicken Tacos", lunch: "Private Chicken Tacos", dinner: "Private Chicken Tacos" },
        thursday: { breakfast: "Private Chicken Tacos", lunch: "Private Chicken Tacos", dinner: "Private Chicken Tacos" },
        friday: { breakfast: "Private Chicken Tacos", lunch: "Private Chicken Tacos", dinner: "Private Chicken Tacos" },
        saturday: { breakfast: "Private Chicken Tacos", lunch: "Private Chicken Tacos", dinner: "Private Chicken Tacos" },
        sunday: { breakfast: "Private Chicken Tacos", lunch: "Private Chicken Tacos", dinner: "Private Chicken Tacos" },
      },
    });

    const { POST } = await import("../../src/bigtable/routes/ai.meal-plan.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/meal-plan", {
        prompt: "busy week",
        mealStyle: "comfort",
        quickTags: ["busy_weekdays"],
      }) as never
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.generatedBy).toBe("fallback");
    expect(buildMealPlan).toHaveBeenCalledTimes(1);
  });

  it("still returns a planner when usage bookkeeping fails after persistence", async () => {
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
    buildMealPlan.mockResolvedValue({
      source: "fallback",
      plan: {
        monday: { breakfast: "A", lunch: "B", dinner: "C" },
        tuesday: { breakfast: "A", lunch: "B", dinner: "C" },
        wednesday: { breakfast: "A", lunch: "B", dinner: "C" },
        thursday: { breakfast: "A", lunch: "B", dinner: "C" },
        friday: { breakfast: "A", lunch: "B", dinner: "C" },
        saturday: { breakfast: "A", lunch: "B", dinner: "C" },
        sunday: { breakfast: "A", lunch: "B", dinner: "C" },
      },
    });

    const { POST } = await import("../../src/bigtable/routes/ai.meal-plan.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/meal-plan", {
        prompt: "busy week",
        mealStyle: "comfort",
        quickTags: ["busy_weekdays"],
      }) as never
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload).toHaveProperty("planner");
    expect(payload.generatedBy).toBe("fallback");
  });

  it("does not charge credits for fully occupied selected days when overwriteExisting is false", async () => {
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

    mealSlotsRows = [
      { id: "slot-1", day: "monday", slot: "breakfast", custom_meal: "Existing A", recipe_items: [{ title: "Existing A", role: "entree" }], excluded_members: [], completed: false },
      { id: "slot-2", day: "monday", slot: "lunch", custom_meal: "Existing B", recipe_items: [{ title: "Existing B", role: "entree" }], excluded_members: [], completed: false },
      { id: "slot-3", day: "monday", slot: "dinner", custom_meal: "Existing C", recipe_items: [{ title: "Existing C", role: "entree" }], excluded_members: [], completed: false },
    ];

    buildMealPlan.mockResolvedValue({
      source: "fallback",
      plan: {
        monday: { breakfast: "A", lunch: "B", dinner: "C" },
        tuesday: { breakfast: "A", lunch: "B", dinner: "C" },
        wednesday: { breakfast: "A", lunch: "B", dinner: "C" },
        thursday: { breakfast: "A", lunch: "B", dinner: "C" },
        friday: { breakfast: "A", lunch: "B", dinner: "C" },
        saturday: { breakfast: "A", lunch: "B", dinner: "C" },
        sunday: { breakfast: "A", lunch: "B", dinner: "C" },
      },
    });

    const { POST } = await import("../../src/bigtable/routes/ai.meal-plan.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/meal-plan", {
        prompt: "only monday",
        overwriteExisting: false,
        selectedMeals: {
          monday: ["breakfast", "lunch", "dinner"],
        },
      }) as never
    );
    const payload = (await response.json()) as {
      usage?: {
        creditsCharged?: number;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.usage?.creditsCharged).toBe(0);
    expect(incrementUsageBy).not.toHaveBeenCalled();
  });

  it("returns 401 for an unauthenticated request", async () => {
    getUserIdFromAuthHeader.mockResolvedValue(null);

    const { POST } = await import("../../src/bigtable/routes/ai.meal-plan.js");
    const response = await POST(
      buildUnauthenticatedJsonRequest("http://localhost/api/ai/meal-plan", { prompt: "busy week" }) as never
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    assertErrorResponse(payload);
    expect(payload.error).toBe("Unauthorized");
  });

  it("returns 403 when caller is a household member", async () => {
    getUserIdFromAuthHeader.mockResolvedValue("member-1");
    membershipOrganizerId = "organizer-1";

    const { POST } = await import("../../src/bigtable/routes/ai.meal-plan.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/meal-plan", { prompt: "busy week" }) as never
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(403);
    expect(payload.error).toBe("Your organizer hasn't granted you access to AI meal planning");
    expect(buildMealPlan).not.toHaveBeenCalled();
  });

  it("returns 500 when plan generation throws", async () => {
    getUserIdFromAuthHeader.mockResolvedValue("user-1");
    getUsageStatus.mockResolvedValue(usageFixture({ requestsUsed: 2, requestsLimit: 1000000 }));
    buildMealPlan.mockRejectedValue(new Error("Provider unavailable"));

    const { POST } = await import("../../src/bigtable/routes/ai.meal-plan.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/meal-plan", { prompt: "busy week" }) as never
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    assertErrorResponse(payload);
    expect(payload.error).toBe("Failed to generate meal plan");
  });
});
