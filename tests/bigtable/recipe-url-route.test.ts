import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAuthenticatedJsonRequest, buildUnauthenticatedJsonRequest } from "./helpers/session.js";

const getUserIdFromAuthHeader = vi.fn();
const importRecipeFromUrl = vi.fn();

// Real-ish error class so the route's `instanceof RecipeUrlError` check works.
class RecipeUrlError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status = 502) {
    super(message);
    this.name = "RecipeUrlError";
    this.code = code;
    this.status = status;
  }
}

vi.mock("../../src/bigtable/lib/auth.js", () => ({
  getUserIdFromAuthHeader,
}));

vi.mock("../../src/bigtable/lib/ai-recipe-url.js", () => ({
  importRecipeFromUrl,
  RecipeUrlError,
}));

beforeEach(() => {
  vi.resetAllMocks();
  getUserIdFromAuthHeader.mockResolvedValue("user-1");
});

async function postRecipeUrl(request: Request) {
  const { POST } = await import("../../src/bigtable/routes/ai.recipe-url.js");
  return POST(request as never);
}

describe("POST /api/ai/recipe-url", () => {
  it("rejects unauthenticated requests", async () => {
    getUserIdFromAuthHeader.mockResolvedValue(null);
    const response = await postRecipeUrl(
      buildUnauthenticatedJsonRequest("http://localhost/api/ai/recipe-url", { url: "https://example.com/r" }),
    );
    expect(response.status).toBe(401);
    expect(importRecipeFromUrl).not.toHaveBeenCalled();
  });

  it("rejects a missing url", async () => {
    const response = await postRecipeUrl(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/recipe-url", {}),
    );
    expect(response.status).toBe(400);
    expect(importRecipeFromUrl).not.toHaveBeenCalled();
  });

  it("returns the imported recipe fields on success", async () => {
    const generated = {
      isRecipe: true,
      title: "Lemon Pasta",
      description: "Bright and quick.",
      baseServings: 4,
      tags: ["dinner", "italian"],
      ingredients: ["200g pasta", "1 lemon"],
      instructions: ["Boil pasta", "Toss with lemon"],
      failureReason: null,
    };
    importRecipeFromUrl.mockResolvedValue(generated);

    const response = await postRecipeUrl(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/recipe-url", {
        url: "https://example.com/lemon-pasta",
      }),
    );

    expect(response.status).toBe(200);
    expect(importRecipeFromUrl).toHaveBeenCalledWith("https://example.com/lemon-pasta");
    expect(await response.json()).toEqual(generated);
  });

  it("maps RecipeUrlError to its status and code", async () => {
    importRecipeFromUrl.mockRejectedValue(new RecipeUrlError("That can't be reached.", "BLOCKED_URL", 400));

    const response = await postRecipeUrl(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/recipe-url", {
        url: "http://127.0.0.1/admin",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "That can't be reached.", code: "BLOCKED_URL" });
  });

  it("returns a 500 for unexpected failures", async () => {
    importRecipeFromUrl.mockRejectedValue(new Error("boom"));

    const response = await postRecipeUrl(
      buildAuthenticatedJsonRequest("http://localhost/api/ai/recipe-url", {
        url: "https://example.com/r",
      }),
    );

    expect(response.status).toBe(500);
  });
});
