import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAuthenticatedJsonRequest, buildUnauthenticatedJsonRequest } from "./helpers/session.js";

const getUserIdFromAuthHeader = vi.fn();
const refineRecipe = vi.fn();

class RecipeAudioError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status = 502) {
    super(message);
    this.name = "RecipeAudioError";
    this.code = code;
    this.status = status;
  }
}

vi.mock("../../src/bigtable/lib/auth.js", () => ({ getUserIdFromAuthHeader }));
vi.mock("../../src/bigtable/lib/ai-recipe-audio.js", () => ({ RecipeAudioError }));
vi.mock("../../src/bigtable/lib/ai-recipe-refine.js", () => ({ refineRecipe }));

beforeEach(() => {
  vi.resetAllMocks();
  getUserIdFromAuthHeader.mockResolvedValue("user-1");
});

async function post(request: Request) {
  const { POST } = await import("../../src/bigtable/routes/ai.recipe-refine.js");
  return POST(request as never);
}

const url = "http://localhost/v1/bigtable/ai/recipe-refine";

describe("POST /v1/bigtable/ai/recipe-refine", () => {
  it("rejects unauthenticated requests", async () => {
    getUserIdFromAuthHeader.mockResolvedValue(null);
    const response = await post(buildUnauthenticatedJsonRequest(url, { request: "Less spicy" }));
    expect(response.status).toBe(401);
    expect(refineRecipe).not.toHaveBeenCalled();
  });

  it("rejects a missing request", async () => {
    const response = await post(buildAuthenticatedJsonRequest(url, { recipe: "Title: Chili" }));
    expect(response.status).toBe(400);
    expect(refineRecipe).not.toHaveBeenCalled();
  });

  it("returns the changed recipe and reply", async () => {
    const refined = {
      isRecipe: true,
      title: "Chili",
      description: null,
      baseServings: 12,
      tags: ["dinner"],
      ingredients: ["4 lb ground beef"],
      instructions: ["Brown the beef"],
      failureReason: null,
      prepMinutes: 15,
      cookMinutes: 60,
      difficulty: "easy",
      reply: "Doubled it for 12.",
    };
    refineRecipe.mockResolvedValue(refined);
    const response = await post(buildAuthenticatedJsonRequest(url, { recipe: "Title: Chili", request: "Enough for 12" }));
    expect(response.status).toBe(200);
    expect(refineRecipe).toHaveBeenCalledWith("Title: Chili", "Enough for 12");
    expect(await response.json()).toEqual(refined);
  });

  it("passes through AI errors", async () => {
    refineRecipe.mockRejectedValue(new RecipeAudioError("Failed to change the recipe", "AI_UPSTREAM_ERROR", 502));
    const response = await post(buildAuthenticatedJsonRequest(url, { recipe: "", request: "A casserole" }));
    expect(response.status).toBe(502);
  });
});
