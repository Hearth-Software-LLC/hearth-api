import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAuthHeader } from "./helpers/session.js";

const getUserIdFromAuthHeader = vi.fn();
const fromMock = vi.fn();

const recipesSelectSingleMock = vi.fn();
const recipesSelectEqMock = vi.fn();
const recipesSelectMock = vi.fn();
const recipesUpdateEqMock = vi.fn();
const recipesUpdateMock = vi.fn();
const recipesDeleteEqMock = vi.fn();
const recipesDeleteMock = vi.fn();

const savedRecipesEqMock = vi.fn();
const savedRecipesSelectMock = vi.fn();

const mealSlotsFilterMock = vi.fn();
const mealSlotsSelectMock = vi.fn();

const recipesTable = {
  select: recipesSelectMock,
  update: recipesUpdateMock,
  delete: recipesDeleteMock,
};

const savedRecipesTable = {
  select: savedRecipesSelectMock,
};

const mealSlotsTable = {
  select: mealSlotsSelectMock,
};

vi.mock("../../src/bigtable/lib/auth.js", () => ({
  getUserIdFromAuthHeader,
}));

vi.mock("../../src/bigtable/lib/supabase.js", () => ({
  supabaseAdmin: {
    from: fromMock,
  },
}));

describe("DELETE /api/recipes/[id]", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    getUserIdFromAuthHeader.mockResolvedValue("user-1");

    recipesSelectSingleMock.mockResolvedValue({
      data: {
        source_name: "user",
        created_by_profile_id: "user-1",
      },
      error: null,
    });
    recipesSelectEqMock.mockReturnValue({ single: recipesSelectSingleMock });
    recipesSelectMock.mockReturnValue({ eq: recipesSelectEqMock });

    recipesUpdateEqMock.mockResolvedValue({ error: null });
    recipesUpdateMock.mockReturnValue({ eq: recipesUpdateEqMock });

    recipesDeleteEqMock.mockResolvedValue({ error: null });
    recipesDeleteMock.mockReturnValue({ eq: recipesDeleteEqMock });

    savedRecipesEqMock.mockResolvedValue({ count: 0, error: null });
    savedRecipesSelectMock.mockReturnValue({ eq: savedRecipesEqMock });

    mealSlotsFilterMock.mockResolvedValue({ count: 0, error: null });
    mealSlotsSelectMock.mockReturnValue({ filter: mealSlotsFilterMock });

    fromMock.mockImplementation((table: string) => {
      if (table === "recipes") {
        return recipesTable;
      }
      if (table === "saved_recipes") {
        return savedRecipesTable;
      }
      if (table === "meal_slots") {
        return mealSlotsTable;
      }
      throw new Error(`Unexpected table: ${table}`);
    });
  });

  it("soft-removes recipe when dependencies exist", async () => {
    savedRecipesEqMock.mockResolvedValueOnce({ count: 2, error: null });
    mealSlotsFilterMock.mockResolvedValueOnce({ count: 1, error: null });

    const { DELETE } = await import("../../src/bigtable/routes/recipes._id.js");

    const response = await DELETE(
      new Request("http://localhost/api/recipes/recipe-1", {
        method: "DELETE",
        headers: { authorization: buildAuthHeader() },
      }) as never,
      { params: Promise.resolve({ id: "recipe-1" }) } as never
    );

    const payload = await response.json() as { hardDeleted: boolean; dependencies: number };

    expect(response.status).toBe(200);
    expect(payload.hardDeleted).toBe(false);
    expect(payload.dependencies).toBe(3);
    expect(recipesUpdateMock).toHaveBeenCalledWith({ status: "removed" });
    expect(recipesDeleteMock).not.toHaveBeenCalled();
  });

  it("hard-deletes recipe when there are no dependencies", async () => {
    const { DELETE } = await import("../../src/bigtable/routes/recipes._id.js");

    const response = await DELETE(
      new Request("http://localhost/api/recipes/recipe-1", {
        method: "DELETE",
        headers: { authorization: buildAuthHeader() },
      }) as never,
      { params: Promise.resolve({ id: "recipe-1" }) } as never
    );

    const payload = await response.json() as { hardDeleted: boolean; dependencies: number };

    expect(response.status).toBe(200);
    expect(payload.hardDeleted).toBe(true);
    expect(payload.dependencies).toBe(0);
    expect(recipesDeleteMock).toHaveBeenCalled();
    expect(recipesUpdateMock).not.toHaveBeenCalled();
  });
});
