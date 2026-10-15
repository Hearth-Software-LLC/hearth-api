import { NextResponse } from "../next-shim.js";

import { importRecipeFromUrl, RecipeUrlError } from "../lib/ai-recipe-url.js";
import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { serverError } from "../lib/server-error.js";

type JsonObject = Record<string, unknown>;

type RecipeUrlPayload = {
  url: string;
};

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function normalizePayload(payload: JsonObject): RecipeUrlPayload {
  const urlRaw = payload.url;

  if (typeof urlRaw !== "string" || !urlRaw.trim()) {
    throw new Error("url is required");
  }

  const url = urlRaw.trim();
  if (url.length > 2_000) {
    throw new Error("url is too long");
  }

  return { url };
}

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

  let normalized: RecipeUrlPayload;
  try {
    normalized = normalizePayload(payload);
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : "Invalid payload");
  }

  try {
    const generated = await importRecipeFromUrl(normalized.url);
    return NextResponse.json(generated);
  } catch (error) {
    if (error instanceof RecipeUrlError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
        },
        { status: error.status },
      );
    }

    return serverError("POST /api/ai/recipe-url failed", "Failed to import recipe from URL", error);
  }
}
