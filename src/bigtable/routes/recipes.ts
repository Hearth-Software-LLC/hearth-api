import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { toMemberAvatarPublicUrl } from "../lib/member-avatar.js";
import { parseRecipeVersionContent } from "../lib/recipe-versioning.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { serverError } from "../lib/server-error.js";

type JsonObject = Record<string, unknown>;

type CreateRecipeIngredientPayload = {
  name: string;
  amount: number | null;
  measurementType: string | null;
};

type CreateRecipePayload = {
  title: string;
  imageUrl: string;
  description: string | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  baseServings: number;
  difficulty: string | null;
  tags: string[];
  ingredients: CreateRecipeIngredientPayload[];
  instructions: string[];
};

const MAX_LIMIT = 50;

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function normalizeCreatePayload(payload: JsonObject): CreateRecipePayload {
  const titleRaw = payload.title;
  if (typeof titleRaw !== "string" || !titleRaw.trim()) {
    throw new Error("title is required");
  }

  const imageUrlRaw = payload.imageUrl;
  if (typeof imageUrlRaw !== "string" || !imageUrlRaw.trim()) {
    throw new Error("imageUrl is required");
  }

  const descriptionRaw = payload.description;
  const prepMinutesRaw = payload.prepMinutes;
  const cookMinutesRaw = payload.cookMinutes;
  const baseServingsRaw = payload.baseServings;
  const difficultyRaw = payload.difficulty;
  const tagsRaw = payload.tags;
  const ingredientsRaw = payload.ingredients;
  const instructionsRaw = payload.instructions;

  const tags = Array.isArray(tagsRaw)
    ? tagsRaw
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)
    : [];

  const instructions = Array.isArray(instructionsRaw)
    ? instructionsRaw
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)
    : [];

  const ingredients = Array.isArray(ingredientsRaw)
    ? ingredientsRaw
        .map((value): CreateRecipeIngredientPayload | null => {
          if (typeof value === "string") {
            const name = value.trim();
            if (!name) {
              return null;
            }
            return {
              name,
              amount: null,
              measurementType: null,
            };
          }

          if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return null;
          }

          const ingredient = value as JsonObject;
          const nameRaw = ingredient.name;
          const amountRaw = ingredient.amount ?? ingredient.quantity;
          const measurementTypeRaw = ingredient.measurementType ?? ingredient.unit;

          if (typeof nameRaw !== "string" || !nameRaw.trim()) {
            return null;
          }

          return {
            name: nameRaw.trim(),
            amount: typeof amountRaw === "number" && Number.isFinite(amountRaw) ? amountRaw : null,
            measurementType: typeof measurementTypeRaw === "string" && measurementTypeRaw.trim() ? measurementTypeRaw.trim() : null,
          };
        })
        .filter((value): value is CreateRecipeIngredientPayload => value !== null)
    : [];

  return {
    title: titleRaw.trim(),
    imageUrl: imageUrlRaw.trim(),
    description: typeof descriptionRaw === "string" && descriptionRaw.trim() ? descriptionRaw.trim() : null,
    prepMinutes: typeof prepMinutesRaw === "number" && prepMinutesRaw >= 0 ? prepMinutesRaw : null,
    cookMinutes: typeof cookMinutesRaw === "number" && cookMinutesRaw >= 0 ? cookMinutesRaw : null,
    baseServings: typeof baseServingsRaw === "number" && Number.isInteger(baseServingsRaw) && baseServingsRaw > 0 ? baseServingsRaw : 8,
    difficulty: typeof difficultyRaw === "string" && difficultyRaw.trim() ? difficultyRaw.trim() : null,
    tags,
    ingredients,
    instructions,
  };
}

export async function GET(request: Request) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  const quickFilter = url.searchParams.get("quickFilter")?.trim() ?? "";
  const normalizedQuickFilter = quickFilter.toLowerCase();
  const collection = url.searchParams.get("collection")?.trim().toLowerCase();
  const collectionScope = collection === "my" ? "my" : collection === "removed" ? "removed" : "all";
  const limitParam = Number(url.searchParams.get("limit") ?? "20");
  const offsetParam = Number(url.searchParams.get("offset") ?? "0");

  const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limitParam))) : 20;
  const offset = Number.isFinite(offsetParam) ? Math.max(0, Math.trunc(offsetParam)) : 0;

  let recipesQuery = supabaseAdmin
    .from("recipes")
    .select(
      "id, title, description, image_url, prep_minutes, cook_minutes, base_servings, difficulty, tags, source_name, source_url, attribution_required, attribution_text, status, current_version_id, published_at, like_count, created_by_profile_id",
      { count: "exact" }
    )
    .order("title", { ascending: true })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);

  if (collectionScope === "removed") {
    recipesQuery = recipesQuery
      .eq("created_by_profile_id", userId)
      .eq("source_name", "user")
      .eq("status", "removed");
  } else if (collectionScope === "my") {
    recipesQuery = recipesQuery
      .eq("created_by_profile_id", userId)
      .neq("status", "removed");
  } else {
    recipesQuery = recipesQuery
      .or(`status.eq.published,created_by_profile_id.eq.${userId}`)
      .neq("status", "removed");
  }

  if (query) {
    recipesQuery = recipesQuery.ilike("title", `%${query}%`);
  }

  if (normalizedQuickFilter && normalizedQuickFilter !== "all") {
    recipesQuery = recipesQuery.contains("tags", [normalizedQuickFilter]);
  }

  const { data: recipes, error: recipesError, count } = await recipesQuery;

  if (recipesError) {
    return serverError("GET /api/recipes query failed", "Failed to fetch recipes", recipesError);
  }

  const rows = recipes ?? [];
  const totalCount = typeof count === "number" ? count : null;
  const hasMore = totalCount !== null ? offset + rows.length < totalCount : rows.length === limit;
  const pagedRecipes = rows;
  const recipeIds = pagedRecipes.map((recipe) => recipe.id);
  const creatorProfileIds = Array.from(
    new Set(
      pagedRecipes
        .map((recipe) => recipe.created_by_profile_id)
        .filter((profileId): profileId is string => typeof profileId === "string" && profileId.trim().length > 0)
    )
  );

  const currentVersionIds = pagedRecipes
    .map((recipe) => recipe.current_version_id)
    .filter((versionId): versionId is string => typeof versionId === "string" && versionId.trim().length > 0);

  const noRows = Promise.resolve({ data: [] as { recipe_id: string }[], error: null });
  const noVersionRows = Promise.resolve({ data: [] as { id: string; content: unknown }[], error: null });
  const noProfileRows = Promise.resolve({ data: [] as { id: string; household_name: string | null; avatar_url: string | null }[], error: null });
  const noOrganizerRows = Promise.resolve({ data: [] as { profile_id: string; name: string | null; avatar_url: string | null; sort_order: number | null }[], error: null });

  const [
    favoritesLookup,
    likesLookup,
    versionsLookup,
    creatorProfilesLookup,
    creatorOrganizersLookup,
  ] = await Promise.all([
    recipeIds.length > 0
      ? supabaseAdmin.from("saved_recipes").select("recipe_id").eq("profile_id", userId).in("recipe_id", recipeIds)
      : noRows,
    recipeIds.length > 0
      ? supabaseAdmin.from("recipe_likes").select("recipe_id").eq("profile_id", userId).in("recipe_id", recipeIds)
      : noRows,
    currentVersionIds.length > 0
      ? supabaseAdmin.from("recipe_versions").select("id, content").in("id", currentVersionIds)
      : noVersionRows,
    creatorProfileIds.length > 0
      ? supabaseAdmin.from("profiles").select("id, household_name, avatar_url").in("id", creatorProfileIds)
      : noProfileRows,
    creatorProfileIds.length > 0
      ? supabaseAdmin.from("household_members").select("profile_id, name, avatar_url, sort_order").in("profile_id", creatorProfileIds).order("sort_order", { ascending: true })
      : noOrganizerRows,
  ]);

  if (favoritesLookup.error) {
    return serverError("GET /api/recipes favorites lookup failed", "Failed to fetch recipes", favoritesLookup.error);
  }
  if (likesLookup.error) {
    return serverError("GET /api/recipes likes lookup failed", "Failed to fetch recipes", likesLookup.error);
  }
  if (versionsLookup.error) {
    return serverError("GET /api/recipes recipe_versions lookup failed", "Failed to fetch recipes", versionsLookup.error);
  }
  if (creatorProfilesLookup.error) {
    return serverError("GET /api/recipes creator profile lookup failed", "Failed to fetch recipes", creatorProfilesLookup.error);
  }
  if (creatorOrganizersLookup.error) {
    return serverError("GET /api/recipes creator organizer lookup failed", "Failed to fetch recipes", creatorOrganizersLookup.error);
  }

  const favoriteIds = new Set((favoritesLookup.data ?? []).map((row) => row.recipe_id));
  const likedIds = new Set((likesLookup.data ?? []).map((row) => row.recipe_id));

  const versionContentById = new Map<string, unknown>();
  (versionsLookup.data ?? []).forEach((row) => {
    versionContentById.set(row.id, row.content);
  });

  const creatorProfileById = new Map<string, { household_name: string | null; avatar_url: string | null }>();
  const creatorOrganizerById = new Map<string, { name: string | null; avatar_url: string | null }>();

  if (creatorProfileIds.length > 0) {
    const { data: creatorProfiles } = creatorProfilesLookup;
    const { data: creatorOrganizers } = creatorOrganizersLookup;

    (creatorProfiles ?? []).forEach((profile) => {
      creatorProfileById.set(profile.id, {
        household_name: profile.household_name,
        avatar_url: profile.avatar_url,
      });
    });

    (creatorOrganizers ?? []).forEach((member) => {
      if (!creatorOrganizerById.has(member.profile_id)) {
        creatorOrganizerById.set(member.profile_id, {
          name: member.name,
          avatar_url: member.avatar_url,
        });
      }
    });
  }

  return NextResponse.json({
    recipes: pagedRecipes.map((recipe) => {
      const versioned = (function resolveVersionedFields() {
        // For the recipe owner, prefer live row values so draft edits are visible immediately.
        if (recipe.created_by_profile_id === userId) {
          return null;
        }

        const versionId = recipe.current_version_id;
        if (typeof versionId !== "string" || !versionId) {
          return null;
        }

        const parsed = parseRecipeVersionContent(versionContentById.get(versionId));
        if (!parsed) {
          return null;
        }

        return {
          title: parsed.title,
          description: parsed.description,
          imageUrl: parsed.imageUrl,
          prepMinutes: parsed.prepMinutes,
          cookMinutes: parsed.cookMinutes,
          baseServings: parsed.baseServings,
          difficulty: parsed.difficulty,
          tags: parsed.tags,
        };
      })();

      const creatorProfileId = recipe.created_by_profile_id;
      const creatorProfile = typeof creatorProfileId === "string" ? creatorProfileById.get(creatorProfileId) ?? null : null;
      const creatorOrganizer = typeof creatorProfileId === "string" ? creatorOrganizerById.get(creatorProfileId) ?? null : null;

      return {
        id: recipe.id,
        title: versioned?.title ?? recipe.title,
        description: versioned?.description ?? recipe.description,
        imageUrl: versioned?.imageUrl ?? recipe.image_url,
        prepMinutes: versioned?.prepMinutes ?? recipe.prep_minutes,
        cookMinutes: versioned?.cookMinutes ?? recipe.cook_minutes,
        baseServings: versioned?.baseServings ?? recipe.base_servings,
        difficulty: versioned?.difficulty ?? recipe.difficulty,
        tags: versioned?.tags ?? recipe.tags,
        sourceName: recipe.source_name,
        sourceUrl: recipe.source_url,
        attributionRequired: recipe.attribution_required,
        attributionText: recipe.attribution_text,
        isFavorite: favoriteIds.has(recipe.id),
        isLiked: likedIds.has(recipe.id),
        likeCount: recipe.like_count ?? 0,
        createdByProfileId: recipe.created_by_profile_id,
        creatorName: creatorOrganizer?.name ?? creatorProfile?.household_name ?? null,
        creatorAvatarUrl: toMemberAvatarPublicUrl(creatorOrganizer?.avatar_url ?? creatorProfile?.avatar_url ?? null),
        status: recipe.status,
        currentVersionId: recipe.current_version_id,
        publishedAt: recipe.published_at,
      };
    }),
    pagination: {
      limit,
      offset,
      hasMore,
      nextOffset: hasMore ? offset + rows.length : null,
      totalCount,
    },
  }, { headers: { "Cache-Control": "private, max-age=30" } });
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

  let normalized: CreateRecipePayload;
  try {
    normalized = normalizeCreatePayload(payload);
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : "Invalid payload");
  }

  const { data: recipe, error } = await supabaseAdmin
    .from("recipes")
    .insert({
      title: normalized.title,
      description: normalized.description,
      image_url: normalized.imageUrl,
      prep_minutes: normalized.prepMinutes,
      cook_minutes: normalized.cookMinutes,
      base_servings: normalized.baseServings,
      difficulty: normalized.difficulty,
      tags: normalized.tags,
      instructions: normalized.instructions,
      source_name: "user",
      created_by_profile_id: userId,
      status: "draft",
    })
    .select("id")
    .single();

  if (error) {
    return serverError("POST /api/recipes insert failed", "Failed to create recipe", error);
  }

  if (normalized.ingredients.length > 0) {
    const { error: ingredientsError } = await supabaseAdmin.from("recipe_ingredients").insert(
      normalized.ingredients.map((ingredient) => ({
        recipe_id: recipe.id,
        name: ingredient.name,
        amount: ingredient.amount,
        measurement_type: ingredient.measurementType,
        quantity: ingredient.amount,
        unit: ingredient.measurementType,
        notes: null,
      }))
    );

    if (ingredientsError) {
      await supabaseAdmin.from("recipes").delete().eq("id", recipe.id);
      return serverError(
        "POST /api/recipes ingredients insert failed",
        "Failed to create recipe",
        ingredientsError
      );
    }
  }

  const { error: favoriteError } = await supabaseAdmin
    .from("saved_recipes")
    .upsert({
      profile_id: userId,
      recipe_id: recipe.id,
    });

  if (favoriteError) {
    await supabaseAdmin.from("recipes").delete().eq("id", recipe.id);
    return serverError(
      "POST /api/recipes save-to-favorites failed",
      "Failed to create recipe",
      favoriteError
    );
  }

  return NextResponse.json({ id: recipe.id }, { status: 201 });
}
