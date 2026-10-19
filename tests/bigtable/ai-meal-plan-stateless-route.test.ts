import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSupabase, type QueryCall, type QueryResult } from "./helpers/fake-supabase.js";
import { buildAuthenticatedJsonRequest } from "./helpers/session.js";

const getUserIdFromAuthHeader = vi.fn();
const getUsageStatus = vi.fn();
const incrementUsageBy = vi.fn();
const canConsumeCredits = vi.fn();
const buildMealPlan = vi.fn();

let fake: ReturnType<typeof createFakeSupabase>;
const supabaseAdmin = {
  from: (table: string) => fake.client.from(table),
  rpc: (fn: string, args: Record<string, unknown>) => fake.client.rpc(fn, args),
};

vi.mock("../../src/bigtable/lib/auth.js", () => ({ getUserIdFromAuthHeader }));
vi.mock("../../src/bigtable/lib/rate-limit.js", () => ({ getUsageStatus, incrementUsageBy, canConsumeCredits }));
vi.mock("../../src/bigtable/lib/ai-meal-plan.js", () => ({ buildMealPlan }));
vi.mock("../../src/bigtable/lib/supabase.js", () => ({ supabaseAdmin }));

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

function futureIso(daysAhead: number) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + daysAhead);
  const iso = new Date(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T00:00:00`);
  return {
    iso: `${iso.getFullYear()}-${String(iso.getMonth() + 1).padStart(2, "0")}-${String(iso.getDate()).padStart(2, "0")}`,
    day: DAY_NAMES[iso.getDay()]!,
  };
}

function planWith(overrides: Record<string, Record<string, string>> = {}) {
  const plan: Record<string, Record<string, string>> = {};
  for (const day of ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]) {
    plan[day] = { breakfast: "Toast", lunch: "Salad", dinner: "Mystery Stew", ...(overrides[day] ?? {}) };
  }
  return plan;
}

function respond(call: QueryCall): QueryResult | undefined {
  if (call.table === "household_memberships") {
    return { data: null };
  }
  if (call.table === "saved_recipes") {
    return { data: [{ recipe_id: "fav-1" }] };
  }
  if (call.table === "recipes") {
    return {
      data: [
        { id: "fav-1", title: "Grandma's Lasagna", tags: [], prep_minutes: 20, cook_minutes: 60, image_url: "https://img/lasagna.jpg", created_by_profile_id: "user-9" },
        { id: "pub-1", title: "Sheet Pan Fajitas", tags: [], prep_minutes: 10, cook_minutes: 20, image_url: null, created_by_profile_id: "user-8" },
      ],
    };
  }
  throw new Error(`Unexpected ${call.op} on ${call.table}`);
}

const household = { people: [{ age: 41, role: "parent" }, { age: 9, role: "kid" }], allergies: ["peanuts"], restrictions: [], likes: [], dislikes: [] };

const usage = {
  tier: "pro",
  requestsUsed: 2,
  requestsLimit: 1000000,
  resetsAt: "2026-11-01T00:00:00.000Z",
  canMakeRequest: true,
};

describe("POST /ai/meal-plan with myRecipes (stateless)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fake = createFakeSupabase(respond);
    getUserIdFromAuthHeader.mockResolvedValue("user-1");
    getUsageStatus.mockResolvedValueOnce(usage).mockResolvedValueOnce({ ...usage, requestsUsed: 4 });
    canConsumeCredits.mockReturnValue(true);
    incrementUsageBy.mockResolvedValue(undefined);
  });

  it("plans from the client's recipes without touching the stored plan", async () => {
    const first = futureIso(2);
    const second = futureIso(3);
    buildMealPlan.mockResolvedValue({
      source: "anthropic",
      plan: planWith({
        [first.day]: { dinner: "Taco Tuesday Bowls" },
        [second.day]: { dinner: "grandma's lasagna", lunch: "Sheet Pan Fajitas" },
      }),
    });

    const { POST } = await import("../../src/bigtable/routes/ai.meal-plan.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/v1/bigtable/ai/meal-plan", {
        selectedDates: [first.iso, second.iso],
        selectedMeals: { [first.day]: ["dinner"], [second.day]: ["lunch", "dinner"] },
        recipeMix: { mine: 50, favorites: 25, other: 25 },
        previewOnly: false,
        overwriteExisting: false,
        household,
        myRecipes: [
          { id: "ck-recipe-1", title: "Taco Tuesday Bowls", tags: ["dinner"], minutes: 30 },
          { id: "", title: "No id, skipped" },
        ],
      }) as never
    );
    const payload = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(Object.keys(payload).sort()).toEqual(["generatedBy", "generatedPlan", "recipeLookup", "usage"]);
    expect(payload.generatedBy).toBe("anthropic");

    // The "mine" bucket is the client's recipes; favorites and other still come from the server.
    const input = buildMealPlan.mock.calls[0]![0];
    expect(input.recipeBuckets.mine).toEqual([
      { title: "Taco Tuesday Bowls", tags: ["dinner"], prepMinutes: null, cookMinutes: 30 },
    ]);
    expect(input.recipeBuckets.favorites.map((recipe: { title: string }) => recipe.title)).toEqual(["Grandma's Lasagna"]);
    expect(input.recipeBuckets.other.map((recipe: { title: string }) => recipe.title)).toEqual(["Sheet Pan Fajitas"]);

    expect(payload.recipeLookup).toEqual({
      "taco tuesday bowls": { recipeId: "ck-recipe-1", imageUrl: null, bucket: "mine" },
      "grandma's lasagna": { recipeId: "fav-1", imageUrl: "https://img/lasagna.jpg", bucket: "favorites" },
      "sheet pan fajitas": { recipeId: "pub-1", imageUrl: null, bucket: "other" },
    });

    // Two selected dates with slots: two credits, even though overwriteExisting was false.
    expect(incrementUsageBy).toHaveBeenCalledWith("user-1", "meal_plan", 2);
    expect(payload.usage).toMatchObject({ creditsCharged: 2, requestedCredits: 2, requestsUsed: 4 });

    // Nothing read from or written to plans.
    expect(fake.callsTo("weekly_plans")).toHaveLength(0);
    expect(fake.callsTo("meal_slots")).toHaveLength(0);
    expect(fake.calls.every((call) => call.op === "select")).toBe(true);
  });

  it("doesn't persist even when previewOnly is false and returns no planner", async () => {
    const date = futureIso(1);
    buildMealPlan.mockResolvedValue({ source: "fallback", plan: planWith() });

    const { POST } = await import("../../src/bigtable/routes/ai.meal-plan.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/v1/bigtable/ai/meal-plan", {
        selectedDates: [date.iso],
        selectedMeals: { [date.day]: ["breakfast", "lunch", "dinner"] },
        household,
        myRecipes: [],
      }) as never
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.planner).toBeUndefined();
    expect(payload.previewPlanner).toBeUndefined();
    expect(payload.recipeLookup).toEqual({});
    expect(incrementUsageBy).toHaveBeenCalledWith("user-1", "meal_plan", 1);
    expect(fake.callsTo("meal_slots")).toHaveLength(0);
  });

  it("rejects a myRecipes that isn't an array", async () => {
    const { POST } = await import("../../src/bigtable/routes/ai.meal-plan.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/v1/bigtable/ai/meal-plan", { myRecipes: { id: "x" } }) as never
    );
    expect(response.status).toBe(400);
    expect(buildMealPlan).not.toHaveBeenCalled();
  });
});
