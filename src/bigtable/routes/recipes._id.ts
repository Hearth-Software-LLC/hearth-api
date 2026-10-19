import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { toMemberAvatarPublicUrl } from "../lib/member-avatar.js";
import { loadPublicDisplayNames } from "../lib/public-identity.js";
import { parseRecipeVersionContent } from "../lib/recipe-versioning.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { serverError } from "../lib/server-error.js";

type RecipeIngredientDto = {
  id: string;
  name: string;
  amount: number | null;
  measurementType: string | null;
};

function parseThemealdbMeasure(measureRaw: string): { quantity: number | null; unit: string | null } {
  const measure = measureRaw.trim().replace(/\s+/g, " ");
  if (!measure) {
    return { quantity: null, unit: null };
  }

  const mixedFractionMatch = measure.match(/^(\d+)\s+(\d+)\/(\d+)(?:\s+(.*))?$/);
  if (mixedFractionMatch) {
    const whole = Number(mixedFractionMatch[1]);
    const numerator = Number(mixedFractionMatch[2]);
    const denominator = Number(mixedFractionMatch[3]);
    if (Number.isFinite(whole) && Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
      return {
        quantity: whole + numerator / denominator,
        unit: mixedFractionMatch[4]?.trim() || null,
      };
    }
  }

  const fractionMatch = measure.match(/^(\d+)\/(\d+)(?:\s+(.*))?$/);
  if (fractionMatch) {
    const numerator = Number(fractionMatch[1]);
    const denominator = Number(fractionMatch[2]);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
      return {
        quantity: numerator / denominator,
        unit: fractionMatch[3]?.trim() || null,
      };
    }
  }

  const decimalMatch = measure.match(/^(\d+(?:\.\d+)?)(?:\s+(.*))?$/);
  if (decimalMatch) {
    const quantity = Number(decimalMatch[1]);
    if (Number.isFinite(quantity)) {
      return {
        quantity,
        unit: decimalMatch[2]?.trim() || null,
      };
    }
  }

  return { quantity: null, unit: measure };
}

function normalizeThemealdbIngredients(meal: Record<string, unknown>, recipeId: string): RecipeIngredientDto[] {
  const ingredients: RecipeIngredientDto[] = [];

  for (let i = 1; i <= 20; i += 1) {
    const nameRaw = meal[`strIngredient${i}`];
    const measureRaw = meal[`strMeasure${i}`];

    const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
    if (!name) {
      continue;
    }

    const parsedMeasure = parseThemealdbMeasure(typeof measureRaw === "string" ? measureRaw : "");
    ingredients.push({
      id: `${recipeId}-themealdb-${i}`,
      name,
      amount: parsedMeasure.quantity,
      measurementType: parsedMeasure.unit,
    });
  }

  return ingredients;
}

async function fetchThemealdbIngredients(sourceId: string, recipeId: string): Promise<RecipeIngredientDto[]> {
  const response = await fetch(`https://www.themealdb.com/api/json/v1/1/lookup.php?i=${encodeURIComponent(sourceId)}`);
  if (!response.ok) {
    return [];
  }

  const payload = (await response.json()) as { meals?: Array<Record<string, unknown>> | null };
  const meal = payload.meals?.[0];
  if (!meal) {
    return [];
  }

  return normalizeThemealdbIngredients(meal, recipeId);
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const url = new URL(request.url);
  const requestedVersionIdRaw = url.searchParams.get("versionId");
  const requestedVersionId = typeof requestedVersionIdRaw === "string" && requestedVersionIdRaw.trim().length > 0
    ? requestedVersionIdRaw.trim()
    : null;

  const { data: recipe, error: recipeError } = await supabaseAdmin
    .from("recipes")
    .select(
      "id, title, description, image_url, prep_minutes, cook_minutes, base_servings, difficulty, tags, instructions, source_name, source_id, source_url, attribution_required, attribution_text, status, current_version_id, created_by_profile_id, published_at, like_count"
    )
    .eq("id", id)
    .single();

  if (recipeError || !recipe) {
    return NextResponse.json({ error: recipeError?.message ?? "Recipe not found" }, { status: 404 });
  }

  const { data: favoriteRow, error: favoriteError } = await supabaseAdmin
    .from("saved_recipes")
    .select("recipe_id, version_id")
    .eq("profile_id", userId)
    .eq("recipe_id", id)
    .maybeSingle();

  if (favoriteError) {
    return serverError(
      "GET /api/recipes/[id] favorite lookup failed",
      "Failed to fetch recipe",
      favoriteError
    );
  }

  const { data: likeRow, error: likeError } = await supabaseAdmin
    .from("recipe_likes")
    .select("recipe_id")
    .eq("profile_id", userId)
    .eq("recipe_id", id)
    .maybeSingle();

  if (likeError) {
    return serverError(
      "GET /api/recipes/[id] like lookup failed",
      "Failed to fetch recipe",
      likeError
    );
  }

  const canViewByVisibility = recipe.status === "published" || recipe.created_by_profile_id === userId;
  const canViewByPinnedSave = Boolean(favoriteRow?.version_id);
  let canViewByPinnedPlan = false;

  if (requestedVersionId && !canViewByVisibility) {
    const { data: plannedSlot, error: plannedSlotError } = await supabaseAdmin
      .from("meal_slots")
      .select("id, weekly_plans!inner(profile_id)")
      .eq("weekly_plans.profile_id", userId)
      .filter("recipe_items", "cs", JSON.stringify([{ recipeId: id, recipeVersionId: requestedVersionId }]))
      .limit(1)
      .maybeSingle();

    if (plannedSlotError) {
      return serverError(
        "GET /api/recipes/[id] planned pin lookup failed",
        "Failed to fetch recipe",
        plannedSlotError
      );
    }

    canViewByPinnedPlan = Boolean(plannedSlot?.id);
  }

  if (!canViewByVisibility && !canViewByPinnedSave && !canViewByPinnedPlan) {
    return NextResponse.json({ error: "Recipe not found" }, { status: 404 });
  }

  let creatorProfile: { household_name: string | null; avatar_url: string | null } | null = null;
  let creatorDisplayName: string | null = null;
  let creatorMemberIdentity: { name: string | null; avatar_url: string | null } | null = null;
  if (typeof recipe.created_by_profile_id === "string" && recipe.created_by_profile_id.trim().length > 0) {
    const [creatorProfileLookup, creatorLinkedMemberLookup, creatorOwnMemberLookup] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("household_name, avatar_url")
        .eq("id", recipe.created_by_profile_id)
        .maybeSingle(),
      supabaseAdmin
        .from("household_members")
        .select("name, avatar_url")
        .eq("linked_profile_id", recipe.created_by_profile_id)
        .order("sort_order", { ascending: true })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from("household_members")
        .select("name, avatar_url")
        .eq("profile_id", recipe.created_by_profile_id)
        .order("sort_order", { ascending: true })
        .limit(1)
        .maybeSingle(),
    ]);

    const { data: creatorProfileRow, error: creatorProfileError } = creatorProfileLookup;
    const { data: creatorLinkedMemberRow, error: creatorLinkedMemberError } = creatorLinkedMemberLookup;
    const { data: creatorOwnMemberRow, error: creatorOwnMemberError } = creatorOwnMemberLookup;

    if (creatorProfileError) {
      return serverError(
        "GET /api/recipes/[id] creator profile lookup failed",
        "Failed to fetch recipe",
        creatorProfileError
      );
    }

    if (creatorLinkedMemberError || creatorOwnMemberError) {
      return serverError(
        "GET /api/recipes/[id] creator organizer lookup failed",
        "Failed to fetch recipe",
        creatorLinkedMemberError ?? creatorOwnMemberError
      );
    }

    creatorProfile = creatorProfileRow;
    creatorMemberIdentity = creatorLinkedMemberRow ?? creatorOwnMemberRow;
    creatorDisplayName = (await loadPublicDisplayNames([recipe.created_by_profile_id])).get(recipe.created_by_profile_id) ?? null;
  }

  const canRenderRequestedVersion = Boolean(
    requestedVersionId
    && (
      canViewByVisibility
      || favoriteRow?.version_id === requestedVersionId
      || canViewByPinnedPlan
    )
  );

  const renderVersionId = canRenderRequestedVersion
    ? requestedVersionId
    : favoriteRow?.version_id
      ?? (
        recipe.status === "published" && recipe.created_by_profile_id !== userId
          ? recipe.current_version_id
          : null
      );

  let versioned = null;
  if (typeof renderVersionId === "string" && renderVersionId.trim().length > 0) {
    const { data: versionRow, error: versionError } = await supabaseAdmin
      .from("recipe_versions")
      .select("content")
      .eq("id", renderVersionId)
      .maybeSingle();

    if (versionError) {
      return serverError(
        "GET /api/recipes/[id] version lookup failed",
        "Failed to fetch recipe",
        versionError
      );
    }

    versioned = parseRecipeVersionContent(versionRow?.content);
  }

  const { data: ingredients, error: ingredientsError } = await supabaseAdmin
    .from("recipe_ingredients")
    .select("id, name, amount, measurement_type, quantity, unit")
    .eq("recipe_id", id)
    .order("name", { ascending: true });

  if (ingredientsError) {
    return serverError(
      "GET /api/recipes/[id] ingredients lookup failed",
      "Failed to fetch recipe",
      ingredientsError
    );
  }

  let normalizedIngredients: RecipeIngredientDto[] = (ingredients ?? []).map((item) => ({
    id: item.id,
    name: item.name,
    amount: item.amount ?? item.quantity,
    measurementType: item.measurement_type ?? item.unit,
  }));

  if (versioned?.ingredients && versioned.ingredients.length > 0) {
    normalizedIngredients = versioned.ingredients.map((item, index) => ({
      id: item.id ?? `${recipe.id}-version-${index + 1}`,
      name: item.name,
      amount: item.amount,
      measurementType: item.measurementType,
    }));
  } else if (
    normalizedIngredients.length === 0 &&
    recipe.source_name === "themealdb" &&
    typeof recipe.source_id === "string" &&
    recipe.source_id.trim().length > 0
  ) {
    try {
      normalizedIngredients = await fetchThemealdbIngredients(recipe.source_id, recipe.id);
    } catch {
      normalizedIngredients = [];
    }
  }

  const { count: versionCount, error: versionCountError } = await supabaseAdmin
    .from("recipe_versions")
    .select("id", { count: "exact", head: true })
    .eq("recipe_id", id);

  if (versionCountError) {
    return serverError(
      "GET /api/recipes/[id] version count lookup failed",
      "Failed to fetch recipe",
      versionCountError
    );
  }

  return NextResponse.json({
    recipe: {
      id: recipe.id,
      title: versioned?.title ?? recipe.title,
      description: versioned?.description ?? recipe.description,
      imageUrl: versioned?.imageUrl ?? recipe.image_url,
      prepMinutes: versioned?.prepMinutes ?? recipe.prep_minutes,
      cookMinutes: versioned?.cookMinutes ?? recipe.cook_minutes,
      baseServings: versioned?.baseServings ?? recipe.base_servings,
      difficulty: versioned?.difficulty ?? recipe.difficulty,
      tags: versioned?.tags ?? recipe.tags,
      instructions: versioned?.instructions ?? (Array.isArray(recipe.instructions) ? recipe.instructions : []),
      sourceName: recipe.source_name,
      sourceUrl: recipe.source_url,
      attributionRequired: recipe.attribution_required,
      attributionText: recipe.attribution_text,
      isFavorite: Boolean(favoriteRow),
      isLiked: Boolean(likeRow),
      likeCount: recipe.like_count ?? 0,
      createdByProfileId: recipe.created_by_profile_id,
      creatorName: creatorDisplayName ?? creatorMemberIdentity?.name ?? creatorProfile?.household_name ?? null,
      creatorAvatarUrl: toMemberAvatarPublicUrl(creatorMemberIdentity?.avatar_url ?? creatorProfile?.avatar_url ?? null),
      status: recipe.status,
      currentVersionId: recipe.current_version_id,
      pinnedVersionId: renderVersionId,
      hasUpdateAvailable: Boolean(
        renderVersionId
        && recipe.current_version_id
        && renderVersionId !== recipe.current_version_id
        && recipe.status === "published"
      ),
      publishedAt: recipe.published_at,
      versionCount: typeof versionCount === "number" ? versionCount : 0,
      ingredients: normalizedIngredients,
    },
  });
}

type UpdateRecipePayload = {
  title: string;
  imageUrl: string;
  description: string | null;
  baseServings: number;
  tags: string[];
  ingredients: Array<{ name: string; amount: number | null; measurementType: string | null }>;
  instructions: string[];
};

function normalizeUpdatePayload(payload: Record<string, unknown>): UpdateRecipePayload {
  const titleRaw = payload.title;
  if (typeof titleRaw !== "string" || !titleRaw.trim()) {
    throw new Error("title is required");
  }

  const imageUrlRaw = payload.imageUrl;
  if (typeof imageUrlRaw !== "string" || !imageUrlRaw.trim()) {
    throw new Error("imageUrl is required");
  }

  const descriptionRaw = payload.description;
  const description = typeof descriptionRaw === "string" && descriptionRaw.trim() ? descriptionRaw.trim() : null;

  const baseServingsRaw = payload.baseServings;
  const baseServings = typeof baseServingsRaw === "number" && Number.isInteger(baseServingsRaw) && baseServingsRaw > 0
    ? baseServingsRaw
    : 8;

  const tagsRaw = payload.tags;
  const tags = Array.isArray(tagsRaw) ? tagsRaw.filter((t): t is string => typeof t === "string") : [];

  const ingredientsRaw = payload.ingredients;
  const ingredients = Array.isArray(ingredientsRaw)
    ? ingredientsRaw
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .map((item) => ({
          name: typeof item.name === "string" ? item.name : "",
          amount: typeof (item.amount ?? item.quantity) === "number" ? (item.amount ?? item.quantity) as number : null,
          measurementType: typeof (item.measurementType ?? item.unit) === "string" ? (item.measurementType ?? item.unit) as string : null,
        }))
        .filter((item) => item.name.trim().length > 0)
    : [];

  const instructionsRaw = payload.instructions;
  const instructions = Array.isArray(instructionsRaw)
    ? instructionsRaw.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : [];

  return {
    title: titleRaw.trim(),
    imageUrl: imageUrlRaw.trim(),
    description,
    baseServings,
    tags,
    ingredients,
    instructions,
  };
}


export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;

  const { data: recipe, error: recipeError } = await supabaseAdmin
    .from("recipes")
    .select("source_name, created_by_profile_id")
    .eq("id", id)
    .single();

  if (recipeError || !recipe) {
    return NextResponse.json({ error: "Recipe not found" }, { status: 404 });
  }

  if (recipe.source_name !== "user" || recipe.created_by_profile_id !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  let payload: UpdateRecipePayload;
  try {
    payload = normalizeUpdatePayload(body);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid payload" }, { status: 400 });
  }

  const { error: updateError } = await supabaseAdmin
    .from("recipes")
    .update({
      title: payload.title,
      image_url: payload.imageUrl,
      description: payload.description,
      base_servings: payload.baseServings,
      tags: payload.tags,
      instructions: payload.instructions,
    })
    .eq("id", id);

  if (updateError) {
    return serverError("PATCH /api/recipes/[id] update failed", "Failed to update recipe", updateError);
  }

  const { error: deleteIngredientsError } = await supabaseAdmin
    .from("recipe_ingredients")
    .delete()
    .eq("recipe_id", id);

  if (deleteIngredientsError) {
    return serverError("PATCH /api/recipes/[id] ingredients delete failed", "Failed to update recipe", deleteIngredientsError);
  }

  if (payload.ingredients.length > 0) {
    const { error: insertIngredientsError } = await supabaseAdmin
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
      );

    if (insertIngredientsError) {
      return serverError("PATCH /api/recipes/[id] ingredients insert failed", "Failed to update recipe", insertIngredientsError);
    }
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;

  const { data: recipe, error: recipeError } = await supabaseAdmin
    .from("recipes")
    .select("source_name, created_by_profile_id")
    .eq("id", id)
    .single();

  if (recipeError || !recipe) {
    return NextResponse.json({ error: "Recipe not found" }, { status: 404 });
  }

  if (recipe.source_name !== "user" || recipe.created_by_profile_id !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [savedDependenciesResult, mealSlotDependenciesResult] = await Promise.all([
    supabaseAdmin
      .from("saved_recipes")
      .select("recipe_id", { count: "exact", head: true })
      .eq("recipe_id", id),
    supabaseAdmin
      .from("meal_slots")
      .select("id", { count: "exact" })
      .filter("recipe_items", "cs", JSON.stringify([{ recipeId: id }])),
  ]);

  if (savedDependenciesResult.error || mealSlotDependenciesResult.error) {
    return serverError(
      "DELETE /api/recipes/[id] dependency lookup failed",
      "Failed to delete recipe",
      savedDependenciesResult.error ?? mealSlotDependenciesResult.error
    );
  }

  const dependencyCount = (savedDependenciesResult.count ?? 0) + (mealSlotDependenciesResult.count ?? 0);

  if (dependencyCount > 0) {
    const { error: softRemoveError } = await supabaseAdmin
      .from("recipes")
      .update({ status: "removed" })
      .eq("id", id);

    if (softRemoveError) {
      return serverError("DELETE /api/recipes/[id] soft remove failed", "Failed to delete recipe", softRemoveError);
    }

    return NextResponse.json({ ok: true, removed: true, hardDeleted: false, dependencies: dependencyCount });
  }

  const { error: deleteError } = await supabaseAdmin.from("recipes").delete().eq("id", id);

  if (deleteError) {
    return serverError("DELETE /api/recipes/[id] failed", "Failed to delete recipe", deleteError);
  }

  return NextResponse.json({ ok: true, removed: true, hardDeleted: true, dependencies: 0 });
}
