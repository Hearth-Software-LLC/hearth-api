import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAuthHeader } from "./helpers/session.js";

const getUserIdFromAuthHeader = vi.fn();
const fromMock = vi.fn();

const supabaseAdmin = {
  from: fromMock,
};

vi.mock("../../src/bigtable/lib/auth.js", () => ({
  getUserIdFromAuthHeader,
}));

vi.mock("../../src/services/supabase.js", () => ({
  supabaseAdmin,
}));

function createRecipesTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        single: vi.fn(async () => ({
          data: {
            id: "recipe-1",
            title: "Recipe",
            description: "Desc",
            image_url: null,
            prep_minutes: 10,
            cook_minutes: 20,
            base_servings: 4,
            difficulty: "easy",
            tags: ["dessert"],
            instructions: ["Mix", "Bake"],
            source_name: "user",
            source_id: null,
            source_url: null,
            attribution_required: false,
            attribution_text: null,
            status: "published",
            current_version_id: null,
            created_by_profile_id: "creator-1",
            published_at: "2026-06-01T00:00:00.000Z",
            like_count: 0,
          },
          error: null,
        })),
      })),
    })),
  };
}

function createSavedRecipesTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({ data: null, error: null })),
        })),
      })),
    })),
  };
}

function createRecipeLikesTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({ data: null, error: null })),
        })),
      })),
    })),
  };
}

function createProfilesTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn(async () => ({
          data: {
            household_name: "Old Household Name",
            avatar_url: null,
          },
          error: null,
        })),
      })),
    })),
  };
}

function createHouseholdMembersTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn((column: string) => ({
        order: vi.fn(() => ({
          limit: vi.fn(() => ({
            maybeSingle: vi.fn(async () => {
              if (column === "linked_profile_id") {
                return {
                  data: {
                    name: "Actual User Name",
                    avatar_url: "https://img.example/user-avatar.png",
                  },
                  error: null,
                };
              }

              return {
                data: {
                  name: "Organizer Household Name",
                  avatar_url: "https://img.example/organizer-avatar.png",
                },
                error: null,
              };
            }),
          })),
        })),
      })),
    })),
  };
}

function createRecipeIngredientsTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        order: vi.fn(async () => ({
          data: [
            {
              id: "ingredient-1",
              name: "Flour",
              amount: 1,
              measurement_type: "cup",
              quantity: null,
              unit: null,
            },
          ],
          error: null,
        })),
      })),
    })),
  };
}

function createRecipeVersionsTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn(async () => ({ count: 0, error: null })),
    })),
  };
}

describe("GET /api/recipes/[id] creator identity", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getUserIdFromAuthHeader.mockResolvedValue("caller-1");

    fromMock.mockImplementation((table: string) => {
      if (table === "recipes") {
        return createRecipesTableMock();
      }
      if (table === "saved_recipes") {
        return createSavedRecipesTableMock();
      }
      if (table === "recipe_likes") {
        return createRecipeLikesTableMock();
      }
      if (table === "profiles") {
        return createProfilesTableMock();
      }
      if (table === "household_members") {
        return createHouseholdMembersTableMock();
      }
      if (table === "recipe_ingredients") {
        return createRecipeIngredientsTableMock();
      }
      if (table === "recipe_versions") {
        return createRecipeVersionsTableMock();
      }
      throw new Error(`Unexpected table: ${table}`);
    });
  });

  it("prefers linked member name/avatar over household profile metadata", async () => {
    const { GET } = await import("../../src/bigtable/routes/recipes._id.js");
    const response = await GET(
      new Request("http://localhost/api/recipes/recipe-1", {
        headers: {
          authorization: buildAuthHeader(),
        },
      }) as never,
      { params: Promise.resolve({ id: "recipe-1" }) },
    );

    const payload = (await response.json()) as {
      recipe: {
        creatorName: string | null;
        creatorAvatarUrl: string | null;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.recipe.creatorName).toBe("Actual User Name");
    expect(payload.recipe.creatorAvatarUrl).toBe("https://img.example/user-avatar.png");
  });
});
