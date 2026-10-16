import { NextResponse } from "../next-shim.js";

import { RecipeAudioError } from "../lib/ai-recipe-audio.js";
import { refineRecipe } from "../lib/ai-recipe-refine.js";
import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { serverError } from "../lib/server-error.js";

type JsonObject = Record<string, unknown>;

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/** Change a recipe the way the cook asks ("dairy-free and enough for 12"), or write one from a
 * request when `recipe` is empty. Returns the recipe fields plus a short `reply`. */
export async function POST(request: Request) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: JsonObject;
  try {
    payload = (await request.json()) as JsonObject;
  } catch {
    return badRequest("Request body must be valid JSON");
  }

  const recipe = typeof payload.recipe === "string" ? payload.recipe : "";
  const ask = typeof payload.request === "string" ? payload.request.trim() : "";
  if (!ask) {
    return badRequest("request is required");
  }
  if (ask.length > 1_000) {
    return badRequest("request is too long");
  }
  if (recipe.length > 12_000) {
    return badRequest("recipe is too large");
  }

  try {
    return NextResponse.json(await refineRecipe(recipe, ask));
  } catch (error) {
    if (error instanceof RecipeAudioError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return serverError("POST /v1/bigtable/ai/recipe-refine failed", "Failed to change the recipe", error);
  }
}
