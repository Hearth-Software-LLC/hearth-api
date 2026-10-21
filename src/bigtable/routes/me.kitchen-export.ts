import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { getMembershipContext } from "../lib/household.js";
import { toMemberAvatarPublicUrl } from "../lib/member-avatar.js";
import { loadPublicDisplayName } from "../lib/public-identity.js";
import { serverError } from "../lib/server-error.js";
import { supabaseAdmin } from "../../services/supabase.js";
import { loadGrocerySnapshotsPayload } from "./grocery.snapshots.js";
import { buildPlanResponseForPlan } from "./plans.current.js";
import { toCustomTagDto, type CustomTagRow } from "./recipes.tags.js";

// Everything the organizer's kitchen holds on the server, for the one-time move to iCloud:
// their recipes (every status), custom tags, every plan week, grocery snapshots and the household
// member ids and names. Each part is in the same JSON shape its own route returns.

const PAGE_SIZE = 1000;
const IN_CHUNK = 150;
const PLAN_CONCURRENCY = 8;

type QueryResult<T> = { data: T[] | null; error: { message: string } | null };

/** Every row of a query, a page at a time (PostgREST caps a response at 1000 rows). */
async function fetchAllRows<T>(page: (from: number, to: number) => PromiseLike<QueryResult<T>>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) {
      throw new Error(error.message);
    }
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) {
      return rows;
    }
  }
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

/** Runs a query per chunk of ids and concatenates the rows. */
async function selectInChunks<T>(ids: string[], query: (chunkIds: string[]) => PromiseLike<QueryResult<T>>): Promise<T[]> {
  const rows: T[] = [];
  for (const chunkIds of chunk(ids, IN_CHUNK)) {
    const { data, error } = await query(chunkIds);
    if (error) {
      throw new Error(error.message);
    }
    rows.push(...(data ?? []));
  }
  return rows;
}

type RecipeRow = {
  id: string;
  title: string;
  description: string | null;
  image_url: string | null;
  prep_minutes: number | null;
  cook_minutes: number | null;
  base_servings: number | null;
  difficulty: string | null;
  tags: string[] | null;
  instructions: unknown;
  source_name: string | null;
  source_url: string | null;
  attribution_required: boolean | null;
  attribution_text: string | null;
  status: string | null;
  current_version_id: string | null;
  created_by_profile_id: string | null;
  published_at: string | null;
  like_count: number | null;
};

type IngredientRow = {
  id: string;
  recipe_id: string;
  name: string;
  amount: number | null;
  measurement_type: string | null;
  quantity: number | null;
  unit: string | null;
};

const RECIPE_COLUMNS =
  "id, title, description, image_url, prep_minutes, cook_minutes, base_servings, difficulty, tags, instructions, source_name, source_url, attribution_required, attribution_text, status, current_version_id, created_by_profile_id, published_at, like_count";

/** The caller's own public name and avatar, resolved as GET /recipes/:id resolves a creator's. */
async function loadOwnCreatorIdentity(userId: string) {
  const [profileResult, memberResult, displayName] = await Promise.all([
    supabaseAdmin.from("profiles").select("household_name, avatar_url").eq("id", userId).maybeSingle(),
    supabaseAdmin
      .from("household_members")
      .select("name, avatar_url")
      .eq("profile_id", userId)
      .order("sort_order", { ascending: true })
      .limit(1)
      .maybeSingle(),
    loadPublicDisplayName(userId),
  ]);

  if (profileResult.error || memberResult.error) {
    throw new Error((profileResult.error ?? memberResult.error)!.message);
  }

  return {
    name: displayName ?? memberResult.data?.name ?? profileResult.data?.household_name ?? null,
    avatarUrl: toMemberAvatarPublicUrl(memberResult.data?.avatar_url ?? profileResult.data?.avatar_url ?? null),
  };
}

/**
 * The caller's recipes in the GET /recipes/:id `recipe` shape. The content is the recipe row as the
 * owner last saved it (the private copy being moved), not a pinned published version.
 */
async function loadOwnRecipeDetails(userId: string) {
  const recipes = await fetchAllRows<RecipeRow>((from, to) =>
    supabaseAdmin
      .from("recipes")
      .select(RECIPE_COLUMNS)
      .eq("created_by_profile_id", userId)
      .order("id", { ascending: true })
      .range(from, to)
  );

  const recipeIds = recipes.map((recipe) => recipe.id);
  const [ingredients, saved, likes, versions, creator] = await Promise.all([
    selectInChunks<IngredientRow>(recipeIds, (ids) =>
      supabaseAdmin
        .from("recipe_ingredients")
        .select("id, recipe_id, name, amount, measurement_type, quantity, unit")
        .in("recipe_id", ids)
    ),
    selectInChunks<{ recipe_id: string; version_id: string | null }>(recipeIds, (ids) =>
      supabaseAdmin.from("saved_recipes").select("recipe_id, version_id").eq("profile_id", userId).in("recipe_id", ids)
    ),
    selectInChunks<{ recipe_id: string }>(recipeIds, (ids) =>
      supabaseAdmin.from("recipe_likes").select("recipe_id").eq("profile_id", userId).in("recipe_id", ids)
    ),
    selectInChunks<{ recipe_id: string }>(recipeIds, (ids) =>
      supabaseAdmin.from("recipe_versions").select("recipe_id").in("recipe_id", ids)
    ),
    loadOwnCreatorIdentity(userId),
  ]);

  const ingredientsByRecipe = new Map<string, IngredientRow[]>();
  for (const row of ingredients) {
    const list = ingredientsByRecipe.get(row.recipe_id) ?? [];
    list.push(row);
    ingredientsByRecipe.set(row.recipe_id, list);
  }
  const savedByRecipe = new Map(saved.map((row) => [row.recipe_id, row]));
  const likedIds = new Set(likes.map((row) => row.recipe_id));
  const versionCountByRecipe = new Map<string, number>();
  for (const row of versions) {
    versionCountByRecipe.set(row.recipe_id, (versionCountByRecipe.get(row.recipe_id) ?? 0) + 1);
  }

  return recipes.map((recipe) => {
    const savedRow = savedByRecipe.get(recipe.id) ?? null;
    const pinnedVersionId = savedRow?.version_id ?? null;
    const recipeIngredients = (ingredientsByRecipe.get(recipe.id) ?? [])
      .slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map((item) => ({
        id: item.id,
        name: item.name,
        amount: item.amount ?? item.quantity,
        measurementType: item.measurement_type ?? item.unit,
      }));

    return {
      id: recipe.id,
      title: recipe.title,
      description: recipe.description,
      imageUrl: recipe.image_url,
      prepMinutes: recipe.prep_minutes,
      cookMinutes: recipe.cook_minutes,
      baseServings: recipe.base_servings,
      difficulty: recipe.difficulty,
      tags: recipe.tags,
      instructions: Array.isArray(recipe.instructions) ? recipe.instructions : [],
      sourceName: recipe.source_name,
      sourceUrl: recipe.source_url,
      attributionRequired: recipe.attribution_required,
      attributionText: recipe.attribution_text,
      isFavorite: Boolean(savedRow),
      isLiked: likedIds.has(recipe.id),
      likeCount: recipe.like_count ?? 0,
      createdByProfileId: recipe.created_by_profile_id,
      creatorName: creator.name,
      creatorAvatarUrl: creator.avatarUrl,
      status: recipe.status,
      currentVersionId: recipe.current_version_id,
      pinnedVersionId,
      hasUpdateAvailable: Boolean(
        pinnedVersionId
        && recipe.current_version_id
        && pinnedVersionId !== recipe.current_version_id
        && recipe.status === "published"
      ),
      publishedAt: recipe.published_at,
      versionCount: versionCountByRecipe.get(recipe.id) ?? 0,
      ingredients: recipeIngredients,
    };
  });
}

async function loadAllPlans(userId: string) {
  const plans = await fetchAllRows<{ id: string; week_start: string }>((from, to) =>
    supabaseAdmin
      .from("weekly_plans")
      .select("id, week_start")
      .eq("profile_id", userId)
      .order("week_start", { ascending: true })
      .range(from, to)
  );

  const planners: Array<Awaited<ReturnType<typeof buildPlanResponseForPlan>>> = [];
  for (const batch of chunk(plans, PLAN_CONCURRENCY)) {
    planners.push(...(await Promise.all(batch.map((plan) => buildPlanResponseForPlan(plan)))));
  }
  return planners;
}

export async function GET(request: Request) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const membership = await getMembershipContext(userId);
    if (membership.role === "member") {
      return NextResponse.json(
        { error: "Only the household's organizer can move its kitchen", code: "NOT_ORGANIZER" },
        { status: 409 }
      );
    }
  } catch (error) {
    return serverError("GET /me/kitchen-export membership lookup failed", "Failed to export kitchen", error);
  }

  try {
    const [recipes, tagRows, plans, grocery, memberRows] = await Promise.all([
      loadOwnRecipeDetails(userId),
      fetchAllRows<CustomTagRow>((from, to) =>
        supabaseAdmin
          .from("custom_recipe_tags")
          .select("id, label, normalized")
          .eq("profile_id", userId)
          .order("label", { ascending: true })
          .range(from, to)
      ),
      loadAllPlans(userId),
      loadGrocerySnapshotsPayload(userId),
      fetchAllRows<{ id: string; name: string | null }>((from, to) =>
        supabaseAdmin
          .from("household_members")
          .select("id, name")
          .eq("profile_id", userId)
          .order("sort_order", { ascending: true })
          .range(from, to)
      ),
    ]);

    return NextResponse.json(
      {
        recipes,
        tags: tagRows.map(toCustomTagDto),
        plans,
        grocery,
        householdMembers: memberRows.map((row) => ({ id: row.id, name: row.name ?? "" })),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return serverError("GET /me/kitchen-export failed", "Failed to export kitchen", error);
  }
}
