import { NextRequest, NextResponse } from "../next-shim.js";

import { buildMealPlan } from "../lib/ai-meal-plan.js";
import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { getMembershipContext } from "../lib/household.js";
import {
  contextFromHearth,
  contextFromStoredHousehold,
  parseHearthHousehold,
  type HearthAIContext,
  type StoredHouseholdSeat,
} from "../lib/hearth-household.js";
import { DAYS, SLOTS, type DayOfWeek, type MealSlotType } from "../lib/planner-contract.js";
import { canConsumeCredits, getUsageStatus, incrementUsageBy } from "../lib/rate-limit.js";
import {
  apportionRecipeSlots,
  DEFAULT_RECIPE_MIX,
  normalizeRecipeMix,
  RECIPE_MIX_BUCKETS,
  type RecipeMix,
  type RecipeMixBucket,
} from "../lib/recipe-mix.js";
import { supabaseAdmin } from "../lib/supabase.js";

type RecipeCandidateRow = {
  title: string;
  tags: string[];
  prepMinutes: number | null;
  cookMinutes: number | null;
};

type MealPlanRequest = {
  prompt?: string;
  mealStyle?: "comfort" | "varied" | "light";
  recipeMix?: Partial<RecipeMix>;
  // Legacy single-source field from the previous build; still accepted.
  recipeSource?: "all" | "mine" | "favorites";
  quickTags?: string[];
  selectedMeals?: Record<string, string[]>;
  weekStart?: string;
  selectedDates?: string[];
  startDate?: string;
  endDate?: string;
  overwriteExisting?: boolean;
  previewOnly?: boolean;
  generatedPlan?: Record<string, Record<string, string>>;
  generatedBy?: "anthropic" | "fallback";
  /** The Hearth household, unnamed (see lib/hearth-household). Preferred over the stored household. */
  household?: unknown;
  /**
   * The family's own recipes, from their iCloud. When present the request is stateless: these are
   * the "mine" bucket, and nothing is read from or written to the stored plan.
   */
  myRecipes?: unknown;
};

/** A recipe from the client's own (iCloud) library, as `myRecipes` sends it. */
type ClientRecipe = {
  id: string;
  title: string;
  tags: string[];
  minutes: number | null;
};

type RecipeLookupEntry = {
  recipeId: string;
  imageUrl: string | null;
  bucket: RecipeMixBucket;
};

const MAX_MY_RECIPES = 300;

type PlannerMealRole = "entree" | "side" | "dessert" | "other";
type PlannerMealItem = {
  title: string;
  role: PlannerMealRole;
  imageUrl: string | null;
};

type SelectedDateSlots = Record<string, MealSlotType[]>;

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function sundayOf(date = new Date()) {
  const normalized = new Date(date);
  normalized.setHours(0, 0, 0, 0);
  const day = normalized.getDay();
  const diff = -day;
  normalized.setDate(normalized.getDate() + diff);
  return normalized.toISOString().slice(0, 10);
}

function addDaysIso(isoDate: string, days: number) {
  const date = new Date(`${isoDate}T00:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayNameFromIso(isoDate: string): DayOfWeek {
  const day = new Date(`${isoDate}T00:00:00`).getDay();
  return DAYS[day === 0 ? 6 : day - 1]!;
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

async function ensureWeeklyPlan(profileId: string, weekStart: string) {
  const existingPlanResult = await supabaseAdmin
    .from("weekly_plans")
    .select("id, week_start")
    .eq("profile_id", profileId)
    .eq("week_start", weekStart)
    .maybeSingle();

  if (existingPlanResult.error) {
    throw new Error(existingPlanResult.error.message);
  }

  if (existingPlanResult.data) {
    return existingPlanResult.data;
  }

  const insertResult = await supabaseAdmin
    .from("weekly_plans")
    .insert({ profile_id: profileId, week_start: weekStart })
    .select("id, week_start")
    .single();

  if (insertResult.error) {
    throw new Error(insertResult.error.message);
  }

  return insertResult.data;
}

async function findWeeklyPlan(profileId: string, weekStart: string) {
  const existingPlanResult = await supabaseAdmin
    .from("weekly_plans")
    .select("id, week_start")
    .eq("profile_id", profileId)
    .eq("week_start", weekStart)
    .maybeSingle();

  if (existingPlanResult.error) {
    throw new Error(existingPlanResult.error.message);
  }

  return existingPlanResult.data;
}

async function buildPlanResponse(profileId: string, weekStart: string, createIfMissing = true) {
  const plan = createIfMissing
    ? await ensureWeeklyPlan(profileId, weekStart)
    : await findWeeklyPlan(profileId, weekStart);

  if (!plan) {
    const emptyDays = Object.fromEntries(
      DAYS.map((day) => {
        const perDay = Object.fromEntries(
          SLOTS.map((slot) => [
            slot,
            {
              id: null,
              customMeal: null,
              recipeItems: [],
              excludedMembers: [],
              completed: false,
            },
          ])
        );
        return [day, perDay];
      })
    );

    return {
      planId: "preview",
      weekStart,
      days: emptyDays,
    };
  }

  const slotsResult = await supabaseAdmin
    .from("meal_slots")
    .select("id, day, slot, custom_meal, recipe_items, excluded_members, completed")
    .eq("plan_id", plan.id);

  if (slotsResult.error) {
    throw new Error(slotsResult.error.message);
  }

  const slotIndex = new Map((slotsResult.data ?? []).map((item) => [`${item.day}:${item.slot}`, item]));

  const days = Object.fromEntries(
    DAYS.map((day) => {
      const perDay = Object.fromEntries(
        SLOTS.map((slot) => {
          const item = slotIndex.get(`${day}:${slot}`);
          const recipeItems = parseRecipeItems(item?.recipe_items, item?.custom_meal);
          const excludedMembers = parseExcludedMembers(item?.excluded_members);
          return [
            slot,
            {
              id: item?.id ?? null,
              customMeal: item?.custom_meal ?? null,
              recipeItems,
              excludedMembers,
              completed: item?.completed ?? false,
            },
          ];
        })
      );

      return [day, perDay];
    })
  );

  return {
    planId: plan.id,
    weekStart: plan.week_start,
    days,
  };
}

function parseRecipeItems(value: unknown, legacyCustomMeal?: string | null): PlannerMealItem[] {
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          return null;
        }

        const titleRaw = (entry as { title?: unknown }).title;
        const roleRaw = (entry as { role?: unknown }).role;
        const imageUrlRaw = (entry as { imageUrl?: unknown }).imageUrl;
        const title = typeof titleRaw === "string" ? titleRaw.trim() : "";
        const role = roleRaw === "entree" || roleRaw === "side" || roleRaw === "dessert" || roleRaw === "other"
          ? roleRaw
          : "other";
        const imageUrl = typeof imageUrlRaw === "string" ? imageUrlRaw.trim() || null : null;
        if (!title) {
          return null;
        }
        return { title, role, imageUrl } satisfies PlannerMealItem;
      })
      .filter((entry): entry is PlannerMealItem => entry !== null)
      .slice(0, 8);
    if (normalized.length > 0) {
      return normalized;
    }
  }

  if (typeof legacyCustomMeal === "string" && legacyCustomMeal.trim()) {
    return [{ title: legacyCustomMeal.trim(), role: "entree", imageUrl: null }];
  }

  return [];
}

function collectSelectedGeneratedTitles(
  generatedPlan: Record<DayOfWeek, Record<MealSlotType, string>>,
  selectedDateSlots: SelectedDateSlots
) {
  const unique = new Set<string>();

  Object.entries(selectedDateSlots).forEach(([isoDate, slots]) => {
    if (slots.length === 0) {
      return;
    }

    const day = dayNameFromIso(isoDate);
    slots.forEach((slot) => {
      const title = generatedPlan[day][slot]?.trim();
      if (title) {
        unique.add(title);
      }
    });
  });

  return Array.from(unique);
}

async function loadRecipeImageLookup(profileId: string, titles: string[]) {
  if (titles.length === 0) {
    return new Map<string, string>();
  }

  const { data, error } = await supabaseAdmin
    .from("recipes")
    .select("title, image_url")
    .or(`status.eq.published,created_by_profile_id.eq.${profileId}`)
    .in("title", titles);

  if (error) {
    throw new Error(error.message);
  }

  const lookup = new Map<string, string>();
  (data ?? []).forEach((row) => {
    const title = typeof row.title === "string" ? row.title.trim().toLowerCase() : "";
    const imageUrl = typeof row.image_url === "string" ? row.image_url.trim() : "";
    if (title && imageUrl && !lookup.has(title)) {
      lookup.set(title, imageUrl);
    }
  });

  return lookup;
}

type RecipeRow = {
  id?: string;
  title?: unknown;
  tags?: unknown;
  prep_minutes?: unknown;
  cook_minutes?: unknown;
  created_by_profile_id?: unknown;
  status?: unknown;
};

function toRecipeCandidate(row: RecipeRow): RecipeCandidateRow | null {
  const title = typeof row.title === "string" ? row.title.trim() : "";
  if (!title) {
    return null;
  }
  return {
    title,
    tags: Array.isArray(row.tags)
      ? row.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
      : [],
    prepMinutes: typeof row.prep_minutes === "number" ? row.prep_minutes : null,
    cookMinutes: typeof row.cook_minutes === "number" ? row.cook_minutes : null,
  };
}

// Loads the three disjoint recipe pools for the weighted source mix:
//   - mine:      recipes the profile created
//   - favorites: favorited recipes that are NOT the profile's own
//   - other:     published recipes that are neither the profile's own nor favorited
async function loadRecipeBuckets(profileId: string): Promise<Record<RecipeMixBucket, RecipeCandidateRow[]>> {
  const [savedResult, mineResult, publishedResult] = await Promise.all([
    supabaseAdmin.from("saved_recipes").select("recipe_id").eq("profile_id", profileId),
    supabaseAdmin
      .from("recipes")
      .select("id, title, tags, prep_minutes, cook_minutes")
      .neq("status", "removed")
      .eq("created_by_profile_id", profileId),
    supabaseAdmin
      .from("recipes")
      .select("id, title, tags, prep_minutes, cook_minutes, created_by_profile_id")
      .eq("status", "published")
      .neq("created_by_profile_id", profileId),
  ]);

  if (savedResult.error) {
    throw new Error(savedResult.error.message);
  }
  if (mineResult.error) {
    throw new Error(mineResult.error.message);
  }
  if (publishedResult.error) {
    throw new Error(publishedResult.error.message);
  }

  const favoriteIds = new Set(
    (savedResult.data ?? [])
      .map((row) => (typeof row.recipe_id === "string" ? row.recipe_id : null))
      .filter((id): id is string => Boolean(id))
  );

  const mine = (mineResult.data ?? [])
    .map((row) => toRecipeCandidate(row as RecipeRow))
    .filter((recipe): recipe is RecipeCandidateRow => recipe !== null);

  const favorites: RecipeCandidateRow[] = [];
  const other: RecipeCandidateRow[] = [];
  for (const raw of publishedResult.data ?? []) {
    const row = raw as RecipeRow;
    const candidate = toRecipeCandidate(row);
    if (!candidate) {
      continue;
    }
    if (typeof row.id === "string" && favoriteIds.has(row.id)) {
      favorites.push(candidate);
    } else {
      other.push(candidate);
    }
  }

  return { mine, favorites, other };
}

/**
 * Reads the optional `myRecipes`. Null when it's absent (the stored-plan mode); throws when it's
 * there but isn't an array. Entries without an id or title are skipped; at most 300 are used.
 */
function parseMyRecipes(value: unknown): ClientRecipe[] | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new Error("myRecipes must be an array");
  }

  const recipes: ClientRecipe[] = [];
  for (const entry of value.slice(0, MAX_MY_RECIPES)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const raw = entry as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id.trim().slice(0, 100) : "";
    const title = typeof raw.title === "string" ? raw.title.trim().slice(0, 200) : "";
    if (!id || !title) {
      continue;
    }
    const tags = Array.isArray(raw.tags)
      ? raw.tags
          .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
          .filter(Boolean)
          .slice(0, 20)
      : [];
    const minutes = typeof raw.minutes === "number" && Number.isFinite(raw.minutes) && raw.minutes >= 0
      ? Math.round(raw.minutes)
      : null;
    recipes.push({ id, title, tags, minutes });
  }
  return recipes;
}

type SharedRecipeRow = RecipeCandidateRow & { id: string; imageUrl: string | null };

// The favorites and other (published) buckets, with the ids and images a stateless response needs
// to point the client at them. Same pools as loadRecipeBuckets.
async function loadSharedRecipeBuckets(profileId: string): Promise<{ favorites: SharedRecipeRow[]; other: SharedRecipeRow[] }> {
  const [savedResult, publishedResult] = await Promise.all([
    supabaseAdmin.from("saved_recipes").select("recipe_id").eq("profile_id", profileId),
    supabaseAdmin
      .from("recipes")
      .select("id, title, tags, prep_minutes, cook_minutes, image_url, created_by_profile_id")
      .eq("status", "published")
      .neq("created_by_profile_id", profileId),
  ]);

  if (savedResult.error) {
    throw new Error(savedResult.error.message);
  }
  if (publishedResult.error) {
    throw new Error(publishedResult.error.message);
  }

  const favoriteIds = new Set(
    (savedResult.data ?? [])
      .map((row) => (typeof row.recipe_id === "string" ? row.recipe_id : null))
      .filter((id): id is string => Boolean(id))
  );

  const favorites: SharedRecipeRow[] = [];
  const other: SharedRecipeRow[] = [];
  for (const raw of publishedResult.data ?? []) {
    const row = raw as RecipeRow & { image_url?: unknown };
    const candidate = toRecipeCandidate(row);
    if (!candidate || typeof row.id !== "string") {
      continue;
    }
    const imageUrl = typeof row.image_url === "string" && row.image_url.trim() ? row.image_url.trim() : null;
    const shared = { ...candidate, id: row.id, imageUrl };
    if (favoriteIds.has(row.id)) {
      favorites.push(shared);
    } else {
      other.push(shared);
    }
  }

  return { favorites, other };
}

function toCandidate(recipe: RecipeCandidateRow): RecipeCandidateRow {
  return {
    title: recipe.title,
    tags: recipe.tags,
    prepMinutes: recipe.prepMinutes,
    cookMinutes: recipe.cookMinutes,
  };
}

/** Which bucket (and recipe) each generated title came from: mine, then favorites, then other. */
function buildRecipeLookup(
  generatedPlan: Record<DayOfWeek, Record<MealSlotType, string>>,
  myRecipes: ClientRecipe[],
  shared: { favorites: SharedRecipeRow[]; other: SharedRecipeRow[] }
): Record<string, RecipeLookupEntry> {
  const byTitle = new Map<string, RecipeLookupEntry>();
  const add = (title: string, entry: RecipeLookupEntry) => {
    const key = title.trim().toLowerCase();
    if (key && !byTitle.has(key)) {
      byTitle.set(key, entry);
    }
  };
  myRecipes.forEach((recipe) => add(recipe.title, { recipeId: recipe.id, imageUrl: null, bucket: "mine" }));
  shared.favorites.forEach((recipe) => add(recipe.title, { recipeId: recipe.id, imageUrl: recipe.imageUrl, bucket: "favorites" }));
  shared.other.forEach((recipe) => add(recipe.title, { recipeId: recipe.id, imageUrl: recipe.imageUrl, bucket: "other" }));

  const lookup: Record<string, RecipeLookupEntry> = {};
  for (const day of DAYS) {
    for (const slot of SLOTS) {
      const key = generatedPlan[day]?.[slot]?.trim().toLowerCase();
      if (!key) {
        continue;
      }
      const entry = byTitle.get(key);
      if (entry) {
        lookup[key] = entry;
      }
    }
  }
  return lookup;
}

function parseExcludedMembers(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean)
    .slice(0, 20);
}

function resolveRecipeMix(payload: MealPlanRequest): RecipeMix {
  if (payload.recipeMix && typeof payload.recipeMix === "object") {
    return normalizeRecipeMix(payload.recipeMix);
  }
  // Legacy single-source field from the previous build -> 100% of that bucket
  // (old "all" had no separate pools, so it maps to the default spread).
  if (payload.recipeSource === "mine") {
    return { mine: 100, favorites: 0, other: 0 };
  }
  if (payload.recipeSource === "favorites") {
    return { mine: 0, favorites: 100, other: 0 };
  }
  return { ...DEFAULT_RECIPE_MIX };
}

function normalizePayload(payload: MealPlanRequest) {
  // The prompt is optional; fall back to a generic instruction so the model
  // still has direction when the user doesn't type anything.
  const promptRaw = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  if (promptRaw.length > 1000) {
    throw new Error("prompt must be 1000 characters or fewer");
  }
  const prompt = promptRaw || "Create a balanced, varied weekly meal plan.";

  const mealStyle = payload.mealStyle ?? "comfort";
  if (!["comfort", "varied", "light"].includes(mealStyle)) {
    throw new Error("mealStyle must be comfort, varied, or light");
  }

  const recipeMix = resolveRecipeMix(payload);

  const quickTags = Array.isArray(payload.quickTags)
    ? payload.quickTags
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)
        .slice(0, 15)
    : [];

  const selectedDates = Array.isArray(payload.selectedDates)
    ? payload.selectedDates
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
    : [];

  // The server clock may be a calendar day ahead of the user's local date (e.g.
  // a UTC server vs. an evening in the Americas). Allow one day of grace so a
  // user can still plan their own "today" without a timezone false-positive.
  const serverTodayIso = new Date(new Date().toDateString()).toISOString().slice(0, 10);
  const earliestAllowedIso = addDaysIso(serverTodayIso, -1);
  if (selectedDates.some((value) => value < earliestAllowedIso)) {
    throw new Error("Past dates cannot be selected");
  }

  const startDate = typeof payload.startDate === "string" ? payload.startDate.trim() : "";
  const endDate = typeof payload.endDate === "string" ? payload.endDate.trim() : "";
  if ((startDate && !endDate) || (!startDate && endDate)) {
    throw new Error("startDate and endDate must be provided together");
  }
  if ((startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) || (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate))) {
    throw new Error("startDate and endDate must be YYYY-MM-DD");
  }
  if (startDate && endDate && endDate < startDate) {
    throw new Error("endDate must be on or after startDate");
  }
  if (startDate && startDate < earliestAllowedIso) {
    throw new Error("Past dates cannot be selected");
  }

  const rangeDates = startDate && endDate ? buildIsoDateRange(startDate, endDate) : [];
  const mergedDateSet = new Set<string>([...selectedDates, ...rangeDates]);

  const weekStartFromPayload = typeof payload.weekStart === "string" ? payload.weekStart.trim() : "";
  if (weekStartFromPayload && !/^\d{4}-\d{2}-\d{2}$/.test(weekStartFromPayload)) {
    throw new Error("weekStart must be YYYY-MM-DD");
  }

  const mergedDates = Array.from(mergedDateSet).sort();
  const resolvedWeekStart = weekStartFromPayload || sundayOf(mergedDates[0] ? new Date(`${mergedDates[0]}T00:00:00`) : new Date());

  const effectiveDates = mergedDates.length > 0
    ? mergedDates
    : buildIsoDateRange(resolvedWeekStart, addDaysIso(resolvedWeekStart, 6));

  const allowedDays = new Set<DayOfWeek>(effectiveDates.map((iso) => dayNameFromIso(iso)));

  const selectedMealsRaw = payload.selectedMeals;
  const selectedMeals: Record<DayOfWeek, MealSlotType[]> = Object.fromEntries(
    DAYS.map((day) => [day, [...SLOTS]])
  ) as Record<DayOfWeek, MealSlotType[]>;

  if (selectedMealsRaw && (typeof selectedMealsRaw !== "object" || Array.isArray(selectedMealsRaw))) {
    throw new Error("selectedMeals must be an object");
  }

  if (selectedMealsRaw && typeof selectedMealsRaw === "object") {
    for (const day of DAYS) {
      if (!allowedDays.has(day)) {
        selectedMeals[day] = [];
        continue;
      }

      const value = (selectedMealsRaw as Record<string, unknown>)[day];
      if (!Array.isArray(value)) {
        selectedMeals[day] = [];
        continue;
      }

      selectedMeals[day] = value
        .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
        .filter((entry): entry is MealSlotType => SLOTS.includes(entry as MealSlotType));
    }
  } else {
    for (const day of DAYS) {
      if (!allowedDays.has(day)) {
        selectedMeals[day] = [];
      }
    }
  }

  const selectedDateSlots = Object.fromEntries(
    effectiveDates.map((iso) => {
      const day = dayNameFromIso(iso);
      return [iso, [...(selectedMeals[day] ?? [])]];
    })
  ) as SelectedDateSlots;

  const selectedCount = Object.values(selectedDateSlots).reduce((count, slots) => count + slots.length, 0);
  if (selectedCount === 0) {
    throw new Error("selectedMeals must include at least one valid day/meal selection");
  }

  const chargedDays = Object.values(selectedDateSlots).reduce(
    (count, slots) => count + (slots.length > 0 ? 1 : 0),
    0
  );
  if (chargedDays === 0) {
    throw new Error("Select at least one day to generate");
  }

  let generatedPlan: Record<DayOfWeek, Record<MealSlotType, string>> | null = null;
  if (payload.generatedPlan) {
    if (typeof payload.generatedPlan !== "object" || Array.isArray(payload.generatedPlan)) {
      throw new Error("generatedPlan must be an object");
    }

    const nextPlan = {} as Record<DayOfWeek, Record<MealSlotType, string>>;
    for (const day of DAYS) {
      const perDay = (payload.generatedPlan as Record<string, unknown>)[day];
      if (typeof perDay !== "object" || perDay === null || Array.isArray(perDay)) {
        throw new Error(`generatedPlan.${day} must be an object`);
      }

      const normalizedPerDay = {} as Record<MealSlotType, string>;
      for (const slot of SLOTS) {
        const raw = (perDay as Record<string, unknown>)[slot];
        if (typeof raw !== "string" || !raw.trim()) {
          throw new Error(`generatedPlan.${day}.${slot} must be a non-empty string`);
        }
        normalizedPerDay[slot] = raw.trim().slice(0, 120);
      }
      nextPlan[day] = normalizedPerDay;
    }
    generatedPlan = nextPlan;
  }

  const previewOnly = payload.previewOnly === true;
  const generatedBy = payload.generatedBy === "fallback" ? "fallback" : "anthropic";

  return {
    prompt,
    mealStyle,
    recipeMix,
    quickTags,
    selectedMeals,
    selectedDates: effectiveDates,
    selectedDateSlots,
    weekStart: resolvedWeekStart,
    requestedCredits: chargedDays,
    overwriteExisting: payload.overwriteExisting !== false,
    previewOnly,
    generatedPlan,
    generatedBy,
  } as const;
}

function slotHasContent(slot: {
  customMeal: string | null;
  recipeItems: PlannerMealItem[];
}) {
  if (typeof slot.customMeal === "string" && slot.customMeal.trim().length > 0) {
    return true;
  }
  return Array.isArray(slot.recipeItems) && slot.recipeItems.length > 0;
}

function computeBillableDays(
  selectedDateSlots: SelectedDateSlots,
  overwriteExisting: boolean,
  baselinePlannersByWeek: Map<string, Awaited<ReturnType<typeof buildPlanResponse>>>
) {
  return Object.entries(selectedDateSlots).reduce((count, [isoDate, slots]) => {
    if (slots.length === 0) {
      return count;
    }

    if (overwriteExisting) {
      return count + 1;
    }

    const weekStart = sundayOf(new Date(`${isoDate}T00:00:00`));
    const day = dayNameFromIso(isoDate);
    const baselinePlanner = baselinePlannersByWeek.get(weekStart);
    const baselineDay = baselinePlanner?.days[day];

    const hasWritableSlot = slots.some((slot) => {
      if (!baselineDay) {
        return true;
      }
      return !slotHasContent(baselineDay[slot]!);
    });

    return hasWritableSlot ? count + 1 : count;
  }, 0);
}

function mergeGeneratedPlanPreview(
  baseline: Awaited<ReturnType<typeof buildPlanResponse>>,
  generatedPlan: Record<DayOfWeek, Record<MealSlotType, string>>,
  selectedDateSlots: SelectedDateSlots,
  overwriteExisting: boolean,
  previewWeekStart: string,
  recipeImageLookup: Map<string, string>
) {
  const selectedSets = Object.fromEntries(DAYS.map((day) => [day, new Set<MealSlotType>()])) as Record<DayOfWeek, Set<MealSlotType>>;

  Object.entries(selectedDateSlots).forEach(([isoDate, slots]) => {
    const weekStart = sundayOf(new Date(`${isoDate}T00:00:00`));
    if (weekStart !== previewWeekStart) {
      return;
    }

    const day = dayNameFromIso(isoDate);
    slots.forEach((slot) => selectedSets[day].add(slot));
  });

  const days = Object.fromEntries(
    DAYS.map((day) => {
      const perDay = Object.fromEntries(
        SLOTS.map((slot) => {
          // buildPlanResponse fills every day and slot, so these lookups are always defined.
          const current = baseline.days[day]![slot]!;
          const isSelected = selectedSets[day].has(slot);
          if (!isSelected) {
            return [slot, current];
          }

          if (!overwriteExisting && slotHasContent(current)) {
            return [slot, current];
          }

          const title = generatedPlan[day][slot];
          const imageUrl = recipeImageLookup.get(title.trim().toLowerCase()) ?? null;
          return [
            slot,
            {
              ...current,
              customMeal: title,
              recipeItems: [{ title, role: "entree" as const, imageUrl }],
              completed: false,
            },
          ];
        })
      );
      return [day, perDay];
    })
  );

  return {
    planId: baseline.planId,
    weekStart: baseline.weekStart,
    days,
  };
}

async function loadBaselinePlannersByWeek(profileId: string, selectedDateSlots: SelectedDateSlots) {
  const weekStarts = Array.from(
    new Set(Object.keys(selectedDateSlots).map((isoDate) => sundayOf(new Date(`${isoDate}T00:00:00`))))
  );

  const planners = await Promise.all(
    weekStarts.map(async (weekStart) => [weekStart, await buildPlanResponse(profileId, weekStart, false)] as const)
  );

  return new Map(planners);
}

/**
 * The stored BigTable household, for clients that don't send a Hearth household yet. Reduced to
 * what the iCloud path sends (ages, roles, restrictions, likes, dislikes): member names and the
 * household name never reach the AI provider.
 */
async function getHouseholdContext(profileId: string) {
  const [membersResult, linkedMemberResult] = await Promise.all([
    supabaseAdmin.from("household_members").select("date_of_birth, likes, dislikes").eq("profile_id", profileId),
    supabaseAdmin
      .from("household_memberships")
      .select("member_id")
      .eq("organizer_id", profileId),
  ]);

  if (membersResult.error || linkedMemberResult.error) {
    throw new Error(
      membersResult.error?.message
        ?? linkedMemberResult.error?.message
        ?? "Failed loading context"
    );
  }

  const restrictionProfileIds = Array.from(
    new Set([
      profileId,
      ...(linkedMemberResult.data ?? [])
        .map((row) => (typeof row.member_id === "string" ? row.member_id : ""))
        .filter(Boolean),
    ])
  );

  const restrictionsResult = await supabaseAdmin
    .from("dietary_restrictions")
    .select("value")
    .in("profile_id", restrictionProfileIds);

  if (restrictionsResult.error) {
    throw new Error(restrictionsResult.error.message);
  }

  return contextFromStoredHousehold(
    (membersResult.data ?? []) as StoredHouseholdSeat[],
    (restrictionsResult.data ?? [])
      .map((entry) => entry.value)
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
  );
}

async function persistPlanAcrossDates(
  profileId: string,
  days: Record<DayOfWeek, Record<MealSlotType, string>>,
  selectedDateSlots: SelectedDateSlots,
  overwriteExisting: boolean,
  recipeImageLookup: Map<string, string>
) {
  const dateEntries = Object.entries(selectedDateSlots).filter(([, slots]) => slots.length > 0);
  if (dateEntries.length === 0) {
    return;
  }

  const weekStarts = Array.from(
    new Set(dateEntries.map(([isoDate]) => sundayOf(new Date(`${isoDate}T00:00:00`))))
  );

  const weekPlans = await Promise.all(
    weekStarts.map(async (weekStart) => [weekStart, await ensureWeeklyPlan(profileId, weekStart)] as const)
  );
  const weeklyPlanByStart = new Map(weekPlans);

  const futureRows = dateEntries.flatMap(([isoDate, slots]) => {
    const weekStart = sundayOf(new Date(`${isoDate}T00:00:00`));
    const weeklyPlan = weeklyPlanByStart.get(weekStart);
    if (!weeklyPlan) {
      return [];
    }

    const day = dayNameFromIso(isoDate);
    return slots.map((slot) => {
      const title = days[day][slot];
      const imageUrl = recipeImageLookup.get(title.trim().toLowerCase()) ?? null;

      return {
        plan_id: weeklyPlan.id,
        day,
        slot,
        custom_meal: title,
        recipe_items: [{ title, role: "entree" as const, imageUrl }],
        excluded_members: [],
        completed: false,
      };
    });
  });

  let rowsToWrite = futureRows;
  if (!overwriteExisting) {
    const planIds = weekPlans.map(([, plan]) => plan.id);
    const existingResult = await supabaseAdmin
      .from("meal_slots")
      .select("plan_id, day, slot, custom_meal, recipe_items")
      .in("plan_id", planIds)
      .in("day", DAYS)
      .in("slot", SLOTS);

    if (existingResult.error) {
      throw new Error(existingResult.error.message);
    }

    const occupied = new Set<string>();
    (existingResult.data ?? []).forEach((row) => {
      const hasRecipeItems = Array.isArray(row.recipe_items) && row.recipe_items.length > 0;
      const hasCustomMeal = typeof row.custom_meal === "string" && row.custom_meal.trim().length > 0;
      if (hasRecipeItems || hasCustomMeal) {
        occupied.add(`${row.plan_id}:${row.day}:${row.slot}`);
      }
    });

    rowsToWrite = futureRows.filter((row) => !occupied.has(`${row.plan_id}:${row.day}:${row.slot}`));
  }

  if (rowsToWrite.length === 0) {
    return;
  }

  const { error } = await supabaseAdmin.from("meal_slots").upsert(rowsToWrite, {
    onConflict: "plan_id,day,slot",
  });

  if (error) {
    throw new Error(error.message);
  }
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
        .select("can_use_ai_meal_plan")
        .eq("member_id", userId)
        .maybeSingle();

      if (!permissionsResult.data?.can_use_ai_meal_plan) {
        return NextResponse.json({ error: "Your organizer hasn't granted you access to AI meal planning" }, { status: 403 });
      }
    }
  } catch (error) {
    return NextResponse.json({ error: "Failed to generate meal plan" }, { status: 500 });
  }

  let body: MealPlanRequest;
  try {
    body = (await request.json()) as MealPlanRequest;
  } catch {
    return badRequest("Request body must be valid JSON");
  }

  let payload: ReturnType<typeof normalizePayload>;
  let hearthHousehold: HearthAIContext | null;
  let myRecipes: ClientRecipe[] | null;
  try {
    payload = normalizePayload(body);
    hearthHousehold = parseHearthHousehold(body?.household);
    myRecipes = parseMyRecipes(body?.myRecipes);
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : "Invalid payload");
  }

  if (myRecipes) {
    return generateStatelessMealPlan(userId, payload, hearthHousehold, myRecipes);
  }

  try {
    const usage = await getUsageStatus(userId);
    const baselinePlannersByWeek = await loadBaselinePlannersByWeek(userId, payload.selectedDateSlots);
    const baselinePlanner = baselinePlannersByWeek.get(payload.weekStart)
      ?? await buildPlanResponse(userId, payload.weekStart, false);
    const effectiveCreditsToCharge = computeBillableDays(
      payload.selectedDateSlots,
      payload.overwriteExisting,
      baselinePlannersByWeek
    );

    if (!canConsumeCredits(usage, effectiveCreditsToCharge)) {
      return NextResponse.json(
        {
          error: "Monthly AI limit reached",
          code: "LIMIT_REACHED",
          tier: usage.tier,
          requestsUsed: usage.requestsUsed,
          requestsLimit: usage.requestsLimit,
          requestedCredits: effectiveCreditsToCharge,
          resetsAt: usage.resetsAt,
        },
        { status: 403 }
      );
    }

    let generatedPlan = payload.generatedPlan;
    let generatedBy = payload.generatedBy;

    if (!generatedPlan) {
      const membership = await getMembershipContext(userId);
      const contextProfileId = membership.organizerProfileId;
      const [household, recipeBuckets] = await Promise.all([
        hearthHousehold ? contextFromHearth(hearthHousehold) : getHouseholdContext(contextProfileId),
        loadRecipeBuckets(contextProfileId),
      ]);

      const nonEmpty: Record<RecipeMixBucket, boolean> = {
        mine: recipeBuckets.mine.length > 0,
        favorites: recipeBuckets.favorites.length > 0,
        other: recipeBuckets.other.length > 0,
      };

      // The mix is a preference, so an empty weighted bucket cascades to the
      // others; only block when there are no recipes at all to plan from.
      if (!RECIPE_MIX_BUCKETS.some((bucket) => nonEmpty[bucket])) {
        return NextResponse.json(
          {
            error: "There are no recipes available to build a meal plan from yet. Add or favorite some recipes and try again.",
            code: "EMPTY_RECIPE_POOL",
          },
          { status: 422 }
        );
      }

      // Apportion the distinct selected (weekday, slot) cells across the buckets.
      const selectedCells = new Set<string>();
      for (const [iso, slots] of Object.entries(payload.selectedDateSlots)) {
        const day = dayNameFromIso(iso);
        for (const slot of slots) {
          selectedCells.add(`${day}:${slot}`);
        }
      }
      const bucketTargets = apportionRecipeSlots(selectedCells.size, payload.recipeMix, nonEmpty);

      const generated = await buildMealPlan({
        prompt: payload.prompt,
        mealStyle: payload.mealStyle,
        quickTags: payload.quickTags,
        householdName: household.householdName,
        householdMembers: household.memberNames,
        householdLikes: household.householdLikes,
        householdDislikes: household.householdDislikes,
        restrictions: household.restrictions,
        selectedDateSlots: payload.selectedDateSlots,
        recipeBuckets,
        bucketTargets,
      });
      generatedPlan = generated.plan;
      generatedBy = generated.source;
    }

    const generatedTitles = collectSelectedGeneratedTitles(generatedPlan, payload.selectedDateSlots);
    const recipeImageLookup = await loadRecipeImageLookup(userId, generatedTitles);

    if (payload.previewOnly) {
      const previewPlanner = mergeGeneratedPlanPreview(
        baselinePlanner,
        generatedPlan,
        payload.selectedDateSlots,
        payload.overwriteExisting,
        payload.weekStart,
        recipeImageLookup
      );

      return NextResponse.json({
        previewPlanner,
        generatedPlan,
        generatedBy,
        usage: {
          tier: usage.tier,
          requestsUsed: usage.requestsUsed,
          requestsLimit: usage.requestsLimit,
          creditsCharged: effectiveCreditsToCharge,
          requestedCredits: payload.requestedCredits,
          resetsAt: usage.resetsAt,
          canMakeRequest: usage.canMakeRequest,
        },
      });
    }

    await persistPlanAcrossDates(
      userId,
      generatedPlan,
      payload.selectedDateSlots,
      payload.overwriteExisting,
      recipeImageLookup
    );

    let latestUsage = usage;
    let planner = mergeGeneratedPlanPreview(
      baselinePlanner,
      generatedPlan,
      payload.selectedDateSlots,
      payload.overwriteExisting,
      payload.weekStart,
      recipeImageLookup
    );

    try {
      if (effectiveCreditsToCharge > 0) {
        await incrementUsageBy(userId, "meal_plan", effectiveCreditsToCharge);
      }

      latestUsage = await getUsageStatus(userId);
      planner = await buildPlanResponse(userId, payload.weekStart);
    } catch {
      latestUsage = {
        ...usage,
        requestsUsed: usage.requestsUsed + effectiveCreditsToCharge,
        canMakeRequest: canConsumeCredits(usage, effectiveCreditsToCharge),
      };
    }

    return NextResponse.json({
      planner,
      generatedBy,
      usage: {
        tier: latestUsage.tier,
        requestsUsed: latestUsage.requestsUsed,
        requestsLimit: latestUsage.requestsLimit,
        creditsCharged: effectiveCreditsToCharge,
        requestedCredits: payload.requestedCredits,
        resetsAt: latestUsage.resetsAt,
        canMakeRequest: latestUsage.canMakeRequest,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: "Failed to generate meal plan" }, { status: 500 });
  }
}

/**
 * The stateless meal plan: the family's recipes come in the request (`myRecipes`) and the plan goes
 * back in the response for the app to keep in iCloud. No plan or meal slot is read or written.
 * Every selected date with at least one slot is charged, as if overwriting, since the app only
 * sends the slots it wants filled; a request that brings its own `generatedPlan` (nothing to
 * generate) is not charged again.
 */
async function generateStatelessMealPlan(
  userId: string,
  payload: ReturnType<typeof normalizePayload>,
  hearthHousehold: HearthAIContext | null,
  myRecipes: ClientRecipe[]
) {
  try {
    const usage = await getUsageStatus(userId);
    const creditsToCharge = payload.generatedPlan ? 0 : payload.requestedCredits;

    if (creditsToCharge > 0 && !canConsumeCredits(usage, creditsToCharge)) {
      return NextResponse.json(
        {
          error: "Monthly AI limit reached",
          code: "LIMIT_REACHED",
          tier: usage.tier,
          requestsUsed: usage.requestsUsed,
          requestsLimit: usage.requestsLimit,
          requestedCredits: creditsToCharge,
          resetsAt: usage.resetsAt,
        },
        { status: 403 }
      );
    }

    const membership = await getMembershipContext(userId);
    const contextProfileId = membership.organizerProfileId;
    const shared = await loadSharedRecipeBuckets(contextProfileId);

    let generatedPlan = payload.generatedPlan;
    let generatedBy = payload.generatedBy;

    if (!generatedPlan) {
      const household = hearthHousehold ? contextFromHearth(hearthHousehold) : await getHouseholdContext(contextProfileId);
      const recipeBuckets: Record<RecipeMixBucket, RecipeCandidateRow[]> = {
        mine: myRecipes.map((recipe) => ({
          title: recipe.title,
          tags: recipe.tags,
          prepMinutes: null,
          cookMinutes: recipe.minutes,
        })),
        favorites: shared.favorites.map(toCandidate),
        other: shared.other.map(toCandidate),
      };

      const nonEmpty: Record<RecipeMixBucket, boolean> = {
        mine: recipeBuckets.mine.length > 0,
        favorites: recipeBuckets.favorites.length > 0,
        other: recipeBuckets.other.length > 0,
      };

      if (!RECIPE_MIX_BUCKETS.some((bucket) => nonEmpty[bucket])) {
        return NextResponse.json(
          {
            error: "There are no recipes available to build a meal plan from yet. Add or favorite some recipes and try again.",
            code: "EMPTY_RECIPE_POOL",
          },
          { status: 422 }
        );
      }

      const selectedCells = new Set<string>();
      for (const [iso, slots] of Object.entries(payload.selectedDateSlots)) {
        const day = dayNameFromIso(iso);
        for (const slot of slots) {
          selectedCells.add(`${day}:${slot}`);
        }
      }
      const bucketTargets = apportionRecipeSlots(selectedCells.size, payload.recipeMix, nonEmpty);

      const generated = await buildMealPlan({
        prompt: payload.prompt,
        mealStyle: payload.mealStyle,
        quickTags: payload.quickTags,
        householdName: household.householdName,
        householdMembers: household.memberNames,
        householdLikes: household.householdLikes,
        householdDislikes: household.householdDislikes,
        restrictions: household.restrictions,
        selectedDateSlots: payload.selectedDateSlots,
        recipeBuckets,
        bucketTargets,
      });
      generatedPlan = generated.plan;
      generatedBy = generated.source;
    }

    const recipeLookup = buildRecipeLookup(generatedPlan, myRecipes, shared);

    let latestUsage = usage;
    if (creditsToCharge > 0) {
      try {
        await incrementUsageBy(userId, "meal_plan", creditsToCharge);
        latestUsage = await getUsageStatus(userId);
      } catch {
        latestUsage = {
          ...usage,
          requestsUsed: usage.requestsUsed + creditsToCharge,
          canMakeRequest: canConsumeCredits(usage, creditsToCharge),
        };
      }
    }

    return NextResponse.json({
      generatedPlan,
      generatedBy,
      usage: {
        tier: latestUsage.tier,
        requestsUsed: latestUsage.requestsUsed,
        requestsLimit: latestUsage.requestsLimit,
        creditsCharged: creditsToCharge,
        requestedCredits: payload.requestedCredits,
        resetsAt: latestUsage.resetsAt,
        canMakeRequest: latestUsage.canMakeRequest,
      },
      recipeLookup,
    });
  } catch (error) {
    return NextResponse.json({ error: "Failed to generate meal plan" }, { status: 500 });
  }
}
