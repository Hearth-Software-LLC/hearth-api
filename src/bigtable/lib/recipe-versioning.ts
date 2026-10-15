export type VersionedRecipeIngredient = {
  id: string | null;
  name: string;
  amount: number | null;
  measurementType: string | null;
  notes: string | null;
};

export type VersionedRecipeContent = {
  title: string;
  description: string | null;
  imageUrl: string | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  baseServings: number | null;
  difficulty: string | null;
  tags: string[];
  instructions: string[];
  ingredients: VersionedRecipeIngredient[];
};

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

function normalizeIngredients(value: unknown): VersionedRecipeIngredient[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return null;
      }

      const row = entry as Record<string, unknown>;
      const name = normalizeString(row.name);
      if (!name) {
        return null;
      }

      const notes = normalizeString(row.notes);
      return {
        id: normalizeString(row.id),
        name,
        amount: normalizeNumber(row.amount),
        measurementType: normalizeString(row.measurementType ?? row.measurement_type),
        notes,
      } satisfies VersionedRecipeIngredient;
    })
    .filter((entry): entry is VersionedRecipeIngredient => entry !== null);
}

export function parseRecipeVersionContent(content: unknown): VersionedRecipeContent | null {
  if (typeof content !== "object" || content === null || Array.isArray(content)) {
    return null;
  }

  const row = content as Record<string, unknown>;
  const title = normalizeString(row.title);
  if (!title) {
    return null;
  }

  return {
    title,
    description: normalizeString(row.description),
    imageUrl: normalizeString(row.imageUrl ?? row.image_url),
    prepMinutes: normalizeNumber(row.prepMinutes ?? row.prep_minutes),
    cookMinutes: normalizeNumber(row.cookMinutes ?? row.cook_minutes),
    baseServings: normalizeNumber(row.baseServings ?? row.base_servings),
    difficulty: normalizeString(row.difficulty),
    tags: normalizeStringArray(row.tags),
    instructions: normalizeStringArray(row.instructions),
    ingredients: normalizeIngredients(row.ingredients),
  };
}
