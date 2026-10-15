import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { notifyRecipeLiked } from "../lib/notifications.js";
import { serverError } from "../lib/server-error.js";
import { supabaseAdmin } from "../lib/supabase.js";

type JsonObject = Record<string, unknown>;

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;

  const { data: row, error } = await supabaseAdmin
    .from("recipe_likes")
    .select("recipe_id")
    .eq("profile_id", userId)
    .eq("recipe_id", id)
    .maybeSingle();

  if (error) {
    return serverError("GET /api/recipes/[id]/like failed", "Failed to fetch like state", error);
  }

  return NextResponse.json({ liked: Boolean(row) });
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;

  let payload: JsonObject;
  try {
    payload = (await request.json()) as JsonObject;
  } catch {
    return badRequest("Request body must be valid JSON");
  }

  const liked = payload.liked;
  if (typeof liked !== "boolean") {
    return badRequest("liked must be a boolean");
  }

  if (liked) {
    const { error } = await supabaseAdmin
      .from("recipe_likes")
      .upsert({
        profile_id: userId,
        recipe_id: id,
      });

    if (error) {
      return serverError("PUT /api/recipes/[id]/like insert failed", "Failed to update like", error);
    }

    const { data: recipe } = await supabaseAdmin
      .from("recipes")
      .select("title")
      .eq("id", id)
      .maybeSingle();

    await notifyRecipeLiked({
      actorProfileId: userId,
      recipeId: id,
      recipeTitle: recipe?.title ?? "Recipe",
    });
  } else {
    const { error } = await supabaseAdmin
      .from("recipe_likes")
      .delete()
      .eq("profile_id", userId)
      .eq("recipe_id", id);

    if (error) {
      return serverError("PUT /api/recipes/[id]/like delete failed", "Failed to update like", error);
    }
  }

  return NextResponse.json({ ok: true });
}
