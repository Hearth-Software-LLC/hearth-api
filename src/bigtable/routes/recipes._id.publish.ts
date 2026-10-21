import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { fanOutRecipePublishNotification } from "../lib/notifications.js";
import { parseRecipeVersionContent } from "../lib/recipe-versioning.js";
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
    .select("id, title, description, image_url, prep_minutes, cook_minutes, base_servings, difficulty, tags, instructions, source_name, source_id, source_url, attribution_required, attribution_text, created_by_profile_id")
    .eq("id", id)
    .single();

  if (recipeError || !recipe) {
    return NextResponse.json({ error: "Recipe not found" }, { status: 404 });
  }

  if (recipe.created_by_profile_id !== userId || recipe.source_name !== "user") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: ingredients, error: ingredientsError } = await supabaseAdmin
    .from("recipe_ingredients")
    .select("id, name, amount, measurement_type, quantity, unit, notes")
    .eq("recipe_id", id)
    .order("name", { ascending: true });

  if (ingredientsError) {
    return serverError("POST /api/recipes/[id]/publish ingredients failed", "Failed to publish recipe", ingredientsError);
  }

  const { data: latestVersion, error: latestVersionError } = await supabaseAdmin
    .from("recipe_versions")
    .select("version_number")
    .eq("recipe_id", id)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestVersionError) {
    return serverError("POST /api/recipes/[id]/publish latest version lookup failed", "Failed to publish recipe", latestVersionError);
  }

  const versionNumber = (latestVersion?.version_number ?? 0) + 1;
  const content = {
    title: recipe.title,
    description: recipe.description,
    imageUrl: recipe.image_url,
    prepMinutes: recipe.prep_minutes,
    cookMinutes: recipe.cook_minutes,
    baseServings: recipe.base_servings,
    difficulty: recipe.difficulty,
    tags: Array.isArray(recipe.tags) ? recipe.tags : [],
    instructions: Array.isArray(recipe.instructions) ? recipe.instructions : [],
    sourceName: recipe.source_name,
    sourceId: recipe.source_id,
    sourceUrl: recipe.source_url,
    attributionRequired: recipe.attribution_required,
    attributionText: recipe.attribution_text,
    createdByProfileId: recipe.created_by_profile_id,
    ingredients: (ingredients ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      amount: item.amount ?? item.quantity,
      measurementType: item.measurement_type ?? item.unit,
      notes: item.notes ?? null,
    })),
  };

  const parsed = parseRecipeVersionContent(content);
  if (!parsed) {
    return NextResponse.json({ error: "Recipe content is invalid for publishing" }, { status: 400 });
  }

  const { data: insertedVersion, error: insertVersionError } = await supabaseAdmin
    .from("recipe_versions")
    .insert({
      recipe_id: id,
      version_number: versionNumber,
      content,
      published_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (insertVersionError || !insertedVersion) {
    return serverError("POST /api/recipes/[id]/publish version insert failed", "Failed to publish recipe", insertVersionError);
  }

  const { error: publishUpdateError } = await supabaseAdmin
    .from("recipes")
    .update({
      status: "published",
      current_version_id: insertedVersion.id,
      published_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (publishUpdateError) {
    return serverError("POST /api/recipes/[id]/publish recipe update failed", "Failed to publish recipe", publishUpdateError);
  }

  const { error: savePinUpdateError } = await supabaseAdmin
    .from("saved_recipes")
    .update({ version_id: insertedVersion.id })
    .eq("profile_id", userId)
    .eq("recipe_id", id)
    .is("version_id", null);

  if (savePinUpdateError) {
    return serverError("POST /api/recipes/[id]/publish save pin update failed", "Failed to publish recipe", savePinUpdateError);
  }

  await fanOutRecipePublishNotification({
    actorProfileId: userId,
    recipeId: id,
    versionId: insertedVersion.id,
    recipeTitle: recipe.title,
    isUpdate: versionNumber > 1,
  });

  return NextResponse.json({
    ok: true,
    recipeId: id,
    versionId: insertedVersion.id,
    versionNumber,
    status: "published",
  });
}
