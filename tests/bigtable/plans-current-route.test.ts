import { beforeEach, describe, expect, it, vi } from "vitest";

const getUserIdFromAuthHeader = vi.fn();
const fromMock = vi.fn();
const rpcMock = vi.fn();

type Row = Record<string, unknown>;

let mealSlotsRows: Row[] = [];
let recipeMetaRows: Row[] = [];
let membershipOrganizerId: string | null = null;

const supabaseAdmin = {
  from: fromMock,
  rpc: rpcMock,
};

vi.mock("../../src/bigtable/lib/auth.js", () => ({
  getUserIdFromAuthHeader,
}));

vi.mock("../../src/services/supabase.js", () => ({
  supabaseAdmin,
}));

function createTableMock(table: string) {
  if (table === "weekly_plans") {
    return {
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({
              data: { id: "plan-1", week_start: "2026-05-25" },
              error: null,
            })),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn(async () => ({
            data: { id: "plan-1", week_start: "2026-05-25" },
            error: null,
          })),
        })),
      })),
    };
  }

  if (table === "meal_slots") {
    return {
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
            Promise.resolve({ data: mealSlotsRows, error: null }).then(resolve),
        })),
      })),
    };
  }

  if (table === "recipes") {
    return {
      select: vi.fn(() => ({
        in: vi.fn(async () => ({
          data: recipeMetaRows,
          error: null,
        })),
      })),
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
    // Members start with no permissions until their organizer grants them.
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

describe("GET /api/plans/current", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    membershipOrganizerId = null;
    rpcMock.mockResolvedValue({ data: "user-1", error: null });
    recipeMetaRows = [];
    mealSlotsRows = [
      {
        id: "slot-1",
        day: "monday",
        slot: "dinner",
        custom_meal: "Dine Out: Subway - 285 E Main St",
        dine_out: {
          label: "Subway - 285 E Main St",
          name: "Subway",
          address: "285 E Main St",
          phone: null,
          latitude: 39.9,
          longitude: -111.8,
          logoUrl: "https://img.logo.dev/subway.com",
        },
        recipe_items: [{ title: "Should not render", role: "entree", imageUrl: null }],
        excluded_members: [],
        completed: false,
      },
    ];
    fromMock.mockImplementation((table: string) => createTableMock(table));
  });

  it("returns dineOut slots without recipeItems", async () => {
    getUserIdFromAuthHeader.mockResolvedValue("user-1");

    const { GET } = await import("../../src/bigtable/routes/plans.current.js");
    const request = new Request("http://localhost/api/plans/current", {
      headers: {
        authorization: "Bearer token",
      },
    });

    const response = await GET(request as never);
    const payload = (await response.json()) as {
      days: {
        monday: {
          dinner: {
            customMeal: string | null;
            recipeItems: Array<{ title: string }>;
            dineOut: { label: string } | null;
          };
        };
      };
    };

    expect(response.status).toBe(200);
    expect(payload.days.monday.dinner.dineOut?.label).toBe("Subway - 285 E Main St");
    expect(payload.days.monday.dinner.customMeal).toBeNull();
    expect(payload.days.monday.dinner.recipeItems).toEqual([]);
  });

  it("parses recipe_items contract fields and drops invalid id/version pairs", async () => {
    mealSlotsRows = [
      {
        id: "slot-2",
        day: "monday",
        slot: "lunch",
        custom_meal: "Pinned Lunch",
        dine_out: null,
        recipe_items: [
          {
            title: "Pinned Wrap",
            role: "entree",
            imageUrl: "https://example.com/wrap.jpg",
            recipeId: "recipe-1",
            recipeVersionId: "version-1",
            source: "library",
          },
          {
            title: "Broken Item",
            role: "entree",
            recipeId: "recipe-2",
          },
        ],
        excluded_members: [],
        completed: false,
      },
    ];
    recipeMetaRows = [
      {
        id: "recipe-1",
        status: "published",
        current_version_id: "version-2",
      },
    ];

    getUserIdFromAuthHeader.mockResolvedValue("user-1");

    const { GET } = await import("../../src/bigtable/routes/plans.current.js");
    const request = new Request("http://localhost/api/plans/current", {
      headers: {
        authorization: "Bearer token",
      },
    });

    const response = await GET(request as never);
    const payload = (await response.json()) as {
      days: {
        monday: {
          lunch: {
            recipeItems: Array<{
              title: string;
              recipeId?: string;
              recipeVersionId?: string;
              source?: string;
              recipeStatus?: string;
              currentVersionId?: string | null;
              hasUpdateAvailable?: boolean;
            }>;
          };
        };
      };
    };

    expect(response.status).toBe(200);
    expect(payload.days.monday.lunch.recipeItems).toHaveLength(1);
    expect(payload.days.monday.lunch.recipeItems[0]).toMatchObject({
      title: "Pinned Wrap",
      recipeId: "recipe-1",
      recipeVersionId: "version-1",
      source: "library",
      recipeStatus: "published",
      currentVersionId: "version-2",
      hasUpdateAvailable: true,
    });
  });

  it("loads organizer plan when effective_profile_id resolves a member to organizer", async () => {
    rpcMock.mockResolvedValue({ data: "organizer-1", error: null });

    getUserIdFromAuthHeader.mockResolvedValue("member-1");

    const { GET } = await import("../../src/bigtable/routes/plans.current.js");
    const request = new Request("http://localhost/api/plans/current", {
      headers: {
        authorization: "Bearer token",
      },
    });

    const response = await GET(request as never);

    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("effective_profile_id", { uid: "member-1" });
  });

  it("returns 403 on PUT when caller is a member", async () => {
    membershipOrganizerId = "organizer-1";
    getUserIdFromAuthHeader.mockResolvedValue("member-1");

    const { PUT } = await import("../../src/bigtable/routes/plans.current.js");
    const response = await PUT(new Request("http://localhost/api/plans/current", {
      method: "PUT",
      headers: {
        authorization: "Bearer token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        day: "monday",
        slot: "dinner",
        customMeal: "Pasta",
      }),
    }) as never);

    const payload = (await response.json()) as { error?: string };
    expect(response.status).toBe(403);
    expect(payload.error).toBe("You don't have permission to edit the meal plan");
  });
});
