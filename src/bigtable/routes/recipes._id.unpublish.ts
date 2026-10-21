import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { serverError } from "../lib/server-error.js";
import { supabaseAdmin } from "../../services/supabase.js";

function isPublishingEnabled() {
  return process.env.RECIPE_PUBLISHING_PHASE3_ENABLED?.trim().toLowerCase() !== "false";
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isPublishingEnabled()) {
    return NextResponse.json({ error: "Recipe publishing is disabled" }, { status: 403 });
  }

  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;

  const { data: recipe, error: recipeError } = await supabaseAdmin
    .from("recipes")
    .select("id, source_name, created_by_profile_id")
    .eq("id", id)
    .single();

  if (recipeError || !recipe) {
    return NextResponse.json({ error: "Recipe not found" }, { status: 404 });
  }

  if (recipe.created_by_profile_id !== userId || recipe.source_name !== "user") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { error: updateError } = await supabaseAdmin
    .from("recipes")
    .update({ status: "unpublished" })
    .eq("id", id);

  if (updateError) {
    return serverError("POST /api/recipes/[id]/unpublish failed", "Failed to unpublish recipe", updateError);
  }

  return NextResponse.json({
    ok: true,
    recipeId: id,
    status: "unpublished",
  });
}
