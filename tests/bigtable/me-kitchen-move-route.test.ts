import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSupabase, eqValue, hasFilter, type QueryCall, type QueryResult } from "./helpers/fake-supabase.js";
import { buildAuthenticatedJsonRequest } from "./helpers/session.js";

const getUserIdFromAuthHeader = vi.fn();

let fake: ReturnType<typeof createFakeSupabase>;
const supabaseAdmin = {
  from: (table: string) => fake.client.from(table),
  rpc: (fn: string, args: Record<string, unknown>) => fake.client.rpc(fn, args),
};

vi.mock("../../src/bigtable/lib/auth.js", () => ({ getUserIdFromAuthHeader }));
vi.mock("../../src/bigtable/lib/supabase.js", () => ({ supabaseAdmin }));

let respondWith: (call: QueryCall) => QueryResult | undefined = () => ({ data: null });

function request(path: string, payload: Record<string, unknown> = {}, method = "POST") {
  return buildAuthenticatedJsonRequest(`http://localhost/v1/bigtable/me/${path}`, payload, "token", { method });
}

function exportRequest() {
  return new Request("http://localhost/v1/bigtable/me/kitchen-export", { headers: { authorization: "Bearer token" } });
}

describe("PUT /me/public-profile", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getUserIdFromAuthHeader.mockResolvedValue("user-1");
    fake = createFakeSupabase(() => ({ data: null }));
  });

  it("trims and saves the display name", async () => {
    const { PUT } = await import("../../src/bigtable/routes/me.public-profile.js");
    const response = await PUT(request("public-profile", { displayName: "  The Warrens  " }, "PUT"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ displayName: "The Warrens" });
    const [update] = fake.callsTo("profiles", "update");
    expect(update!.payload).toEqual({ display_name: "The Warrens" });
    expect(eqValue(update!, "id")).toBe("user-1");
  });

  it("clears it for an empty string or null", async () => {
    const { PUT } = await import("../../src/bigtable/routes/me.public-profile.js");
    expect(await (await PUT(request("public-profile", { displayName: "   " }, "PUT"))).json()).toEqual({ displayName: null });
    expect(await (await PUT(request("public-profile", { displayName: null }, "PUT"))).json()).toEqual({ displayName: null });
    expect(fake.callsTo("profiles", "update").map((call) => call.payload)).toEqual([
      { display_name: null },
      { display_name: null },
    ]);
  });

  it("rejects names over 60 characters", async () => {
    const { PUT } = await import("../../src/bigtable/routes/me.public-profile.js");
    const response = await PUT(request("public-profile", { displayName: "x".repeat(61) }, "PUT"));
    expect(response.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("POST /me/kitchen-moved", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getUserIdFromAuthHeader.mockResolvedValue("user-1");
    fake = createFakeSupabase((call) => respondWith(call));
  });

  it("records the move once", async () => {
    respondWith = (call) => (call.op === "update" ? { data: [{ kitchen_moved_at: "2026-10-19T12:00:00.000Z" }] } : { data: null });
    const { POST } = await import("../../src/bigtable/routes/me.kitchen-moved.js");
    const response = await POST(request("kitchen-moved"));

    expect(await response.json()).toEqual({ movedAt: "2026-10-19T12:00:00.000Z" });
    const [update] = fake.callsTo("profiles", "update");
    expect(eqValue(update!, "id")).toBe("user-1");
    expect(hasFilter(update!, "is", "kitchen_moved_at")).toBe(true);
  });

  it("keeps the first date when called again", async () => {
    respondWith = (call) =>
      call.op === "update" ? { data: [] } : { data: { kitchen_moved_at: "2026-10-01T08:00:00.000Z" } };
    const { POST } = await import("../../src/bigtable/routes/me.kitchen-moved.js");
    const response = await POST(request("kitchen-moved"));

    expect(await response.json()).toEqual({ movedAt: "2026-10-01T08:00:00.000Z" });
  });
});

describe("GET /me/kitchen-export", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getUserIdFromAuthHeader.mockResolvedValue("user-1");
    fake = createFakeSupabase((call) => respondWith(call));
  });

  it("refuses household members", async () => {
    respondWith = (call) => (call.table === "household_memberships" ? { data: { organizer_id: "organizer-1" } } : { data: null });
    const { GET } = await import("../../src/bigtable/routes/me.kitchen-export.js");
    const response = await GET(exportRequest());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "NOT_ORGANIZER" });
  });

  it("exports the organizer's recipes, tags, plans, grocery and household", async () => {
    respondWith = (call) => {
      switch (call.table) {
        case "household_memberships":
          return { data: null };
        case "recipes":
          if (call.columns === "id, status, current_version_id") {
            return { data: [] };
          }
          return {
            data: [
              {
                id: "recipe-1", title: "Soup", description: null, image_url: "https://img/soup.jpg", prep_minutes: 5,
                cook_minutes: 30, base_servings: 4, difficulty: null, tags: ["dinner"], instructions: ["Simmer"],
                source_name: "user", source_url: null, attribution_required: false, attribution_text: null,
                status: "removed", current_version_id: null, created_by_profile_id: "user-1", published_at: null, like_count: 0,
              },
            ],
          };
        case "recipe_ingredients":
          return { data: [{ id: "ing-1", recipe_id: "recipe-1", name: "Water", amount: 1, measurement_type: "l", quantity: 1, unit: "l" }] };
        case "saved_recipes":
          return { data: [{ recipe_id: "recipe-1", version_id: null }] };
        case "recipe_likes":
        case "recipe_versions":
          return { data: [] };
        case "profiles":
          if (call.columns === "id, display_name") {
            return { data: [] };
          }
          return { data: { household_name: "The Warrens", avatar_url: null } };
        case "household_members":
          if (call.terminal === "maybeSingle") {
            return { data: { name: "Steve", avatar_url: null } };
          }
          return { data: [{ id: "member-1", name: "Steve" }, { id: "member-2", name: "June" }] };
        case "custom_recipe_tags":
          return { data: [{ id: "tag-1", label: "Weeknight", normalized: "weeknight" }] };
        case "weekly_plans":
          return { data: [{ id: "plan-1", week_start: "2026-10-18" }] };
        case "meal_slots":
          return { data: [{ id: "slot-1", day: "monday", slot: "dinner", custom_meal: "Soup", dine_out: null, recipe_items: [{ title: "Soup", role: "entree", imageUrl: null }], snack_items: [], excluded_members: [], completed: false }] };
        case "grocery_snapshots":
          return { data: [] };
        default:
          throw new Error(`Unexpected table ${call.table}`);
      }
    };

    const { GET } = await import("../../src/bigtable/routes/me.kitchen-export.js");
    const response = await GET(exportRequest());
    const payload = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(Object.keys(payload).sort()).toEqual(["grocery", "householdMembers", "plans", "recipes", "tags"]);
    expect(payload.recipes).toHaveLength(1);
    expect(payload.recipes[0]).toMatchObject({
      id: "recipe-1",
      status: "removed",
      isFavorite: true,
      creatorName: "Steve",
      versionCount: 0,
      ingredients: [{ id: "ing-1", name: "Water", amount: 1, measurementType: "l" }],
    });
    expect(payload.tags).toEqual([{ id: "tag-1", label: "Weeknight", normalized: "weeknight" }]);
    expect(payload.plans).toHaveLength(1);
    expect(payload.plans[0]).toMatchObject({ planId: "plan-1", weekStart: "2026-10-18" });
    expect(payload.plans[0].days.monday.dinner).toMatchObject({ id: "slot-1", customMeal: "Soup" });
    expect(payload.grocery).toEqual({ snapshots: [], activeSnapshotId: null });
    expect(payload.householdMembers).toEqual([{ id: "member-1", name: "Steve" }, { id: "member-2", name: "June" }]);
    expect(fake.calls.every((call) => call.op === "select")).toBe(true);
  });
});
