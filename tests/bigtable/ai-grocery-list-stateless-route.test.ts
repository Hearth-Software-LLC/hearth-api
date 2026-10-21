import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSupabase, type QueryCall, type QueryResult } from "./helpers/fake-supabase.js";
import { buildAuthenticatedJsonRequest } from "./helpers/session.js";

const getUserIdFromAuthHeader = vi.fn();
const getUsageStatus = vi.fn();
const incrementUsageBy = vi.fn();
const canConsumeCredits = vi.fn();
const buildGroceryList = vi.fn();
const GroceryListGenerationError = class extends Error {
  code = "UNKNOWN";
  status = 500;
};

let fake: ReturnType<typeof createFakeSupabase>;
const supabaseAdmin = {
  from: (table: string) => fake.client.from(table),
  rpc: (fn: string, args: Record<string, unknown>) => fake.client.rpc(fn, args),
};

vi.mock("../../src/bigtable/lib/auth.js", () => ({ getUserIdFromAuthHeader }));
vi.mock("../../src/bigtable/lib/rate-limit.js", () => ({ getUsageStatus, incrementUsageBy, canConsumeCredits }));
vi.mock("../../src/bigtable/lib/ai-grocery-list.js", () => ({ buildGroceryList, GroceryListGenerationError }));
vi.mock("../../src/services/supabase.js", () => ({ supabaseAdmin }));

function respond(call: QueryCall): QueryResult | undefined {
  if (call.table === "household_memberships") {
    return { data: null };
  }
  if (call.table === "recipes") {
    return { data: [{ id: "pub-1", title: "Sheet Pan Fajitas", base_servings: 4 }] };
  }
  if (call.table === "recipe_ingredients") {
    return { data: [{ recipe_id: "pub-1", name: "Bell pepper", quantity: 2, unit: "whole" }] };
  }
  throw new Error(`Unexpected ${call.op} on ${call.table}`);
}

const household = { people: [{ age: 41, role: "parent" }, { age: 39, role: "parent" }, { age: 9, role: "kid" }, { age: 6, role: "kid" }], allergies: [], restrictions: [], likes: [], dislikes: [] };

function tomorrowIso() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

describe("POST /ai/grocery-list with plannedMeals (stateless)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fake = createFakeSupabase(respond);
    getUserIdFromAuthHeader.mockResolvedValue("user-1");
    getUsageStatus.mockResolvedValue({ tier: "pro", requestsUsed: 0, requestsLimit: 1000000, resetsAt: "2026-11-01T00:00:00.000Z", canMakeRequest: true });
    canConsumeCredits.mockReturnValue(true);
    incrementUsageBy.mockResolvedValue(undefined);
    buildGroceryList.mockResolvedValue({ source: "fallback", groceryList: { sections: [] } });
  });

  it("uses the meals and ingredients sent, looking up only meals without ingredients", async () => {
    const iso = tomorrowIso();
    const { POST } = await import("../../src/bigtable/routes/ai.grocery-list.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/v1/bigtable/ai/grocery-list", {
        selectedDates: [iso],
        household,
        plannedMeals: [
          {
            isoDate: iso,
            day: "monday",
            slot: "dinner",
            title: "Taco Tuesday Bowls",
            eaters: 2,
            baseServings: 4,
            ingredients: [
              { name: "Black beans", amount: 2, measurementType: "can" },
              { name: "Lime" },
            ],
          },
          { isoDate: iso, day: "monday", slot: "lunch", title: "Sheet Pan Fajitas", eaters: 4 },
        ],
      }) as never
    );

    expect(response.status).toBe(200);
    const input = buildGroceryList.mock.calls[0]![0];
    expect(input.meals).toEqual([
      "Taco Tuesday Bowls (make a smaller portion; 2 household member(s) are away)",
      "Sheet Pan Fajitas",
    ]);
    expect(input.recipeTitles).toEqual(["Sheet Pan Fajitas", "Taco Tuesday Bowls"]);
    expect(input.plannedMeals).toEqual([
      { isoDate: iso, day: "monday", slot: "dinner", title: "Taco Tuesday Bowls", eaters: 2 },
      { isoDate: iso, day: "monday", slot: "lunch", title: "Sheet Pan Fajitas", eaters: 4 },
    ]);
    expect(input.ingredientNeeds).toEqual([
      { name: "Bell pepper", unit: "whole", totalQuantity: 2, occurrences: 1, recipes: ["Sheet Pan Fajitas"], notes: [] },
      { name: "Black beans", unit: "can", totalQuantity: 1, occurrences: 1, recipes: ["Taco Tuesday Bowls"], notes: [] },
      { name: "Lime", unit: null, totalQuantity: null, occurrences: 1, recipes: ["Taco Tuesday Bowls"], notes: [] },
    ]);

    // Only the meal without ingredients was looked up, by title.
    const [recipeLookup] = fake.callsTo("recipes");
    expect(recipeLookup!.filters).toContainEqual({ method: "in", args: ["title", ["Sheet Pan Fajitas"]] });

    expect(fake.callsTo("weekly_plans")).toHaveLength(0);
    expect(fake.callsTo("meal_slots")).toHaveLength(0);
    expect(fake.calls.every((call) => call.op === "select")).toBe(true);
    expect(incrementUsageBy).toHaveBeenCalledWith("user-1", "grocery_list", 1);
  });

  it("answers PLAN_EMPTY for an empty plannedMeals", async () => {
    const { POST } = await import("../../src/bigtable/routes/ai.grocery-list.js");
    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/v1/bigtable/ai/grocery-list", {
        selectedDates: [tomorrowIso()],
        household,
        plannedMeals: [],
      }) as never
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "PLAN_EMPTY" });
    expect(fake.callsTo("meal_slots")).toHaveLength(0);
    expect(buildGroceryList).not.toHaveBeenCalled();
  });
});
