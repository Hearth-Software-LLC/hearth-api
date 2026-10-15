import type { DayOfWeek } from "./planner-contract.js";
import { fetchAnthropicMessages } from "./anthropic.js";
import { RECIPE_MIX_BUCKETS, type RecipeBucketCounts, type RecipeMixBucket } from "./recipe-mix.js";

const RECIPE_MIX_LABELS: Record<RecipeMixBucket, string> = {
  mine: "My Recipes",
  favorites: "Favorites",
  other: "Other Recipes",
};

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL?.trim() || "claude-haiku-4-5-20251001";

type MealSlots = {
  breakfast: string;
  lunch: string;
  dinner: string;
};

export type GeneratedMealPlan = Record<DayOfWeek, MealSlots>;

type MealSlotType = keyof MealSlots;

export type RecipeCandidate = {
  title: string;
  tags: string[];
  prepMinutes: number | null;
  cookMinutes: number | null;
};

type BucketedRecipe = RecipeCandidate & { bucket: RecipeMixBucket };

type BuildMealPlanInput = {
  prompt: string;
  mealStyle: "comfort" | "varied" | "light";
  quickTags: string[];
  householdName: string | null;
  householdMembers: string[];
  householdLikes: string[];
  householdDislikes: string[];
  restrictions: string[];
  selectedDateSlots: Record<string, MealSlotType[]>;
  recipeBuckets: Record<RecipeMixBucket, RecipeCandidate[]>;
  bucketTargets: RecipeBucketCounts;
};

const DAYS: DayOfWeek[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

const SLOT_KEYS: Array<keyof MealSlots> = ["breakfast", "lunch", "dinner"];

const BREAKFAST_KEYWORDS = ["breakfast", "pancake", "waffle", "omelet", "oat", "toast", "muffin", "egg"];
const LUNCH_KEYWORDS = ["lunch", "sandwich", "wrap", "salad", "soup", "bowl", "quesadilla", "burger"];
const DINNER_KEYWORDS = ["dinner", "pasta", "roast", "stew", "curry", "skillet", "casserole", "enchilada"];

const RESTRICTION_KEYWORD_MAP: Array<{ needle: string; blocked: string[] }> = [
  { needle: "fish", blocked: ["fish", "salmon", "tuna", "cod", "tilapia", "sardine", "anchovy", "trout"] },
  { needle: "seafood", blocked: ["shrimp", "prawn", "crab", "lobster", "mussel", "clam", "oyster", "scallop"] },
  { needle: "shellfish", blocked: ["shrimp", "prawn", "crab", "lobster", "mussel", "clam", "oyster", "scallop"] },
  { needle: "dairy", blocked: ["milk", "cream", "butter", "cheese", "yogurt"] },
  { needle: "gluten", blocked: ["wheat", "bread", "pasta", "flour", "barley", "rye"] },
  { needle: "nut", blocked: ["almond", "cashew", "peanut", "walnut", "pecan", "hazelnut", "pistachio"] },
  { needle: "egg", blocked: ["egg", "eggs"] },
  { needle: "soy", blocked: ["soy", "tofu", "edamame", "miso"] },
  { needle: "pork", blocked: ["pork", "bacon", "ham", "sausage"] },
  { needle: "beef", blocked: ["beef", "steak"] },
  { needle: "chicken", blocked: ["chicken"] },
  { needle: "turkey", blocked: ["turkey"] },
];

function hashSeed(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function normalizeMealLabel(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  if (!normalized || normalized.length > 120) {
    return null;
  }

  return normalized;
}

// Flattens the three labeled pools into one deduped, bucket-tagged catalog.
// Buckets are disjoint, but if a title somehow appears twice the first
// (higher-priority) bucket wins. Each bucket is capped so one large pool can't
// crowd the others out of the prompt.
function combineRecipeBuckets(
  buckets: Record<RecipeMixBucket, RecipeCandidate[]>,
  perBucketCap = 110
): BucketedRecipe[] {
  const seen = new Set<string>();
  const combined: BucketedRecipe[] = [];

  for (const bucket of RECIPE_MIX_BUCKETS) {
    let kept = 0;
    for (const recipe of buckets[bucket] ?? []) {
      if (kept >= perBucketCap) {
        break;
      }
      const title = recipe.title?.trim() ?? "";
      if (!title) {
        continue;
      }
      const key = title.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      combined.push({
        title,
        tags: Array.isArray(recipe.tags)
          ? recipe.tags.map((tag) => (typeof tag === "string" ? tag.trim() : "")).filter(Boolean)
          : [],
        prepMinutes: typeof recipe.prepMinutes === "number" ? recipe.prepMinutes : null,
        cookMinutes: typeof recipe.cookMinutes === "number" ? recipe.cookMinutes : null,
        bucket,
      });
      kept += 1;
    }
  }

  return combined;
}

// Unique selected (weekday, slot) cells in stable order. The generated plan is
// keyed by weekday, so the mix targets apply to these cells.
function selectedWeekdaySlots(selectedDateSlots: Record<string, MealSlotType[]>) {
  const seen = new Set<string>();
  const cells: Array<{ day: DayOfWeek; slot: MealSlotType }> = [];
  for (const day of DAYS) {
    for (const slot of SLOT_KEYS) {
      cells.push({ day, slot });
    }
  }
  const selected = new Set<string>();
  for (const [iso, slots] of Object.entries(selectedDateSlots)) {
    const day = dayNameFromIsoLib(iso);
    for (const slot of slots) {
      selected.add(`${day}:${slot}`);
    }
  }
  return cells.filter(({ day, slot }) => {
    const key = `${day}:${slot}`;
    if (!selected.has(key) || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dayNameFromIsoLib(isoDate: string): DayOfWeek {
  const day = new Date(`${isoDate}T00:00:00`).getDay();
  return DAYS[day === 0 ? 6 : day - 1]!;
}

// Expands per-bucket target counts into a flat sequence, e.g.
// { mine: 2, favorites: 1, other: 0 } -> ["mine","mine","favorites"].
function buildBucketSequence(targets: RecipeBucketCounts): RecipeMixBucket[] {
  const sequence: RecipeMixBucket[] = [];
  for (const bucket of RECIPE_MIX_BUCKETS) {
    for (let i = 0; i < targets[bucket]; i += 1) {
      sequence.push(bucket);
    }
  }
  return sequence;
}

function normalizeCatalog(catalog: BucketedRecipe[]) {
  const seen = new Set<string>();

  return catalog
    .filter((recipe) => {
      if (!recipe.title) {
        return false;
      }
      const key = recipe.title.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function extractBlockedKeywords(restrictions: string[]) {
  const normalized = restrictions.join(" ").toLowerCase();
  const blocked = new Set<string>();

  RESTRICTION_KEYWORD_MAP.forEach((mapping) => {
    if (normalized.includes(mapping.needle)) {
      mapping.blocked.forEach((keyword) => blocked.add(keyword));
    }
  });

  return blocked;
}

function recipeMentionsBlockedKeyword(recipe: RecipeCandidate, blockedKeywords: Set<string>) {
  if (blockedKeywords.size === 0) {
    return false;
  }

  const haystack = `${recipe.title} ${recipe.tags.join(" ")}`.toLowerCase();
  return Array.from(blockedKeywords).some((keyword) => haystack.includes(keyword));
}

function recipeMatchesSlot(recipe: RecipeCandidate, slot: MealSlotType) {
  const haystack = `${recipe.title} ${recipe.tags.join(" ")}`.toLowerCase();

  if (slot === "breakfast") {
    return BREAKFAST_KEYWORDS.some((keyword) => haystack.includes(keyword));
  }
  if (slot === "lunch") {
    return LUNCH_KEYWORDS.some((keyword) => haystack.includes(keyword));
  }
  return DINNER_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

function buildSlotPools<T extends RecipeCandidate>(catalog: T[]) {
  const pools: Record<MealSlotType, T[]> = {
    breakfast: [],
    lunch: [],
    dinner: [],
  };

  catalog.forEach((recipe) => {
    let matched = false;
    SLOT_KEYS.forEach((slot) => {
      if (recipeMatchesSlot(recipe, slot)) {
        pools[slot].push(recipe);
        matched = true;
      }
    });

    if (!matched) {
      SLOT_KEYS.forEach((slot) => pools[slot].push(recipe));
    }
  });

  return pools;
}

function extractJsonObject(text: string): string | null {
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    return fence[1].trim();
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  return text.slice(firstBrace, lastBrace + 1);
}

function validatePlanShape(payload: unknown, allowedTitles: Set<string>): GeneratedMealPlan | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }

  const source = payload as Record<string, unknown>;
  const candidate = (source.days ?? source.plan ?? source) as Record<string, unknown>;

  const result = {} as GeneratedMealPlan;

  for (const day of DAYS) {
    const dayRaw = candidate[day];
    if (typeof dayRaw !== "object" || dayRaw === null || Array.isArray(dayRaw)) {
      return null;
    }

    const dayObject = dayRaw as Record<string, unknown>;
    const breakfast = normalizeMealLabel(dayObject.breakfast);
    const lunch = normalizeMealLabel(dayObject.lunch);
    const dinner = normalizeMealLabel(dayObject.dinner);

    if (!breakfast || !lunch || !dinner) {
      return null;
    }

    if (!allowedTitles.has(breakfast.toLowerCase()) || !allowedTitles.has(lunch.toLowerCase()) || !allowedTitles.has(dinner.toLowerCase())) {
      return null;
    }

    result[day] = { breakfast, lunch, dinner };
  }

  return result;
}

function fallbackMealPlan(input: BuildMealPlanInput, catalog: BucketedRecipe[]): GeneratedMealPlan {
  const seed = hashSeed(
    `${input.prompt}|${input.mealStyle}|${input.quickTags.sort().join(",")}|${input.householdName ?? ""}|${input.householdMembers.join("|")}`
  );

  const blockedKeywords = extractBlockedKeywords(input.restrictions);
  const filtered = catalog.filter((recipe) => !recipeMentionsBlockedKeyword(recipe, blockedKeywords));
  const base = filtered.length > 0 ? filtered : catalog;

  const combinedPools = buildSlotPools(base);
  const bucketSlotPools: Record<RecipeMixBucket, Record<MealSlotType, BucketedRecipe[]>> = {
    mine: buildSlotPools(base.filter((recipe) => recipe.bucket === "mine")),
    favorites: buildSlotPools(base.filter((recipe) => recipe.bucket === "favorites")),
    other: buildSlotPools(base.filter((recipe) => recipe.bucket === "other")),
  };

  // Assign the apportioned buckets to the selected (weekday, slot) cells.
  const sequence = buildBucketSequence(input.bucketTargets);
  const bucketByCell = new Map<string, RecipeMixBucket>();
  selectedWeekdaySlots(input.selectedDateSlots).forEach((cell, index) => {
    const bucket = sequence[index];
    if (bucket) {
      bucketByCell.set(`${cell.day}:${cell.slot}`, bucket);
    }
  });

  // Track titles already placed so the deterministic fallback spreads across the
  // catalog instead of re-picking the same "best fit" recipe for every slot.
  const usedTitles = new Set<string>();
  const pick = (pool: BucketedRecipe[], salt: number): string => {
    if (pool.length === 0) {
      return base[0]!.title;
    }
    const start = (seed + salt) % pool.length;
    for (let offset = 0; offset < pool.length; offset += 1) {
      const candidate = pool[(start + offset) % pool.length]!;
      const key = candidate.title.toLowerCase();
      if (!usedTitles.has(key)) {
        usedTitles.add(key);
        return candidate.title;
      }
    }
    // Every recipe in this pool is already used; fall back to the seeded pick.
    return pool[start]!.title;
  };

  const fillSlot = (day: DayOfWeek, slot: MealSlotType, salt: number): string => {
    const bucket = bucketByCell.get(`${day}:${slot}`);
    const preferred = bucket ? bucketSlotPools[bucket][slot] : [];
    if (preferred.length > 0) {
      return pick(preferred, salt);
    }
    return pick(combinedPools[slot].length > 0 ? combinedPools[slot] : base, salt);
  };

  const plan = {} as GeneratedMealPlan;
  DAYS.forEach((day, dayIndex) => {
    plan[day] = {
      breakfast: fillSlot(day, "breakfast", dayIndex),
      lunch: fillSlot(day, "lunch", dayIndex * 3 + 1),
      dinner: fillSlot(day, "dinner", dayIndex * 5 + 2),
    };
  });

  return plan;
}

async function generateWithAnthropic(input: BuildMealPlanInput, catalog: BucketedRecipe[]): Promise<GeneratedMealPlan | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return null;
  }

  const selectedDateContext = Object.entries(input.selectedDateSlots)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([isoDate, slots]) => `${isoDate}: ${slots.join(", ") || "none"}`)
    .join("\n");

  const blockedKeywords = extractBlockedKeywords(input.restrictions);
  const filteredCatalog = catalog.filter((recipe) => !recipeMentionsBlockedKeyword(recipe, blockedKeywords));
  const baseCatalog = filteredCatalog.length > 0 ? filteredCatalog : catalog;
  const slotPools = buildSlotPools(baseCatalog);

  const formatRecipe = (recipe: BucketedRecipe) => {
    const mins = [recipe.prepMinutes, recipe.cookMinutes].filter((value): value is number => typeof value === "number");
    const totalMinutes = mins.length > 0 ? mins.reduce((sum, value) => sum + value, 0) : null;
    return `${recipe.title}${totalMinutes ? ` (${totalMinutes} min)` : ""}${recipe.tags.length > 0 ? ` [${recipe.tags.slice(0, 4).join(", ")}]` : ""} {${RECIPE_MIX_LABELS[recipe.bucket]}}`;
  };

  const breakfastOptions = slotPools.breakfast.slice(0, 70).map(formatRecipe).join("\n");
  const lunchOptions = slotPools.lunch.slice(0, 70).map(formatRecipe).join("\n");
  const dinnerOptions = slotPools.dinner.slice(0, 70).map(formatRecipe).join("\n");

  const totalSelected = RECIPE_MIX_BUCKETS.reduce((sum, bucket) => sum + input.bucketTargets[bucket], 0);
  const mixInstruction = totalSelected > 0
    ? `- Recipe source mix: each option is tagged with its source in {curly braces}. Across the ${totalSelected} selected meal slot(s), aim for about ${input.bucketTargets.mine} from {My Recipes}, ${input.bucketTargets.favorites} from {Favorites}, and ${input.bucketTargets.other} from {Other Recipes}. Treat this as a soft preference; never invent or substitute titles to hit it.`
    : "- Each option is tagged with its source in {curly braces}; you may use any of them.";

  const distinctAvailable = baseCatalog.length;
  const varietyInstruction = totalSelected > 0 && distinctAvailable >= totalSelected
    ? `- Maximize variety: there are ${distinctAvailable} distinct recipes available for ${totalSelected} meal slot(s) — enough for every meal to be a DIFFERENT recipe. Do NOT repeat any recipe; use a unique title for each slot and spread your picks across the whole option list.`
    : `- Maximize variety: use as many DIFFERENT recipes as possible and spread picks across the whole option list. Only repeat a recipe when there are more meal slots than distinct recipes, and keep any repeats to the bare minimum.`;

  const prompt = [
    "You are generating a 7-day family meal plan.",
    "Return strict JSON only with this shape:",
    '{"days":{"monday":{"breakfast":"...","lunch":"...","dinner":"..."},"tuesday":{...},"wednesday":{...},"thursday":{...},"friday":{...},"saturday":{...},"sunday":{...}}}',
    "Rules:",
    "- Use ONLY recipe titles from the option lists below. Do not invent titles.",
    "- Return recipe titles exactly as listed (case and spelling), WITHOUT the trailing {source} tag.",
    "- Respect restrictions, selected dates/slots, household size, and practical prep effort.",
    "- Accommodate household likes and avoid household dislikes when possible.",
    "- Heavier dinners are better for weekends; faster meals on busy weekdays.",
    varietyInstruction,
    mixInstruction,
    `User prompt: ${input.prompt}`,
    `Meal style: ${input.mealStyle}`,
    `Quick tags: ${input.quickTags.join(", ") || "none"}`,
    `Household members: ${input.householdMembers.join(", ") || "unknown"}`,
    `Household likes: ${input.householdLikes.join(", ") || "none"}`,
    `Household dislikes: ${input.householdDislikes.join(", ") || "none"}`,
    `Restrictions: ${input.restrictions.join(", ") || "none"}`,
    `Household name: ${input.householdName ?? "unknown"}`,
    "Selected dates and meal slots:",
    selectedDateContext || "none",
    "Allowed breakfast recipes:",
    breakfastOptions || "none",
    "Allowed lunch recipes:",
    lunchOptions || "none",
    "Allowed dinner recipes:",
    dinnerOptions || "none",
  ].join("\n");

  const response = await fetchAnthropicMessages(apiKey, {
    model: ANTHROPIC_MODEL,
    max_tokens: 900,
    temperature: 0.7,
    messages: [{ role: "user", content: prompt }],
  });

  if (!response) {
    return null;
  }

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };

  const text = payload.content?.find((item) => item.type === "text")?.text;
  if (!text) {
    return null;
  }

  const json = extractJsonObject(text);
  if (!json) {
    return null;
  }

  const allowedTitles = new Set(baseCatalog.map((recipe) => recipe.title.toLowerCase()));

  try {
    const parsed = JSON.parse(json) as unknown;
    return validatePlanShape(parsed, allowedTitles);
  } catch {
    return null;
  }
}

export async function buildMealPlan(input: BuildMealPlanInput) {
  const combinedCatalog = normalizeCatalog(combineRecipeBuckets(input.recipeBuckets)).slice(0, 240);
  if (combinedCatalog.length === 0) {
    throw new Error("No recipes available for meal planning");
  }

  const generated = await generateWithAnthropic(input, combinedCatalog);
  if (generated) {
    return { plan: generated, source: "anthropic" as const };
  }

  return {
    plan: fallbackMealPlan(input, combinedCatalog),
    source: "fallback" as const,
  };
}
