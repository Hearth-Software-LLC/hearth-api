import { NextRequest, NextResponse } from "../next-shim.js";

import { buildGroceryList, GroceryListGenerationError } from "../lib/ai-grocery-list.js";
import { getUserIdFromAuthHeader } from "../lib/auth.js";
import {
  contextFromHearth,
  contextFromStoredHousehold,
  parseHearthHousehold,
  type HearthAIContext,
  type StoredHouseholdSeat,
} from "../lib/hearth-household.js";
import { getMembershipContext } from "../lib/household.js";
import { DAYS, SLOTS } from "../lib/planner-contract.js";
import { canConsumeCredits, getUsageStatus, incrementUsageBy } from "../lib/rate-limit.js";
import { supabaseAdmin } from "../../services/supabase.js";

type GroceryRequest = {
  costcoMode?: boolean;
  weekStart?: string;
  selectedDates?: string[];
  startDate?: string;
  endDate?: string;
  overwriteExisting?: boolean;
  additionalPrompt?: string;
  /** The Hearth household, unnamed (see lib/hearth-household). Preferred over the stored household. */
  household?: unknown;
  /**
   * The planned meals, from the app's iCloud plan. When present the request is stateless: the
   * stored plan isn't read, and these meals (with their own ingredients, when sent) are used.
   */
  plannedMeals?: unknown;
};

type PlannedMeal = {
  isoDate: string;
  day: string;
  slot: string;
  title: string;
  eaters: number;
};

type ProvidedIngredient = {
  name: string;
  amount: number | null;
  measurementType: string | null;
};

/** A planned meal as the stateless request sends it: optionally with its recipe's ingredients. */
type ClientPlannedMeal = PlannedMeal & {
  baseServings: number | null;
  ingredients: ProvidedIngredient[] | null;
};

const MAX_PLANNED_MEALS = 200;
const MAX_MEAL_INGREDIENTS = 100;

type IngredientNeed = {
  name: string;
  unit: string | null;
  totalQuantity: number | null;
  occurrences: number;
  recipes: string[];
  notes: string[];
};

type MealSlotRow = {
  plan_id: string;
  day: string;
  slot: string;
  custom_meal: string | null;
  recipe_items?: unknown;
  excluded_members?: unknown;
};

function sundayOf(date = new Date()) {
  const normalized = new Date(date);
  normalized.setHours(0, 0, 0, 0);
  normalized.setDate(normalized.getDate() - normalized.getDay());
  return normalized.toISOString().slice(0, 10);
}

function addDaysIso(isoDate: string, days: number) {
  const date = new Date(`${isoDate}T00:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function buildIsoDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  let cursor = startDate;
  let guard = 0;
  while (cursor <= endDate && guard < 60) {
    dates.push(cursor);
    cursor = addDaysIso(cursor, 1);
    guard += 1;
  }
  return dates;
}

function normalizeDateSelection(payload: GroceryRequest) {
  const selectedDatesRaw = Array.isArray(payload.selectedDates)
    ? payload.selectedDates
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
    : [];

  const todayIso = new Date(new Date().toDateString()).toISOString().slice(0, 10);
  // Backward compatibility for older app versions: ignore past selectedDates
  // instead of hard failing the entire request.
  const selectedDates = selectedDatesRaw.filter((value) => value >= todayIso);

  let startDate = typeof payload.startDate === "string" ? payload.startDate.trim() : "";
  let endDate = typeof payload.endDate === "string" ? payload.endDate.trim() : "";
  if ((startDate && !endDate) || (!startDate && endDate)) {
    throw new Error("startDate and endDate must be provided together");
  }
  if ((startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) || (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate))) {
    throw new Error("startDate and endDate must be YYYY-MM-DD");
  }

  if (startDate && endDate && endDate < todayIso) {
    throw new Error("Past dates cannot be selected");
  }
  if (startDate && startDate < todayIso) {
    startDate = todayIso;
  }
  if (startDate && endDate && endDate < startDate) {
    throw new Error("endDate must be on or after startDate");
  }

  const weekStart = typeof payload.weekStart === "string" && /^\d{4}-\d{2}-\d{2}$/.test(payload.weekStart.trim())
    ? payload.weekStart.trim()
    : sundayOf();

  const dateSet = new Set<string>();
  selectedDates.forEach((date) => dateSet.add(date));
  if (startDate && endDate) {
    buildIsoDateRange(startDate, endDate).forEach((date) => dateSet.add(date));
  }
  if (dateSet.size === 0) {
    buildIsoDateRange(weekStart, addDaysIso(weekStart, 6)).forEach((date) => dateSet.add(date));
  }

  const allDates = Array.from(dateSet).sort();
  // dateSet always has at least one date (it falls back to the current week above).
  const minDate = allDates[0]!;
  const maxDate = allDates[allDates.length - 1]!;

  return {
    dateSet,
    minDate,
    maxDate,
    creditsToCharge: dateSet.size,
    label: `${minDate} to ${maxDate}`,
  };
}

async function getMealsForDateSelection(
  profileId: string,
  dateSet: Set<string>,
  minDate: string,
  maxDate: string,
  householdSize: number
): Promise<{ meals: string[]; recipeTitles: string[]; plannedMeals: PlannedMeal[] }> {
  const minWeekStart = sundayOf(new Date(`${minDate}T00:00:00`));
  const maxWeekStart = sundayOf(new Date(`${maxDate}T00:00:00`));

  const plansResult = await supabaseAdmin
    .from("weekly_plans")
    .select("id, week_start")
    .eq("profile_id", profileId)
    .gte("week_start", minWeekStart)
    .lte("week_start", maxWeekStart);

  if (plansResult.error) {
    throw new Error(plansResult.error.message);
  }

  const plans = plansResult.data ?? [];
  if (plans.length === 0) {
    return { meals: [], recipeTitles: [], plannedMeals: [] };
  }

  const planWeekById = new Map(plans.map((plan) => [plan.id, plan.week_start]));
  const planIds = plans.map((plan) => plan.id);

  let data: MealSlotRow[] | null = null;

  const fullResult = await supabaseAdmin
    .from("meal_slots")
    .select("plan_id, day, slot, custom_meal, recipe_items, excluded_members")
    .in("plan_id", planIds)
    .or("custom_meal.not.is.null,recipe_items.not.is.null");

  if (!fullResult.error) {
    data = (fullResult.data ?? []) as MealSlotRow[];
  } else if (isMissingSchemaError(fullResult.error)) {
    // Compatibility path for environments missing excluded_members.
    const withoutExclusionsResult = await supabaseAdmin
      .from("meal_slots")
      .select("plan_id, day, slot, custom_meal, recipe_items")
      .in("plan_id", planIds)
      .or("custom_meal.not.is.null,recipe_items.not.is.null");

    if (!withoutExclusionsResult.error) {
      data = (withoutExclusionsResult.data ?? []) as MealSlotRow[];
    } else if (isMissingSchemaError(withoutExclusionsResult.error)) {
      // Compatibility path for environments missing recipe_items as well.
      const legacyResult = await supabaseAdmin
        .from("meal_slots")
        .select("plan_id, day, slot, custom_meal")
        .in("plan_id", planIds)
        .or("custom_meal.not.is.null");

      if (legacyResult.error) {
        throw new Error(legacyResult.error.message);
      }

      data = (legacyResult.data ?? []) as MealSlotRow[];
    } else {
      throw new Error(withoutExclusionsResult.error.message);
    }
  } else {
    throw new Error(fullResult.error.message);
  }

  const dayOffsets: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };

  const order = new Map<string, number>();
  DAYS.forEach((day, dayIdx) => {
    SLOTS.forEach((slot, slotIdx) => {
      order.set(`${day}:${slot}`, dayIdx * 10 + slotIdx);
    });
  });

  const mealList: string[] = [];
  const recipeTitleSet = new Set<string>();
  const plannedMeals: PlannedMeal[] = [];

  (data ?? [])
    .sort((a, b) => (order.get(`${a.day}:${a.slot}`) ?? 999) - (order.get(`${b.day}:${b.slot}`) ?? 999))
    .forEach((row) => {
      const weekStart = planWeekById.get(row.plan_id);
      if (!weekStart) {
        return;
      }

      const dayOffset = dayOffsets[row.day] ?? 0;
      const slotDate = addDaysIso(weekStart, dayOffset);
      if (!dateSet.has(slotDate)) {
        return;
      }

      const excludedMembers = Array.isArray(row.excluded_members)
        ? row.excluded_members.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        : [];
      const eaters = Math.max(1, householdSize - excludedMembers.length);
      const withPortionHint = (title: string) =>
        excludedMembers.length > 0
          ? `${title} (make a smaller portion; ${excludedMembers.length} household member(s) are away)`
          : title;

      if (Array.isArray(row.recipe_items)) {
        const fromItems = row.recipe_items
          .map((entry) => {
            if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
              return null;
            }
            const titleRaw = (entry as { title?: unknown }).title;
            const title = typeof titleRaw === "string" ? titleRaw.trim() : "";
            return title || null;
          })
          .filter((title): title is string => Boolean(title));

        if (fromItems.length > 0) {
          fromItems.forEach((title) => {
            recipeTitleSet.add(title);
            mealList.push(withPortionHint(title));
            plannedMeals.push({
              isoDate: slotDate,
              day: row.day,
              slot: row.slot,
              title,
              eaters,
            });
          });
          return;
        }
      }

      if (typeof row.custom_meal === "string" && row.custom_meal.trim().length > 0) {
        const title = row.custom_meal.trim();
        mealList.push(withPortionHint(title));
        plannedMeals.push({
          isoDate: slotDate,
          day: row.day,
          slot: row.slot,
          title,
          eaters,
        });
      }
    });

  return {
    meals: mealList,
    recipeTitles: Array.from(recipeTitleSet).sort((a, b) => a.localeCompare(b)),
    plannedMeals,
  };
}

/**
 * Reads the optional `plannedMeals`. Null when absent; throws when it isn't an array. Entries
 * without a title are skipped; at most 200 are used.
 */
function parsePlannedMeals(value: unknown): ClientPlannedMeal[] | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new Error("plannedMeals must be an array");
  }

  const meals: ClientPlannedMeal[] = [];
  for (const entry of value.slice(0, MAX_PLANNED_MEALS)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const raw = entry as Record<string, unknown>;
    const title = typeof raw.title === "string" ? raw.title.trim().slice(0, 200) : "";
    if (!title) {
      continue;
    }
    const isoDate = typeof raw.isoDate === "string" ? raw.isoDate.trim() : "";
    if (isoDate && !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
      throw new Error("plannedMeals isoDate must be YYYY-MM-DD");
    }
    const eatersRaw = toNumberOrNull(raw.eaters);
    const eaters = eatersRaw !== null && eatersRaw >= 1 ? Math.min(Math.floor(eatersRaw), 100) : 1;
    const baseServingsRaw = toNumberOrNull(raw.baseServings);
    const baseServings = baseServingsRaw !== null && baseServingsRaw > 0 ? baseServingsRaw : null;

    let ingredients: ProvidedIngredient[] | null = null;
    if (Array.isArray(raw.ingredients)) {
      ingredients = raw.ingredients
        .slice(0, MAX_MEAL_INGREDIENTS)
        .map((item): ProvidedIngredient | null => {
          if (typeof item !== "object" || item === null || Array.isArray(item)) {
            return null;
          }
          const ingredient = item as Record<string, unknown>;
          const name = typeof ingredient.name === "string" ? ingredient.name.trim().slice(0, 120) : "";
          if (!name) {
            return null;
          }
          const measurementType = typeof ingredient.measurementType === "string" && ingredient.measurementType.trim()
            ? ingredient.measurementType.trim().slice(0, 40)
            : null;
          return { name, amount: toNumberOrNull(ingredient.amount), measurementType };
        })
        .filter((item): item is ProvidedIngredient => item !== null);
    }

    meals.push({
      isoDate,
      day: typeof raw.day === "string" ? raw.day.trim().toLowerCase().slice(0, 20) : "",
      slot: typeof raw.slot === "string" ? raw.slot.trim().toLowerCase().slice(0, 20) : "",
      title,
      eaters,
      baseServings,
      ingredients,
    });
  }
  return meals;
}

/** The meal context from client-sent meals, worded as getMealsForDateSelection words it. */
function mealContextFromClient(plannedMeals: ClientPlannedMeal[], householdSize: number) {
  const meals = plannedMeals.map((meal) => {
    const away = householdSize - meal.eaters;
    return away > 0
      ? `${meal.title} (make a smaller portion; ${away} household member(s) are away)`
      : meal.title;
  });
  return {
    meals,
    recipeTitles: Array.from(new Set(plannedMeals.map((meal) => meal.title))).sort((a, b) => a.localeCompare(b)),
    plannedMeals: plannedMeals.map(({ isoDate, day, slot, title, eaters }) => ({ isoDate, day, slot, title, eaters })),
  };
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

function isMissingSchemaError(error: { code?: string; message?: string } | null | undefined) {
  if (!error) {
    return false;
  }

  // Postgres undefined_table / undefined_column codes.
  if (error.code === "42P01" || error.code === "42703") {
    return true;
  }

  const message = (error.message ?? "").toLowerCase();
  return message.includes("does not exist") || message.includes("could not find");
}

type IngredientSourceMeal = PlannedMeal & {
  baseServings?: number | null;
  ingredients?: ProvidedIngredient[] | null;
};

type ScaledIngredient = { name: string; quantity: number | null; unit: string | null; notes: string | null };

/**
 * Ingredient needs across the planned meals. Meals that bring their own ingredients (the
 * stateless request) use those, scaled from their baseServings (default 8); the rest are looked
 * up as published recipes by title, as before.
 */
async function buildIngredientNeeds(plannedMeals: IngredientSourceMeal[]): Promise<IngredientNeed[]> {
  const providedMeals = plannedMeals.filter((meal) => Array.isArray(meal.ingredients) && meal.ingredients.length > 0);
  const lookupMeals = plannedMeals.filter((meal) => !(Array.isArray(meal.ingredients) && meal.ingredients.length > 0));

  const lookedUp = await lookUpRecipeIngredients(lookupMeals);
  const sources: Array<{ meal: PlannedMeal; title: string; baseServings: number; ingredients: ScaledIngredient[] }> = [
    ...providedMeals.map((meal) => ({
      meal,
      title: meal.title,
      baseServings: typeof meal.baseServings === "number" && meal.baseServings > 0 ? meal.baseServings : 8,
      ingredients: (meal.ingredients ?? []).map((ingredient) => ({
        name: ingredient.name,
        quantity: ingredient.amount,
        unit: ingredient.measurementType,
        notes: null,
      })),
    })),
    ...lookedUp,
  ];

  return aggregateIngredientNeeds(sources);
}

async function lookUpRecipeIngredients(
  plannedMeals: PlannedMeal[]
): Promise<Array<{ meal: PlannedMeal; title: string; baseServings: number; ingredients: ScaledIngredient[] }>> {
  const recipeTitles = Array.from(new Set(plannedMeals.map((meal) => meal.title.trim()).filter(Boolean)));
  if (recipeTitles.length === 0) {
    return [];
  }

    const recipesWithServingsResult = await supabaseAdmin
    .from("recipes")
    .select("id, title, base_servings")
    .in("title", recipeTitles);

    const recipes = recipesWithServingsResult.error && isMissingSchemaError(recipesWithServingsResult.error)
      ? (() => {
        // Compatibility path for environments where base_servings is not present yet.
        return null;
      })()
      : recipesWithServingsResult.data;

    let normalizedRecipes: Array<{ id: string; title: string; base_servings?: number | null }> | null = null;
    if (recipesWithServingsResult.error && isMissingSchemaError(recipesWithServingsResult.error)) {
      const recipesWithoutServingsResult = await supabaseAdmin
        .from("recipes")
        .select("id, title")
        .in("title", recipeTitles);

      if (recipesWithoutServingsResult.error) {
        throw new Error(recipesWithoutServingsResult.error.message);
      }

      normalizedRecipes = (recipesWithoutServingsResult.data ?? []).map((recipe) => ({
        id: recipe.id,
        title: recipe.title,
        base_servings: null,
      }));
    } else {
      if (recipesWithServingsResult.error) {
        throw new Error(recipesWithServingsResult.error.message);
      }

      normalizedRecipes = (recipes ?? []) as Array<{ id: string; title: string; base_servings?: number | null }>;
    }

    if (!normalizedRecipes || normalizedRecipes.length === 0) {
      return [];
    }

  const recipeByLowerTitle = new Map(
    normalizedRecipes
      .map((recipe) => {
        const title = typeof recipe.title === "string" ? recipe.title.trim().toLowerCase() : "";
        if (!title) {
          return null;
        }
        return [
          title,
          {
            id: recipe.id,
            title: recipe.title,
            baseServings:
              typeof recipe.base_servings === "number" && recipe.base_servings > 0
                ? recipe.base_servings
                : 8,
          },
        ] as const;
      })
      .filter((entry): entry is readonly [string, { id: string; title: string; baseServings: number }] => Boolean(entry))
  );

  const recipeIds = Array.from(new Set(Array.from(recipeByLowerTitle.values()).map((recipe) => recipe.id)));
  if (recipeIds.length === 0) {
    return [];
  }

  const ingredientsResult = await supabaseAdmin
    .from("recipe_ingredients")
    .select("recipe_id, name, quantity, unit")
    .in("recipe_id", recipeIds);

  if (ingredientsResult.error) {
    // Compatibility path for environments where recipe_ingredients table/columns are not ready yet.
    if (isMissingSchemaError(ingredientsResult.error)) {
      return [];
    }
    throw new Error(ingredientsResult.error.message);
  }

  const ingredientsByRecipeId = new Map<string, Array<{ name: string; quantity: number | null; unit: string | null; notes: string | null }>>();
  (ingredientsResult.data ?? []).forEach((ingredient) => {
    if (typeof ingredient.name !== "string" || !ingredient.name.trim()) {
      return;
    }

    const normalized = {
      name: ingredient.name.trim(),
      quantity: toNumberOrNull(ingredient.quantity),
      unit: typeof ingredient.unit === "string" && ingredient.unit.trim() ? ingredient.unit.trim() : null,
      notes: null,
    };

    const current = ingredientsByRecipeId.get(ingredient.recipe_id) ?? [];
    current.push(normalized);
    ingredientsByRecipeId.set(ingredient.recipe_id, current);
  });

  return plannedMeals.flatMap((plannedMeal) => {
    const recipe = recipeByLowerTitle.get(plannedMeal.title.trim().toLowerCase());
    if (!recipe) {
      return [];
    }

    const recipeIngredients = ingredientsByRecipeId.get(recipe.id) ?? [];
    if (recipeIngredients.length === 0) {
      return [];
    }

    return [{ meal: plannedMeal, title: recipe.title, baseServings: recipe.baseServings, ingredients: recipeIngredients }];
  });
}

function aggregateIngredientNeeds(
  sources: Array<{ meal: PlannedMeal; title: string; baseServings: number; ingredients: ScaledIngredient[] }>
): IngredientNeed[] {
  const aggregate = new Map<string, {
    name: string;
    unit: string | null;
    totalQuantity: number | null;
    occurrences: number;
    recipes: Set<string>;
    notes: Set<string>;
  }>();

  sources.forEach(({ meal: plannedMeal, title, baseServings, ingredients: recipeIngredients }) => {
    const recipe = { title, baseServings };
    const scale = Math.max(plannedMeal.eaters, 1) / Math.max(recipe.baseServings, 1);
    recipeIngredients.forEach((ingredient) => {
      const key = `${ingredient.name.toLowerCase()}::${ingredient.unit?.toLowerCase() ?? ""}`;
      const existing = aggregate.get(key) ?? {
        name: ingredient.name,
        unit: ingredient.unit,
        totalQuantity: 0,
        occurrences: 0,
        recipes: new Set<string>(),
        notes: new Set<string>(),
      };

      existing.occurrences += 1;
      existing.recipes.add(recipe.title);
      if (ingredient.notes) {
        existing.notes.add(ingredient.notes);
      }

      if (ingredient.quantity === null) {
        existing.totalQuantity = null;
      } else if (existing.totalQuantity !== null) {
        existing.totalQuantity += ingredient.quantity * scale;
      }

      aggregate.set(key, existing);
    });
  });

  return Array.from(aggregate.values())
    .map((entry) => ({
      name: entry.name,
      unit: entry.unit,
      totalQuantity: entry.totalQuantity === null ? null : Math.round(entry.totalQuantity * 100) / 100,
      occurrences: entry.occurrences,
      recipes: Array.from(entry.recipes).sort((a, b) => a.localeCompare(b)),
      notes: Array.from(entry.notes).sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The stored BigTable household, for clients that don't send a Hearth household yet. Reduced to
 * what the iCloud path sends (ages, roles, restrictions, likes, dislikes): member names and the
 * household name never reach the AI provider.
 */
async function getHouseholdContext(profileId: string) {
  const [membersResult, restrictionsResult] = await Promise.all([
    supabaseAdmin
      .from("household_members")
      .select("date_of_birth, likes, dislikes")
      .eq("profile_id", profileId),
    supabaseAdmin.from("dietary_restrictions").select("value").eq("profile_id", profileId),
  ]);

  if (membersResult.error || restrictionsResult.error) {
    throw new Error(
      membersResult.error?.message
        ?? restrictionsResult.error?.message
        ?? "Failed loading context"
    );
  }

  return contextFromStoredHousehold(
    (membersResult.data ?? []) as StoredHouseholdSeat[],
    (restrictionsResult.data ?? [])
      .map((entry) => entry.value)
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
  );
}

export async function POST(request: NextRequest) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const membership = await getMembershipContext(userId);
    if (membership.role === "member") {
      const permissionsResult = await supabaseAdmin
        .from("household_member_permissions")
        .select("can_use_ai_grocery")
        .eq("member_id", userId)
        .maybeSingle();

      if (!permissionsResult.data?.can_use_ai_grocery) {
        return NextResponse.json({ error: "Your organizer hasn't granted you access to AI grocery lists" }, { status: 403 });
      }
    }
  } catch {
    return NextResponse.json({ error: "Failed to generate grocery list" }, { status: 500 });
  }

  let body: GroceryRequest = {};
  try {
    body = (await request.json()) as GroceryRequest;
  } catch {
    body = {};
  }

  let hearthHousehold: HearthAIContext | null;
  let clientPlannedMeals: ClientPlannedMeal[] | null;
  try {
    hearthHousehold = parseHearthHousehold(body.household);
    clientPlannedMeals = parsePlannedMeals(body.plannedMeals);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid household" },
      { status: 400 }
    );
  }

  const costcoMode = Boolean(body.costcoMode);
  const additionalPrompt = typeof body.additionalPrompt === "string" ? body.additionalPrompt.trim().slice(0, 500) : "";
  let dateSelection: ReturnType<typeof normalizeDateSelection>;
  try {
    dateSelection = normalizeDateSelection(body);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid date selection", code: "INVALID_DATE_RANGE" },
      { status: 400 }
    );
  }

  try {
    const usage = await getUsageStatus(userId);
    if (!canConsumeCredits(usage, dateSelection.creditsToCharge)) {
      return NextResponse.json(
        {
          error: "Monthly AI limit reached",
          code: "LIMIT_REACHED",
          tier: usage.tier,
          requestsUsed: usage.requestsUsed,
          requestsLimit: usage.requestsLimit,
          requestedCredits: dateSelection.creditsToCharge,
          resetsAt: usage.resetsAt,
        },
        { status: 403 }
      );
    }

    const household = hearthHousehold ? contextFromHearth(hearthHousehold) : await getHouseholdContext(userId);
    // Stateless (plannedMeals sent): the household is the Hearth one when sent, else as big as the
    // biggest meal. Nothing is read from the stored plan.
    const householdSize = clientPlannedMeals
      ? Math.max(hearthHousehold ? hearthHousehold.people.length : Math.max(0, ...clientPlannedMeals.map((meal) => meal.eaters)), 1)
      : Math.max(household.memberNames.length, 1);
    const mealContext = clientPlannedMeals
      ? mealContextFromClient(clientPlannedMeals, householdSize)
      : await getMealsForDateSelection(
          userId,
          dateSelection.dateSet,
          dateSelection.minDate,
          dateSelection.maxDate,
          householdSize
        );

    if (mealContext.meals.length === 0) {
      return NextResponse.json(
        {
          error: "No meals planned for the selected date range. Create the meal plan before generating a grocery list.",
          code: "PLAN_EMPTY",
          dateRange: dateSelection.label,
        },
        { status: 400 }
      );
    }

    const ingredientNeeds = await buildIngredientNeeds(clientPlannedMeals ?? mealContext.plannedMeals);
    const generated = await buildGroceryList({
      meals: mealContext.meals,
      recipeTitles: mealContext.recipeTitles,
      dateRangeLabel: dateSelection.label,
      householdMembers: household.memberNames,
      restrictions: household.restrictions,
      householdName: household.householdName,
      costcoMode,
      plannedMeals: mealContext.plannedMeals,
      ingredientNeeds,
      additionalPrompt,
    });

    let latestUsage = usage;
    try {
      await incrementUsageBy(userId, "grocery_list", dateSelection.creditsToCharge);
      latestUsage = await getUsageStatus(userId);
    } catch {
      latestUsage = {
        ...usage,
        requestsUsed: usage.requestsUsed + dateSelection.creditsToCharge,
        canMakeRequest: canConsumeCredits(usage, dateSelection.creditsToCharge),
      };
    }

    return NextResponse.json({
      groceryList: generated.groceryList,
      generatedBy: generated.source,
      usage: {
        tier: latestUsage.tier,
        requestsUsed: latestUsage.requestsUsed,
        requestsLimit: latestUsage.requestsLimit,
        creditsCharged: dateSelection.creditsToCharge,
        resetsAt: latestUsage.resetsAt,
        canMakeRequest: latestUsage.canMakeRequest,
      },
    });
  } catch (error) {
    if (error instanceof GroceryListGenerationError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
        },
        { status: error.status }
      );
    }

    return NextResponse.json({ error: "Failed to generate grocery list" }, { status: 500 });
  }
}
