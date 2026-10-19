import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { toMemberAvatarPublicUrl } from "../lib/member-avatar.js";
import { loadPublicDisplayNames } from "../lib/public-identity.js";
import { parseRecipeVersionContent } from "../lib/recipe-versioning.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { serverError } from "../lib/server-error.js";

type JsonObject = Record<string, unknown>;

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function GET(request: Request) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: favorites, error: favoritesError } = await supabaseAdmin
    .from("saved_recipes")
    .select("recipe_id, version_id")
    .eq("profile_id", userId)
    .order("saved_at", { ascending: false });

  if (favoritesError) {
    return serverError("GET /api/recipes/favorites lookup failed", "Failed to fetch favorites", favoritesError);
  }

  const recipeIds = (favorites ?? []).map((row) => row.recipe_id);
  if (recipeIds.length === 0) {
    return NextResponse.json({ recipes: [] });
  }

  const favoriteVersionIdByRecipeId = new Map(
    (favorites ?? []).map((row) => [row.recipe_id, row.version_id as string | null])
  );

  const { data: recipes, error: recipesError } = await supabaseAdmin
    .from("recipes")
    .select(
      "id, title, description, image_url, prep_minutes, cook_minutes, base_servings, difficulty, tags, source_name, source_url, attribution_required, attribution_text, status, current_version_id, published_at, like_count, created_by_profile_id"
    )
    .in("id", recipeIds)
    .order("title", { ascending: true })
    .order("id", { ascending: true });

  if (recipesError) {
    return serverError(
      "GET /api/recipes/favorites recipes lookup failed",
      "Failed to fetch favorites",
      recipesError
    );
  }

  const pinnedVersionIds = Array.from(
    new Set(
      (favorites ?? [])
        .map((row) => row.version_id)
        .filter((versionId): versionId is string => typeof versionId === "string" && versionId.trim().length > 0)
    )
  );

  const versionContentById = new Map<string, unknown>();
  if (pinnedVersionIds.length > 0) {
    const { data: versions, error: versionsError } = await supabaseAdmin
      .from("recipe_versions")
      .select("id, content")
      .in("id", pinnedVersionIds);

    if (versionsError) {
      return serverError(
        "GET /api/recipes/favorites versions lookup failed",
        "Failed to fetch favorites",
        versionsError
      );
    }

    (versions ?? []).forEach((row) => {
      versionContentById.set(row.id, row.content);
    });
  }

  let likedIds = new Set<string>();
  if (recipeIds.length > 0) {
    const { data: likes, error: likesError } = await supabaseAdmin
      .from("recipe_likes")
      .select("recipe_id")
      .eq("profile_id", userId)
      .in("recipe_id", recipeIds);

    if (likesError) {
      return serverError(
        "GET /api/recipes/favorites likes lookup failed",
        "Failed to fetch favorites",
        likesError
      );
    }

    likedIds = new Set((likes ?? []).map((row) => row.recipe_id));
  }

  const creatorProfileIds = Array.from(
    new Set(
      (recipes ?? [])
        .map((recipe) => recipe.created_by_profile_id)
        .filter((profileId): profileId is string => typeof profileId === "string" && profileId.trim().length > 0)
    )
  );

  const creatorDisplayNames = await loadPublicDisplayNames(creatorProfileIds);
  const creatorProfileById = new Map<string, { household_name: string | null; avatar_url: string | null }>();
  const creatorOrganizerById = new Map<string, { name: string | null; avatar_url: string | null }>();

  if (creatorProfileIds.length > 0) {
    const [creatorProfilesLookup, creatorOrganizersLookup] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("id, household_name, avatar_url")
        .in("id", creatorProfileIds),
      supabaseAdmin
        .from("household_members")
        .select("profile_id, name, avatar_url, sort_order")
        .in("profile_id", creatorProfileIds)
        .order("sort_order", { ascending: true }),
    ]);

    const { data: creatorProfiles, error: creatorProfilesError } = creatorProfilesLookup;
    const { data: creatorOrganizers, error: creatorOrganizersError } = creatorOrganizersLookup;

    if (creatorProfilesError) {
      return serverError(
        "GET /api/recipes/favorites creator profile lookup failed",
        "Failed to fetch favorites",
        creatorProfilesError
      );
    }

    if (creatorOrganizersError) {
      return serverError(
        "GET /api/recipes/favorites creator organizer lookup failed",
        "Failed to fetch favorites",
        creatorOrganizersError
      );
    }

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
    recipes: (recipes ?? []).map((recipe) => {
        const pinnedVersionId = favoriteVersionIdByRecipeId.get(recipe.id) ?? null;
        const versioned = pinnedVersionId ? parseRecipeVersionContent(versionContentById.get(pinnedVersionId)) : null;
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
        isFavorite: true,
        isLiked: likedIds.has(recipe.id),
        likeCount: recipe.like_count ?? 0,
        createdByProfileId: recipe.created_by_profile_id,
        creatorName: (typeof creatorProfileId === "string" ? creatorDisplayNames.get(creatorProfileId) : undefined)
          ?? creatorOrganizer?.name
          ?? creatorProfile?.household_name
          ?? null,
        creatorAvatarUrl: toMemberAvatarPublicUrl(creatorOrganizer?.avatar_url ?? creatorProfile?.avatar_url ?? null),
        status: recipe.status,
        currentVersionId: recipe.current_version_id,
        pinnedVersionId: pinnedVersionId,
        hasUpdateAvailable: Boolean(
          pinnedVersionId
          && recipe.current_version_id
          && pinnedVersionId !== recipe.current_version_id
          && recipe.status === "published"
        ),
        publishedAt: recipe.published_at,
      };
    }),
  });
}

export async function PUT(request: Request) {
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

  const recipeId = payload.recipeId;
  const saved = payload.saved;

  if (typeof recipeId !== "string" || !recipeId.trim()) {
    return badRequest("recipeId is required");
  }
  if (typeof saved !== "boolean") {
    return badRequest("saved must be a boolean");
  }

  if (saved) {
    const { data: recipe, error: recipeError } = await supabaseAdmin
      .from("recipes")
      .select("current_version_id")
      .eq("id", recipeId)
      .maybeSingle();

    if (recipeError || !recipe) {
      return serverError("PUT /api/recipes/favorites recipe lookup failed", "Failed to update favorite", recipeError);
    }

    const { error } = await supabaseAdmin
      .from("saved_recipes")
      .upsert({
        profile_id: userId,
        recipe_id: recipeId,
        version_id: recipe.current_version_id,
      });

    if (error) {
      return serverError("PUT /api/recipes/favorites save failed", "Failed to update favorite", error);
    }
  } else {
    const { error } = await supabaseAdmin
      .from("saved_recipes")
      .delete()
      .eq("profile_id", userId)
      .eq("recipe_id", recipeId);

    if (error) {
      return serverError("PUT /api/recipes/favorites delete failed", "Failed to update favorite", error);
    }
  }

  return NextResponse.json({ ok: true });
}
