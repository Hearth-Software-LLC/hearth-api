/**
 * The Hearth household as an AI request sees it.
 *
 * Hearth apps keep the family (names, photos, birthdays, allergies, diets, likes and dislikes)
 * in the family's own iCloud, end-to-end encrypted where it's sensitive. The server never stores
 * it. When a request needs it, the app sends this minimal, unnamed summary for that one request:
 * each person's age and role, and the household's food rules. Nothing here is saved or logged.
 */

export type HearthAIContext = {
  people: Array<{ age: number | null; role: "parent" | "adult" | "kid" }>;
  /** Hard rules: never in a suggestion. */
  allergies: string[];
  /** Diets and household rules. */
  restrictions: string[];
  likes: string[];
  dislikes: string[];
};

/** The household context the AI routes build their prompts from. */
export type AIHouseholdContext = {
  householdName: string | null;
  memberNames: string[];
  householdLikes: string[];
  householdDislikes: string[];
  restrictions: string[];
};

const MAX_PEOPLE = 20;
const MAX_ITEMS = 40;
const MAX_ITEM_LENGTH = 60;

function cleanList(value: unknown, limit = MAX_ITEMS): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const text = entry.trim().replace(/\s+/g, " ").slice(0, MAX_ITEM_LENGTH);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(text);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

/**
 * Reads an optional `household` from a request body. Returns null when it's missing; throws
 * when it's there but malformed, so the client hears about it instead of getting a plan that
 * ignores an allergy.
 */
export function parseHearthHousehold(value: unknown): HearthAIContext | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("household must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.people)) {
    throw new Error("household.people must be an array");
  }
  const people = raw.people.slice(0, MAX_PEOPLE).map((entry) => {
    const person = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    const age = typeof person.age === "number" && Number.isFinite(person.age) && person.age >= 0 && person.age < 130
      ? Math.floor(person.age)
      : null;
    const role = person.role === "parent" || person.role === "kid" ? person.role : "adult";
    return { age, role } as const;
  });
  return {
    people,
    allergies: cleanList(raw.allergies),
    restrictions: cleanList(raw.restrictions),
    likes: cleanList(raw.likes),
    dislikes: cleanList(raw.dislikes),
  };
}

/** How a person reads in a prompt: "Adult, 41", "Kid, 9", "Parent". Never a name. */
function describe(person: HearthAIContext["people"][number]): string {
  const role = person.role === "kid" ? "Kid" : person.role === "parent" ? "Parent" : "Adult";
  return person.age === null ? role : `${role}, ${person.age}`;
}

/** The prompt context from a Hearth household. Allergies lead the restrictions, as hard rules. */
export function contextFromHearth(household: HearthAIContext): AIHouseholdContext {
  return {
    householdName: null,
    memberNames: household.people.map(describe),
    householdLikes: household.likes,
    householdDislikes: household.dislikes,
    restrictions: [
      ...household.allergies.map((allergy) => `Allergy (never include): ${allergy}`),
      ...household.restrictions,
    ],
  };
}
