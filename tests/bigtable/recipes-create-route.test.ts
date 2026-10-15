import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAuthenticatedJsonRequest } from "./helpers/session.js";

const getUserIdFromAuthHeader = vi.fn();
const fromMock = vi.fn();

const recipesInsertSingleMock = vi.fn();
const recipesInsertSelectMock = vi.fn();
const recipesInsertMock = vi.fn();
const recipesDeleteEqMock = vi.fn();
const recipesDeleteMock = vi.fn();
const recipeIngredientsInsertMock = vi.fn();
const savedRecipesUpsertMock = vi.fn();

const recipesTable = {
  insert: recipesInsertMock,
  delete: recipesDeleteMock,
};

const recipeIngredientsTable = {
  insert: recipeIngredientsInsertMock,
};

const savedRecipesTable = {
  upsert: savedRecipesUpsertMock,
};

const supabaseAdmin = {
  from: fromMock,
};

vi.mock("../../src/bigtable/lib/auth.js", () => ({
  getUserIdFromAuthHeader,
}));

vi.mock("../../src/bigtable/lib/supabase.js", () => ({
  supabaseAdmin,
}));

describe("POST /api/recipes", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    getUserIdFromAuthHeader.mockResolvedValue("user-1");

    recipesInsertSingleMock.mockResolvedValue({
      data: { id: "recipe-1" },
      error: null,
    });
    recipesInsertSelectMock.mockReturnValue({
      single: recipesInsertSingleMock,
    });
    recipesInsertMock.mockReturnValue({
      select: recipesInsertSelectMock,
    });

    recipesDeleteEqMock.mockResolvedValue({ error: null });
    recipesDeleteMock.mockReturnValue({ eq: recipesDeleteEqMock });

    recipeIngredientsInsertMock.mockResolvedValue({ error: null });
    savedRecipesUpsertMock.mockResolvedValue({ error: null });

    fromMock.mockImplementation((table: string) => {
      if (table === "recipes") {
        return recipesTable;
      }
      if (table === "recipe_ingredients") {
        return recipeIngredientsTable;
      }
      if (table === "saved_recipes") {
        return savedRecipesTable;
      }
      throw new Error(`Unexpected table: ${table}`);
    });
  });

  it("creates a recipe and saves it to favorites", async () => {
    const { POST } = await import("../../src/bigtable/routes/recipes.js");

    const response = await POST(
      buildAuthenticatedJsonRequest("http://localhost/api/recipes", {
        title: "Sheet Pan Tacos",
        imageUrl: "https://example.com/recipes/tacos.jpg",
        description: "Weeknight favorite",
        tags: ["dinner", "quick"],
        ingredients: [
          { name: "Tortillas", amount: 8, measurementType: "piece" },
          { name: "Ground beef", amount: 1, measurementType: "lb" },
        ],
        instructions: ["Brown beef", "Assemble tacos"],
      }) as never
    );

    const payload = (await response.json()) as { id: string };

    expect(response.status).toBe(201);
    expect(payload.id).toBe("recipe-1");
    expect(recipeIngredientsInsertMock).toHaveBeenCalledWith([
      {
        recipe_id: "recipe-1",
        name: "Tortillas",
        amount: 8,
        measurement_type: "piece",
        quantity: 8,
        unit: "piece",
        notes: null,
      },
      {
        recipe_id: "recipe-1",
        name: "Ground beef",
        amount: 1,
        measurement_type: "lb",
        quantity: 1,
        unit: "lb",
        notes: null,
      },
    ]);
    expect(savedRecipesUpsertMock).toHaveBeenCalledWith({
      profile_id: "user-1",
      recipe_id: "recipe-1",
    });
  });
});
