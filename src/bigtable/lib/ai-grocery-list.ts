import { fetchAnthropicMessages } from "./anthropic.js";

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL?.trim() || "claude-haiku-4-5-20251001";

type GroceryItem = {
  id: string;
  name: string;
  quantity: string;
  meals: string[];
  bulk: boolean;
};

type GrocerySection = {
  name: string;
  icon: string;
  items: GroceryItem[];
};

type AllowedSectionName =
  | "Produce"
  | "Meat"
  | "Dairy"
  | "Pantry"
  | "Bakery"
  | "Frozen"
  | "Beverages"
  | "Snacks"
  | "Household"
  | "Other";

export type GeneratedGroceryList = {
  sections: GrocerySection[];
  estimatedCost: number;
};

export class GroceryListGenerationError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status = 502) {
    super(message);
    this.name = "GroceryListGenerationError";
    this.code = code;
    this.status = status;
  }
}

type BuildGroceryListInput = {
  meals: string[];
  recipeTitles: string[];
  dateRangeLabel: string;
  householdMembers: string[];
  restrictions: string[];
  householdName: string | null;
  costcoMode: boolean;
  additionalPrompt?: string;
  plannedMeals: Array<{
    isoDate: string;
    day: string;
    slot: string;
    title: string;
    eaters: number;
  }>;
  ingredientNeeds: Array<{
    name: string;
    unit: string | null;
    totalQuantity: number | null;
    occurrences: number;
    recipes: string[];
    notes: string[];
  }>;
};

type CandidateItem = {
  section: string;
  icon: string;
  name: string;
  qty: string;
  bulkPreferred?: boolean;
};

const BASE_STAPLES: CandidateItem[] = [
  { section: "Produce", icon: "🥬", name: "Yellow Onions", qty: "2" },
  { section: "Produce", icon: "🥬", name: "Garlic", qty: "2" },
  { section: "Pantry", icon: "🥫", name: "Kosher Salt", qty: "1" },
  { section: "Pantry", icon: "🥫", name: "Black Pepper", qty: "1" },
];

const ALLOWED_SECTIONS: Array<{ name: AllowedSectionName; icon: string }> = [
  { name: "Produce", icon: "🥬" },
  { name: "Meat", icon: "🥩" },
  { name: "Dairy", icon: "🥛" },
  { name: "Pantry", icon: "🥫" },
  { name: "Bakery", icon: "🥖" },
  { name: "Frozen", icon: "❄️" },
  { name: "Beverages", icon: "🥤" },
  { name: "Snacks", icon: "🍿" },
  { name: "Household", icon: "🧽" },
  { name: "Other", icon: "🛒" },
];

const SECTION_NAME_SET = new Set<AllowedSectionName>(ALLOWED_SECTIONS.map((section) => section.name));
const SECTION_META_BY_NAME = ALLOWED_SECTIONS.reduce<Record<AllowedSectionName, { icon: string }>>((acc, section) => {
  acc[section.name] = { icon: section.icon };
  return acc;
}, {} as Record<AllowedSectionName, { icon: string }>);

const SECTION_ALIAS_TO_ALLOWED: Record<string, AllowedSectionName> = {
  produce: "Produce",
  vegetable: "Produce",
  vegetables: "Produce",
  fruit: "Produce",
  fruits: "Produce",
  meat: "Meat",
  protein: "Meat",
  proteins: "Meat",
  seafood: "Meat",
  butcher: "Meat",
  dairy: "Dairy",
  egg: "Dairy",
  eggs: "Dairy",
  "dairyeggs": "Dairy",
  "dairyandeggs": "Dairy",
  pantry: "Pantry",
  "drygoods": "Pantry",
  "cannedgoods": "Pantry",
  bakery: "Bakery",
  bread: "Bakery",
  frozen: "Frozen",
  freezer: "Frozen",
  beverage: "Beverages",
  beverages: "Beverages",
  drinks: "Beverages",
  drink: "Beverages",
  snacks: "Snacks",
  snack: "Snacks",
  chips: "Snacks",
  household: "Household",
  cleaning: "Household",
  "homecare": "Household",
  "papergoods": "Household",
  "personalcare": "Household",
  other: "Other",
  misc: "Other",
  miscellaneous: "Other",
};

const ICON_TO_ALLOWED: Record<string, AllowedSectionName> = {
  "🥬": "Produce",
  "🥩": "Meat",
  "🥛": "Dairy",
  "🥫": "Pantry",
  "🥖": "Bakery",
  "❄️": "Frozen",
  "🥤": "Beverages",
  "🍿": "Snacks",
  "🧽": "Household",
  "🛒": "Other",
};

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sectionKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, "");
}

function toAllowedSectionName(value: string): AllowedSectionName | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  if (SECTION_NAME_SET.has(normalized as AllowedSectionName)) {
    return normalized as AllowedSectionName;
  }

  return SECTION_ALIAS_TO_ALLOWED[sectionKey(normalized)] ?? null;
}

function resolveAllowedSection(name: string, icon?: string): { name: AllowedSectionName; icon: string } {
  const fromName = toAllowedSectionName(name);
  if (fromName) {
    return { name: fromName, icon: SECTION_META_BY_NAME[fromName].icon };
  }

  const fromIcon = icon ? ICON_TO_ALLOWED[icon.trim()] : undefined;
  if (fromIcon) {
    return { name: fromIcon, icon: SECTION_META_BY_NAME[fromIcon].icon };
  }

  return { name: "Other", icon: SECTION_META_BY_NAME.Other.icon };
}

function normalizeAllowedSections(sections: GrocerySection[]): GrocerySection[] {
  type MutableItem = {
    id: string;
    name: string;
    quantity: string;
    meals: Set<string>;
    bulk: boolean;
  };

  const bySection = new Map<AllowedSectionName, Map<string, MutableItem>>();

  for (const section of sections) {
    const allowedSection = resolveAllowedSection(section.name, section.icon);
    const sectionItems = bySection.get(allowedSection.name) ?? new Map<string, MutableItem>();

    for (const item of section.items) {
      const itemName = item.name.trim();
      if (!itemName) {
        continue;
      }

      const normalizedQuantity = toNumericQuantityValue(item.quantity) ?? "1";
      const quantityValue = Number.parseInt(normalizedQuantity, 10);
      const itemKey = slug(itemName);
      const existing = sectionItems.get(itemKey);

      if (existing) {
        const existingQuantity = Number.parseInt(existing.quantity, 10);
        const nextQuantity = (Number.isFinite(existingQuantity) ? existingQuantity : 0)
          + (Number.isFinite(quantityValue) ? quantityValue : 1);
        existing.quantity = String(Math.max(1, nextQuantity));
        item.meals.forEach((meal) => {
          const trimmedMeal = meal.trim();
          if (trimmedMeal) {
            existing.meals.add(trimmedMeal);
          }
        });
        existing.bulk = existing.bulk || item.bulk;
        continue;
      }

      sectionItems.set(itemKey, {
        id: `${slug(allowedSection.name)}:${itemKey}`,
        name: itemName,
        quantity: String(Math.max(1, Number.isFinite(quantityValue) ? quantityValue : 1)),
        meals: new Set(item.meals.map((meal) => meal.trim()).filter(Boolean)),
        bulk: Boolean(item.bulk),
      });
    }

    if (sectionItems.size > 0) {
      bySection.set(allowedSection.name, sectionItems);
    }
  }

  const normalizedSections: GrocerySection[] = [];

  for (const section of ALLOWED_SECTIONS) {
    const sectionItems = bySection.get(section.name);
    if (!sectionItems || sectionItems.size === 0) {
      continue;
    }

    const items: GroceryItem[] = Array.from(sectionItems.values())
      .map((item) => ({
        id: item.id,
        name: item.name,
        quantity: item.quantity,
        meals: Array.from(item.meals).slice(0, 4),
        bulk: item.bulk,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    normalizedSections.push({
      name: section.name,
      icon: section.icon,
      items,
    });
  }

  return normalizedSections;
}

function estimateCost(list: GrocerySection[]): number {
  const itemCount = list.reduce((sum, section) => sum + section.items.length, 0);
  return Math.max(60, itemCount * 6 + 35);
}

function toNumericQuantityValue(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return String(Math.max(1, Math.ceil(value)));
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    return String(Math.max(1, Number.parseInt(trimmed, 10)));
  }

  const numericMatch = trimmed.match(/\d+(?:\.\d+)?/);
  if (!numericMatch) {
    return null;
  }

  const parsed = Number.parseFloat(numericMatch[0]);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return String(Math.max(1, Math.ceil(parsed)));
}

function formatQuantity(totalQuantity: number | null, _unit: string | null, occurrences: number) {
  if (typeof totalQuantity === "number" && Number.isFinite(totalQuantity)) {
    return String(Math.max(1, Math.ceil(totalQuantity)));
  }

  return String(Math.max(occurrences, 1));
}

function inferSection(name: string) {
  const normalized = name.toLowerCase();
  if (/(onion|garlic|potato|carrot|pepper|tomato|spinach|lettuce|lemon|lime|apple|banana|avocado|broccoli|cabbage|celery|cucumber)/.test(normalized)) {
    return { section: "Produce", icon: "🥬" };
  }
  if (/(chicken|beef|pork|turkey|salmon|fish|shrimp|tofu|bean|lentil|egg)/.test(normalized)) {
    return { section: "Meat", icon: "🥩" };
  }
  if (/(milk|cream|cheese|yogurt|butter)/.test(normalized)) {
    return { section: "Dairy", icon: "🥛" };
  }
  if (/(bread|bagel|bun|roll|tortilla|croissant|muffin)/.test(normalized)) {
    return { section: "Bakery", icon: "🥖" };
  }
  if (/(frozen)/.test(normalized)) {
    return { section: "Frozen", icon: "❄️" };
  }
  if (/(juice|soda|water|coffee|tea|drink|sparkling)/.test(normalized)) {
    return { section: "Beverages", icon: "🥤" };
  }
  if (/(chip|cracker|cookie|pretzel|popcorn|snack|granola bar)/.test(normalized)) {
    return { section: "Snacks", icon: "🍿" };
  }
  if (/(detergent|soap|paper towel|toilet paper|trash bag|cleaner|sponge)/.test(normalized)) {
    return { section: "Household", icon: "🧽" };
  }

  return { section: "Pantry", icon: "🥫" };
}

function toWarehouseQuantity(item: CandidateItem, costcoMode: boolean): string {
  const baseCount = Number.parseInt(item.qty, 10);
  const normalizedBase = Number.isFinite(baseCount) && baseCount > 0 ? baseCount : 1;

  if (!costcoMode) {
    return String(normalizedBase);
  }

  if (item.bulkPreferred) {
    return String(Math.max(1, Math.ceil(normalizedBase / 2)));
  }

  return String(normalizedBase);
}

function validateGeneratedShape(payload: unknown): GeneratedGroceryList | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }

  const source = payload as Record<string, unknown>;
  if (!Array.isArray(source.sections)) {
    return null;
  }

  const sections: GrocerySection[] = [];

  for (const sectionRaw of source.sections) {
    if (typeof sectionRaw !== "object" || sectionRaw === null || Array.isArray(sectionRaw)) {
      return null;
    }
    const sectionObj = sectionRaw as Record<string, unknown>;
    const name = typeof sectionObj.name === "string" ? sectionObj.name.trim() : "";
    const icon = typeof sectionObj.icon === "string" ? sectionObj.icon.trim() : "🛒";
    const itemsRaw = sectionObj.items;

    if (!name || !Array.isArray(itemsRaw)) {
      return null;
    }

    const items: GroceryItem[] = [];
    for (const itemRaw of itemsRaw) {
      if (typeof itemRaw !== "object" || itemRaw === null || Array.isArray(itemRaw)) {
        return null;
      }
      const itemObj = itemRaw as Record<string, unknown>;
      const itemName = typeof itemObj.name === "string" ? itemObj.name.trim() : "";
      const quantity = toNumericQuantityValue(itemObj.quantity);
      const meals = Array.isArray(itemObj.meals)
        ? itemObj.meals.filter((m): m is string => typeof m === "string" && m.trim().length > 0)
        : [];

      if (!itemName || !quantity) {
        return null;
      }

      items.push({
        id: `${slug(name)}:${slug(itemName)}`,
        name: itemName,
        quantity,
        meals,
        bulk: Boolean(itemObj.bulk),
      });
    }

    sections.push({ name, icon, items });
  }

  const estimatedCost =
    typeof source.estimatedCost === "number" && Number.isFinite(source.estimatedCost)
      ? Math.max(0, Math.round(source.estimatedCost))
      : estimateCost(sections);

  const normalizedSections = normalizeAllowedSections(sections);

  return { sections: normalizedSections, estimatedCost };
}

function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  return text.slice(firstBrace, lastBrace + 1);
}

async function generateWithAnthropic(input: BuildGroceryListInput): Promise<GeneratedGroceryList> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new GroceryListGenerationError(
      "AI grocery generation is not configured",
      "AI_NOT_CONFIGURED",
      503
    );
  }

  const plannedMealContext = input.plannedMeals
    .map((meal) => `${meal.isoDate} ${meal.day} ${meal.slot}: ${meal.title} (${meal.eaters} eaters)`)
    .join("\n");

  const ingredientNeedsContext = input.ingredientNeeds
    .map((ingredient) => {
      const qty = formatQuantity(ingredient.totalQuantity, ingredient.unit, ingredient.occurrences);
      const recipeContext = ingredient.recipes.length > 0 ? ` | recipes: ${ingredient.recipes.join(", ")}` : "";
      return `- ${ingredient.name}: ${qty}${recipeContext}`;
    })
    .join("\n");

  const prompt = [
    "Generate a grocery list JSON from the following family meal and ingredient data.",
    "Return strict JSON only in this shape:",
    '{"sections":[{"name":"Produce","icon":"🥬","items":[{"name":"Roma Tomatoes","quantity":"5","meals":["Bolognese"],"bulk":true}]}],"estimatedCost":210}',
    "Rules:",
    "- Group by store sections.",
    "- Section names MUST be exactly one of: Produce, Meat, Dairy, Pantry, Bakery, Frozen, Beverages, Snacks, Household, Other.",
    "- Use the provided ingredient totals as the source of truth for quantities.",
    "- If totals are missing, infer practical quantity from occurrences and meal context.",
    "- Quantity MUST be numeric only (digits only, no units, no symbols, no text).",
    ...(input.costcoMode
      ? [
          "- Costco mode is ON: quantity should represent package count to buy.",
        ]
      : []),
    "- Include meals array per item for traceability.",
    `Date range: ${input.dateRangeLabel}`,
    `Meals: ${input.meals.join(" | ")}`,
    `Recipe titles: ${input.recipeTitles.join(" | ") || "none"}`,
    `Household members: ${input.householdMembers.join(", ") || "unknown"}`,
    `Restrictions: ${input.restrictions.join(", ") || "none"}`,
    `Household: ${input.householdName ?? "unknown"}`,
    `Costco mode: ${input.costcoMode ? "on" : "off"}`,
    "Planned meals with eater counts:",
    plannedMealContext || "none",
    "Aggregated ingredient needs:",
    ingredientNeedsContext || "none",
    ...(input.additionalPrompt
      ? [`Additional instructions from the user: ${input.additionalPrompt}`]
      : []),
  ].join("\n");

  const response = await fetchAnthropicMessages(apiKey, {
    model: ANTHROPIC_MODEL,
    max_tokens: 900,
    temperature: 0.2,
    messages: [{ role: "user", content: prompt }],
  });

  if (!response) {
    throw new GroceryListGenerationError(
      "AI grocery generation timed out or is unavailable",
      "AI_UNAVAILABLE",
      504
    );
  }

  if (!response.ok) {
    throw new GroceryListGenerationError(
      `AI grocery generation failed with upstream status ${response.status}`,
      "AI_UPSTREAM_ERROR",
      502
    );
  }

  const payload = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };

  const text = payload.content?.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new GroceryListGenerationError(
      "AI grocery generation returned an empty response",
      "AI_EMPTY_RESPONSE",
      502
    );
  }

  const json = extractJsonObject(text);
  if (!json) {
    throw new GroceryListGenerationError(
      "AI grocery generation returned malformed JSON",
      "AI_INVALID_JSON",
      502
    );
  }

  try {
    const parsed = JSON.parse(json) as unknown;
    const validated = validateGeneratedShape(parsed);
    if (!validated) {
      throw new GroceryListGenerationError(
        "AI grocery generation returned an invalid list structure",
        "AI_INVALID_SHAPE",
        502
      );
    }
    return validated;
  } catch {
    throw new GroceryListGenerationError(
      "AI grocery generation returned malformed JSON",
      "AI_INVALID_JSON",
      502
    );
  }
}

function fallbackGroceryList(input: BuildGroceryListInput): GeneratedGroceryList {
  const bag = new Map<string, { section: string; icon: string; meals: Set<string>; qty: string; bulk: boolean }>();

  const pushItem = (item: CandidateItem, meal: string) => {
    const key = `${item.section}:${item.name}`;
    const existing = bag.get(key);
    if (existing) {
      existing.meals.add(meal);
      return;
    }

    bag.set(key, {
      section: item.section,
      icon: item.icon,
      meals: new Set([meal]),
      qty: toWarehouseQuantity(item, input.costcoMode),
      bulk: Boolean(item.bulkPreferred && input.costcoMode),
    });
  };

  for (const ingredient of input.ingredientNeeds) {
    const sectionInfo = inferSection(ingredient.name);
    const qty = formatQuantity(ingredient.totalQuantity, ingredient.unit, ingredient.occurrences);
    const item: CandidateItem = {
      section: sectionInfo.section,
      icon: sectionInfo.icon,
      name: ingredient.name,
      qty,
      bulkPreferred: input.costcoMode,
    };
    const mealLabel = ingredient.recipes[0] ?? "Meal Plan";
    pushItem(item, mealLabel);
  }

  if (bag.size === 0) {
    for (const meal of input.meals) {
      BASE_STAPLES.forEach((item) => pushItem(item, meal));
    }
  }

  const bySection = new Map<string, GrocerySection>();
  for (const [key, item] of bag.entries()) {
    const sectionName = key.split(":")[0] ?? key;
    const section = bySection.get(sectionName) ?? {
      name: sectionName,
      icon: item.icon,
      items: [],
    };

    section.items.push({
      id: `${slug(sectionName)}:${slug(key)}`,
      name: key.split(":")[1] ?? key,
      quantity: item.qty,
      meals: Array.from(item.meals).slice(0, 4),
      bulk: item.bulk,
    });

    bySection.set(sectionName, section);
  }

  const sections = Array.from(bySection.values()).map((section) => ({
    ...section,
    items: section.items.sort((a, b) => a.name.localeCompare(b.name)),
  }));

  const normalizedSections = normalizeAllowedSections(sections);

  return {
    sections: normalizedSections,
    estimatedCost: estimateCost(normalizedSections),
  };
}

export async function buildGroceryList(input: BuildGroceryListInput) {
  try {
    const generated = await generateWithAnthropic(input);
    return {
      groceryList: generated,
      source: "anthropic" as const,
    };
  } catch (error) {
    if (error instanceof GroceryListGenerationError) {
      return {
        groceryList: fallbackGroceryList(input),
        source: "fallback" as const,
      };
    }

    throw error;
  }
}
