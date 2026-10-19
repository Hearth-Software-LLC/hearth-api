import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { fanOutRecipePublishNotification } from "../lib/notifications.js";
import { parseRecipeVersionContent, type VersionedRecipeContent } from "../lib/recipe-versioning.js";
import { serverError } from "../lib/server-error.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { normalizeCreatePayload, type CreateRecipePayload } from "./recipes.js";

// Publishing by id, for builds that keep private recipes in the family's iCloud. The client owns
// the recipe's UUID; the server only holds the published copy (row + versions) so the community,
// likes, follows and other families' plans keep resolving it.

type JsonObject = Record<string, unknown>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPublishingEnabled() {
  return process.env.RECIPE_PUBLISHING_PHASE3_ENABLED?.trim().toLowerCase() !== "false";
}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Content without ingredient row ids, which change every time the rows are rewritten. */
function comparableContent(content: VersionedRecipeContent | null) {
  if (!content) {
    return null;
  }
  return JSON.stringify({
    ...content,
    ingredients: content.ingredients.map((ingredient) => ({
      name: ingredient.name,
      amount: ingredient.amount,
      measurementType: ingredient.measurementType,
      notes: ingredient.notes,
    })),
  });
}

type ExistingRecipe = {
  id: string;
  source_name: string | null;
  created_by_profile_id: string | null;
  status: string | null;
  published_at: string | null;
  current_version_id: string | null;
};

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isPublishingEnabled()) {
    return NextResponse.json({ error: "Recipe publishing is disabled" }, { status: 403 });
  }

  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: rawId } = await context.params;
  const id = rawId.trim().toLowerCase();
  if (!UUID_PATTERN.test(id)) {
    return badRequest("Recipe id must be a UUID");
  }

  let body: JsonObject;
  try {
    body = (await request.json()) as JsonObject;
  } catch {
    return badRequest("Request body must be valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return badRequest("Request body must be an object");
  }

  let payload: CreateRecipePayload;
  try {
    payload = normalizeCreatePayload(body);
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : "Invalid payload");
  }
  if (!isHttpUrl(payload.imageUrl)) {
    return badRequest("imageUrl must be an http(s) URL");
  }

  const existingResult = await supabaseAdmin
    .from("recipes")
    .select("id, source_name, created_by_profile_id, status, published_at, current_version_id")
    .eq("id", id)
    .maybeSingle();

  if (existingResult.error) {
    return serverError("PUT /recipes/[id]/publication lookup failed", "Failed to publish recipe", existingResult.error);
  }

  const existing = existingResult.data as ExistingRecipe | null;
  if (existing && (existing.created_by_profile_id !== userId || existing.source_name !== "user")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rowFields = {
    title: payload.title,
    description: payload.description,
    image_url: payload.imageUrl,
    prep_minutes: payload.prepMinutes,
    cook_minutes: payload.cookMinutes,
    base_servings: payload.baseServings,
    difficulty: payload.difficulty,
    tags: payload.tags,
    instructions: payload.instructions,
  };

  if (existing) {
    const { error } = await supabaseAdmin.from("recipes").update(rowFields).eq("id", id);
    if (error) {
      return serverError("PUT /recipes/[id]/publication update failed", "Failed to publish recipe", error);
    }

    const { error: deleteIngredientsError } = await supabaseAdmin
      .from("recipe_ingredients")
      .delete()
      .eq("recipe_id", id);
    if (deleteIngredientsError) {
      return serverError("PUT /recipes/[id]/publication ingredients delete failed", "Failed to publish recipe", deleteIngredientsError);
    }
  } else {
    // Inserted as a draft first: a published row must point at a version, which needs the row.
    const { error } = await supabaseAdmin.from("recipes").insert({
      id,
      ...rowFields,
      source_name: "user",
      created_by_profile_id: userId,
      status: "draft",
    });
    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: "Recipe is being published already. Try again." }, { status: 409 });
      }
      return serverError("PUT /recipes/[id]/publication insert failed", "Failed to publish recipe", error);
    }
  }

  let ingredientRows: Array<{ id: string; name: string; amount: number | null; measurement_type: string | null; notes: string | null }> = [];
  if (payload.ingredients.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("recipe_ingredients")
      .insert(
        payload.ingredients.map((ingredient) => ({
          recipe_id: id,
          name: ingredient.name,
          amount: ingredient.amount,
          measurement_type: ingredient.measurementType,
          quantity: ingredient.amount,
          unit: ingredient.measurementType,
          notes: null,
        }))
      )
      .select("id, name, amount, measurement_type, notes");

    if (error) {
      if (!existing) {
        await supabaseAdmin.from("recipes").delete().eq("id", id);
      }
      return serverError("PUT /recipes/[id]/publication ingredients insert failed", "Failed to publish recipe", error);
    }
    ingredientRows = ((data ?? []) as typeof ingredientRows)
      .slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  // Same content snapshot the publish route stores.
  const content = {
    title: payload.title,
    description: payload.description,
    imageUrl: payload.imageUrl,
    prepMinutes: payload.prepMinutes,
    cookMinutes: payload.cookMinutes,
    baseServings: payload.baseServings,
    difficulty: payload.difficulty,
    tags: payload.tags,
    instructions: payload.instructions,
    sourceName: "user",
    sourceId: null,
    sourceUrl: null,
    attributionRequired: false,
    attributionText: null,
    createdByProfileId: userId,
    ingredients: ingredientRows.map((item) => ({
      id: item.id,
      name: item.name,
      amount: item.amount,
      measurementType: item.measurement_type,
      notes: item.notes ?? null,
    })),
  };

  const parsed = parseRecipeVersionContent(content);
  if (!parsed) {
    return NextResponse.json({ error: "Recipe content is invalid for publishing" }, { status: 400 });
  }

  let latestVersion: { id: string; version_number: number; content: unknown } | null = null;
  if (existing) {
    const latestResult = await supabaseAdmin
      .from("recipe_versions")
      .select("id, version_number, content")
      .eq("recipe_id", id)
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestResult.error) {
      return serverError("PUT /recipes/[id]/publication latest version lookup failed", "Failed to publish recipe", latestResult.error);
    }
    latestVersion = latestResult.data;
  }

  const contentChanged = !latestVersion
    || comparableContent(parseRecipeVersionContent(latestVersion.content)) !== comparableContent(parsed);

  const nowIso = new Date().toISOString();
  let versionId = latestVersion?.id ?? null;
  let versionNumber = latestVersion?.version_number ?? 0;

  if (contentChanged || !versionId) {
    versionNumber += 1;
    const { data: insertedVersion, error: insertVersionError } = await supabaseAdmin
      .from("recipe_versions")
      .insert({
        recipe_id: id,
        version_number: versionNumber,
        content,
        published_at: nowIso,
      })
      .select("id")
      .single();

    if (insertVersionError || !insertedVersion) {
      return serverError("PUT /recipes/[id]/publication version insert failed", "Failed to publish recipe", insertVersionError);
    }
    versionId = insertedVersion.id as string;
  }

  const isFirstPublish = !existing || !existing.published_at;
  const publishUpdate: Record<string, unknown> = {
    status: "published",
    current_version_id: versionId,
  };
  if (isFirstPublish) {
    publishUpdate.published_at = nowIso;
  }

  const { error: publishUpdateError } = await supabaseAdmin
    .from("recipes")
    .update(publishUpdate)
    .eq("id", id);

  if (publishUpdateError) {
    return serverError("PUT /recipes/[id]/publication publish update failed", "Failed to publish recipe", publishUpdateError);
  }

  // As the publish route does: a creator's own unpinned save follows the published version.
  const { error: savePinUpdateError } = await supabaseAdmin
    .from("saved_recipes")
    .update({ version_id: versionId })
    .eq("profile_id", userId)
    .eq("recipe_id", id)
    .is("version_id", null);

  if (savePinUpdateError) {
    return serverError("PUT /recipes/[id]/publication save pin update failed", "Failed to publish recipe", savePinUpdateError);
  }

  // First publish tells followers it's out (recipe_published); a later publish that changed the
  // recipe tells them it was updated (recipe_updated), as the publish route does for version 2+.
  // Re-sending identical content is a no-op for notifications.
  if (isFirstPublish || contentChanged) {
    await fanOutRecipePublishNotification({
      actorProfileId: userId,
      recipeId: id,
      versionId: versionId!,
      recipeTitle: payload.title,
      isUpdate: !isFirstPublish,
    });
  }

  return NextResponse.json({
    ok: true,
    recipeId: id,
    versionId,
    versionNumber,
    status: "published",
  });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isPublishingEnabled()) {
    return NextResponse.json({ error: "Recipe publishing is disabled" }, { status: 403 });
  }

  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: rawId } = await context.params;
  const id = rawId.trim().toLowerCase();

  const { data: recipe, error: recipeError } = await supabaseAdmin
    .from("recipes")
    .select("id, source_name, created_by_profile_id")
    .eq("id", id)
    .maybeSingle();

  if (recipeError) {
    return serverError("DELETE /recipes/[id]/publication lookup failed", "Failed to unpublish recipe", recipeError);
  }

  if (!recipe || recipe.created_by_profile_id !== userId || recipe.source_name !== "user") {
    return NextResponse.json({ error: "Recipe not found" }, { status: 404 });
  }

  // The row stays so other families' plans and saves keep resolving it.
  const { error: updateError } = await supabaseAdmin
    .from("recipes")
    .update({ status: "unpublished" })
    .eq("id", id);

  if (updateError) {
    return serverError("DELETE /recipes/[id]/publication failed", "Failed to unpublish recipe", updateError);
  }

  return NextResponse.json({
    ok: true,
    recipeId: id,
    status: "unpublished",
  });
}
